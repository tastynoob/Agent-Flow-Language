import type { AgentControlToolDescriptor } from "./agent-executor.js";
import { AflVmError } from "./errors.js";
import type { ComputeValue, AgentControlMode, SourceSpan } from "./ir.js";

export interface FreedomPolicyLimits {
  readonly maxControlCalls: number;
  readonly maxRoutes: number;
  readonly maxIrValidations: number;
  readonly maxIrExecutions: number;
  readonly maxGeneratedBytes: number;
  readonly maxGeneratedNodes: number;
  readonly maxActivationDepth: number;
  readonly timeoutMs: number;
}

export interface FreedomLimits extends FreedomPolicyLimits {
  readonly minRoutes: number;
}

const DEFAULT_POLICY_LIMITS: FreedomPolicyLimits = Object.freeze({
  maxControlCalls: 64,
  maxRoutes: 32,
  maxIrValidations: 16,
  maxIrExecutions: 8,
  maxGeneratedBytes: 65_536,
  maxGeneratedNodes: 64,
  maxActivationDepth: 8,
  timeoutMs: 300_000,
});

export function parseFreedomLimits(
  value: Readonly<Record<string, ComputeValue>>,
  span: SourceSpan,
  policy: Partial<FreedomPolicyLimits> = {},
): FreedomLimits {
  const maximum: Record<keyof FreedomPolicyLimits, number> = { ...DEFAULT_POLICY_LIMITS };
  for (const [field, candidate] of Object.entries(policy)) {
    if (candidate === undefined) continue;
    if (!Object.hasOwn(maximum, field)) {
      throw new AflVmError("VM_POLICY_INVALID", `unknown Freedom policy limit '${field}'`);
    }
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new AflVmError("VM_POLICY_INVALID", `Freedom policy limit '${field}' must be a positive integer`);
    }
    maximum[field as keyof FreedomPolicyLimits] = candidate;
  }
  let minRoutes = 0;
  let maxRoutes = maximum.maxRoutes;
  for (const [field, candidate] of Object.entries(value)) {
    if (field !== "min_routes" && field !== "max_routes") {
      throw new AflVmError("FREEDOM_CONSTRAINT_INVALID", `unknown Freedom constraint '${field}'`, { span });
    }
    const minimum = field === "min_routes" ? 0 : 1;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum) {
      throw new AflVmError(
        "FREEDOM_CONSTRAINT_INVALID",
        `Freedom constraint '${field}' must be ${minimum === 0 ? "a non-negative" : "a positive"} integer`,
        { span },
      );
    }
    if (field === "max_routes" && candidate > maximum.maxRoutes) {
      throw new AflVmError(
        "FREEDOM_CONSTRAINT_INVALID",
        `Freedom constraint '${field}' cannot exceed policy limit ${maximum.maxRoutes}`,
        { span },
      );
    }
    if (field === "min_routes") minRoutes = candidate;
    else maxRoutes = candidate;
  }
  if (minRoutes > maxRoutes) {
    throw new AflVmError(
      "FREEDOM_CONSTRAINT_INVALID",
      `Freedom constraint min_routes=${minRoutes} cannot exceed max_routes=${maxRoutes}`,
      { span },
    );
  }
  return Object.freeze({ ...maximum, minRoutes, maxRoutes });
}

export function freedomControlTools(mode: AgentControlMode): readonly AgentControlToolDescriptor[] {
  const tools: AgentControlToolDescriptor[] = [environmentTool()];
  if (mode === "route") tools.push(routeAddTool());
  else tools.push(nodeExecuteTool(), irValidateTool(), irExecuteTool());
  return Object.freeze(tools);
}

function environmentTool(): AgentControlToolDescriptor {
  return {
    name: "afl.environment.get",
    label: "AFL environment",
    description: "Discover unknown Nodes, Agents, controlled parameters, or route constraints visible in this Freedom activation. Do not call merely to learn how another tool works or to confirm exact Node names and refs already supplied by the user: every active AFL tool includes its own usage instructions. Omit include to return every environment section.",
    inputSchema: {
      type: "object",
      properties: {
        include: {
          type: "array",
          description: "Optional environment sections to return. Omit this field to return all sections.",
          items: { enum: ["agents", "nodes", "parameters", "constraints"] },
          uniqueItems: true,
        },
      },
      additionalProperties: false,
    },
  };
}

