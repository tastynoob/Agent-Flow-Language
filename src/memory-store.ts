import { createHash, randomUUID } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AflVmError } from "./errors.js";
import {
  AFL_MESSAGE_ROLE_SCHEMA,
  type AgentInterruptionContext,
  type BackendSessionJournalDelta,
  type BackendSessionJournalPayload,
  type BackendSessionRecord,
  type MemoryContinuationAppendRequest,
  type MemoryDoBeginRequest,
  type MemoryDoEndRequest,
  type MemoryPersistenceBinding,
  type MemoryRunInterruptionRequest,
  type MemorySaveContext,
  type MemoryStateStore,
  type Message,
  type PersistedMemoryBase,
  type PersistedMemoryContinuation,
  type PersistedMemorySlot,
  type PersistedRunMemoryState,
} from "./memory.js";

const activeRuns = new Set<string>();
const storeIds = new WeakMap<object, string>();
let nextStoreId = 0;
const MAX_MEMORY_VALUE_DEPTH = 64;
const MAX_MEMORY_VALUE_NODES = 100_000;
const MAX_MEMORY_STRING_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_MEMORY_FILE_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 1_000_000;
const MAX_MEMORY_FILES = 100_000;

interface ProgramBeginRecord {
  readonly type: "program.begin";
  readonly version: 0;
  readonly role_schema: typeof AFL_MESSAGE_ROLE_SCHEMA;
  readonly run_id: string;
  readonly module: string;
  readonly started_at: string;
}

interface ProgramInterruptedRecord {
  readonly type: "program.interrupted";
  readonly finished_at: string;
  readonly error_code: string;
  readonly error_message: string;
  readonly agent: string;
  readonly executor: string;
  readonly activation: string;
  readonly location: string;
  readonly memory_slot: string;
  readonly memory_revision: number;
  readonly workspace: string;
  readonly readonly_workspaces: readonly string[];
}

interface MemoryHeaderRecord {
  readonly type: "memory";
  readonly version: 0;
  readonly name: string;
  readonly key: string;
  readonly module: string;
  readonly agent?: string;
  readonly executor?: string;
  readonly format?: string;
  readonly base?: {
    readonly file: string;
    readonly revision: number;
  };
}

interface LoadedMemoryFile {
  readonly filename: string;
  readonly header: MemoryHeaderRecord;
  readonly records: readonly unknown[];
}

interface ParsedSlot {
  readonly slot: PersistedMemorySlot;
  readonly history: ReadonlyMap<number, PersistedMemorySlot>;
}

interface ActiveFileDo {
  readonly attemptId: string;
  readonly input: Message;
  inputMirrored: boolean;
}

interface CapturedMemory {
  readonly moduleDigest: string;
  readonly messages: readonly Message[];
  readonly revision: number;
  readonly continuation?: PersistedMemoryContinuation;
  readonly base?: PersistedMemoryBase;
}

export class FileMemoryStateStore implements MemoryStateStore {
  readonly namespace: string;

  private readonly states = new Map<string, PersistedRunMemoryState>();
  private readonly histories = new Map<string, Map<string, Map<number, PersistedMemorySlot>>>();
  private readonly runDirectories = new Map<string, string>();
  private readonly files = new Map<string, Map<string, string>>();
  private readonly headers = new Map<string, Map<string, MemoryHeaderRecord>>();
  private readonly activeDos = new Map<string, ActiveFileDo>();

  private constructor(readonly directory: string) {
    this.namespace = `file:${directory}`;
  }

  static create(directory: string): FileMemoryStateStore {
    return new FileMemoryStateStore(resolve(directory));
  }

  async loadRun(runId: string, signal: AbortSignal): Promise<PersistedRunMemoryState | undefined> {
    throwIfAborted(signal);
    const runDirectory = await this.findRunDirectory(runId);
    if (runDirectory === undefined) return undefined;
    this.runDirectories.set(runId, runDirectory);

    const programPath = join(runDirectory, "program.jsons");
    const programText = await readMemoryFile(programPath, "Memory program");
    const programStream = parseJsonStream(programText, programPath);
    if (programStream.validBytes !== Buffer.byteLength(programText)) {
      await truncateMemoryFile(programPath, programStream.validBytes);
    }
    const program = parseProgram(programStream.values, runId, programPath);

    const names = (await readdir(runDirectory))
      .filter((name) => name !== "program.jsons" && name.endsWith(".jsons"))
      .sort();
    if (names.length > MAX_MEMORY_FILES) {
      throw invalidState(`Memory run '${runDirectory}' contains too many Memory files`);
    }
    const loaded = new Map<string, LoadedMemoryFile>();
    const filenameToSlot = new Map<string, string>();
    const fileMap = new Map<string, string>();
    const headerMap = new Map<string, MemoryHeaderRecord>();
    for (const filename of names) {
      const path = join(runDirectory, filename);
      const text = await readMemoryFile(path, "Memory file");
      const stream = parseJsonStream(text, path);
      if (stream.validBytes !== Buffer.byteLength(text)) await truncateMemoryFile(path, stream.validBytes);
      const [rawHeader, ...records] = stream.values;
      const header = parseMemoryHeader(rawHeader, path);
      if (loaded.has(header.key)) throw invalidState(`Duplicate Memory key '${header.key}'`);
      if (filenameToSlot.has(filename)) throw invalidState(`Duplicate Memory file '${filename}'`);
      loaded.set(header.key, { filename, header, records });
      filenameToSlot.set(filename, header.key);
      fileMap.set(header.key, filename);
      headerMap.set(header.key, header);
    }

    const resolved = new Map<string, ParsedSlot>();
    const resolving = new Set<string>();
    const resolveSlot = (slot: string): ParsedSlot => {
      const cached = resolved.get(slot);
      if (cached !== undefined) return cached;
      if (resolving.has(slot)) throw invalidState(`Memory slot '${slot}' has a cyclic base reference`);
      const file = loaded.get(slot);
      if (file === undefined) throw invalidState(`Memory slot '${slot}' does not exist`);
      resolving.add(slot);
      try {
        let base: PersistedMemorySlot | undefined;
        let logicalBase: PersistedMemoryBase | undefined;
        if (file.header.base !== undefined) {
          const baseSlot = filenameToSlot.get(file.header.base.file);
          if (baseSlot === undefined) {
            throw invalidState(`Memory '${slot}' references missing file '${file.header.base.file}'`);
          }
          logicalBase = { slot: baseSlot, revision: file.header.base.revision };
          base = resolveSlot(baseSlot).history.get(file.header.base.revision);
          if (base === undefined) {
            throw invalidState(
              `Memory '${slot}' references missing revision ${file.header.base.revision} of '${baseSlot}'`,
            );
          }
        }
        const parsed = parseMemoryStream(file.header, file.records, base, logicalBase);
        resolved.set(slot, parsed);
        return parsed;
      } finally {
        resolving.delete(slot);
      }
    };

    const memories: Record<string, PersistedMemorySlot> = {};
    const history = new Map<string, Map<number, PersistedMemorySlot>>();
    for (const slot of loaded.keys()) {
      const parsed = resolveSlot(slot);
      memories[slot] = cloneSlot(parsed.slot);
      history.set(slot, new Map([...parsed.history].map(([revision, value]) => [revision, cloneSlot(value)])));
    }
    const state: PersistedRunMemoryState = {
      version: 0,
      format: "afl.memory-run",
      roleSchema: AFL_MESSAGE_ROLE_SCHEMA,
      runId,
      rootModuleDigest: program.module,
      memories,
    };
    this.states.set(runId, cloneState(state));
    this.histories.set(runId, history);
    this.files.set(runId, fileMap);
    this.headers.set(runId, headerMap);
    return state;
  }

