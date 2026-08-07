import { CCSafetyNetPlugin } from "cc-safety-net";

import type {
  AgentPreToolPolicy,
  AgentToolAction,
  AgentToolPolicyDecision,
} from "./agent-tool-policy.js";

export interface CCSafetyNetPolicyOptions {
  readonly name?: string;
  readonly toolNames?: readonly string[];
  readonly homeDir?: string;
}

interface CCSafetyNetHook {
  readonly "tool.execute.before": (
    input: { readonly tool: string; readonly sessionID: string; readonly callID: string },
    output: { readonly args: Readonly<Record<string, unknown>> },
  ) => Promise<void>;
}

type CCSafetyNetFactory = (input: {
  readonly directory: string;
  readonly homeDir?: string;
}) => Promise<CCSafetyNetHook>;

export function createCCSafetyNetPolicy(options: CCSafetyNetPolicyOptions = {}): AgentPreToolPolicy {
  const toolNames = new Set(options.toolNames ?? ["bash"]);
  if (toolNames.size === 0 || [...toolNames].some((name) => name.trim().length === 0)) {
    throw new TypeError("cc-safety-net toolNames must contain non-empty tool names");
  }
  const hooks = new Map<string, Promise<CCSafetyNetHook>>();
  const factory = CCSafetyNetPlugin as unknown as CCSafetyNetFactory;
  return Object.freeze({
    name: options.name ?? "cc-safety-net",
    async evaluate(action: AgentToolAction): Promise<AgentToolPolicyDecision> {
      if (!toolNames.has(action.toolName)) return { verdict: "abstain" };
      const command = action.effectiveInput.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        return {
          verdict: "deny",
          code: "CC_SAFETY_NET_INPUT_INVALID",
          reason: `CC Safety Net requires '${action.toolName}' to provide a non-empty command`,
        };
      }
      const directory = action.workspace.primary.root;
      let hook = hooks.get(directory);
      if (hook === undefined) {
        hook = factory({
          directory,
          ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
        });
        hooks.set(directory, hook);
      }
      try {
        await (await hook)["tool.execute.before"]({
          tool: "bash",
          sessionID: "",
          callID: action.toolCallId,
        }, { args: { command } });
        return { verdict: "allow" };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "CC Safety Net analysis failed";
        if (!reason.startsWith("BLOCKED by CC Safety Net")) {
          return {
            verdict: "deny",
            code: "CC_SAFETY_NET_FAILED",
            reason: "CC Safety Net analysis failed",
          };
        }
        return {
          verdict: "block",
          code: "CC_SAFETY_NET_BLOCKED",
          reason,
        };
      }
    },
  });
}
