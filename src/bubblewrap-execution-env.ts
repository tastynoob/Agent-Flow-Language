import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ExecutionError,
  FileError,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";

import { AgentExecutorError } from "./agent-executor.js";
import type { AgentWorkspaceSet } from "./workspace.js";

export interface BubblewrapExecutionEnvOptions {
  readonly workspace: AgentWorkspaceSet;
  readonly network?: "none" | "host";
  readonly executable?: string;
  readonly startupTimeoutMs?: number;
  readonly maxMessageBytes?: number;
}

interface RpcWorkerError {
  readonly kind: "file" | "execution" | "sandbox";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

interface RpcResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: RpcWorkerError;
}

interface RpcEvent {
  readonly id: number;
  readonly event: "stdout" | "stderr";
  readonly chunk: string;
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  readonly onStdout: ((chunk: string) => void) | undefined;
  readonly onStderr: ((chunk: string) => void) | undefined;
}

const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const FILE_ERROR_CODES = new Set<FileErrorCode>([
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown",
]);

export class BubblewrapExecutionEnv implements ExecutionEnv {
  readonly cwd = "/workspace";
  readonly readOnlyRoots: readonly string[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxMessageBytes: number;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly stderr: string[] = [];
  private stdoutBuffer = "";
  private nextId = 0;
  private unrefTask: ReturnType<typeof setImmediate> | undefined;
  private terminalError: Error | undefined;
  private disposed = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    readOnlyRoots: readonly string[],
    maxMessageBytes: number,
  ) {
    this.child = child;
    this.readOnlyRoots = Object.freeze([...readOnlyRoots]);
    this.maxMessageBytes = maxMessageBytes;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.captureStderr(chunk));
    child.once("error", (error) => this.failWorker(error));
    child.once("exit", (code, signal) => {
      this.failWorker(new Error(
        `bubblewrap worker exited${code === null ? "" : ` with code ${code}`}` +
        `${signal === null ? "" : ` from ${signal}`}${this.stderrText()}`,
      ));
    });
  }

  static async create(options: BubblewrapExecutionEnvOptions): Promise<BubblewrapExecutionEnv> {
    if (process.platform !== "linux") {
      throw new AgentExecutorError(
        "AGENT_SANDBOX_UNAVAILABLE",
        "The bubblewrap sandbox is only available on Linux",
      );
    }
    const timeout = options.startupTimeoutMs ?? 5_000;
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new TypeError("bubblewrap startupTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes <= 0) {
      throw new TypeError("bubblewrap maxMessageBytes must be a positive integer");
    }
    const workerPath = fileURLToPath(new URL("./bubblewrap-worker.js", import.meta.url));
    const args = bubblewrapArgs(options, workerPath);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable ?? "/usr/bin/bwrap", args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new AgentExecutorError(
        "AGENT_SANDBOX_INIT_FAILED",
        "Failed to spawn bubblewrap",
        { cause: error },
      );
    }
    const env = new BubblewrapExecutionEnv(
      child,
      options.workspace.readOnly.map((_item, index) => `/readonly/${index}`),
      maxMessageBytes,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("sandbox startup timed out")), timeout);
    try {
      await env.rpc("ping", {}, controller.signal);
      return env;
    } catch (error) {
      await env.cleanup();
      throw new AgentExecutorError(
        "AGENT_SANDBOX_INIT_FAILED",
        `Bubblewrap sandbox failed to initialize${env.stderrText()}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileRpc("absolutePath", { path }, abortSignal, path);
  }

  joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileRpc("joinPath", { parts }, abortSignal);
  }

  readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileRpc("readTextFile", { path }, abortSignal, path);
  }

  readTextLines(
    path: string,
    options?: { readonly maxLines?: number; readonly abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    return this.fileRpc("readTextLines", {
      path,
      ...(options?.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    }, options?.abortSignal, path);
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    const result = await this.fileRpc<{ readonly encoding: string; readonly data: string }>(
      "readBinaryFile",
      { path },
      abortSignal,
      path,
    );
    if (!result.ok) return result;
    if (result.value.encoding !== "base64" || typeof result.value.data !== "string") {
      return errorResult(new FileError("unknown", "Sandbox returned invalid binary content", path));
    }
    return valueResult(Buffer.from(result.value.data, "base64"));
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return this.voidFileRpc("writeFile", { path, content: encodeContent(content) }, abortSignal, path);
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    return this.voidFileRpc("appendFile", { path, content: encodeContent(content) }, abortSignal, path);
  }

  fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
    return this.fileRpc("fileInfo", { path }, abortSignal, path);
  }

  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    return this.fileRpc("listDir", { path }, abortSignal, path);
  }

  canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileRpc("canonicalPath", { path }, abortSignal, path);
  }

  exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
    return this.fileRpc("exists", { path }, abortSignal, path);
  }

  createDir(
    path: string,
    options?: { readonly recursive?: boolean; readonly abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    return this.voidFileRpc("createDir", {
      path,
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
    }, options?.abortSignal, path);
  }

  remove(
    path: string,
    options?: { readonly recursive?: boolean; readonly force?: boolean; readonly abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    return this.voidFileRpc("remove", {
      path,
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      ...(options?.force === undefined ? {} : { force: options.force }),
    }, options?.abortSignal, path);
  }

  createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    return this.fileRpc("createTempDir", {
      ...(prefix === undefined ? {} : { prefix }),
    }, abortSignal);
  }

  createTempFile(
    options?: { readonly prefix?: string; readonly suffix?: string; readonly abortSignal?: AbortSignal },
  ): Promise<Result<string, FileError>> {
    return this.fileRpc("createTempFile", {
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options?.suffix === undefined ? {} : { suffix: options.suffix }),
    }, options?.abortSignal);
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options?.abortSignal?.aborted) {
      return errorResult(new ExecutionError("aborted", "Operation aborted"));
    }
    try {
      const value = await this.rpc("exec", {
        command,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      }, options?.abortSignal, options?.onStdout, options?.onStderr);
      if (!isExecResult(value)) throw new Error("Sandbox returned an invalid execution result");
      return valueResult(value);
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        return errorResult(new ExecutionError("aborted", "Operation aborted",
          error instanceof Error ? error : undefined));
      }
      return errorResult(toExecutionError(error));
    }
  }

  async cleanup(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unrefTask !== undefined) clearImmediate(this.unrefTask);
    this.failWorker(new Error("Bubblewrap execution environment was closed"));
    try {
      this.child.stdin.end();
    } catch {
      // Best-effort cleanup.
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup.
    }
  }

  private async fileRpc<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    path?: string,
  ): Promise<Result<T, FileError>> {
    if (signal?.aborted) return errorResult(new FileError("aborted", "Operation aborted", path));
    try {
      return valueResult(await this.rpc(method, params, signal) as T);
    } catch (error) {
      if (signal?.aborted) {
        return errorResult(new FileError("aborted", "Operation aborted", path,
          error instanceof Error ? error : undefined));
      }
      return errorResult(toFileError(error, path));
    }
  }

  private async voidFileRpc(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    path?: string,
  ): Promise<Result<void, FileError>> {
    const result = await this.fileRpc<unknown>(method, params, signal, path);
    return result.ok ? valueResult(undefined) : result;
  }

  private rpc(
    method: string,
    params: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Bubblewrap execution environment is closed"));
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError);
    if (signal?.aborted) return Promise.reject(abortedError(signal));
    this.nextId += 1;
    const id = this.nextId;
    let serialized: string;
    try {
      serialized = `${JSON.stringify({ id, method, params })}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    if (Buffer.byteLength(serialized) > this.maxMessageBytes) {
      return Promise.reject(new Error(`Sandbox request exceeds ${this.maxMessageBytes} bytes`));
    }
    this.refWorker();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.sendCancel(id);
        this.settle(id, () => reject(abortedError(signal!)));
      };
      this.pending.set(id, { resolve, reject, signal, onAbort, onStdout, onStderr });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child.stdin.write(serialized, "utf8", (error) => {
        if (error !== null && error !== undefined) this.failWorker(error);
      });
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxMessageBytes) {
      this.failWorker(new Error(`Sandbox response exceeds ${this.maxMessageBytes} bytes`));
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    let message: RpcResponse | RpcEvent;
    try {
      message = JSON.parse(line) as RpcResponse | RpcEvent;
    } catch (error) {
      this.failWorker(new Error("Sandbox returned malformed JSON", { cause: error }));
      return;
    }
    if (!Number.isInteger(message.id)) {
      this.failWorker(new Error("Sandbox returned a response without a valid id"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    if ("event" in message) {
      if (typeof message.chunk !== "string") {
        this.failWorker(new Error("Sandbox returned an invalid stream event"));
        return;
      }
      const callback = message.event === "stdout" ? pending.onStdout : pending.onStderr;
      try {
        callback?.(message.chunk);
      } catch (error) {
        this.sendCancel(message.id);
        this.settle(message.id, () => pending.reject(new ExecutionError(
          "callback_error",
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error : undefined,
        )));
      }
      return;
    }
    this.settle(message.id, () => {
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new SandboxRpcError(message.error ?? {
        kind: "sandbox",
        code: "unknown",
        message: "Sandbox request failed without an error",
      }));
    });
  }

  private settle(id: number, complete: () => void): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    complete();
    if (this.pending.size === 0) this.scheduleUnref();
  }

  private sendCancel(id: number): void {
    if (this.disposed || this.terminalError !== undefined) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ cancel: id })}\n`);
    } catch {
      // Worker failure is reported through the original request.
    }
  }

  private captureStderr(chunk: string): void {
    this.stderr.push(chunk);
    let size = this.stderr.reduce((total, item) => total + Buffer.byteLength(item), 0);
    while (size > 8_192 && this.stderr.length > 1) {
      size -= Buffer.byteLength(this.stderr.shift()!);
    }
  }

  private stderrText(): string {
    const value = this.stderr.join("").trim();
    return value.length === 0 ? "" : `: ${value}`;
  }

  private failWorker(error: Error): void {
    if (this.terminalError === undefined) this.terminalError = error;
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id)!;
      this.settle(id, () => pending.reject(this.terminalError));
    }
  }

  private refWorker(): void {
    if (this.unrefTask !== undefined) {
      clearImmediate(this.unrefTask);
      this.unrefTask = undefined;
    }
    this.child.ref();
    refHandle(this.child.stdin);
    refHandle(this.child.stdout);
    refHandle(this.child.stderr);
  }

  private scheduleUnref(): void {
    if (this.unrefTask !== undefined || this.disposed) return;
    this.unrefTask = setImmediate(() => {
      this.unrefTask = undefined;
      if (this.pending.size === 0 && !this.disposed) this.unrefWorker();
    });
  }

  private unrefWorker(): void {
    this.child.unref();
    unrefHandle(this.child.stdin);
    unrefHandle(this.child.stdout);
    unrefHandle(this.child.stderr);
  }
}

class SandboxRpcError extends Error {
  readonly worker: RpcWorkerError;

  constructor(worker: RpcWorkerError) {
    super(worker.message);
    this.name = "SandboxRpcError";
    this.worker = worker;
  }
}

function bubblewrapArgs(options: BubblewrapExecutionEnvOptions, workerPath: string): string[] {
  const network = options.network ?? "none";
  if (network !== "none" && network !== "host") {
    throw new TypeError("bubblewrap network must be 'none' or 'host'");
  }
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(network === "host" ? ["--share-net"] : []),
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    "--cap-drop", "ALL",
    "--hostname", "afl-sandbox",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/home",
    "--dir", "/home/afl",
    "--dir", "/workspace",
    "--bind", options.workspace.primary.root, "/workspace",
    "--tmpfs", "/workspace/.afl",
    "--dir", "/readonly",
  ];
  for (const [index, item] of options.workspace.readOnly.entries()) {
    const destination = `/readonly/${index}`;
    args.push("--dir", destination, "--ro-bind", item.root, destination);
  }
  args.push(
    "--dir", "/opt",
    "--dir", "/opt/afl",
    "--ro-bind", process.execPath, "/opt/afl/node",
    "--ro-bind", workerPath, "/opt/afl/bubblewrap-worker.mjs",
    "--dir", "/etc",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
  );
  if (network === "host") {
    args.push(
      "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
      "--ro-bind-try", "/etc/hosts", "/etc/hosts",
      "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    );
  }
  args.push(
    "--clearenv",
    "--setenv", "HOME", "/home/afl",
    "--setenv", "USER", "afl",
    "--setenv", "LOGNAME", "afl",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
    "--chdir", "/workspace",
    "--",
    "/opt/afl/node", "/opt/afl/bubblewrap-worker.mjs",
  );
  return args;
}

function encodeContent(content: string | Uint8Array): string | { readonly encoding: "base64"; readonly data: string } {
  return typeof content === "string"
    ? content
    : { encoding: "base64", data: Buffer.from(content).toString("base64") };
}

function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  if (error instanceof SandboxRpcError && error.worker.kind === "file") {
    const code = FILE_ERROR_CODES.has(error.worker.code as FileErrorCode)
      ? error.worker.code as FileErrorCode
      : "unknown";
    return new FileError(code, error.worker.message, error.worker.path ?? path, error);
  }
  return new FileError("unknown", error instanceof Error ? error.message : String(error), path,
    error instanceof Error ? error : undefined);
}

function toExecutionError(error: unknown): ExecutionError {
  if (error instanceof ExecutionError) return error;
  if (error instanceof SandboxRpcError && error.worker.kind === "execution") {
    const code = error.worker.code === "aborted" || error.worker.code === "timeout" ||
      error.worker.code === "shell_unavailable" || error.worker.code === "spawn_error" ||
      error.worker.code === "callback_error"
      ? error.worker.code
      : "unknown";
    return new ExecutionError(code, error.worker.message, error);
  }
  return new ExecutionError("unknown", error instanceof Error ? error.message : String(error),
    error instanceof Error ? error : undefined);
}

function isExecResult(value: unknown): value is { stdout: string; stderr: string; exitCode: number } {
  return typeof value === "object" && value !== null &&
    "stdout" in value && typeof value.stdout === "string" &&
    "stderr" in value && typeof value.stderr === "string" &&
    "exitCode" in value && typeof value.exitCode === "number" && Number.isInteger(value.exitCode);
}

function valueResult<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function errorResult<T>(error: T): Result<never, T> {
  return { ok: false, error };
}

function abortedError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function refHandle(handle: unknown): void {
  if (typeof handle === "object" && handle !== null && "ref" in handle && typeof handle.ref === "function") {
    handle.ref();
  }
}

function unrefHandle(handle: unknown): void {
  if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") {
    handle.unref();
  }
}