  async saveRun(
    state: PersistedRunMemoryState,
    signal: AbortSignal,
    context?: MemorySaveContext,
  ): Promise<void> {
    throwIfAborted(signal);
    validateStateShape(state);
    await this.ensureProgram(state);
    const slots = context === undefined ? Object.keys(state.memories) : [context.slot];
    for (const slot of slots) {
      const next = state.memories[slot];
      if (next === undefined) throw invalidState(`Memory slot '${slot}' is missing from the run state`);
      const previous = this.previousSlot(state.runId, slot, next);
      assertAppendOnly(previous, next, slot);
      await this.ensureMemoryFile(state.runId, slot, next);
      const records = next.messages.slice(previous.revision).map((message) => appendRecord(message));
      if (records.length > 0) await appendPretty(this.memoryPath(state.runId, slot), records);
      this.rememberSlot(state.runId, slot, next);
    }
    this.states.set(state.runId, cloneState(state));
  }

  async beginMemoryDo(request: MemoryDoBeginRequest, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    validateStateShape(request.state);
    const key = doKey(request.runId, request.slot);
    if (this.activeDos.has(key)) throw invalidState(`Memory slot '${request.slot}' already has an active do`);
    await this.ensureProgram(request.state);
    const next = request.state.memories[request.slot];
    if (next === undefined) throw invalidState(`Memory slot '${request.slot}' is missing from the run state`);
    const previous = this.previousSlot(request.runId, request.slot, next);
    assertAppendOnly(previous, next, request.slot);
    const added = next.messages.slice(previous.revision);
    const input = added.at(-1) ?? request.resumeInput;
    if (input === undefined) throw invalidState(`Memory slot '${request.slot}' do has no input Message`);
    const durableInput = next.messages.at(-1);
    if (added.length === 0 &&
        (durableInput?.role !== input.role || durableInput.content !== input.content)) {
      throw invalidState(`Memory slot '${request.slot}' resumed do input is not durable`);
    }
    const header = await this.ensureMemoryFile(request.runId, request.slot, next, {
      agent: request.agent,
      executor: request.executor,
      ...(request.format === undefined ? {} : { format: request.format }),
    });
    const canonicalPrefix = added.slice(0, -1).map((message) => appendRecord(message));
    const continuationPrefix = newContinuationRecords(previous.continuation, next.continuation, request.slot);
    const records: BackendSessionRecord[] = [
      ...canonicalPrefix,
      ...stripCanonicalMirrors(continuationPrefix, previous, canonicalPrefix),
      {
        type: "do.begin",
        location: request.location,
        started_at: request.startedAt,
        ...(header.format === undefined ? { agent: request.agent, executor: request.executor } : {}),
        ...(header.format === undefined && request.format !== undefined ? { format: request.format } : {}),
      },
      ...(added.length === 0 ? [] : [inputRecord(input)]),
    ];
    await appendPretty(this.memoryPath(request.runId, request.slot), records);
    this.states.set(request.runId, cloneState(request.state));
    this.rememberSlot(request.runId, request.slot, next);
    this.activeDos.set(key, {
      attemptId: request.attemptId,
      input: { ...input },
      inputMirrored: added.length === 0,
    });
  }

  async appendMemoryContinuation(
    request: MemoryContinuationAppendRequest,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    validateDelta(request.delta, request.slot);
    const active = this.requireDo(request.runId, request.slot, request.attemptId);
    const state = this.states.get(request.runId);
    const current = state?.memories[request.slot];
    if (state === undefined || current === undefined) {
      throw invalidState(`Memory slot '${request.slot}' is not materialized`);
    }
    const continuation = applyJournalDelta(current.continuation, request.delta, request.slot);
    const written: BackendSessionRecord[] = [];
    let projected = cloneSlot(current);
    for (const record of request.delta.records) {
      if (!active.inputMirrored && isMirroredInput(record, active.input)) {
        active.inputMirrored = true;
      } else {
        written.push(structuredClone(record));
      }
      projected = projectCanonicalRecord(projected, record, request.slot);
    }
    const next: PersistedMemorySlot = {
      ...projected,
      continuation: {
        ...continuation,
        memoryRevision: projected.revision,
      },
    };
    if (written.length > 0) await appendPretty(this.memoryPath(request.runId, request.slot), written);
    this.states.set(request.runId, {
      ...state,
      memories: { ...state.memories, [request.slot]: cloneSlot(next) },
    });
    this.rememberSlot(request.runId, request.slot, next);
  }

  async endMemoryDo(request: MemoryDoEndRequest, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.requireDo(request.runId, request.slot, request.attemptId);
    const storedState = this.states.get(request.runId);
    const current = storedState?.memories[request.slot];
    const requested = request.state.memories[request.slot];
    if (storedState === undefined || current === undefined || requested === undefined) {
      throw invalidState(`Memory slot '${request.slot}' is not materialized`);
    }
    let resolved: PersistedMemorySlot;
    const records: BackendSessionRecord[] = [];
    if (isMessagePrefix(current.messages, requested.messages)) {
      records.push(...requested.messages.slice(current.revision).map((message, index) => outputRecord(
        message,
        (requested.continuation?.memoryRevision ?? 0) >= current.revision + index + 1,
      )));
      resolved = cloneSlot(requested);
    } else if (isMessagePrefix(requested.messages, current.messages)) {
      resolved = cloneSlot(current);
    } else {
      throw invalidState(`Memory slot '${request.slot}' diverged while ending do`);
    }
    records.push({
      type: "do.end",
      status: request.status,
      finished_at: request.finishedAt,
      ...(request.error === undefined ? {} : {
        error_code: request.error.code,
        error_message: request.error.message,
      }),
      ...(request.interruption === undefined ? {} : interruptionRecordFields(request.interruption)),
    });
    await appendPretty(this.memoryPath(request.runId, request.slot), records);
    const nextState: PersistedRunMemoryState = {
      ...request.state,
      memories: { ...request.state.memories, [request.slot]: cloneSlot(resolved) },
    };
    this.states.set(request.runId, cloneState(nextState));
    this.rememberSlot(request.runId, request.slot, resolved);
    this.activeDos.delete(doKey(request.runId, request.slot));
  }

  async recordRunInterruption(
    request: MemoryRunInterruptionRequest,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    validateStateShape(request.state);
    const directory = await this.ensureProgram(request.state);
    const record: ProgramInterruptedRecord = {
      type: "program.interrupted",
      finished_at: request.finishedAt,
      error_code: request.error.code,
      error_message: request.error.message,
      ...interruptionRecordFields(request.interruption),
    };
    await appendPretty(join(directory, "program.jsons"), [record]);
  }

