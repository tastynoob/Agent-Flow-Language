import { createHash } from "node:crypto";

import type { SymbolRef } from "./ir.js";
import type { AgentWorkspaceSet } from "./workspace.js";

export type AgentToolExecutionBoundary = "sandbox" | "host-control" | "host";

export interface AgentToolActionDisplay {
  readonly title: string;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string>>;
}

export interface AgentToolAction {
  readonly requestId: string;
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly backend: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly executionBoundary: AgentToolExecutionBoundary;
  readonly workspace: AgentWorkspaceSet;
  readonly input: Readonly<Record<string, unknown>>;
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly display: AgentToolActionDisplay;
  readonly signal: AbortSignal;
}

export type AgentToolPolicyDecision =
  | { readonly verdict: "allow"; readonly reason?: string }
  | { readonly verdict: "block"; readonly code: string; readonly reason: string }
  | { readonly verdict: "deny"; readonly code: string; readonly reason: string }
  | { readonly verdict: "abstain" };

export interface AgentPreToolPolicy {
  readonly name: string;
  evaluate(action: AgentToolAction): AgentToolPolicyDecision | Promise<AgentToolPolicyDecision>;
}

export interface AgentPreToolPolicyConfig {
  readonly policies: readonly AgentPreToolPolicy[];
  readonly requireCoverage?: boolean;
}

export interface AgentToolPolicyResult {
  readonly policy: string;
  readonly decision: AgentToolPolicyDecision;
}

export type AgentToolPolicyEvaluation =
  | {
      readonly verdict: "allow";
      readonly covered: boolean;
      readonly results: readonly AgentToolPolicyResult[];
    }
  | {
      readonly verdict: "block";
      readonly covered: true;
      readonly policy: string;
      readonly code: string;
      readonly reason: string;
      readonly blocks: readonly { readonly policy: string; readonly code: string; readonly reason: string }[];
      readonly results: readonly AgentToolPolicyResult[];
    }
  | {
      readonly verdict: "deny";
      readonly covered: boolean;
      readonly policy?: string;
      readonly code: string;
      readonly reason: string;
      readonly results: readonly AgentToolPolicyResult[];
    };

const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key)/iu;
const SECRET_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?))=([^\s]+)/gu;
const BEARER = /\b(Bearer)\s+[^\s]+/giu;

export class AgentToolPolicyEngine {
  private readonly policies: readonly AgentPreToolPolicy[];
  private readonly requireCoverage: boolean;

  constructor(config: AgentPreToolPolicyConfig) {
    const names = new Set<string>();
    for (const policy of config.policies) {
      if (policy.name.trim().length === 0) throw new TypeError("tool policy name must not be empty");
      if (names.has(policy.name)) throw new TypeError(`duplicate tool policy name '${policy.name}'`);
      names.add(policy.name);
    }
    this.policies = Object.freeze([...config.policies]);
    this.requireCoverage = config.requireCoverage ?? false;
  }

  async evaluate(action: AgentToolAction): Promise<AgentToolPolicyEvaluation> {
    let snapshot: AgentToolAction;
    try {
      snapshot = snapshotAgentToolAction(action);
    } catch {
      return {
        verdict: "deny",
        covered: true,
        code: "AGENT_TOOL_POLICY_FAILED",
        reason: "Tool action could not be normalized for policy evaluation",
        results: [],
      };
    }
    const results: AgentToolPolicyResult[] = [];
    const blocks: { policy: string; code: string; reason: string }[] = [];
    let covered = false;
    for (const policy of this.policies) {
      let decision: AgentToolPolicyDecision;
      try {
        decision = validateDecision(await policy.evaluate(snapshot), policy.name);
      } catch {
        return {
          verdict: "deny",
          covered: true,
          policy: policy.name,
          code: "AGENT_TOOL_POLICY_FAILED",
          reason: `Tool policy '${policy.name}' failed`,
          results: Object.freeze(results),
        };
      }
      results.push(Object.freeze({ policy: policy.name, decision }));
      if (decision.verdict === "abstain") continue;
      covered = true;
      if (decision.verdict === "deny") {
        return {
          verdict: "deny",
          covered,
          policy: policy.name,
          code: decision.code,
          reason: decision.reason,
          results: Object.freeze(results),
        };
      }
      if (decision.verdict === "block") {
        blocks.push({ policy: policy.name, code: decision.code, reason: decision.reason });
      }
    }
    if (!covered && this.requireCoverage) {
      return {
        verdict: "deny",
        covered: false,
        code: "AGENT_TOOL_POLICY_UNCOVERED",
        reason: `No tool policy covers '${action.toolName}'`,
        results: Object.freeze(results),
      };
    }
    if (blocks.length > 0) {
      const first = blocks[0]!;
      return {
        verdict: "block",
        covered: true,
        policy: first.policy,
        code: first.code,
        reason: first.reason,
        blocks: Object.freeze(blocks),
        results: Object.freeze(results),
      };
    }
    return { verdict: "allow", covered, results: Object.freeze(results) };
  }
}

