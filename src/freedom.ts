import type { AgentControlToolDescriptor } from "./agent-executor.js";
import { AflVmError } from "./errors.js";
import type { ComputeValue, FreedomMode, SourceSpan } from "./ir.js";

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

export function freedomControlTools(mode: FreedomMode): readonly AgentControlToolDescriptor[] {
  const tools: AgentControlToolDescriptor[] = [environmentTool(), nodeTool()];
  if (mode === "flow") tools.push(irValidateTool(), irExecuteTool());
  return Object.freeze(tools);
}

function environmentTool(): AgentControlToolDescriptor {
  return {
    name: "afl.environment.get",
    label: "AFL environment",
    description: "Inspect the Nodes, Agents, controlled parameters, constraints, and AFL tools visible in this activation.",
    inputSchema: {
      type: "object",
      properties: {
        include: {
          type: "array",
          items: { enum: ["agents", "nodes", "parameters", "constraints", "tools"] },
          uniqueItems: true,
        },
      },
      additionalProperties: false,
    },
  };
}

function nodeTool(): AgentControlToolDescriptor {
  return {
    name: "afl.node.execute",
    label: "Execute AFL Node",
    description: "Execute one explicitly allowed existing AFL Node with controlled references or string arguments. Child Agent workspaces must not conflict with the writer workspace.",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string", minLength: 1 },
        args: { type: "array", items: controlArgumentSchema() },
      },
      required: ["node", "args"],
      additionalProperties: false,
    },
  };
}

function irValidateTool(): AgentControlToolDescriptor {
  return {
    name: "afl.ir.validate",
    label: "Validate AFL IR",
    description: "Parse and validate generated AFL without executing it or calling bindings. Static writer/child workspace conflicts are returned as warnings.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", minLength: 1 },
        entry: { type: "string", minLength: 1 },
        args: { type: "array", items: controlArgumentSchema() },
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
    description: "Revalidate and execute generated AFL as a child activation at the writer origin. Generated Agents should omit Workspace for isolated .afl/tmpworkspace allocation or use an explicit non-conflicting workspace.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", minLength: 1 },
        entry: { type: "string", minLength: 1 },
        args: { type: "array", items: controlArgumentSchema() },
        expectedDigest: { type: "string", minLength: 1 },
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
        type: "object",
        properties: { ref: { type: "string", minLength: 1 } },
        required: ["ref"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { string: { type: "string" } },
        required: ["string"],
        additionalProperties: false,
      },
    ],
  };
}