  private async findRunDirectory(runId: string): Promise<string | undefined> {
    const suffix = `-${shortId(runId)}`;
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter((name) => name.startsWith("afl-") && name.endsWith(suffix));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    const matches: string[] = [];
    for (const name of names) {
      const path = join(this.directory, name, "program.jsons");
      try {
        const stream = parseJsonStream(await readMemoryFile(path, "Memory program"), path);
        const first = stream.values[0];
        if (isRecord(first) && first.type === "program.begin" && first.run_id === runId) {
          matches.push(join(this.directory, name));
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
    if (matches.length > 1) throw invalidState(`Run '${runId}' has multiple Memory directories`);
    return matches[0];
  }

  private async ensureProgram(state: PersistedRunMemoryState): Promise<string> {
    const known = this.runDirectories.get(state.runId) ?? await this.findRunDirectory(state.runId);
    if (known !== undefined) {
      this.runDirectories.set(state.runId, known);
      return known;
    }
    await mkdir(this.directory, { recursive: true });
    const directory = join(this.directory, `afl-${localDateStamp(new Date())}-${shortId(state.runId)}`);
    await mkdir(directory);
    const record: ProgramBeginRecord = {
      type: "program.begin",
      version: 0,
      role_schema: AFL_MESSAGE_ROLE_SCHEMA,
      run_id: state.runId,
      module: state.rootModuleDigest,
      started_at: new Date().toISOString(),
    };
    await writeExclusive(join(directory, "program.jsons"), prettyRecord(record));
    this.runDirectories.set(state.runId, directory);
    this.files.set(state.runId, new Map());
    this.headers.set(state.runId, new Map());
    return directory;
  }

  private async ensureMemoryFile(
    runId: string,
    slot: string,
    value: PersistedMemorySlot,
    binding?: { readonly agent: string; readonly executor: string; readonly format?: string },
  ): Promise<MemoryHeaderRecord> {
    const existing = this.headers.get(runId)?.get(slot);
    if (existing !== undefined) return existing;
    const files = this.files.get(runId) ?? new Map<string, string>();
    this.files.set(runId, files);
    const headers = this.headers.get(runId) ?? new Map<string, MemoryHeaderRecord>();
    this.headers.set(runId, headers);
    const filename = this.allocateFilename(runId, semanticSlotLabel(slot));
    let base: MemoryHeaderRecord["base"];
    if (value.base !== undefined) {
      const sourceFile = files.get(value.base.slot);
      if (sourceFile === undefined) {
        throw invalidState(`Memory base '${value.base.slot}' revision ${value.base.revision} is not materialized`);
      }
      base = { file: sourceFile, revision: value.base.revision };
    }
    const header: MemoryHeaderRecord = {
      type: "memory",
      version: 0,
      name: semanticSlotLabel(slot),
      key: slot,
      module: value.moduleDigest,
      ...(binding === undefined ? {} : {
        agent: binding.agent,
        executor: binding.executor,
        ...(binding.format === undefined ? {} : { format: binding.format }),
      }),
      ...(base === undefined ? {} : { base }),
    };
    await writeExclusive(join(this.runDirectory(runId), filename), prettyRecord(header));
    files.set(slot, filename);
    headers.set(slot, header);
    return header;
  }

  private allocateFilename(runId: string, label: string): string {
    const used = new Set(this.files.get(runId)?.values() ?? []);
    const plain = `${label}.jsons`;
    if (!used.has(plain)) return plain;
    for (let index = 1; ; index += 1) {
      const candidate = `${label}-${String(index).padStart(2, "0")}.jsons`;
      if (!used.has(candidate)) return candidate;
    }
  }

  private previousSlot(runId: string, slot: string, next: PersistedMemorySlot): PersistedMemorySlot {
    const existing = this.states.get(runId)?.memories[slot];
    if (existing !== undefined) return cloneSlot(existing);
    if (next.base !== undefined) {
      const base = this.histories.get(runId)?.get(next.base.slot)?.get(next.base.revision);
      if (base === undefined) {
        throw invalidState(`Memory base '${next.base.slot}' revision ${next.base.revision} is not durable`);
      }
      return {
        ...cloneSlot(base),
        moduleDigest: next.moduleDigest,
        base: structuredClone(next.base),
      };
    }
    return { moduleDigest: next.moduleDigest, messages: [], revision: 0 };
  }

  private rememberSlot(runId: string, slot: string, value: PersistedMemorySlot): void {
    let slots = this.histories.get(runId);
    if (slots === undefined) {
      slots = new Map();
      this.histories.set(runId, slots);
    }
    let revisions = slots.get(slot);
    if (revisions === undefined) {
      revisions = new Map();
      slots.set(slot, revisions);
    }
    revisions.set(value.revision, cloneSlot(value));
  }

  private requireDo(runId: string, slot: string, attemptId: string): ActiveFileDo {
    const active = this.activeDos.get(doKey(runId, slot));
    if (active?.attemptId !== attemptId) {
      throw invalidState(`Memory slot '${slot}' has no matching active do`);
    }
    return active;
  }

  private runDirectory(runId: string): string {
    const directory = this.runDirectories.get(runId);
    if (directory === undefined) throw invalidState(`Run '${runId}' has no Memory directory`);
    return directory;
  }

  private memoryPath(runId: string, slot: string): string {
    const filename = this.files.get(runId)?.get(slot);
    if (filename === undefined) throw invalidState(`Memory slot '${slot}' has no file`);
    return join(this.runDirectory(runId), filename);
  }
}

export interface ClaimedMemory {
  readonly messages: Message[];
  readonly revision: number;
  readonly continuation?: PersistedMemoryContinuation;
  readonly base?: PersistedMemoryBase;
  readonly restored: boolean;
  readonly materialized: boolean;
}

export interface MemoryPersistenceAttempt {
  readonly slot: string;
  readonly attemptId: string;
}

export interface AgentAttemptEnd {
  readonly status: "error" | "interrupted" | "cancelled";
  readonly error?: { readonly code: string; readonly message: string };
  readonly interruption?: AgentInterruptionContext;
}

export interface AgentDoPersistenceRequest {
  readonly slot: string;
  readonly moduleDigest: string;
  readonly messages: readonly Message[];
  readonly revision: number;
  readonly continuation?: PersistedMemoryContinuation;
  readonly agent: string;
  readonly executor: string;
  readonly format?: string;
  readonly location: string;
  readonly resumeInput?: Message;
}

export class RunMemoryPersistence {
  private state: PersistedRunMemoryState;
  private committedState: PersistedRunMemoryState;
  private readonly claimedSlots = new Set<string>();
  private readonly requestedBases = new Map<string, PersistedMemoryBase>();
  private readonly captures = new Map<string, Map<number, CapturedMemory>>();
  private readonly attempts = new Map<string, MemoryPersistenceAttempt>();
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
    this.committedState = cloneState(state);
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

  claim(
    slot: string,
    moduleDigest: string,
    initializer: readonly Message[] = [],
    requestedBase?: PersistedMemoryBase,
  ): ClaimedMemory {
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
      return {
        messages: cloneMessages(persisted.messages),
        revision: persisted.revision,
        ...(persisted.continuation === undefined ? {} : { continuation: cloneContinuation(persisted.continuation) }),
        ...(persisted.base === undefined ? {} : { base: structuredClone(persisted.base) }),
        restored: true,
        materialized: true,
      };
    }
    if (requestedBase !== undefined) this.requestedBases.set(slot, structuredClone(requestedBase));
    const messages = cloneMessages(initializer);
    return {
      messages,
      revision: messages.length,
      ...(requestedBase === undefined ? {} : { base: structuredClone(requestedBase) }),
      restored: false,
      materialized: false,
    };
  }

  capture(
    slot: string,
    moduleDigest: string,
    messages: readonly Message[],
    revision: number,
    continuation?: PersistedMemoryContinuation,
    base?: PersistedMemoryBase,
  ): void {
    this.assertHealthy();
    validateMessages(messages, revision, slot);
    let revisions = this.captures.get(slot);
    if (revisions === undefined) {
      revisions = new Map();
      this.captures.set(slot, revisions);
    }
    revisions.set(revision, {
      moduleDigest,
      messages: cloneMessages(messages),
      revision,
      ...(continuation === undefined ? {} : { continuation: cloneContinuation(continuation) }),
      ...(base === undefined ? {} : { base: structuredClone(base) }),
    });
  }

  isMaterialized(slot: string): boolean {
    return this.committedState.memories[slot] !== undefined;
  }

  currentRevision(slot: string): number | undefined {
    return this.committedState.memories[slot]?.revision;
  }

  async beginAgentAttempt(
    request: AgentDoPersistenceRequest,
    signal: AbortSignal,
  ): Promise<MemoryPersistenceAttempt> {
    this.assertHealthy();
    if (!this.claimedSlots.has(request.slot)) {
      throw new AflVmError("MEMORY_SLOT_UNCLAIMED", `Memory slot '${request.slot}' has not been allocated`);
    }
    if (this.attempts.has(request.slot)) {
      throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${request.slot}' already has an active Agent do`);
    }
    validateMessages(request.messages, request.revision, request.slot);
    if (request.continuation !== undefined) {
      validateContinuation(request.continuation, request.revision, request.slot);
    }
    await this.ensureRequestedBase(request.slot, signal);
    const continuation = synchronizeCanonicalContinuation(request);
    this.setSlot(request.slot, request.moduleDigest, request.messages, request.revision, continuation);
    const attempt = { slot: request.slot, attemptId: randomUUID() };
    const target = cloneSlot(this.state.memories[request.slot]!);
    await this.enqueue(async () => {
      const snapshot = this.snapshotWithSlot(request.slot, target);
      if (this.store.beginMemoryDo !== undefined) {
        await this.store.beginMemoryDo({
          state: snapshot,
          runId: this.runId,
          ...attempt,
          agent: request.agent,
          executor: request.executor,
          ...(request.format === undefined ? {} : { format: request.format }),
          location: request.location,
          startedAt: new Date().toISOString(),
          ...(request.resumeInput === undefined ? {} : { resumeInput: { ...request.resumeInput } }),
        }, signal);
      } else {
        await this.store.saveRun(snapshot, signal, { slot: request.slot, kind: "materialize" });
      }
      this.committedState = cloneState(snapshot);
    }, signal);
    this.attempts.set(request.slot, attempt);
    return attempt;
  }

  async appendContinuation(
    attempt: MemoryPersistenceAttempt,
    delta: BackendSessionJournalDelta,
    signal: AbortSignal,
  ): Promise<void> {
    this.requireAttempt(attempt);
    validateDelta(delta, attempt.slot);
    const current = this.state.memories[attempt.slot];
    if (current === undefined) throw new AflVmError("MEMORY_STATE_INVALID", "Agent Memory is not materialized");
    const continuation = applyJournalDelta(current.continuation, delta, attempt.slot);
    let projected = cloneSlot(current);
    for (const record of delta.records) projected = projectCanonicalRecord(projected, record, attempt.slot);
    const target: PersistedMemorySlot = {
      ...projected,
      continuation: { ...continuation, memoryRevision: projected.revision },
    };
    this.state = {
      ...this.state,
      memories: {
        ...this.state.memories,
        [attempt.slot]: cloneSlot(target),
      },
    };
    await this.enqueue(async () => {
      if (this.store.appendMemoryContinuation === undefined) return;
      await this.store.appendMemoryContinuation({
        runId: this.runId,
        ...attempt,
        delta: structuredClone(delta),
      }, signal);
      this.committedState = this.snapshotWithSlot(attempt.slot, target);
    }, signal);
  }

  async abortAgentAttempt(
    attempt: MemoryPersistenceAttempt,
    outcome: AgentAttemptEnd,
  ): Promise<void> {
    if (this.attempts.get(attempt.slot)?.attemptId !== attempt.attemptId) return;
    const signal = new AbortController().signal;
    const target = this.state.memories[attempt.slot] === undefined
      ? undefined
      : cloneSlot(this.state.memories[attempt.slot]!);
    try {
      await this.enqueue(async () => {
        if (this.store.endMemoryDo === undefined) return;
        const snapshot = target === undefined
          ? cloneState(this.committedState)
          : this.snapshotWithSlot(attempt.slot, target);
        await this.store.endMemoryDo({
          state: snapshot,
          runId: this.runId,
          ...attempt,
          status: outcome.status,
          finishedAt: new Date().toISOString(),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
          ...(outcome.interruption === undefined ? {} : { interruption: outcome.interruption }),
        }, signal);
        this.committedState = cloneState(snapshot);
      }, signal);
    } finally {
      this.attempts.delete(attempt.slot);
    }
  }

  async recordRunInterruption(
    error: { readonly code: string; readonly message: string },
    interruption: AgentInterruptionContext,
  ): Promise<void> {
    const signal = new AbortController().signal;
    await this.enqueue(async () => {
      const snapshot = cloneState(this.committedState);
      await this.store.recordRunInterruption?.({
        state: snapshot,
        runId: this.runId,
        finishedAt: new Date().toISOString(),
        error,
        interruption,
      }, signal);
    }, signal);
  }

  async save(
    slot: string,
    moduleDigest: string,
    messages: readonly Message[],
    revision: number,
    continuation: PersistedMemoryContinuation | undefined,
    signal: AbortSignal,
    attempt?: MemoryPersistenceAttempt,
  ): Promise<void> {
    this.assertHealthy();
    if (!this.claimedSlots.has(slot)) {
      throw new AflVmError("MEMORY_SLOT_UNCLAIMED", `Memory slot '${slot}' has not been allocated`);
    }
    if (attempt !== undefined) this.requireAttempt(attempt);
    validateMessages(messages, revision, slot);
    if (continuation !== undefined) validateContinuation(continuation, revision, slot);
    const wasMaterialized = this.state.memories[slot] !== undefined;
    if (!wasMaterialized) await this.ensureRequestedBase(slot, signal);
    this.setSlot(slot, moduleDigest, messages, revision, continuation);
    const target = cloneSlot(this.state.memories[slot]!);
    await this.enqueue(async () => {
      const snapshot = this.snapshotWithSlot(slot, target);
      if (attempt !== undefined && this.store.endMemoryDo !== undefined) {
        await this.store.endMemoryDo({
          state: snapshot,
          runId: this.runId,
          ...attempt,
          status: "ok",
          finishedAt: new Date().toISOString(),
        }, signal);
      } else {
        await this.store.saveRun(snapshot, signal, {
          slot,
          kind: wasMaterialized ? "append" : "materialize",
        });
      }
      this.committedState = cloneState(snapshot);
    }, signal);
    if (attempt !== undefined) this.attempts.delete(slot);
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

  private async ensureRequestedBase(slot: string, signal: AbortSignal): Promise<void> {
    const base = this.state.memories[slot]?.base ?? this.requestedBases.get(slot);
    if (base === undefined) return;
    await this.ensureBaseReference(base, signal, new Set());
  }

  private async ensureBaseReference(
    base: PersistedMemoryBase,
    signal: AbortSignal,
    resolving: Set<string>,
  ): Promise<void> {
    if (this.state.memories[base.slot] !== undefined) return;
    if (resolving.has(base.slot)) {
      throw new AflVmError("MEMORY_STATE_INVALID", `Memory base '${base.slot}' has a cyclic reference`);
    }
    resolving.add(base.slot);
    const captured = this.captures.get(base.slot)?.get(base.revision);
    if (captured === undefined) {
      throw new AflVmError(
        "MEMORY_STATE_INVALID",
        `Memory base '${base.slot}' revision ${base.revision} was not captured`,
      );
    }
    if (captured.base !== undefined) await this.ensureBaseReference(captured.base, signal, resolving);
    this.state = {
      ...this.state,
      memories: {
        ...this.state.memories,
        [base.slot]: {
          moduleDigest: captured.moduleDigest,
          messages: cloneMessages(captured.messages),
          revision: captured.revision,
          ...(captured.continuation === undefined ? {} : { continuation: cloneContinuation(captured.continuation) }),
          ...(captured.base === undefined ? {} : { base: structuredClone(captured.base) }),
        },
      },
    };
    const target = cloneSlot(this.state.memories[base.slot]!);
    await this.enqueue(
      async () => {
        const snapshot = this.snapshotWithSlot(base.slot, target);
        await this.store.saveRun(snapshot, signal, { slot: base.slot, kind: "materialize" });
        this.committedState = cloneState(snapshot);
      },
      signal,
    );
    resolving.delete(base.slot);
  }

  private setSlot(
    slot: string,
    moduleDigest: string,
    messages: readonly Message[],
    revision: number,
    continuation?: PersistedMemoryContinuation,
  ): void {
    const base = this.state.memories[slot]?.base ?? this.requestedBases.get(slot);
    this.state = {
      ...this.state,
      memories: {
        ...this.state.memories,
        [slot]: {
          moduleDigest,
          messages: cloneMessages(messages),
          revision,
          ...(continuation === undefined ? {} : { continuation: cloneContinuation(continuation) }),
          ...(base === undefined ? {} : { base: structuredClone(base) }),
        },
      },
    };
  }

  private snapshotWithSlot(slot: string, value: PersistedMemorySlot): PersistedRunMemoryState {
    return {
      ...this.committedState,
      memories: {
        ...this.committedState.memories,
        [slot]: cloneSlot(value),
      },
    };
  }

  private async enqueue(operation: () => Promise<void>, signal: AbortSignal): Promise<void> {
    this.assertHealthy();
    const current = this.queue.then(async () => {
      this.assertHealthy();
      throwIfAborted(signal);
      await operation();
    });
    this.queue = current.catch((error) => {
      this.failure ??= error;
    });
    try {
      await current;
    } catch (error) {
      this.failure ??= error;
      throw normalizePersistenceError(
        error,
        "MEMORY_STATE_SAVE_FAILED",
        `Failed to save Memory for run '${this.runId}'`,
      );
    }
  }

  private requireAttempt(attempt: MemoryPersistenceAttempt): void {
    if (this.attempts.get(attempt.slot)?.attemptId !== attempt.attemptId) {
      throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${attempt.slot}' has no matching Agent do`);
    }
  }

  private assertHealthy(): void {
    if (this.failure !== undefined) {
      throw normalizePersistenceError(
        this.failure,
        "MEMORY_STATE_SAVE_FAILED",
        `Memory persistence for run '${this.runId}' has failed`,
      );
    }
  }
}

function synchronizeCanonicalContinuation(
  request: AgentDoPersistenceRequest,
): PersistedMemoryContinuation | undefined {
  if (request.format === undefined) return request.continuation;
  const synchronizedRevision = request.continuation?.memoryRevision ?? 0;
  const targetRevision = request.resumeInput === undefined
    ? Math.max(0, request.revision - 1)
    : request.revision;
  if (synchronizedRevision > targetRevision) {
    throw new AflVmError(
      "MEMORY_STATE_INVALID",
      `Memory slot '${request.slot}' continuation is ahead of the Agent input`,
    );
  }
  if (request.continuation !== undefined &&
      (request.continuation.state.backend !== request.executor ||
       request.continuation.state.format !== request.format)) {
    throw new AflVmError(
      "MEMORY_STATE_INVALID",
      `Memory slot '${request.slot}' continuation changed backend or format`,
    );
  }
  const pending = request.messages.slice(synchronizedRevision, targetRevision);
  if (pending.length === 0) return request.continuation;
  const payload = request.continuation === undefined
    ? { version: 0 as const, records: [] as BackendSessionRecord[] }
    : structuredClone(asJournalPayload(request.continuation.state.payload, request.slot)) as {
        version: 0;
        records: BackendSessionRecord[];
      };
  payload.records.push(...pending.map(sessionAppendRecord));
  return {
    memoryRevision: targetRevision,
    state: {
      backend: request.executor,
      format: request.format,
      payload,
    },
  };
}

function parseMemoryStream(
  header: MemoryHeaderRecord,
  records: readonly unknown[],
  base: PersistedMemorySlot | undefined,
  logicalBase: PersistedMemoryBase | undefined,
): ParsedSlot {
  let slot: PersistedMemorySlot = base === undefined
    ? { moduleDigest: header.module, messages: [], revision: 0 }
    : {
        ...cloneSlot(base),
        moduleDigest: header.module,
        ...(logicalBase === undefined ? {} : { base: structuredClone(logicalBase) }),
      };
  const history = new Map<number, PersistedMemorySlot>();
  history.set(slot.revision, cloneSlot(slot));
  const firstBinding = records.find((raw) => isRecord(raw) && raw.type === "do.begin" &&
    typeof raw.executor === "string" && typeof raw.format === "string");
  let executor = header.format === undefined
    ? (isRecord(firstBinding) ? firstBinding.executor as string : undefined)
    : header.executor;
  let format = header.format ?? (isRecord(firstBinding) ? firstBinding.format as string : undefined);
  if (base !== undefined) slot = synchronizeLoadedCanonicalContinuation(slot, executor, format, header.key);
  for (const raw of records) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      throw invalidState(`Memory '${header.key}' has an invalid record`);
    }
    if (raw.type === "do.begin") {
      if (typeof raw.format === "string") {
        format = raw.format;
        if (typeof raw.executor === "string") executor = raw.executor;
      }
      history.set(slot.revision, cloneSlot(slot));
      continue;
    }
    if (raw.type === "do.end") {
      history.set(slot.revision, cloneSlot(slot));
      continue;
    }
    if (raw.type === "append") {
      if (typeof raw.role !== "string" || raw.role.length === 0) {
        throw invalidState(`Memory '${header.key}' has an invalid append record`);
      }
      const message = { role: raw.role, content: decodeText(raw.text, header.key) };
      slot = appendSlotMessage(slot, message);
      slot = appendContinuationRecord(slot, sessionAppendRecord(message), executor, format, header.key);
      history.set(slot.revision, cloneSlot(slot));
      continue;
    }
    if (raw.type === "user" || raw.type === "input") {
      const role = raw.type === "user" ? "user" : raw.role;
      if (typeof role !== "string" || role.length === 0) {
        throw invalidState(`Memory '${header.key}' has an invalid input record`);
      }
      if (raw.canonical !== false) {
        slot = appendSlotMessage(slot, { role, content: decodeText(raw.text, header.key) });
      }
      slot = appendContinuationRecord(slot, raw as BackendSessionRecord, executor, format, header.key);
      history.set(slot.revision, cloneSlot(slot));
      continue;
    }
    if (raw.type === "assistant") {
      if (raw.continuation !== false) {
        slot = appendContinuationRecord(slot, raw as BackendSessionRecord, executor, format, header.key);
      }
      if (isFinalAssistantRecord(raw)) {
        slot = appendSlotMessage(slot, { role: "assistant", content: assistantRecordText(raw, header.key) });
        if (slot.continuation !== undefined) {
          slot = {
            ...slot,
            continuation: { ...slot.continuation, memoryRevision: slot.revision },
          };
        }
      }
      history.set(slot.revision, cloneSlot(slot));
      continue;
    }
    if (raw.type === "tool.result" || raw.type.startsWith("session.")) {
      slot = appendContinuationRecord(slot, raw as BackendSessionRecord, executor, format, header.key);
      history.set(slot.revision, cloneSlot(slot));
      continue;
    }
    throw invalidState(`Memory '${header.key}' has unknown record '${raw.type}'`);
  }
  validateMessages(slot.messages, slot.revision, header.key);
  if (slot.continuation !== undefined) validateContinuation(slot.continuation, slot.revision, header.key);
  return { slot, history };
}

function appendContinuationRecord(
  slot: PersistedMemorySlot,
  record: BackendSessionRecord,
  executor: string | undefined,
  format: string | undefined,
  name: string,
): PersistedMemorySlot {
  if (format === undefined) return slot;
  if (executor === undefined) throw invalidState(`Memory '${name}' continuation has no executor`);
  const existing = slot.continuation;
  if (existing !== undefined &&
      (existing.state.backend !== executor || existing.state.format !== format)) {
    throw invalidState(`Memory '${name}' changes executor continuation format`);
  }
  const payload = existing === undefined
    ? { version: 0 as const, records: [] as BackendSessionRecord[] }
    : structuredClone(asJournalPayload(existing.state.payload, name)) as {
        version: 0;
        records: BackendSessionRecord[];
      };
  payload.records.push(structuredClone(record));
  return {
    ...slot,
    continuation: {
      memoryRevision: slot.revision,
      state: { backend: executor, format, payload },
    },
  };
}

function applyJournalDelta(
  continuation: PersistedMemoryContinuation | undefined,
  delta: BackendSessionJournalDelta,
  slot: string,
): PersistedMemoryContinuation {
  const existing = continuation?.state;
  if (existing !== undefined && (existing.backend !== delta.backend || existing.format !== delta.format)) {
    throw invalidState(`Memory slot '${slot}' continuation changed backend or format`);
  }
  const payload = existing === undefined
    ? { version: 0 as const, records: [] as BackendSessionRecord[] }
    : structuredClone(asJournalPayload(existing.payload, slot)) as {
        version: 0;
        records: BackendSessionRecord[];
      };
  if (payload.records.length !== delta.baseRecordCount) {
    throw invalidState(
      `Memory slot '${slot}' continuation expected ${payload.records.length} records, got ${delta.baseRecordCount}`,
    );
  }
  payload.records.push(...structuredClone(delta.records));
  return {
    memoryRevision: continuation?.memoryRevision ?? 0,
    state: { backend: delta.backend, format: delta.format, payload },
  };
}

function newContinuationRecords(
  previous: PersistedMemoryContinuation | undefined,
  next: PersistedMemoryContinuation | undefined,
  slot: string,
): BackendSessionRecord[] {
  if (next === undefined) return [];
  if (previous !== undefined &&
      (previous.state.backend !== next.state.backend || previous.state.format !== next.state.format)) {
    throw invalidState(`Memory slot '${slot}' continuation changed backend or format`);
  }
  const nextPayload = asJournalPayload(next.state.payload, slot);
  const previousRecords = previous === undefined ? [] : asJournalPayload(previous.state.payload, slot).records;
  if (previousRecords.length > nextPayload.records.length ||
      previousRecords.some((record, index) => !isDeepStrictEqual(record, nextPayload.records[index]))) {
    throw invalidState(`Memory slot '${slot}' continuation is not append-only`);
  }
  return structuredClone(nextPayload.records.slice(previousRecords.length));
}

function stripCanonicalMirrors(
  continuation: readonly BackendSessionRecord[],
  previous: PersistedMemorySlot,
  canonical: readonly BackendSessionRecord[],
): BackendSessionRecord[] {
  const synchronizedRevision = previous.continuation?.memoryRevision ?? 0;
  const mirrors = [
    ...previous.messages.slice(synchronizedRevision).map(sessionAppendRecord),
    ...canonical.map((record) => ({ ...record, type: "session.append" })),
  ];
  let mirrored = 0;
  while (mirrored < continuation.length && mirrored < mirrors.length) {
    const nativeRecord = continuation[mirrored]!;
    const mirror = mirrors[mirrored]!;
    if (!isDeepStrictEqual(nativeRecord, mirror)) {
      break;
    }
    mirrored += 1;
  }
  return structuredClone(continuation.slice(mirrored));
}

function synchronizeLoadedCanonicalContinuation(
  slot: PersistedMemorySlot,
  executor: string | undefined,
  format: string | undefined,
  name: string,
): PersistedMemorySlot {
  if (executor === undefined || format === undefined) return slot;
  const synchronizedRevision = slot.continuation?.memoryRevision ?? 0;
  let synchronized = slot;
  for (const message of slot.messages.slice(synchronizedRevision)) {
    synchronized = appendContinuationRecord(synchronized, sessionAppendRecord(message), executor, format, name);
  }
  return synchronized;
}

function projectCanonicalRecord(
  slot: PersistedMemorySlot,
  record: BackendSessionRecord,
  name: string,
): PersistedMemorySlot {
  if (record.type !== "assistant" || !isFinalAssistantRecord(record)) return slot;
  const content = assistantRecordText(record, name);
  if (slot.messages.at(-1)?.role === "assistant" && slot.messages.at(-1)?.content === content) return slot;
  return appendSlotMessage(slot, { role: "assistant", content });
}

function isFinalAssistantRecord(record: Record<string, unknown>): boolean {
  if (record.canonical === false) return false;
  if (record.final === true) return true;
  return "text" in record && !("content" in record) && record.final !== false;
}

function assistantRecordText(record: Record<string, unknown>, name: string): string {
  if ("text" in record) return decodeText(record.text, name);
  if (!Array.isArray(record.content)) throw invalidState(`Memory '${name}' has an invalid assistant record`);
  return record.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => decodeText(block.text, name))
    .join("");
}