export function agentToolActionDigest(action: AgentToolAction): string {
  const canonical = canonicalize({
    backend: action.backend,
    toolName: action.toolName,
    executionBoundary: action.executionBoundary,
    workspace: {
      primary: action.workspace.primary.resourceId,
      readOnly: action.workspace.readOnly.map((item) => item.resourceId),
    },
    effectiveInput: action.effectiveInput,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function createAgentToolActionDisplay(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  workspace?: string,
): AgentToolActionDisplay {
  const redacted = redactValue(input);
  const serialized = JSON.stringify(redacted);
  const summary = serialized.length <= 1_000 ? serialized : `${serialized.slice(0, 997)}...`;
  return Object.freeze({
    title: toolName,
    summary,
    ...(workspace === undefined ? {} : { details: Object.freeze({ workspace }) }),
  });
}

export function redactAgentToolText(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(BEARER, "$1 [REDACTED]");
}

export function snapshotAgentToolAction(action: AgentToolAction): AgentToolAction {
  const executionBoundary = action.executionBoundary;
  if (executionBoundary !== "sandbox" && executionBoundary !== "host-control" && executionBoundary !== "host") {
    throw new TypeError("tool action executionBoundary is invalid");
  }
  return Object.freeze({
    requestId: requireNonEmpty(action.requestId, "tool action requestId"),
    runId: requireNonEmpty(action.runId, "tool action runId"),
    node: requireNonEmpty(action.node, "tool action node"),
    block: requireNonEmpty(action.block, "tool action block"),
    agent: deepFreeze(structuredClone(action.agent)),
    backend: requireNonEmpty(action.backend, "tool action backend"),
    toolCallId: requireNonEmpty(action.toolCallId, "tool action toolCallId"),
    toolName: requireNonEmpty(action.toolName, "tool action toolName"),
    executionBoundary,
    workspace: deepFreeze(structuredClone(action.workspace)),
    input: cloneRecord(action.input, "tool action input"),
    effectiveInput: cloneRecord(action.effectiveInput, "tool action effectiveInput"),
    display: deepFreeze(structuredClone(action.display)),
    signal: action.signal,
  });
}

function validateDecision(value: AgentToolPolicyDecision, policy: string): AgentToolPolicyDecision {
  if (typeof value !== "object" || value === null || !("verdict" in value)) {
    throw new TypeError(`tool policy '${policy}' returned an invalid decision`);
  }
  if (value.verdict === "abstain") return Object.freeze({ verdict: "abstain" });
  if (value.verdict === "allow") {
    return Object.freeze(value.reason === undefined
      ? { verdict: "allow" }
      : { verdict: "allow", reason: requireNonEmpty(value.reason, "tool policy reason") });
  }
  if (value.verdict === "block") {
    return Object.freeze({
      verdict: "block",
      code: requireNonEmpty(value.code, "tool policy code"),
      reason: requireNonEmpty(value.reason, "tool policy reason"),
    });
  }
  if (value.verdict === "deny") {
    return Object.freeze({
      verdict: "deny",
      code: requireNonEmpty(value.code, "tool policy code"),
      reason: requireNonEmpty(value.reason, "tool policy reason"),
    });
  }
  throw new TypeError(`tool policy '${policy}' returned an unknown verdict`);
}

function cloneRecord(value: Readonly<Record<string, unknown>>, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be a record`);
  }
  canonicalize(value);
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("tool action contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") throw new TypeError("tool action contains a non-serializable value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("tool action contains a non-plain object");
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactAgentToolText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    redactValue(child, childKey),
  ]));
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must not be empty`);
  return value;
}
