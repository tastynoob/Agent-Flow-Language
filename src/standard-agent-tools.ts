import type { AgentStandardToolName } from "./ir.js";

export type AgentToolProfileName = "none" | "readonly" | "editing" | "coding";

export const AGENT_TOOL_PROFILES = Object.freeze({
  none: Object.freeze([]),
  readonly: Object.freeze(["read", "list", "search"] as const),
  editing: Object.freeze(["read", "list", "search", "write", "edit"] as const),
  coding: Object.freeze(["read", "list", "search", "write", "edit", "shell"] as const),
}) satisfies Readonly<Record<AgentToolProfileName, readonly AgentStandardToolName[]>>;

const STANDARD_TOOL_NAMES = new Set<AgentStandardToolName>(AGENT_TOOL_PROFILES.coding);

export function isAgentToolProfileName(value: string): value is AgentToolProfileName {
  return Object.hasOwn(AGENT_TOOL_PROFILES, value);
}

export function isAgentStandardToolName(value: string): value is AgentStandardToolName {
  return STANDARD_TOOL_NAMES.has(value as AgentStandardToolName);
}

export function expandAgentToolProfile(profile: AgentToolProfileName): readonly AgentStandardToolName[] {
  return AGENT_TOOL_PROFILES[profile];
}