function appendSlotMessage(slot: PersistedMemorySlot, message: Message): PersistedMemorySlot {
  return {
    ...slot,
    messages: [...slot.messages, message],
    revision: slot.revision + 1,
  };
}

function appendRecord(message: Message): BackendSessionRecord {
  return { type: "append", role: message.role, text: encodeText(message.content) };
}

function sessionAppendRecord(message: Message): BackendSessionRecord {
  return { type: "session.append", role: message.role, text: encodeText(message.content) };
}

function inputRecord(message: Message): BackendSessionRecord {
  return message.role === "user"
    ? { type: "user", text: encodeText(message.content) }
    : { type: "input", role: message.role, text: encodeText(message.content) };
}

function outputRecord(message: Message, continuationSynchronized = false): BackendSessionRecord {
  return message.role === "assistant"
    ? {
        type: "assistant",
        text: encodeText(message.content),
        ...(continuationSynchronized ? { continuation: false } : {}),
      }
    : { type: "append", role: message.role, text: encodeText(message.content) };
}

function isMirroredInput(record: BackendSessionRecord, input: Message): boolean {
  if (record.type === "user" && input.role !== "user") return false;
  if (record.type === "input" && record.role !== input.role) return false;
  if (record.type !== "user" && record.type !== "input") return false;
  try {
    return decodeText(record.text, "continuation") === input.content;
  } catch {
    return false;
  }
}

