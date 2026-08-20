import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as FS_CONSTANTS } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { AflVmError } from "./errors.js";
import type { ComputeValue, Frag, SymbolRef } from "./ir.js";
import type { VmArgument } from "./adapters.js";

const RECOVERY_FORMAT = "afl.recovery-run" as const;
const MAX_VALUE_DEPTH = 64;
const MAX_VALUE_NODES = 100_000;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_RECOVERY_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_RECOVERY_JOURNAL_BYTES = 256 * 1024 * 1024;
const MAX_RECOVERY_RECORDS = 1_000_000;
const FILE_LOCK_HOLDER = `
const fs = require("node:fs");
const path = process.argv[1];
const owner = process.argv[2];
const parent = Number(process.argv[3]);
fs.writeFileSync(path, owner + "\\n", "utf8");
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 250);
`;

export type RecoveryRunStatus = "running" | "interrupted" | "failed" | "completed";
export type RecoveryOperationStatus = "prepared" | "interrupted" | "ambiguous" | "completed";

export interface RecoveryRunDescriptor {
  readonly version: 0;
  readonly format: typeof RECOVERY_FORMAT;
  readonly runId: string;
  readonly generation: number;
  readonly rootModuleDigest: string;
  readonly entry: string;
  readonly args: readonly VmArgument[];
  readonly argsDigest: string;
  readonly executionRoot: string;
  readonly bindingFingerprint?: string;
  readonly executorFingerprint?: string;
  readonly startedAt: string;
}

export interface RecoveryOperationDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly inputDigest: string;
  readonly activation: string;
  readonly node: string;
  readonly block: string;
  readonly instruction: number;
  readonly blockVisit: number;
  readonly details?: ComputeValue;
}

export interface RecoveryOperationState {
  readonly descriptor: RecoveryOperationDescriptor;
  readonly status: RecoveryOperationStatus;
  readonly result?: VmArgument;
  readonly progressDetails?: ComputeValue;
  readonly completedDetails?: ComputeValue;
  readonly error?: RecoveryError;
}

export interface RecoveryError {
  readonly code: string;
  readonly message: string;
}

export interface LoadedRecoveryRun {
  readonly descriptor: RecoveryRunDescriptor;
  readonly status: RecoveryRunStatus;
  readonly resumeAttempt: number;
  readonly operations: ReadonlyMap<string, RecoveryOperationState>;
  readonly output?: VmArgument;
  readonly error?: RecoveryError;
}

export type RecoveryRecord =
  | {
      readonly type: "run.begin";
      readonly descriptor: RecoveryRunDescriptor;
    }
  | {
      readonly type: "run.resume";
      readonly generation: number;
      readonly attempt: number;
      readonly resumed_at: string;
    }
  | {
      readonly type: "operation.prepared";
      readonly generation: number;
      readonly operation: RecoveryOperationDescriptor;
      readonly prepared_at: string;
    }
  | {
      readonly type: "operation.interrupted";
      readonly generation: number;
      readonly id: string;
      readonly input_digest: string;
      readonly interrupted_at: string;
      readonly error: RecoveryError;
    }
  | {
      readonly type: "operation.ambiguous";
      readonly generation: number;
      readonly id: string;
      readonly input_digest: string;
      readonly ambiguous_at: string;
      readonly error: RecoveryError;
    }
  | {
      readonly type: "operation.completed";
      readonly generation: number;
      readonly id: string;
      readonly input_digest: string;
      readonly completed_at: string;
      readonly result: VmArgument;
      readonly details?: ComputeValue;
    }
  | {
      readonly type: "operation.progress";
      readonly generation: number;
      readonly id: string;
      readonly input_digest: string;
      readonly updated_at: string;
      readonly details: ComputeValue;
    }
  | {
      readonly type: "run.interrupted";
      readonly generation: number;
      readonly interrupted_at: string;
      readonly error: RecoveryError;
    }
  | {
      readonly type: "run.failed";
      readonly generation: number;
      readonly failed_at: string;
      readonly error: RecoveryError;
    }
  | {
      readonly type: "run.completed";
      readonly generation: number;
      readonly completed_at: string;
      readonly output: VmArgument;
    };

export interface RecoveryStateStore {
  readonly namespace?: string;
  loadRun(runId: string, signal: AbortSignal): Promise<readonly RecoveryRecord[] | undefined>;
  createRun(descriptor: RecoveryRunDescriptor, signal: AbortSignal): Promise<void>;
  appendRun(runId: string, records: readonly RecoveryRecord[], signal: AbortSignal): Promise<void>;
  acquireRun?(runId: string, mode: "start" | "resume", signal: AbortSignal): Promise<RecoveryWriterLease>;
}

export interface RecoveryWriterLease {
  release(): Promise<void>;
}

export interface RecoveryPersistenceBinding {
  readonly directory?: string;
  readonly store?: RecoveryStateStore;
}

export interface OpenRecoveryRunRequest {
  readonly mode: "start" | "resume";
  readonly runId: string;
  readonly rootModuleDigest: string;
  readonly entry: string;
  readonly args: readonly VmArgument[];
  readonly executionRoot: string;
  readonly bindingFingerprint?: string;
  readonly executorFingerprint?: string;
}

const activeRuns = new Set<string>();
const storeIds = new WeakMap<object, string>();
let nextStoreId = 0;

export class FileRecoveryStateStore implements RecoveryStateStore {
  readonly namespace: string;
  private readonly recordCounts = new Map<string, number>();

  private constructor(readonly directory: string) {
    this.namespace = `file:${directory}`;
  }

  static create(directory: string): FileRecoveryStateStore {
    return new FileRecoveryStateStore(resolve(directory));
  }

