import type { AgentOutputFormat, AgentStandardToolName, ComputeValue } from "./ir.js";

export type AgentToolProvider = "executor" | "vm";
export type AgentToolExecutionMode = "sequential" | "parallel";

export const AFL_TRANSACTION_TOOL_NAME = "afl.transaction.request";
export const AFL_FORMAT_OUTPUT_TOOL_NAME = "afl.format_output";
export const AFL_ELEVATION_TOOL_NAME = "afl.elevation.execute";

export interface AgentToolCapability<TName extends string = string> {
  readonly name: TName;
  readonly description: string;
  readonly provider: AgentToolProvider;
}

export interface AgentToolDescriptor<TName extends string = string>
  extends AgentToolCapability<TName> {
  readonly label: string;
  /** Canonical VM input shape. Executors may expose another model-facing form and translate it. */
  readonly inputSchema: ComputeValue;
  readonly executionMode: AgentToolExecutionMode;
}

export interface AgentStandardToolDescriptor extends AgentToolCapability<AgentStandardToolName> {
  readonly provider: "executor";
  readonly authorization: "required";
}

export interface AgentControlToolDescriptor extends AgentToolDescriptor<`afl.${string}`> {
  readonly provider: "vm";
}

export type AgentToolProfileName = "none" | "readonly" | "editing" | "coding";

export const AGENT_STANDARD_TOOLS = Object.freeze({
  read: standardTool({
    name: "read",
    description: "Read file content from the Agent workspace without modifying it.",
  }),
  list: standardTool({
    name: "list",
    description: "List directory entries from the Agent workspace without modifying them.",
  }),
  search: standardTool({
    name: "search",
    description: "Search file content in the Agent workspace without modifying it.",
  }),
  write: standardTool({
    name: "write",
    description: "Create or replace file content in the Agent workspace.",
  }),
  edit: standardTool({
    name: "edit",
    description: "Apply targeted changes to an existing file in the Agent workspace.",
  }),
  shell: standardTool({
    name: "shell",
    description: "Execute a shell command in the Agent workspace and return its result.",
  }),
}) satisfies Readonly<Record<AgentStandardToolName, AgentStandardToolDescriptor>>;

export const AGENT_TOOL_PROFILES = Object.freeze({
  none: Object.freeze([]),
  readonly: Object.freeze(["read", "list", "search"] as const),
  editing: Object.freeze(["read", "list", "search", "write", "edit"] as const),
  coding: Object.freeze(["read", "list", "search", "write", "edit", "shell"] as const),
}) satisfies Readonly<Record<AgentToolProfileName, readonly AgentStandardToolName[]>>;

export const AFL_TRANSACTION_TOOL = controlTool({
  name: AFL_TRANSACTION_TOOL_NAME,
  label: "Request user action",
  description: [
    "Ask the user to perform an external prerequisite action, then pause until they confirm completion.",
    "Use this only when work cannot continue without something the user or host must provide.",
    "It does not grant permissions or perform the action; verify the resume condition after completion.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, description: "Short human-readable request title." },
      request: { type: "string", minLength: 1, description: "Exact action the user needs to perform." },
      reason: { type: "string", minLength: 1, description: "Why the Agent cannot continue without this action." },
      resume_when: {
        type: "string",
        minLength: 1,
        description: "Optional observable condition to verify after completion.",
      },
    },
    required: ["title", "request", "reason"],
    additionalProperties: false,
  },
  executionMode: "sequential",
});

export function agentFormatOutputTool(format: AgentOutputFormat): AgentControlToolDescriptor {
  return controlTool({
    name: AFL_FORMAT_OUTPUT_TOOL_NAME,
    label: "Format Output",
    description: [
      "Before finishing, submit the result for this step.",
      "You may resubmit; the last accepted value is returned.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { value: formatOutputValueSchema(format) },
      required: ["value"],
      additionalProperties: false,
    },
    executionMode: "sequential",
  });
}

export function agentElevationTool(
  toolNames: readonly string[],
): AgentToolDescriptor<typeof AFL_ELEVATION_TOOL_NAME> {
  return {
    name: AFL_ELEVATION_TOOL_NAME,
    label: "Request elevated tool execution",
    description: [
      "Retry one previously blocked or sandbox-failed tool action after one-shot human approval.",
      "Use the same tool and arguments only after safer alternatives are impractical.",
      "Hard policy denials cannot be elevated; request a user transaction when external action is required.",
      `Available elevated tools: ${toolNames.join(", ")}.`,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          minLength: 1,
          enum: [...toolNames],
          description: "Tool to retry.",
        },
        arguments: {
          type: "object",
          additionalProperties: true,
          description: "Exact arguments from the failed call.",
        },
        reason: {
          type: "string",
          minLength: 1,
          description: "Why safer alternatives are too costly or the sandbox prevents completion.",
        },
      },
      required: ["tool", "arguments", "reason"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    provider: "executor",
  };
}

const STANDARD_TOOL_NAMES = new Set<AgentStandardToolName>(
  Object.keys(AGENT_STANDARD_TOOLS) as AgentStandardToolName[],
);

export function isAgentToolProfileName(value: string): value is AgentToolProfileName {
  return Object.hasOwn(AGENT_TOOL_PROFILES, value);
}

export function isAgentStandardToolName(value: string): value is AgentStandardToolName {
  return STANDARD_TOOL_NAMES.has(value as AgentStandardToolName);
}

export function expandAgentToolProfile(profile: AgentToolProfileName): readonly AgentStandardToolName[] {
  return AGENT_TOOL_PROFILES[profile];
}

export function agentStandardTool(name: AgentStandardToolName): AgentStandardToolDescriptor {
  return AGENT_STANDARD_TOOLS[name];
}

function standardTool(
  descriptor: Omit<AgentStandardToolDescriptor, "provider" | "authorization">,
): AgentStandardToolDescriptor {
  return Object.freeze({ ...descriptor, provider: "executor", authorization: "required" });
}

export function controlTool(
  descriptor: Omit<AgentControlToolDescriptor, "provider">,
): AgentControlToolDescriptor {
  return Object.freeze({ ...descriptor, provider: "vm" });
}

function formatOutputValueSchema(format: AgentOutputFormat): ComputeValue {
  if (format.kind === "enum") {
    const variants = format.values.map((value) => ({ const: value }));
    return variants.length === 1 ? variants[0]! : { anyOf: variants };
  }
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(format.fields).map(([name, description]) => [
      name,
      { description },
    ])),
    required: Object.keys(format.fields),
    additionalProperties: false,
  };
}