function encodeText(content: string): string | string[] {
  return content.includes("\n") ? content.split("\n") : content;
}

function decodeText(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("\n");
  throw invalidState(`Memory '${name}' has invalid text`);
}

function parseProgram(values: readonly unknown[], runId: string, path: string): ProgramBeginRecord {
  const first = values[0];
  if (!isRecord(first) || first.type !== "program.begin" || first.version !== 0 ||
      first.role_schema !== AFL_MESSAGE_ROLE_SCHEMA || first.run_id !== runId ||
      typeof first.module !== "string" || typeof first.started_at !== "string") {
    throw invalidState(`Memory program '${path}' is invalid`);
  }
  for (const value of values.slice(1)) {
    if (!isRecord(value) || (
      value.type !== "program.begin" &&
      value.type !== "program.end" &&
      !isProgramInterruptedRecord(value)
    )) {
      throw invalidState(`Memory program '${path}' has an invalid record`);
    }
  }
  return first as unknown as ProgramBeginRecord;
}

function isProgramInterruptedRecord(value: Record<string, unknown>): boolean {
  return value.type === "program.interrupted" &&
    typeof value.finished_at === "string" &&
    typeof value.error_code === "string" &&
    typeof value.error_message === "string" &&
    typeof value.agent === "string" &&
    typeof value.executor === "string" &&
    typeof value.activation === "string" &&
    typeof value.location === "string" &&
    typeof value.memory_slot === "string" &&
    Number.isInteger(value.memory_revision) &&
    (value.memory_revision as number) >= 0 &&
    typeof value.workspace === "string" &&
    Array.isArray(value.readonly_workspaces) &&
    value.readonly_workspaces.every((item) => typeof item === "string");
}

