import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { AflVmError } from "./errors.js";
import type { SourceSpan } from "./ir.js";

export interface WorkspaceDescriptor {
  readonly root: string;
  readonly resourceId: string;
}

export interface AgentWorkspaceSet {
  readonly primary: WorkspaceDescriptor;
  readonly readOnly: readonly WorkspaceDescriptor[];
  readonly origin: "default" | "explicit";
}

export async function resolveExecutionRoot(root: string, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const absolute = resolve(root);
  try {
    await mkdir(absolute, { recursive: true });
    throwIfAborted(signal);
    if (!(await stat(absolute)).isDirectory()) {
      throw new AflVmError("EXECUTION_ROOT_INVALID", `Execution root '${absolute}' is not a directory`);
    }
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw new AflVmError("EXECUTION_ROOT_INVALID", `Execution root '${absolute}' is not accessible`, {
      cause: error,
    });
  }
}

export async function resolveAgentWorkspace(
  value: unknown,
  executionRoot: string,
  signal: AbortSignal,
  span?: SourceSpan,
): Promise<AgentWorkspaceSet> {
  if (value === undefined) {
    return workspaceSet(descriptor(executionRoot), [], "default");
  }

  const paths = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : undefined;
  if (paths === undefined || paths.length === 0 || (Array.isArray(value) && paths.length < 2) ||
      paths.some((item) => item.trim().length === 0)) {
    throw new AflVmError(
      "AGENT_WORKSPACE_INVALID",
      "Agent Workspace must be a non-empty path or a list with a primary path and at least one read-only path",
      span === undefined ? {} : { span },
    );
  }

  const primary = await canonicalPrimary(paths[0]!, executionRoot, signal, span);
  const readOnly: WorkspaceDescriptor[] = [];
  for (const path of paths.slice(1)) {
    const canonical = await canonicalReadOnly(path, executionRoot, signal, span);
    if (readOnly.some((item) => item.root === canonical)) {
      throw workspaceError("Agent Workspace contains a duplicate read-only path", span);
    }
    if (pathsOverlap(primary, canonical)) {
      throw workspaceError("Agent primary and read-only Workspaces must not overlap", span);
    }
    readOnly.push(descriptor(canonical));
  }
  return workspaceSet(descriptor(primary), readOnly, "explicit");
}

export function workspacePathOverlap(left: string, right: string): boolean {
  return pathsOverlap(left, right);
}

export function workspaceKey(workspace: AgentWorkspaceSet): string {
  return JSON.stringify([
    workspace.origin,
    ["write", workspace.primary.resourceId],
    ...workspace.readOnly.map((item) => ["read", item.resourceId]),
  ]);
}

function descriptor(root: string): WorkspaceDescriptor {
  return Object.freeze({ root, resourceId: `file:${root}` });
}

function workspaceSet(
  primary: WorkspaceDescriptor,
  readOnly: readonly WorkspaceDescriptor[],
  origin: "default" | "explicit",
): AgentWorkspaceSet {
  return Object.freeze({ primary, readOnly: Object.freeze([...readOnly]), origin });
}

async function canonicalPrimary(
  path: string,
  executionRoot: string,
  signal: AbortSignal,
  span?: SourceSpan,
): Promise<string> {
  const absolute = resolvePath(path, executionRoot);
  throwIfAborted(signal);
  try {
    await mkdir(absolute, { recursive: true });
  } catch (error) {
    throw new AflVmError("AGENT_WORKSPACE_INVALID", `Primary Workspace '${absolute}' cannot be created`, {
      ...(span === undefined ? {} : { span }),
      cause: error,
    });
  }
  return canonicalDirectory(absolute, signal, span);
}

async function canonicalReadOnly(
  path: string,
  executionRoot: string,
  signal: AbortSignal,
  span?: SourceSpan,
): Promise<string> {
  return canonicalDirectory(resolvePath(path, executionRoot), signal, span);
}

async function canonicalDirectory(path: string, signal: AbortSignal, span?: SourceSpan): Promise<string> {
  throwIfAborted(signal);
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw workspaceError(`Workspace path '${path}' is not a directory`, span);
    return await realpath(path);
  } catch (error) {
    if (error instanceof AflVmError) throw error;
    throw new AflVmError("AGENT_WORKSPACE_INVALID", `Workspace path '${path}' is not accessible`, {
      ...(span === undefined ? {} : { span }),
      cause: error,
    });
  }
}

function resolvePath(path: string, executionRoot: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(executionRoot, path);
}

function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return isWithin(fromLeft) || isWithin(fromRight);
}

function isWithin(path: string): boolean {
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

function workspaceError(message: string, span?: SourceSpan): AflVmError {
  return new AflVmError("AGENT_WORKSPACE_INVALID", message, span === undefined ? {} : { span });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new AflVmError("RUN_ABORTED", "AFL run was aborted");
}
