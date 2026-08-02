import type { Message } from "./adapters.js";
import type { ComputeValue, Frag, SymbolRef } from "./ir.js";

export interface MemoryHandle {
  readonly kind: "memory";
  readonly id: string;
  readonly messages: Message[];
  owner?: string;
}

export interface AgentHandle {
  readonly kind: "agent";
  readonly id: string;
  readonly agent: SymbolRef;
  readonly memory: MemoryHandle;
  systemPrompt?: string;
}

export interface TaskGroupHandle {
  readonly kind: "taskGroup";
  readonly id: string;
  readonly tasks: readonly Promise<Frag>[];
  readonly controller: AbortController;
  readonly dispose: () => void;
  consumed: boolean;
}

export type VmValue =
  | Frag
  | ComputeValue
  | SymbolRef
  | MemoryHandle
  | AgentHandle
  | TaskGroupHandle;

export function isMemoryHandle(value: unknown): value is MemoryHandle {
  return isObject(value) && value.kind === "memory" && typeof value.id === "string" &&
    Array.isArray(value.messages);
}

export function isAgentHandle(value: unknown): value is AgentHandle {
  return isObject(value) && value.kind === "agent" && typeof value.id === "string" &&
    isMemoryHandle(value.memory);
}

export function isTaskGroupHandle(value: unknown): value is TaskGroupHandle {
  return isObject(value) && value.kind === "taskGroup" && typeof value.id === "string" &&
    Array.isArray(value.tasks);
}

export function isSymbolRef(value: unknown): value is SymbolRef {
  return isObject(value) && value.kind === "symbol" && typeof value.name === "string" &&
    value.name.startsWith("@");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