function interruptionRecordFields(interruption: AgentInterruptionContext): Omit<
  ProgramInterruptedRecord,
  "type" | "finished_at" | "error_code" | "error_message"
> {
  return {
    agent: interruption.agent,
    executor: interruption.executor,
    activation: interruption.activation,
    location: interruption.location,
    memory_slot: interruption.memorySlot,
    memory_revision: interruption.memoryRevision,
    workspace: interruption.workspace,
    readonly_workspaces: [...interruption.readOnlyWorkspaces],
  };
}

function parseMemoryHeader(value: unknown, path: string): MemoryHeaderRecord {
  if (!isRecord(value) || value.type !== "memory" || value.version !== 0 ||
      typeof value.name !== "string" || value.name.length === 0 ||
      typeof value.key !== "string" || value.key.length === 0 ||
      typeof value.module !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.module) ||
      !(value.agent === undefined || typeof value.agent === "string") ||
      !(value.executor === undefined || typeof value.executor === "string") ||
      !(value.format === undefined || typeof value.format === "string")) {
    throw invalidState(`Memory file '${path}' has an invalid header`);
  }
  if (value.base !== undefined && (!isRecord(value.base) || typeof value.base.file !== "string" ||
      value.base.file.length === 0 || !Number.isInteger(value.base.revision) || (value.base.revision as number) < 0)) {
    throw invalidState(`Memory file '${path}' has an invalid base`);
  }
  return structuredClone(value) as unknown as MemoryHeaderRecord;
}

