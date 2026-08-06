import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { AflVmError } from "./errors.js";
import {
  AFL_MESSAGE_ROLE_SCHEMA,
  type MemoryPersistenceBinding,
  type MemoryStateStore,
  type Message,
  type PersistedMemorySlot,
  type PersistedRunMemoryState,
} from "./memory.js";

const activeRuns = new Set<string>();
const storeIds = new WeakMap<object, string>();
let nextStoreId = 0;

export class FileMemoryStateStore implements MemoryStateStore {
  readonly namespace: string;

  private constructor(readonly directory: string) {
    this.namespace = `file:${directory}`;
  }

  static create(directory: string): FileMemoryStateStore {
    return new FileMemoryStateStore(resolve(directory));
  }

  async loadRun(runId: string, signal: AbortSignal): Promise<PersistedRunMemoryState | undefined> {
    throwIfAborted(signal);
    try {
      const text = await readFile(this.pathFor(runId), "utf8");
      throwIfAborted(signal);
      return JSON.parse(text) as PersistedRunMemoryState;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      if (error instanceof SyntaxError) {
        throw new AflVmError("MEMORY_STATE_INVALID", `Memory state for run '${runId}' is not valid JSON`, { cause: error });
      }
      throw error;
    }
  }

  async saveRun(state: PersistedRunMemoryState, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await mkdir(this.directory, { recursive: true });
    const runId = state.runId;
    const target = this.pathFor(runId);
    const temporary = join(this.directory, `.${encodedRunId(runId)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      throwIfAborted(signal);
      await rename(temporary, target);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private pathFor(runId: string): string {
    return join(this.directory, `${encodedRunId(runId)}.json`);
  }
}

export interface ClaimedMemory {
  readonly messages: Message[];
  readonly revision: number;
  readonly restored: boolean;
}

export class RunMemoryPersistence {
  private state: PersistedRunMemoryState;
  private readonly claimedSlots = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;

  private constructor(
    private readonly store: MemoryStateStore,
    private readonly lease: string,
    readonly runId: string,
    readonly rootModuleDigest: string,
    state: PersistedRunMemoryState,
  ) {
    this.state = state;
  }

  static async open(
    binding: MemoryPersistenceBinding | undefined,
    executionRoot: string,
    runId: string,
    rootModuleDigest: string,
    signal: AbortSignal,
  ): Promise<RunMemoryPersistence> {
    const store = await resolveStore(binding, executionRoot);
    const lease = `${storeNamespace(store)}\0${runId}`;
    if (activeRuns.has(lease)) {
      throw new AflVmError(
        "MEMORY_RUN_ACTIVE",
        `Run '${runId}' is already active against the same Memory store in this process`,
      );
    }
    activeRuns.add(lease);
    try {
      const loaded = await store.loadRun(runId, signal);
      const state = loaded ?? emptyState(runId, rootModuleDigest);
      validateState(state, runId, rootModuleDigest);
      return new RunMemoryPersistence(store, lease, runId, rootModuleDigest, cloneState(state));
    } catch (error) {
      activeRuns.delete(lease);
      throw normalizePersistenceError(error, "MEMORY_STATE_LOAD_FAILED", `Failed to load Memory for run '${runId}'`);
    }
  }

  claim(slot: string, moduleDigest: string, initializer: readonly Message[] = []): ClaimedMemory {
    this.assertHealthy();
    if (this.claimedSlots.has(slot)) {
      throw new AflVmError("MEMORY_SLOT_CLAIMED", `Memory slot '${slot}' was allocated more than once in this run`);
    }
    this.claimedSlots.add(slot);
    const persisted = this.state.memories[slot];
    if (persisted !== undefined) {
      if (persisted.moduleDigest !== moduleDigest) {
        throw new AflVmError("MEMORY_MODULE_MISMATCH", `Memory slot '${slot}' belongs to a different generated module`);
      }
      return { messages: cloneMessages(persisted.messages), revision: persisted.revision, restored: true };
    }
    const messages = cloneMessages(initializer);
    return { messages, revision: messages.length, restored: false };
  }

  async save(
    slot: string,
    moduleDigest: string,
    messages: readonly Message[],
    revision: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertHealthy();
    if (!this.claimedSlots.has(slot)) {
      throw new AflVmError("MEMORY_SLOT_UNCLAIMED", `Memory slot '${slot}' has not been allocated`);
    }
    validateMessages(messages, revision, slot);
    const memories = {
      ...this.state.memories,
      [slot]: { moduleDigest, messages: cloneMessages(messages), revision },
    };
    this.state = { ...this.state, memories };
    const snapshot = cloneState(this.state);
    const operation = this.queue.then(async () => {
      this.assertHealthy();
      throwIfAborted(signal);
      await this.store.saveRun(snapshot, signal);
    });
    this.queue = operation.catch((error) => {
      this.failure ??= error;
    });
    try {
      await operation;
    } catch (error) {
      this.failure ??= error;
      throw normalizePersistenceError(error, "MEMORY_STATE_SAVE_FAILED", `Failed to save Memory for run '${this.runId}'`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.queue;
      this.assertHealthy();
    } finally {
      activeRuns.delete(this.lease);
    }
  }

  private assertHealthy(): void {
    if (this.failure !== undefined) {
      throw normalizePersistenceError(this.failure, "MEMORY_STATE_SAVE_FAILED", `Memory persistence for run '${this.runId}' has failed`);
    }
  }
}

async function resolveStore(
  binding: MemoryPersistenceBinding | undefined,
  executionRoot: string,
): Promise<MemoryStateStore> {
  if (binding?.directory !== undefined && binding.store !== undefined) {
    throw new AflVmError("MEMORY_BINDING_INVALID", "Memory persistence cannot specify both directory and store");
  }
  if (binding?.store !== undefined) return binding.store;
  const configured = binding?.directory ?? join(executionRoot, ".afl", "memory");
  const unresolved = isAbsolute(configured) ? resolve(configured) : resolve(executionRoot, configured);
  const directory = await canonicalFuturePath(unresolved);
  return FileMemoryStateStore.create(directory);
}

async function canonicalFuturePath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function emptyState(runId: string, rootModuleDigest: string): PersistedRunMemoryState {
  return {
    version: 1,
    format: "afl.memory-run",
    roleSchema: AFL_MESSAGE_ROLE_SCHEMA,
    runId,
    rootModuleDigest,
    memories: {},
  };
}

function validateState(state: PersistedRunMemoryState, runId: string, rootModuleDigest: string): void {
  if (state.version !== 1 || state.format !== "afl.memory-run" ||
      state.roleSchema !== AFL_MESSAGE_ROLE_SCHEMA || state.runId !== runId ||
      state.rootModuleDigest !== rootModuleDigest ||
      typeof state.memories !== "object" || state.memories === null) {
    throw new AflVmError("MEMORY_STATE_INVALID", `Memory state for run '${runId}' is incompatible with this flow`);
  }
  for (const [slot, value] of Object.entries(state.memories)) {
    if (slot.length === 0 || typeof value !== "object" || value === null ||
        typeof value.moduleDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.moduleDigest) ||
        !Array.isArray(value.messages) || !Number.isInteger(value.revision)) {
      throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${slot}' is invalid`);
    }
    validateMessages(value.messages, value.revision, slot);
  }
}

function validateMessages(messages: readonly Message[], revision: number, slot: string): void {
  if (revision !== messages.length || messages.some((item) =>
    typeof item !== "object" || item === null || typeof item.role !== "string" || item.role.length === 0 ||
    typeof item.content !== "string")) {
    throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${slot}' has invalid messages or revision`);
  }
}

function cloneState(state: PersistedRunMemoryState): PersistedRunMemoryState {
  return {
    ...state,
    memories: Object.fromEntries(Object.entries(state.memories).map(([slot, value]) => [slot, {
      moduleDigest: value.moduleDigest,
      messages: cloneMessages(value.messages),
      revision: value.revision,
    }])),
  };
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function encodedRunId(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

function storeNamespace(store: MemoryStateStore): string {
  if (store instanceof FileMemoryStateStore) return store.namespace;
  let id = storeIds.get(store);
  if (id === undefined) {
    nextStoreId += 1;
    id = `custom:${nextStoreId}`;
    storeIds.set(store, id);
  }
  return id;
}

function normalizePersistenceError(error: unknown, code: string, message: string): AflVmError {
  return error instanceof AflVmError ? error : new AflVmError(code, message, { cause: error });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new AflVmError("RUN_ABORTED", "AFL run was aborted");
}