  async loadRun(runId: string, signal: AbortSignal): Promise<readonly RecoveryRecord[] | undefined> {
    throwIfAborted(signal);
    const path = this.journalPath(runId);
    let text: string;
    try {
      text = await readRecoveryFile(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (Buffer.byteLength(text) > MAX_RECOVERY_JOURNAL_BYTES) {
      throw invalidState(`Recovery journal '${path}' exceeds the byte limit`);
    }
    const stream = parseJsonStream(text, path);
    if (stream.validBytes !== Buffer.byteLength(text)) await truncateRecoveryFile(path, stream.validBytes);
    if (stream.values.length === 0 && (text.trim().length === 0 || stream.validBytes === 0)) {
      if (stream.validBytes !== 0) await truncateRecoveryFile(path, 0);
      this.recordCounts.set(path, 0);
      return undefined;
    }
    const records = stream.values.map((value) => parseRecoveryRecord(value, path));
    this.recordCounts.set(path, records.length);
    return records;
  }

  async createRun(descriptor: RecoveryRunDescriptor, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await mkdir(this.directory, { recursive: true });
    const directory = this.runDirectory(descriptor.runId);
    await mkdir(directory, { recursive: true });
    await writeInitialRecord(
      join(directory, "recovery.jsons"),
      prettyRecord({ type: "run.begin", descriptor } satisfies RecoveryRecord),
    );
    this.recordCounts.set(join(directory, "recovery.jsons"), 1);
  }

  async appendRun(runId: string, records: readonly RecoveryRecord[], signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const path = this.journalPath(runId);
    let count = this.recordCounts.get(path);
    if (count === undefined) {
      const loaded = await this.loadRun(runId, signal);
      count = loaded?.length ?? 0;
    }
    if (count + records.length > MAX_RECOVERY_RECORDS) {
      throw invalidState(`Recovery journal '${path}' exceeds the record-count limit`);
    }
    await appendPretty(path, records, signal);
    this.recordCounts.set(path, count + records.length);
  }

  async acquireRun(
    runId: string,
    mode: "start" | "resume",
    signal: AbortSignal,
  ): Promise<RecoveryWriterLease> {
    throwIfAborted(signal);
    const lockDirectory = join(this.directory, ".locks");
    await mkdir(lockDirectory, { recursive: true });
    const path = join(lockDirectory, `${createHash("sha256").update(runId).digest("hex")}.lock`);
    const token = randomUUID();
    const owner = {
      version: 0,
      run_id: runId,
      token,
      host: hostname(),
      pid: process.pid,
      mode,
      acquired_at: new Date().toISOString(),
    };
    return acquireKernelFileLease(path, owner, runId, signal);
  }

  private runDirectory(runId: string): string {
    return join(this.directory, `run-${createHash("sha256").update(runId).digest("hex")}`);
  }

  private journalPath(runId: string): string {
    return join(this.runDirectory(runId), "recovery.jsons");
  }
}

async function acquireKernelFileLease(
  path: string,
  owner: { readonly token: string },
  runId: string,
  signal: AbortSignal,
): Promise<RecoveryWriterLease> {
  throwIfAborted(signal);
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      "--no-fork",
      path,
      process.execPath,
      "-e",
      FILE_LOCK_HOLDER,
      path,
      JSON.stringify(owner),
      String(process.pid),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let acquired = false;
  let stderr = "";
  const abort = (): void => {
    child.kill("SIGTERM");
  };
  signal.addEventListener("abort", abort, { once: true });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      let checking = false;
      let settled = false;
      const poll = setInterval(() => void checkOwner(), 5);
      const deadline = setTimeout(() => {
        fail(new AflVmError("RECOVERY_LOCK_UNAVAILABLE", "Timed out while acquiring the recovery file lock"));
      }, 5_000);
      const checkOwner = async (): Promise<void> => {
        if (settled || checking) return;
        checking = true;
        try {
          const value = JSON.parse(await readFile(path, "utf8")) as unknown;
          if (!isRecord(value) || value.token !== owner.token) return;
          settled = true;
          acquired = true;
          cleanup();
          resolveReady();
        } catch (error) {
          if (!isNodeError(error, "ENOENT") && error instanceof AflVmError) fail(error);
        } finally {
          checking = false;
        }
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectReady(error);
      };
      const onError = (error: Error): void => {
        fail(new AflVmError(
          "RECOVERY_LOCK_UNAVAILABLE",
          "File recovery persistence requires the 'flock' executable",
          { cause: error },
        ));
      };
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (signal.aborted) {
          fail(signal.reason ?? new AflVmError("RECOVERY_LOCK_CANCELLED", "Recovery lock acquisition was cancelled"));
          return;
        }
        if (code === 1) {
          fail(new AflVmError(
            "RECOVERY_RUN_ACTIVE",
            `Run '${runId}' already has an active recovery writer`,
          ));
          return;
        }
        fail(new AflVmError(
          "RECOVERY_LOCK_UNAVAILABLE",
          `Recovery lock holder exited before acquisition${stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`}`,
          { details: { code: code ?? -1, signal: exitSignal ?? "" } },
        ));
      };
      const cleanup = (): void => {
        clearInterval(poll);
        clearTimeout(deadline);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.once("error", onError);
      child.once("exit", onExit);
      void checkOwner();
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return {
    release: async () => releaseKernelFileLease(child, acquired),
  };
}

async function releaseKernelFileLease(
  child: ChildProcess,
  acquired: boolean,
): Promise<void> {
  if (!acquired || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", rejectExit);
  });
  child.kill("SIGTERM");
  await exited;
}

export class RunRecoveryPersistence {
  private state: LoadedRecoveryRun;
  private queue: Promise<void> = Promise.resolve();
  private readonly operationTransitions = new Map<string, Promise<void>>();
  private failure: unknown;
  private closed = false;

  private constructor(
    private readonly store: RecoveryStateStore,
    private readonly lease: string,
    private readonly writerLease: RecoveryWriterLease | undefined,
    state: LoadedRecoveryRun,
  ) {
    this.state = state;
  }

  static async open(
    binding: RecoveryPersistenceBinding | undefined,
    request: OpenRecoveryRunRequest,
    signal: AbortSignal,
  ): Promise<RunRecoveryPersistence> {
    const store = await resolveStore(binding, request.executionRoot);
    const lease = `${storeNamespace(store)}\0${request.runId}`;
    if (activeRuns.has(lease)) {
      throw new AflVmError(
        "RECOVERY_RUN_ACTIVE",
        `Run '${request.runId}' already has an active recovery writer in this process`,
      );
    }
    activeRuns.add(lease);
    let writerLease: RecoveryWriterLease | undefined;
    try {
      writerLease = await store.acquireRun?.(request.runId, request.mode, signal);
      const loadedRecords = await store.loadRun(request.runId, signal);
      if (loadedRecords === undefined) {
        if (request.mode === "resume") {
          throw new AflVmError("RECOVERY_RUN_NOT_FOUND", `Run '${request.runId}' has no recovery state`);
        }
        const descriptor = createDescriptor(request, 0);
        await store.createRun(descriptor, signal);
        return new RunRecoveryPersistence(store, lease, writerLease, initialState(descriptor));
      }

      const loaded = loadRecoveryRun(loadedRecords, request.runId);
      if (request.mode === "resume") {
        assertCompatible(loaded.descriptor, request);
        if (loaded.status === "completed") {
          return new RunRecoveryPersistence(store, lease, writerLease, loaded);
        }
        if (loaded.status === "failed") {
          throw new AflVmError(
            "RECOVERY_RUN_NOT_RESUMABLE",
            `Run '${request.runId}' failed deterministically and cannot be resumed`,
          );
        }
        const attempt = loaded.resumeAttempt + 1;
        const record: RecoveryRecord = {
          type: "run.resume",
          generation: loaded.descriptor.generation,
          attempt,
          resumed_at: new Date().toISOString(),
        };
        await store.appendRun(request.runId, [record], signal);
        const { error: _error, ...resumable } = loaded;
        return new RunRecoveryPersistence(store, lease, writerLease, {
          ...resumable,
          status: "running",
          resumeAttempt: attempt,
        });
      }

      if (loaded.status !== "completed") {
        throw new AflVmError(
          "RECOVERY_RUN_REQUIRES_RESUME",
          `Run '${request.runId}' is ${loaded.status}; use explicit resume instead of starting it again`,
        );
      }
      throw new AflVmError(
        "RECOVERY_RUN_COMPLETED",
        `Run '${request.runId}' is completed and immutable; use a new runId for a new execution`,
      );
    } catch (error) {
      await writerLease?.release().catch(() => {});
      activeRuns.delete(lease);
      throw normalizeRecoveryError(error, "RECOVERY_STATE_LOAD_FAILED", `Failed to load recovery state for '${request.runId}'`);
    }
  }

  get runId(): string {
    return this.state.descriptor.runId;
  }

  get generation(): number {
    return this.state.descriptor.generation;
  }

  get status(): RecoveryRunStatus {
    return this.state.status;
  }

  completedOutput(): VmArgument | undefined {
    return this.state.status === "completed" && this.state.output !== undefined
      ? cloneRecoveryValue(this.state.output)
      : undefined;
  }

  operation(id: string): RecoveryOperationState | undefined {
    const operation = this.state.operations.get(id);
    return operation === undefined ? undefined : cloneOperation(operation);
  }

  operations(): readonly RecoveryOperationState[] {
    return [...this.state.operations.values()].map(cloneOperation);
  }

  async prepareOperation(
    descriptor: RecoveryOperationDescriptor,
    signal: AbortSignal,
  ): Promise<RecoveryOperationState> {
    return this.withOperationTransition(descriptor.id, () => this.prepareOperationNow(descriptor, signal));
  }

  private async prepareOperationNow(
    descriptor: RecoveryOperationDescriptor,
    signal: AbortSignal,
  ): Promise<RecoveryOperationState> {
    this.assertRunning();
    validateOperationDescriptor(descriptor);
    const existing = this.state.operations.get(descriptor.id);
    if (existing !== undefined) {
      assertOperationCompatible(existing.descriptor, descriptor);
      return cloneOperation(existing);
    }
    const record: RecoveryRecord = {
      type: "operation.prepared",
      generation: this.generation,
      operation: structuredClone(descriptor),
      prepared_at: new Date().toISOString(),
    };
    await this.append([record], signal);
    const state: RecoveryOperationState = { descriptor: structuredClone(descriptor), status: "prepared" };
    this.replaceOperation(state);
    return cloneOperation(state);
  }

  async completeOperation(
    id: string,
    inputDigest: string,
    result: VmArgument,
    signal: AbortSignal,
    details?: ComputeValue,
  ): Promise<void> {
    return this.withOperationTransition(id, () =>
      this.completeOperationNow(id, inputDigest, result, signal, details));
  }

  private async completeOperationNow(
    id: string,
    inputDigest: string,
    result: VmArgument,
    signal: AbortSignal,
    details?: ComputeValue,
  ): Promise<void> {
    this.assertRunning();
    const operation = this.requireOperation(id, inputDigest);
    if (operation.status === "completed") {
      if (recoveryValueDigest(operation.result!) !== recoveryValueDigest(result) ||
          recoveryValueDigest(operation.completedDetails ?? null) !== recoveryValueDigest(details ?? null)) {
        throw invalidState(`Completed operation '${id}' has a different result or completion details`);
      }
      return;
    }
    if (operation.status === "ambiguous") {
      throw invalidState(`Ambiguous operation '${id}' requires explicit reconciliation before completion`);
    }
    const clonedResult = cloneRecoveryValue(result);
    const clonedDetails = details === undefined ? undefined : cloneComputeValue(details);
    const record: RecoveryRecord = {
      type: "operation.completed",
      generation: this.generation,
      id,
      input_digest: inputDigest,
      completed_at: new Date().toISOString(),
      result: clonedResult,
      ...(clonedDetails === undefined ? {} : { details: clonedDetails }),
    };
    await this.append([record], signal);
    this.replaceOperation({
      descriptor: operation.descriptor,
      status: "completed",
      result: clonedResult,
      ...(operation.progressDetails === undefined ? {} : {
        progressDetails: cloneComputeValue(operation.progressDetails),
      }),
      ...(clonedDetails === undefined ? {} : { completedDetails: clonedDetails }),
    });
  }

  async updateOperationProgress(
    id: string,
    inputDigest: string,
    details: ComputeValue,
    signal: AbortSignal,
  ): Promise<void> {
    return this.withOperationTransition(id, () =>
      this.updateOperationProgressNow(id, inputDigest, details, signal));
  }

  private async updateOperationProgressNow(
    id: string,
    inputDigest: string,
    details: ComputeValue,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertRunning();
    const operation = this.requireOperation(id, inputDigest);
    if (operation.status === "completed") {
      throw invalidState(`Completed operation '${id}' cannot publish progress`);
    }
    const cloned = cloneComputeValue(details);
    await this.append([{
      type: "operation.progress",
      generation: this.generation,
      id,
      input_digest: inputDigest,
      updated_at: new Date().toISOString(),
      details: cloned,
    }], signal);
    this.replaceOperation({
      ...operation,
      progressDetails: cloned,
    });
  }

  async interruptOperation(
    id: string,
    inputDigest: string,
    error: RecoveryError,
  ): Promise<void> {
    return this.withOperationTransition(id, () => this.interruptOperationNow(id, inputDigest, error));
  }

  private async interruptOperationNow(
    id: string,
    inputDigest: string,
    error: RecoveryError,
  ): Promise<void> {
    if (this.state.status !== "running") return;
    const operation = this.requireOperation(id, inputDigest);
    if (operation.status === "completed") return;
    const signal = new AbortController().signal;
    const record: RecoveryRecord = {
      type: "operation.interrupted",
      generation: this.generation,
      id,
      input_digest: inputDigest,
      interrupted_at: new Date().toISOString(),
      error: cloneError(error),
    };
    await this.append([record], signal);
    this.replaceOperation({
      ...operation,
      status: "interrupted",
      error: cloneError(error),
    });
  }

  async markOperationAmbiguous(
    id: string,
    inputDigest: string,
    error: RecoveryError,
    signal: AbortSignal,
  ): Promise<void> {
    return this.withOperationTransition(id, () =>
      this.markOperationAmbiguousNow(id, inputDigest, error, signal));
  }

  private async markOperationAmbiguousNow(
    id: string,
    inputDigest: string,
    error: RecoveryError,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertRunning();
    const operation = this.requireOperation(id, inputDigest);
    if (operation.status === "completed") return;
    if (operation.status === "ambiguous") return;
    const record: RecoveryRecord = {
      type: "operation.ambiguous",
      generation: this.generation,
      id,
      input_digest: inputDigest,
      ambiguous_at: new Date().toISOString(),
      error: cloneError(error),
    };
    await this.append([record], signal);
    this.replaceOperation({
      ...operation,
      status: "ambiguous",
      error: cloneError(error),
    });
  }

  async markInterrupted(error: RecoveryError): Promise<void> {
    if (this.state.status !== "running") return;
    const signal = new AbortController().signal;
    await this.append([{
      type: "run.interrupted",
      generation: this.generation,
      interrupted_at: new Date().toISOString(),
      error: cloneError(error),
    }], signal);
    this.state = { ...this.state, status: "interrupted", error: cloneError(error) };
  }

  async markFailed(error: RecoveryError): Promise<void> {
    if (this.state.status !== "running") return;
    const signal = new AbortController().signal;
    await this.append([{
      type: "run.failed",
      generation: this.generation,
      failed_at: new Date().toISOString(),
      error: cloneError(error),
    }], signal);
    this.state = { ...this.state, status: "failed", error: cloneError(error) };
  }

  async markCompleted(output: VmArgument, signal: AbortSignal): Promise<void> {
    this.assertRunning();
    const cloned = cloneRecoveryValue(output);
    await this.append([{
      type: "run.completed",
      generation: this.generation,
      completed_at: new Date().toISOString(),
      output: cloned,
    }], signal);
    const { error: _error, ...completed } = this.state;
    this.state = { ...completed, status: "completed", output: cloned };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await Promise.all([...this.operationTransitions.values()]);
      await this.queue;
      this.assertHealthy();
    } finally {
      await this.writerLease?.release();
      activeRuns.delete(this.lease);
    }
  }

  private async append(records: readonly RecoveryRecord[], signal: AbortSignal): Promise<void> {
    this.assertHealthy();
    const current = this.queue.then(async () => {
      this.assertHealthy();
      throwIfAborted(signal);
      await this.store.appendRun(this.runId, records, signal);
    });
    this.queue = current.catch((error) => {
      this.failure ??= error;
    });
    try {
      await current;
    } catch (error) {
      this.failure ??= error;
      throw normalizeRecoveryError(
        error,
        "RECOVERY_STATE_SAVE_FAILED",
        `Failed to save recovery state for '${this.runId}'`,
      );
    }
  }

  private replaceOperation(operation: RecoveryOperationState): void {
    const operations = new Map(this.state.operations);
    operations.set(operation.descriptor.id, operation);
    this.state = { ...this.state, operations };
  }

  private async withOperationTransition<T>(id: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.operationTransitions.get(id) ?? Promise.resolve();
    const current = previous.then(transition);
    const settled = current.then(() => undefined, () => undefined);
    this.operationTransitions.set(id, settled);
    try {
      return await current;
    } finally {
      if (this.operationTransitions.get(id) === settled) this.operationTransitions.delete(id);
    }
  }

  private requireOperation(id: string, inputDigest: string): RecoveryOperationState {
    const operation = this.state.operations.get(id);
    if (operation === undefined) throw invalidState(`Operation '${id}' was not prepared`);
    if (operation.descriptor.inputDigest !== inputDigest) {
      throw invalidState(`Operation '${id}' input does not match its durable record`);
    }
    return operation;
  }

  private assertRunning(): void {
    this.assertHealthy();
    if (this.state.status !== "running") {
      throw invalidState(`Run '${this.runId}' is ${this.state.status}, not running`);
    }
  }

  private assertHealthy(): void {
    if (this.failure !== undefined) {
      throw normalizeRecoveryError(
        this.failure,
        "RECOVERY_STATE_SAVE_FAILED",
        `Recovery persistence for '${this.runId}' has failed`,
      );
    }
  }
}

export function recoveryOperationId(
  generation: number,
  moduleDigest: string,
  activation: string,
  node: string,
  block: string,
  instruction: number,
  blockVisit: number,
  kind: string,
): string {
  const input = [generation, moduleDigest, activation, node, block, instruction, blockVisit, kind].join("\0");
  return `${kind}:${createHash("sha256").update(input).digest("hex")}`;
}

export function recoveryValueDigest(value: unknown): string {
  const canonical = canonicalJsonValue(value);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function cloneRecoveryValue(value: unknown): VmArgument {
  validateRecoveryValue(value);
  return structuredClone(value) as VmArgument;
}

function createDescriptor(request: OpenRecoveryRunRequest, generation: number): RecoveryRunDescriptor {
  const args = request.args.map((value) => cloneRecoveryValue(value));
  return {
    version: 0,
    format: RECOVERY_FORMAT,
    runId: request.runId,
    generation,
    rootModuleDigest: request.rootModuleDigest,
    entry: request.entry,
    args,
    argsDigest: recoveryValueDigest(args),
    executionRoot: request.executionRoot,
    ...(request.bindingFingerprint === undefined ? {} : { bindingFingerprint: request.bindingFingerprint }),
    ...(request.executorFingerprint === undefined ? {} : { executorFingerprint: request.executorFingerprint }),
    startedAt: new Date().toISOString(),
  };
}

function initialState(descriptor: RecoveryRunDescriptor): LoadedRecoveryRun {
  return {
    descriptor: structuredClone(descriptor),
    status: "running",
    resumeAttempt: 0,
    operations: new Map(),
  };
}

function loadRecoveryRun(records: readonly RecoveryRecord[], runId: string): LoadedRecoveryRun {
  let state: LoadedRecoveryRun | undefined;
  for (const record of records) {
    if (record.type === "run.begin") {
      validateDescriptor(record.descriptor);
      if (record.descriptor.runId !== runId) throw invalidState(`Recovery journal belongs to another run`);
      if (state !== undefined) throw invalidState(`Recovery run '${runId}' contains more than one run.begin record`);
      state = initialState(record.descriptor);
      continue;
    }
    if (state === undefined) throw invalidState(`Recovery journal for '${runId}' has no run.begin record`);
    if (record.generation !== state.descriptor.generation) {
      throw invalidState(`Recovery record for '${runId}' has an unexpected generation`);
    }
    if (state.status !== "running" && record.type !== "run.resume") {
      throw invalidState(`Recovery run '${runId}' has a record after terminal state '${state.status}'`);
    }
    switch (record.type) {
      case "run.resume":
        if (state.status !== "interrupted" && state.status !== "running") {
          throw invalidState(`Recovery run '${runId}' cannot resume from ${state.status}`);
        }
        if (record.attempt !== state.resumeAttempt + 1) {
          throw invalidState(`Recovery run '${runId}' has a non-monotonic resume attempt`);
        }
        {
          const { error: _error, ...resumed } = state;
          state = { ...resumed, status: "running", resumeAttempt: record.attempt };
        }
        break;
      case "operation.prepared": {
        if (state.status !== "running") throw invalidState(`Operation was prepared while run '${runId}' was not running`);
        validateOperationDescriptor(record.operation);
        const existing = state.operations.get(record.operation.id);
        if (existing !== undefined) throw invalidState(`Operation '${record.operation.id}' was prepared twice`);
        const operations = new Map(state.operations);
        operations.set(record.operation.id, { descriptor: record.operation, status: "prepared" });
        state = { ...state, operations };
        break;
      }
      case "operation.interrupted": {
        const operation = requireLoadedOperation(state, record.id, record.input_digest);
        if (operation.status === "completed") throw invalidState(`Completed operation '${record.id}' was interrupted`);
        const operations = new Map(state.operations);
        operations.set(record.id, {
          ...operation,
          status: "interrupted",
          error: cloneError(record.error),
        });
        state = { ...state, operations };
        break;
      }
      case "operation.ambiguous": {
        const operation = requireLoadedOperation(state, record.id, record.input_digest);
        if (operation.status === "completed") throw invalidState(`Completed operation '${record.id}' became ambiguous`);
        const operations = new Map(state.operations);
        operations.set(record.id, {
          ...operation,
          status: "ambiguous",
          error: cloneError(record.error),
        });
        state = { ...state, operations };
        break;
      }
      case "operation.completed": {
        const operation = requireLoadedOperation(state, record.id, record.input_digest);
        const result = cloneRecoveryValue(record.result);
        const details = record.details === undefined ? undefined : cloneComputeValue(record.details);
        if (operation.status === "ambiguous") {
          throw invalidState(`Ambiguous operation '${record.id}' has an ordinary completion record`);
        }
        if (operation.status === "completed" && (
          recoveryValueDigest(operation.result!) !== recoveryValueDigest(result) ||
          recoveryValueDigest(operation.completedDetails ?? null) !== recoveryValueDigest(details ?? null)
        )) {
          throw invalidState(`Operation '${record.id}' has conflicting completion records`);
        }
        const operations = new Map(state.operations);
        operations.set(record.id, {
          descriptor: operation.descriptor,
          status: "completed",
          result,
          ...(operation.progressDetails === undefined ? {} : {
            progressDetails: cloneComputeValue(operation.progressDetails),
          }),
          ...(details === undefined ? {} : { completedDetails: details }),
        });
        state = { ...state, operations };
        break;
      }
      case "operation.progress": {
        const operation = requireLoadedOperation(state, record.id, record.input_digest);
        if (operation.status === "completed") {
          throw invalidState(`Completed operation '${record.id}' published progress`);
        }
        const details = cloneComputeValue(record.details);
        const operations = new Map(state.operations);
        operations.set(record.id, { ...operation, progressDetails: details });
        state = { ...state, operations };
        break;
      }
      case "run.interrupted":
        if (state.status !== "running") throw invalidState(`Recovery run '${runId}' was interrupted from ${state.status}`);
        state = { ...state, status: "interrupted", error: cloneError(record.error) };
        break;
      case "run.failed":
        if (state.status !== "running") throw invalidState(`Recovery run '${runId}' failed from ${state.status}`);
        state = { ...state, status: "failed", error: cloneError(record.error) };
        break;
      case "run.completed":
        if (state.status !== "running") throw invalidState(`Recovery run '${runId}' completed from ${state.status}`);
        {
          const { error: _error, ...completed } = state;
          state = { ...completed, status: "completed", output: cloneRecoveryValue(record.output) };
        }
        break;
    }
  }
    if (state === undefined) throw invalidState(`Recovery journal for '${runId}' is empty`);
    return state;
}

function requireLoadedOperation(
  state: LoadedRecoveryRun,
  id: string,
  inputDigest: string,
): RecoveryOperationState {
  const operation = state.operations.get(id);
  if (operation === undefined) throw invalidState(`Operation '${id}' has no prepare record`);
  if (operation.descriptor.inputDigest !== inputDigest) {
    throw invalidState(`Operation '${id}' completion has a different input digest`);
  }
  return operation;
}

function assertCompatible(descriptor: RecoveryRunDescriptor, request: OpenRecoveryRunRequest): void {
  if (descriptor.rootModuleDigest !== request.rootModuleDigest || descriptor.entry !== request.entry ||
      descriptor.argsDigest !== recoveryValueDigest(request.args) || descriptor.executionRoot !== request.executionRoot) {
    throw new AflVmError(
      "RECOVERY_RUN_INCOMPATIBLE",
      `Run '${request.runId}' recovery state is incompatible with this module, entry, arguments, or execution root`,
    );
  }
  if (descriptor.bindingFingerprint !== request.bindingFingerprint) {
    throw new AflVmError(
      "RECOVERY_RUN_INCOMPATIBLE",
      `Run '${request.runId}' recovery state belongs to a different binding identity`,
    );
  }
  if (descriptor.executorFingerprint !== request.executorFingerprint) {
    throw new AflVmError(
      "RECOVERY_RUN_INCOMPATIBLE",
      `Run '${request.runId}' recovery state belongs to a different Agent executor identity`,
    );
  }
}

function assertOperationCompatible(
  existing: RecoveryOperationDescriptor,
  requested: RecoveryOperationDescriptor,
): void {
  if (recoveryValueDigest(existing) !== recoveryValueDigest(requested)) {
    throw invalidState(`Operation '${requested.id}' does not match its durable descriptor`);
  }
}

function validateDescriptor(value: RecoveryRunDescriptor): void {
  if (!isRecord(value) || value.version !== 0 || value.format !== RECOVERY_FORMAT ||
      typeof value.runId !== "string" || value.runId.length === 0 ||
      value.generation !== 0 ||
      typeof value.rootModuleDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.rootModuleDigest) ||
      typeof value.entry !== "string" || value.entry.length === 0 || !Array.isArray(value.args) ||
      typeof value.argsDigest !== "string" || typeof value.executionRoot !== "string" ||
      !(value.bindingFingerprint === undefined || typeof value.bindingFingerprint === "string") ||
      !(value.executorFingerprint === undefined || typeof value.executorFingerprint === "string") ||
      typeof value.startedAt !== "string") {
    throw invalidState("Recovery run descriptor is invalid");
  }
  for (const argument of value.args) validateRecoveryValue(argument);
  if (recoveryValueDigest(value.args) !== value.argsDigest) throw invalidState("Recovery argument digest is invalid");
}

function validateOperationDescriptor(value: RecoveryOperationDescriptor): void {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 ||
      typeof value.kind !== "string" || value.kind.length === 0 ||
      typeof value.inputDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.inputDigest) ||
      typeof value.activation !== "string" || typeof value.node !== "string" ||
      typeof value.block !== "string" || !Number.isInteger(value.instruction) || value.instruction < 0 ||
      !Number.isInteger(value.blockVisit) || value.blockVisit < 0) {
    throw invalidState("Recovery operation descriptor is invalid");
  }
  if (value.details !== undefined) cloneComputeValue(value.details);
}

function parseRecoveryRecord(value: unknown, path: string): RecoveryRecord {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidState(`Recovery journal '${path}' contains an invalid record`);
  }
  switch (value.type) {
    case "run.begin": {
      if (!isRecord(value.descriptor)) throw invalidState(`Recovery journal '${path}' has an invalid run.begin`);
      const descriptor = structuredClone(value.descriptor) as unknown as RecoveryRunDescriptor;
      validateDescriptor(descriptor);
      return { type: "run.begin", descriptor };
    }
    case "run.resume":
      requireGeneration(value, path);
      if (!Number.isInteger(value.attempt) || (value.attempt as number) <= 0 || typeof value.resumed_at !== "string") {
        throw invalidState(`Recovery journal '${path}' has an invalid run.resume`);
      }
      return structuredClone(value) as unknown as RecoveryRecord;
    case "operation.prepared":
      requireGeneration(value, path);
      if (!isRecord(value.operation) || typeof value.prepared_at !== "string") {
        throw invalidState(`Recovery journal '${path}' has an invalid operation.prepared`);
      }
      validateOperationDescriptor(value.operation as unknown as RecoveryOperationDescriptor);
      return structuredClone(value) as unknown as RecoveryRecord;
    case "operation.interrupted":
      requireOperationTail(value, path, "interrupted_at");
      validateError(value.error, path);
      return structuredClone(value) as unknown as RecoveryRecord;
    case "operation.ambiguous":
      requireOperationTail(value, path, "ambiguous_at");
      validateError(value.error, path);
      return structuredClone(value) as unknown as RecoveryRecord;
    case "operation.completed":
      requireOperationTail(value, path, "completed_at");
      cloneRecoveryValue(value.result);
      if (value.details !== undefined) cloneComputeValue(value.details);
      return structuredClone(value) as unknown as RecoveryRecord;
    case "operation.progress":
      requireOperationTail(value, path, "updated_at");
      cloneComputeValue(value.details);
      return structuredClone(value) as unknown as RecoveryRecord;
    case "run.interrupted":
    case "run.failed": {
      requireGeneration(value, path);
      const time = value.type === "run.interrupted" ? value.interrupted_at : value.failed_at;
      if (typeof time !== "string") throw invalidState(`Recovery journal '${path}' has an invalid ${value.type}`);
      validateError(value.error, path);
      return structuredClone(value) as unknown as RecoveryRecord;
    }
    case "run.completed":
      requireGeneration(value, path);
      if (typeof value.completed_at !== "string") {
        throw invalidState(`Recovery journal '${path}' has an invalid run.completed`);
      }
      cloneRecoveryValue(value.output);
      return structuredClone(value) as unknown as RecoveryRecord;
    default:
      throw invalidState(`Recovery journal '${path}' contains unknown record '${value.type}'`);
  }
}

function requireGeneration(value: Record<string, unknown>, path: string): void {
  if (!Number.isInteger(value.generation) || (value.generation as number) < 0) {
    throw invalidState(`Recovery journal '${path}' has an invalid generation`);
  }
}

function requireOperationTail(value: Record<string, unknown>, path: string, timeField: string): void {
  requireGeneration(value, path);
  if (typeof value.id !== "string" || typeof value.input_digest !== "string" ||
      typeof value[timeField] !== "string") {
    throw invalidState(`Recovery journal '${path}' has an invalid ${value.type as string}`);
  }
}

function validateError(value: unknown, path: string): asserts value is RecoveryError {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw invalidState(`Recovery journal '${path}' has an invalid error`);
  }
}

function validateRecoveryValue(value: unknown): void {
  validateJsonStructure(value);
  if (!isVmArgument(value)) throw invalidState("Recovery value is not an AFL portable value");
}

function validateJsonStructure(value: unknown): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
      throw invalidState("Recovery value exceeds structural limits");
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw invalidState("Recovery value contains a non-finite number");
      return;
    }
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > MAX_STRING_BYTES) throw invalidState("Recovery string exceeds the size limit");
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!isRecord(item)) throw invalidState("Recovery value contains a non-portable object");
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidState("Recovery value contains an unsupported object prototype");
    }
    for (const child of Object.values(item)) {
      if (child === undefined) throw invalidState("Recovery value contains undefined");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function isVmArgument(value: unknown): value is VmArgument {
  if (isFrag(value) || isSymbol(value)) return true;
  return isCompute(value);
}

function isFrag(value: unknown): value is Frag {
  return isRecord(value) && value.kind === "frag" && typeof value.content === "string" &&
    (value.output === "reasoning" || value.output === "formatted") && Object.keys(value).length === 3;
}

function isSymbol(value: unknown): value is SymbolRef {
  return isRecord(value) && value.kind === "symbol" && typeof value.name === "string" &&
    value.name.startsWith("@") && Object.keys(value).length === 2;
}

function isCompute(value: unknown): value is ComputeValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCompute);
  return isRecord(value) && Object.values(value).every(isCompute);
}

function cloneComputeValue(value: unknown): ComputeValue {
  validateJsonStructure(value);
  if (!isCompute(value)) throw invalidState("Recovery details must be compute data");
  return structuredClone(value) as ComputeValue;
}

function canonicalJsonValue(value: unknown): unknown {
  validateJsonStructure(value);
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return canonical(value);
}

function cloneOperation(value: RecoveryOperationState): RecoveryOperationState {
  return {
    descriptor: structuredClone(value.descriptor),
    status: value.status,
    ...(value.result === undefined ? {} : { result: cloneRecoveryValue(value.result) }),
    ...(value.progressDetails === undefined ? {} : { progressDetails: cloneComputeValue(value.progressDetails) }),
    ...(value.completedDetails === undefined ? {} : { completedDetails: cloneComputeValue(value.completedDetails) }),
    ...(value.error === undefined ? {} : { error: cloneError(value.error) }),
  };
}

function cloneError(error: RecoveryError): RecoveryError {
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    throw invalidState("Recovery error is invalid");
  }
  return { code: error.code, message: error.message };
}

async function resolveStore(
  binding: RecoveryPersistenceBinding | undefined,
  executionRoot: string,
): Promise<RecoveryStateStore> {
  if (binding?.directory !== undefined && binding.store !== undefined) {
    throw new AflVmError("RECOVERY_BINDING_INVALID", "Recovery binding cannot set both directory and store");
  }
  if (binding?.store !== undefined) return binding.store;
  const configured = binding?.directory ?? join(".afl", "recovery");
  const unresolved = isAbsolute(configured) ? resolve(configured) : resolve(executionRoot, configured);
  return FileRecoveryStateStore.create(await canonicalFuturePath(unresolved));
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

function storeNamespace(store: RecoveryStateStore): string {
  if (store.namespace !== undefined) return store.namespace;
  let id = storeIds.get(store);
  if (id === undefined) {
    nextStoreId += 1;
    id = `custom:${nextStoreId}`;
    storeIds.set(store, id);
  }
  return id;
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
          if (Buffer.byteLength(text.slice(start, end)) > MAX_RECOVERY_RECORD_BYTES) {
            throw invalidState(`JSON stream '${path}' contains an oversized record`);
          }
          if (values.length >= MAX_RECOVERY_RECORDS) {
            throw invalidState(`JSON stream '${path}' exceeds the record-count limit`);
          }
          try {
            values.push(JSON.parse(text.slice(start, end)) as unknown);
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
  if (Buffer.byteLength(content) > MAX_RECOVERY_RECORD_BYTES) {
    throw invalidState(`Recovery record '${path}' exceeds the byte limit`);
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

async function writeInitialRecord(path: string, content: string): Promise<void> {
  try {
    await writeExclusive(path, content);
    return;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  let handle;
  try {
    handle = await open(path, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (error) {
    throw invalidState(`Cannot open recovery journal '${path}' while initializing`, error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidState(`Recovery journal '${path}' is not a regular file`);
    if (metadata.size !== 0) {
      throw invalidState(`Recovery journal '${path}' already contains data while being initialized`);
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw invalidState(`Cannot initialize recovery journal '${path}'`, error);
  } finally {
    await handle.close();
  }
}

async function appendPretty(
  path: string,
  records: readonly RecoveryRecord[],
  signal: AbortSignal,
): Promise<void> {
  if (records.length === 0) return;
  const rendered = records.map((record) => {
    validateJsonStructure(record);
    const content = prettyRecord(record);
    if (Buffer.byteLength(content) > MAX_RECOVERY_RECORD_BYTES) {
      throw invalidState(`Recovery record '${path}' exceeds the byte limit`);
    }
    return content;
  });
  let handle;
  try {
    handle = await open(path, FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (error) {
    throw invalidState(`Cannot open recovery journal '${path}' for append`, error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidState(`Recovery journal '${path}' is not a regular file`);
    const addedBytes = rendered.reduce((total, content) => total + Buffer.byteLength(content), 0);
    if (metadata.size + addedBytes > MAX_RECOVERY_JOURNAL_BYTES) {
      throw invalidState(`Recovery journal '${path}' exceeds the byte limit`);
    }
    for (const content of rendered) {
      throwIfAborted(signal);
      await handle.writeFile(content, "utf8");
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw invalidState(`Cannot append recovery journal '${path}'`, error);
  } finally {
    await handle.close();
  }
}

async function readRecoveryFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw invalidState(`Cannot open recovery journal '${path}'`, error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidState(`Recovery journal '${path}' is not a regular file`);
    if (metadata.size > MAX_RECOVERY_JOURNAL_BYTES) {
      throw invalidState(`Recovery journal '${path}' exceeds the byte limit`);
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw invalidState(`Cannot read recovery journal '${path}'`, error);
  } finally {
    await handle.close();
  }
}

async function truncateRecoveryFile(path: string, length: number): Promise<void> {
  let handle;
  try {
    handle = await open(path, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_NOFOLLOW);
  } catch (error) {
    throw invalidState(`Cannot open recovery journal '${path}' for tail repair`, error);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidState(`Recovery journal '${path}' is not a regular file`);
    await handle.truncate(length);
    await handle.sync();
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw invalidState(`Cannot repair recovery journal '${path}'`, error);
  } finally {
    await handle.close();
  }
}

function normalizeRecoveryError(error: unknown, code: string, message: string): AflVmError {
  if (error instanceof AflVmError && (error.code.startsWith("RECOVERY_") || error.code === code)) return error;
  return new AflVmError(code, message, { cause: error });
}

function invalidState(message: string, cause?: unknown): AflVmError {
  return new AflVmError("RECOVERY_STATE_INVALID", message, cause === undefined ? {} : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
}