function parseJsonStream(text: string, path: string): { values: unknown[]; validBytes: number } {
  const values: unknown[] = [];
  let index = 0;
  let lastComplete = 0;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index]!)) index += 1;
    if (index === text.length) return { values, validBytes: Buffer.byteLength(text) };
    const start = index;
    if (text[index] !== "{") throw invalidState(`JSON stream '${path}' has invalid data at offset ${index}`);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let complete = false;
    for (; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth < 0) throw invalidState(`JSON stream '${path}' has unbalanced data`);
        if (depth === 0) {
          const end = index + 1;
          if (Buffer.byteLength(text.slice(start, end)) > MAX_MEMORY_RECORD_BYTES) {
            throw invalidState(`JSON stream '${path}' contains a record larger than the byte limit`);
          }
          try {
            const value: unknown = JSON.parse(text.slice(start, end));
            if (!isRecord(value)) throw new TypeError("top-level value is not an object");
            validateMemoryJsonValue(value, path);
            if (values.length >= MAX_MEMORY_RECORDS) {
              throw invalidState(`JSON stream '${path}' exceeds the record-count limit`);
            }
            values.push(value);
          } catch (error) {
            throw invalidState(`JSON stream '${path}' contains invalid JSON`, error);
          }
          lastComplete = end;
          index = end;
          complete = true;
          break;
        }
      }
    }
    if (!complete) return { values, validBytes: Buffer.byteLength(text.slice(0, lastComplete)) };
  }
  return { values, validBytes: Buffer.byteLength(text) };
}

function prettyRecord(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n\n`;
}

async function writeExclusive(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_MEMORY_RECORD_BYTES) {
    throw invalidState(`Memory record '${path}' exceeds the byte limit`);
  }
  const handle = await open(
    path,
    FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendPretty(path: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return;
  const rendered = records.map((record) => {
    validateMemoryJsonValue(record, path);
    const content = prettyRecord(record);
    if (Buffer.byteLength(content) > MAX_MEMORY_RECORD_BYTES) {
      throw invalidState(`Memory record '${path}' exceeds the byte limit`);
    }
    return content;
  });
  const handle = await open(
    path,
    FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    const addedBytes = rendered.reduce((total, content) => total + Buffer.byteLength(content), 0);
    if (metadata.size + addedBytes > MAX_MEMORY_FILE_BYTES) {
      throw invalidState(`Memory file '${path}' exceeds the byte limit`);
    }
    for (const content of rendered) {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

async function readMemoryFile(path: string, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw invalidState(`Cannot open ${label.toLowerCase()} '${path}'`, error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidState(`${label} '${path}' is not a regular file`);
    if (metadata.size > MAX_MEMORY_FILE_BYTES) {
      throw invalidState(`${label} '${path}' exceeds the byte limit`);
    }
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_MEMORY_FILE_BYTES) {
      throw invalidState(`${label} '${path}' exceeds the byte limit`);
    }
    return text;
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw invalidState(`Cannot read ${label.toLowerCase()} '${path}'`, error);
  } finally {
    await handle.close();
  }
}

async function truncateMemoryFile(path: string, length: number): Promise<void> {
  let handle;
  try {
    handle = await open(path, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (error) {
    throw invalidState(`Cannot open Memory file '${path}' for tail repair`, error);
  }
  try {
    await handle.truncate(length);
    await handle.sync();
  } catch (error) {
    throw invalidState(`Cannot repair Memory file '${path}'`, error);
  } finally {
    await handle.close();
  }
}

function validateDelta(delta: BackendSessionJournalDelta, slot: string): void {
  if (!isRecord(delta) || typeof delta.backend !== "string" || delta.backend.length === 0 ||
      typeof delta.format !== "string" || delta.format.length === 0 ||
      !Number.isInteger(delta.baseRecordCount) || delta.baseRecordCount < 0 ||
      !Array.isArray(delta.records) || delta.records.length === 0 ||
      !delta.records.every((record) => isRecord(record) && typeof record.type === "string" &&
        record.type.length > 0 && isJsonValue(record))) {
    throw invalidState(`Memory slot '${slot}' has an invalid continuation delta`);
  }
}

function asJournalPayload(value: unknown, slot: string): BackendSessionJournalPayload {
  if (!isRecord(value) || value.version !== 0 || !Array.isArray(value.records) ||
      !value.records.every((record) => isRecord(record) && typeof record.type === "string" && isJsonValue(record))) {
    throw invalidState(`Memory slot '${slot}' continuation is invalid`);
  }
  return value as unknown as BackendSessionJournalPayload;
}

function validateState(state: PersistedRunMemoryState, runId: string, rootModuleDigest: string): void {
  validateStateShape(state);
  if (state.runId !== runId || state.rootModuleDigest !== rootModuleDigest) {
    throw new AflVmError("MEMORY_STATE_INVALID", `Memory state for run '${runId}' is incompatible with this flow`);
  }
}

function validateStateShape(state: PersistedRunMemoryState): void {
  if (state.version !== 0 || state.format !== "afl.memory-run" ||
      state.roleSchema !== AFL_MESSAGE_ROLE_SCHEMA || typeof state.runId !== "string" ||
      typeof state.rootModuleDigest !== "string" ||
      typeof state.memories !== "object" || state.memories === null) {
    throw new AflVmError("MEMORY_STATE_INVALID", `Memory state for run '${state.runId}' is invalid`);
  }
  for (const [slot, value] of Object.entries(state.memories)) {
    if (slot.length === 0 || typeof value !== "object" || value === null ||
        typeof value.moduleDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.moduleDigest) ||
        !Array.isArray(value.messages) || !Number.isInteger(value.revision)) {
      throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${slot}' is invalid`);
    }
    validateMessages(value.messages, value.revision, slot);
    if (value.continuation !== undefined) validateContinuation(value.continuation, value.revision, slot);
    if (value.base !== undefined && (typeof value.base.slot !== "string" || value.base.slot.length === 0 ||
        !Number.isInteger(value.base.revision) || value.base.revision < 0)) {
      throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${slot}' has an invalid base reference`);
    }
  }
}

