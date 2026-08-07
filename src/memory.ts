import { createHash } from "node:crypto";

import type { AflModule, SymbolRef } from "./ir.js";

export const AFL_MESSAGE_ROLE_SCHEMA = "afl.message-role/v0";

export interface Message {
  readonly role: string;
  readonly content: string;
}

export interface AgentMemoryCapabilities {
  readonly roleSchemas: readonly string[];
  readonly importRoles: readonly string[];
}

export interface AgentMemoryContract {
  readonly capabilities: AgentMemoryCapabilities;
  validateImport(
    agent: SymbolRef,
    roleSchema: string,
    messages: readonly Message[],
  ): void | Promise<void>;
}

export interface BackendSessionState {
  readonly backend: string;
  readonly format: string;
  readonly payload: unknown;
}

export interface BackendSessionRecord {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface BackendSessionJournalPayload {
  readonly version: 0;
  readonly records: readonly BackendSessionRecord[];
}

export interface BackendSessionJournalDelta {
  readonly backend: string;
  readonly format: string;
  readonly baseRecordCount: number;
  readonly records: readonly BackendSessionRecord[];
}

export interface PersistedMemoryContinuation {
  readonly memoryRevision: number;
  readonly state: BackendSessionState;
}

export interface PersistedMemorySlot {
  readonly moduleDigest: string;
  readonly messages: readonly Message[];
  readonly revision: number;
  readonly continuation?: PersistedMemoryContinuation;
  readonly base?: PersistedMemoryBase;
}

export interface PersistedMemoryBase {
  readonly slot: string;
  readonly revision: number;
}

export interface PersistedRunMemoryState {
  readonly version: 0;
  readonly format: "afl.memory-run";
  readonly roleSchema: typeof AFL_MESSAGE_ROLE_SCHEMA;
  readonly runId: string;
  readonly rootModuleDigest: string;
  readonly memories: Readonly<Record<string, PersistedMemorySlot>>;
}

export interface MemoryStateStore {
  loadRun(runId: string, signal: AbortSignal): Promise<PersistedRunMemoryState | undefined>;
  saveRun(
    state: PersistedRunMemoryState,
    signal: AbortSignal,
    context?: MemorySaveContext,
  ): Promise<void>;
  beginMemoryDo?(request: MemoryDoBeginRequest, signal: AbortSignal): Promise<void>;
  appendMemoryContinuation?(request: MemoryContinuationAppendRequest, signal: AbortSignal): Promise<void>;
  endMemoryDo?(request: MemoryDoEndRequest, signal: AbortSignal): Promise<void>;
}

export interface MemorySaveContext {
  readonly slot: string;
  readonly kind: "materialize" | "append";
}

export interface MemoryDoRequest {
  readonly runId: string;
  readonly slot: string;
  readonly attemptId: string;
}

export interface MemoryDoBeginRequest extends MemoryDoRequest {
  readonly state: PersistedRunMemoryState;
  readonly agent: string;
  readonly executor: string;
  readonly format?: string;
  readonly location: string;
  readonly startedAt: string;
}

export interface MemoryContinuationAppendRequest extends MemoryDoRequest {
  readonly delta: BackendSessionJournalDelta;
}

export interface MemoryDoEndRequest extends MemoryDoRequest {
  readonly state: PersistedRunMemoryState;
  readonly status: "ok" | "error";
  readonly finishedAt: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface MemoryPersistenceBinding {
  readonly directory?: string;
  readonly store?: MemoryStateStore;
}

export function canonicalModuleDigest(module: AflModule): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(module, "module"))).digest("hex")}`;
}

type CanonicalContext = "module" | "ir" | "recordEntries" | "data";

function canonicalize(value: unknown, context: CanonicalContext): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, context));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value)
    .filter(([key]) => !(
      (context === "module" && key === "sourceName") ||
      (context === "ir" && key === "span")
    ))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, item]) => [
    key,
    canonicalize(item, childCanonicalContext(value, key, context)),
  ]));
}

function childCanonicalContext(
  parent: object,
  key: string,
  context: CanonicalContext,
): CanonicalContext {
  if (context === "data") return "data";
  if (context === "recordEntries") return "ir";
  if (key === "value" && "kind" in parent && parent.kind === "literal") return "data";
  if (key === "entries" && "kind" in parent && parent.kind === "record") return "recordEntries";
  return "ir";
}
