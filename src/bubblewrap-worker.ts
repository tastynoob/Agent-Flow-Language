import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, writeSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

interface WorkerRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface WorkerCancel {
  readonly cancel: number;
}

interface WorkerError {
  readonly kind: "file" | "execution" | "sandbox";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

const active = new Map<number, AbortController>();
const children = new Set<ChildProcess>();
// Explicit fd streams also work in hosts where Node cannot classify inherited pipe handles.
const inputStream = createReadStream("/dev/stdin", { fd: 0, autoClose: false });
const input = createInterface({ input: inputStream, crlfDelay: Infinity });

input.on("line", (line) => {
  let message: WorkerRequest | WorkerCancel;
  try {
    message = JSON.parse(line) as WorkerRequest | WorkerCancel;
  } catch {
    return;
  }
  if ("cancel" in message) {
    active.get(message.cancel)?.abort();
    return;
  }
  if (!Number.isInteger(message.id) || typeof message.method !== "string") return;
  const controller = new AbortController();
  active.set(message.id, controller);
  void dispatch(message.id, message.method, message.params, controller.signal).then(
    (value) => send({ id: message.id, ok: true, value }),
    (error) => send({ id: message.id, ok: false, error: normalizeError(error) }),
  ).finally(() => active.delete(message.id));
});

input.on("close", () => shutdown());
inputStream.on("error", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

async function dispatch(id: number, method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
  const params = record(raw);
  switch (method) {
    case "ping": return { pid: process.pid };
    case "absolutePath": return resolvePath(string(params.path, "path"));
    case "joinPath": return join(...stringArray(params.parts, "parts"));
    case "readTextFile": return readFile(resolvePath(string(params.path, "path")), { encoding: "utf8", signal });
    case "readTextLines": return readTextLines(params, signal);
    case "readBinaryFile": {
      const content = await readFile(resolvePath(string(params.path, "path")), { signal });
      return { encoding: "base64", data: content.toString("base64") };
    }
    case "writeFile": {
      const path = resolvePath(string(params.path, "path"));
      await mkdir(resolve(path, ".."), { recursive: true });
      throwIfAborted(signal);
      await writeFile(path, decodeContent(params.content), { signal });
      return null;
    }
    case "appendFile": {
      const path = resolvePath(string(params.path, "path"));
      await mkdir(resolve(path, ".."), { recursive: true });
      throwIfAborted(signal);
      await appendFile(path, decodeContent(params.content));
      throwIfAborted(signal);
      return null;
    }
    case "fileInfo": return fileInfo(resolvePath(string(params.path, "path")));
    case "listDir": return listDir(resolvePath(string(params.path, "path")), signal);
    case "canonicalPath": return realpath(resolvePath(string(params.path, "path")));
    case "exists": return exists(resolvePath(string(params.path, "path")));
    case "createDir": {
      const path = resolvePath(string(params.path, "path"));
      await mkdir(path, { recursive: optionalBoolean(params.recursive, true) });
      return null;
    }
    case "remove": {
      const path = resolvePath(string(params.path, "path"));
      await rm(path, {
        recursive: optionalBoolean(params.recursive, false),
        force: optionalBoolean(params.force, false),
      });
      return null;
    }
    case "createTempDir": return mkdtemp(join(tmpdir(), optionalString(params.prefix) ?? "tmp-"));
    case "createTempFile": {
      const dir = await mkdtemp(join(tmpdir(), "tmp-"));
      const path = join(
        dir,
        `${optionalString(params.prefix) ?? ""}${randomUUID()}${optionalString(params.suffix) ?? ""}`,
      );
      await writeFile(path, "");
      return path;
    }
    case "exec": return execute(id, params, signal);
    case "cleanup": {
      for (const child of children) killChild(child);
      children.clear();
      return null;
    }
    case "shutdown": {
      queueMicrotask(shutdown);
      return null;
    }
    default: throw sandboxError("invalid_request", `Unknown sandbox method '${method}'`);
  }
}

async function readTextLines(params: Record<string, unknown>, signal: AbortSignal): Promise<string[]> {
  const path = resolvePath(string(params.path, "path"));
  const maxLines = optionalPositiveInteger(params.maxLines);
  if (maxLines === 0) return [];
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  try {
    for await (const line of reader) {
      throwIfAborted(signal);
      lines.push(line);
      if (maxLines !== undefined && lines.length >= maxLines) break;
    }
    return lines;
  } finally {
    reader.close();
    stream.destroy();
  }
}

async function fileInfo(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  const kind = info.isFile()
    ? "file"
    : info.isDirectory()
    ? "directory"
    : info.isSymbolicLink()
    ? "symlink"
    : undefined;
  if (kind === undefined) throw fileError("invalid", "Unsupported file type", path);
  return {
    name: path.replace(/\/+$/u, "").split("/").at(-1) ?? path,
    path,
    kind,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

async function listDir(path: string, signal: AbortSignal): Promise<unknown[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const values: unknown[] = [];
  for (const entry of entries) {
    throwIfAborted(signal);
    values.push(await fileInfo(resolve(path, entry.name)));
  }
  return values;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function execute(
  requestId: number,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const command = string(params.command, "command");
  const cwd = resolvePath(optionalString(params.cwd) ?? "/workspace");
  const timeout = optionalNumber(params.timeout);
  const environment = stringRecord(params.env, "env");
  const inheritEnv = optionalBoolean(params.inheritEnv, true);
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    let stdout = "";
    let stderr = "";
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      children.delete(child);
      callback();
    };
    const onAbort = () => killChild(child);
    try {
      child = spawn("/bin/bash", ["-c", command], {
        cwd,
        detached: true,
        env: inheritEnv ? { ...process.env, ...environment } : environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
    } catch (error) {
      reject(executionError("spawn_error", errorMessage(error)));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (timeout !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, timeout * 1_000);
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      send({ id: requestId, event: "stdout", chunk });
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      send({ id: requestId, event: "stderr", chunk });
    });
    child.once("error", (error) => finish(() => reject(executionError("spawn_error", error.message))));
    child.once("close", (code) => finish(() => {
      if (signal.aborted) {
        reject(executionError("aborted", "Operation aborted"));
      } else if (timedOut) {
        reject(executionError("timeout", `Command timed out after ${timeout} seconds`));
      } else {
        resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
      }
    }));
  });
}

function resolvePath(path: string): string {
  if (path === "~") return "/home/afl";
  if (path.startsWith("~/")) return resolve("/home/afl", path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve("/workspace", path);
}

function decodeContent(value: unknown): string | Uint8Array {
  if (typeof value === "string") return value;
  const encoded = record(value);
  if (encoded.encoding !== "base64" || typeof encoded.data !== "string") {
    throw sandboxError("invalid_request", "file content is invalid");
  }
  return Buffer.from(encoded.data, "base64");
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw sandboxError("invalid_request", "sandbox request params must be a record");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw sandboxError("invalid_request", `'${field}' must be a string`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw sandboxError("invalid_request", `'${field}' must be a string list`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const candidate = record(value);
  if (!Object.values(candidate).every((item) => typeof item === "string")) {
    throw sandboxError("invalid_request", `'${field}' must contain string values`);
  }
  return candidate as Record<string, string>;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return string(value, "value");
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw sandboxError("invalid_request", "value must be boolean");
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw sandboxError("invalid_request", "timeout must be a positive number");
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw sandboxError("invalid_request", "maxLines must be a non-negative integer");
  }
  return value as number;
}

function normalizeError(error: unknown): WorkerError {
  if (isWorkerError(error)) return error;
  const code = nodeCode(error);
  const path = nodePath(error);
  if (code !== undefined) {
    const mapped = code === "ENOENT"
      ? "not_found"
      : code === "EACCES" || code === "EPERM" || code === "EROFS"
      ? "permission_denied"
      : code === "ENOTDIR"
      ? "not_directory"
      : code === "EISDIR"
      ? "is_directory"
      : code === "ABORT_ERR"
      ? "aborted"
      : code === "EINVAL"
      ? "invalid"
      : "unknown";
    return fileError(mapped, errorMessage(error), path);
  }
  return sandboxError("unknown", errorMessage(error));
}

function fileError(code: string, message: string, path?: string): WorkerError {
  return { kind: "file", code, message, ...(path === undefined ? {} : { path }) };
}

function executionError(code: string, message: string): WorkerError {
  return { kind: "execution", code, message };
}

function sandboxError(code: string, message: string): WorkerError {
  return { kind: "sandbox", code, message };
}

function isWorkerError(value: unknown): value is WorkerError {
  return typeof value === "object" && value !== null &&
    "kind" in value && "code" in value && "message" in value;
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function nodePath(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "path" in error && typeof error.path === "string"
    ? error.path
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw fileError("aborted", "Operation aborted");
}

function killChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function send(message: unknown): void {
  writeSync(1, `${JSON.stringify(message)}\n`);
}

function shutdown(): void {
  for (const controller of active.values()) controller.abort();
  for (const child of children) killChild(child);
  children.clear();
  process.exit(0);
}