function validateMessages(messages: readonly Message[], revision: number, slot: string): void {
  if (revision !== messages.length || messages.some((item) =>
    typeof item !== "object" || item === null || typeof item.role !== "string" || item.role.length === 0 ||
    typeof item.content !== "string")) {
    throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${slot}' has invalid Messages`);
  }
}

function validateContinuation(
  continuation: PersistedMemoryContinuation,
  revision: number,
  slot: string,
): void {
  if (typeof continuation !== "object" || continuation === null ||
      !Number.isInteger(continuation.memoryRevision) || continuation.memoryRevision < 0 ||
      continuation.memoryRevision > revision || !isRecord(continuation.state) ||
      typeof continuation.state.backend !== "string" || continuation.state.backend.length === 0 ||
      typeof continuation.state.format !== "string" || continuation.state.format.length === 0) {
    throw new AflVmError("MEMORY_STATE_INVALID", `Memory slot '${slot}' has an invalid executor continuation`);
  }
  asJournalPayload(continuation.state.payload, slot);
}

function assertAppendOnly(previous: PersistedMemorySlot, next: PersistedMemorySlot, slot: string): void {
  if (previous.moduleDigest !== next.moduleDigest || previous.revision > next.revision ||
      !isMessagePrefix(previous.messages, next.messages)) {
    throw invalidState(`Memory slot '${slot}' is not append-only`);
  }
}

function isMessagePrefix(prefix: readonly Message[], messages: readonly Message[]): boolean {
  return prefix.length <= messages.length && prefix.every((message, index) =>
    message.role === messages[index]?.role && message.content === messages[index]?.content);
}

function cloneState(state: PersistedRunMemoryState): PersistedRunMemoryState {
  return {
    ...state,
    memories: Object.fromEntries(Object.entries(state.memories).map(([slot, value]) => [slot, cloneSlot(value)])),
  };
}

function cloneSlot(value: PersistedMemorySlot): PersistedMemorySlot {
  return {
    moduleDigest: value.moduleDigest,
    messages: cloneMessages(value.messages),
    revision: value.revision,
    ...(value.continuation === undefined ? {} : { continuation: cloneContinuation(value.continuation) }),
    ...(value.base === undefined ? {} : { base: structuredClone(value.base) }),
  };
}

function cloneContinuation(continuation: PersistedMemoryContinuation): PersistedMemoryContinuation {
  return structuredClone(continuation);
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function emptyState(runId: string, rootModuleDigest: string): PersistedRunMemoryState {
  return {
    version: 0,
    format: "afl.memory-run",
    roleSchema: AFL_MESSAGE_ROLE_SCHEMA,
    runId,
    rootModuleDigest,
    memories: {},
  };
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
  return FileMemoryStateStore.create(await canonicalFuturePath(unresolved));
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

function localDateStamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-` +
    `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function shortId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function semanticSlotLabel(slot: string): string {
  const encoded = /(?:^|[:/])agent:([^/]+)/u.exec(slot)?.[1] ??
    /(?:^|[:/])memory\.copy:([^/]+)/u.exec(slot)?.[1] ??
    /(?:^|[:/])fork:([^/]+)/u.exec(slot)?.[1] ??
    "memory";
  let semantic = encoded;
  try {
    semantic = decodeURIComponent(encoded);
  } catch {
    // The stable slot remains authoritative when a generated label is not URI encoded.
  }
  return semantic.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "") || "memory";
}

function doKey(runId: string, slot: string): string {
  return `${runId}\0${slot}`;
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

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => item !== undefined && isJsonValue(item));
}

function validateMemoryJsonValue(value: unknown, path: string): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_MEMORY_VALUE_NODES) {
      throw invalidState(`Memory record '${path}' contains too many values`);
    }
    if (depth > MAX_MEMORY_VALUE_DEPTH) {
      throw invalidState(`Memory record '${path}' exceeds the nesting-depth limit`);
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      if (typeof current === "number" && !Number.isFinite(current)) {
        throw invalidState(`Memory record '${path}' contains a non-finite number`);
      }
      return;
    }
    if (typeof current === "string") {
      if (Buffer.byteLength(current) > MAX_MEMORY_STRING_BYTES) {
        throw invalidState(`Memory record '${path}' contains an oversized string`);
      }
      return;
    }
    if (!Array.isArray(current) && !isRecord(current)) {
      throw invalidState(`Memory record '${path}' contains a non-JSON value`);
    }
    if (seen.has(current)) throw invalidState(`Memory record '${path}' contains a cyclic value`);
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else {
      const entries = Object.entries(current);
      for (const [key, item] of entries) {
        if (Buffer.byteLength(key) > MAX_MEMORY_STRING_BYTES) {
          throw invalidState(`Memory record '${path}' contains an oversized key`);
        }
        visit(item, depth + 1);
      }
    }
    seen.delete(current);
  };
  visit(value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePersistenceError(error: unknown, code: string, message: string): AflVmError {
  if (error instanceof AflVmError && (error.code === code || error.code === "MEMORY_STATE_INVALID")) return error;
  return new AflVmError(code, message, { cause: error });
}

function invalidState(message: string, cause?: unknown): AflVmError {
  return new AflVmError("MEMORY_STATE_INVALID", message, cause === undefined ? {} : { cause });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
}