function routeAddTool(): AgentControlToolDescriptor {
  return {
    name: "afl.route.add",
    label: "Add AFL route",
    description: "Queue one allowed existing Node call in agent.route. Set node to an allowed Node name; args are positional and must exactly match its signature. Pass a controlled value with {\"ref\":\"param:<name>\"}, using an exact ref supplied by the user or discovered from the environment, or pass arbitrary text with {\"string\":\"...\"}. When the user already supplies the exact Node and refs, call this tool directly without afl.environment.get. A successful call counts toward min_routes/max_routes but starts only after the agent finishes: it returns registration metadata, never the child result. Call once for each desired TaskGroup job; AFL code outside the agent collects results with sync.",
    inputSchema: nodeCallSchema(),
  };
}

function nodeExecuteTool(): AgentControlToolDescriptor {
  return {
    name: "afl.node.execute",
    label: "Execute AFL Node",
    description: "Immediately execute one allowed existing Node in agent.flow and wait for its result. Set node to an allowed Node name; args are positional and must exactly match its signature. Pass a controlled or prior-result value with {\"ref\":\"<exact environment or tool-result ref>\"}, or arbitrary text with {\"string\":\"...\"}. Success returns {ok:true, ref, value}; the returned ref may be used by later control calls. The call counts toward min_routes/max_routes, and child Agent workspaces must not overlap the writer workspace.",
    inputSchema: nodeCallSchema(),
  };
}

function nodeCallSchema(): ComputeValue {
  return {
    type: "object",
    properties: {
      node: {
        type: "string",
        minLength: 1,
        description: "Exact name of an allowed existing Node.",
      },
      args: {
        type: "array",
        description: "Positional Node arguments in signature order; use only ref or string argument objects.",
        items: controlArgumentSchema(),
      },
    },
    required: ["node", "args"],
    additionalProperties: false,
  };
}

function irValidateTool(): AgentControlToolDescriptor {
  return {
    name: "afl.ir.validate",
    label: "Validate AFL IR",
    description: "Parse and validate a complete generated AFL fragment at the current writer origin without executing it or calling bindings. entry must name a Node declared in source, and args are its positional arguments using exact refs or free strings. Success returns a digest and diagnostics; pass the unchanged source and digest to afl.ir.execute. Validation alone does not execute workflow work or satisfy min_routes. Static writer/child workspace conflicts are returned as warnings.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          minLength: 1,
          description: "Complete generated AFL source containing the entry Node.",
        },
        entry: {
          type: "string",
          minLength: 1,
          description: "Name of the generated Node to validate as the entry point.",
        },
        args: {
          type: "array",
          description: "Optional positional entry arguments in signature order; use only ref or string objects.",
          items: controlArgumentSchema(),
        },
      },
      required: ["source", "entry"],
      additionalProperties: false,
    },
  };
}

function irExecuteTool(): AgentControlToolDescriptor {
  return {
    name: "afl.ir.execute",
    label: "Execute AFL IR",
    description: "Revalidate and execute a complete generated AFL fragment as a child activation at the current writer origin. Use the same source, entry, and positional args accepted by afl.ir.validate; when validation returned a digest, pass it unchanged as expectedDigest to detect edits. Success returns {ok:true, digest, ref, value}; the ref may be used by later control calls. Generated Agents should omit Workspace for isolated .afl/tmpworkspace allocation or use an explicit workspace that does not overlap the writer.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          minLength: 1,
          description: "Complete generated AFL source containing the entry Node.",
        },
        entry: {
          type: "string",
          minLength: 1,
          description: "Name of the generated Node to execute as the entry point.",
        },
        args: {
          type: "array",
          description: "Optional positional entry arguments in signature order; use only ref or string objects.",
          items: controlArgumentSchema(),
        },
        expectedDigest: {
          type: "string",
          minLength: 1,
          description: "Optional exact digest returned by afl.ir.validate for this unchanged source.",
        },
      },
      required: ["source", "entry"],
      additionalProperties: false,
    },
  };
}

function controlArgumentSchema(): ComputeValue {
  return {
    oneOf: [
      {
        description: "Reference a controlled parameter or a prior result by its exact activation-scoped ref.",
        type: "object",
        properties: {
          ref: {
            type: "string",
            minLength: 1,
            description: "Exact ref such as param:task or a ref returned by a successful flow control call.",
          },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      {
        description: "Pass arbitrary model-authored text as a literal argument.",
        type: "object",
        properties: {
          string: {
            type: "string",
            description: "Literal string value.",
          },
        },
        required: ["string"],
        additionalProperties: false,
      },
    ],
  };
}
