import type { AflModule, ComputeValue, Frag, FreedomMode, ScriptLanguage, SymbolRef } from "./ir.js";
import type { AgentExecutionHost, AgentExecutorBackend } from "./agent-executor.js";
import type { FreedomPolicyLimits } from "./freedom.js";
import type { AgentMemoryContract, MemoryPersistenceBinding, Message } from "./memory.js";
import type { AgentWorkspaceSet } from "./workspace.js";

export interface AgentRunRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly systemPrompt?: string;
  readonly workspace: AgentWorkspaceSet;
  readonly messages: readonly Message[];
  readonly schema?: SymbolRef;
  readonly signal: AbortSignal;
}

export interface AgentRunResult {
  readonly output: string;
}

export interface AgentAdapter {
  readonly workspaceCapabilities?: {
    readonly workspaceContext: boolean;
    readonly readOnlyWorkspaceContext: boolean;
  };
  readonly memory?: AgentMemoryContract;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface PromptRenderRequest {
  readonly prompt: SymbolRef;
  readonly args: readonly PromptArgument[];
  readonly signal: AbortSignal;
}

export type PromptArgument = Frag | ComputeValue | SymbolRef;

export interface PromptAdapter {
  render(request: PromptRenderRequest): string | Promise<string>;
}

export interface InputRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly prompt: string;
  readonly schema?: SymbolRef;
  readonly signal: AbortSignal;
}

export interface InputAdapter {
  read(request: InputRequest): string | Promise<string>;
}

export interface ScriptRequest {
  readonly language: ScriptLanguage;
  readonly source: string;
  readonly args: readonly ComputeValue[];
  readonly signal: AbortSignal;
}

export interface ScriptAdapter {
  execute(request: ScriptRequest): ComputeValue | Promise<ComputeValue>;
}

export interface CapabilityRequest {
  readonly capability: SymbolRef;
  readonly args: readonly PromptArgument[];
  readonly signal: AbortSignal;
}

export interface CapabilityAdapter {
  invoke(request: CapabilityRequest): string | Frag | Promise<string | Frag>;
}

export interface ExternalFlowRequest {
  readonly flow: SymbolRef;
  readonly args: readonly VmArgument[];
  readonly signal: AbortSignal;
}

export interface ExternalFlowAdapter {
  invoke(request: ExternalFlowRequest): VmArgument | Promise<VmArgument>;
}

export interface FormatRequest {
  readonly formatter: SymbolRef;
  readonly values: readonly Frag[];
  readonly signal: AbortSignal;
}

export interface FormatterAdapter {
  format(request: FormatRequest): string | Promise<string>;
}

export interface SchemaValidationRequest {
  readonly schema: SymbolRef;
  readonly content: string;
  readonly signal: AbortSignal;
}

export interface SchemaAdapter {
  validate(request: SchemaValidationRequest): void | Promise<void>;
}

export interface FreedomPolicyRequest {
  readonly mode: FreedomMode;
  readonly module: AflModule;
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly planner: SymbolRef;
  readonly nodes: readonly string[];
  readonly agents: readonly SymbolRef[];
  readonly constraint: Readonly<Record<string, ComputeValue>>;
}

export interface FreedomNodePolicyRequest extends FreedomPolicyRequest {
  readonly target: string;
  readonly args: readonly VmArgument[];
}

export interface FreedomIrPolicyRequest extends FreedomPolicyRequest {
  readonly source: string;
  readonly entry: string;
  readonly digest: string;
}

export interface VmPolicy {
  readonly maxConcurrency?: number;
  readonly maxDispatchWorkers?: number;
  readonly maxDispatchTasks?: number;
  readonly freedomLimits?: Partial<FreedomPolicyLimits>;
  authorizeAgent?(request: AgentRunRequest): boolean | Promise<boolean>;
  authorizeCapability?(request: CapabilityRequest): boolean | Promise<boolean>;
  authorizeFreedom?(request: FreedomPolicyRequest): boolean | Promise<boolean>;
  authorizeFreedomNode?(request: FreedomNodePolicyRequest): boolean | Promise<boolean>;
  authorizeFreedomIr?(request: FreedomIrPolicyRequest): boolean | Promise<boolean>;
}

export type TraceEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "block.started"
  | "block.completed"
  | "instruction.started"
  | "instruction.completed"
  | "instruction.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.event"
  | "dispatch.started"
  | "dispatch.completed"
  | "fork.started"
  | "fork.completed"
  | "freedom.started"
  | "freedom.tool"
  | "freedom.completed";

export interface TraceEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly runId: string;
  readonly type: TraceEventType;
  readonly node?: string;
  readonly block?: string;
  readonly instruction?: number;
  readonly details?: ComputeValue;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface TraceSink {
  emit(event: TraceEvent): void | Promise<void>;
}

export type VmArgument = Frag | ComputeValue | SymbolRef;

export interface VmBindings {
  readonly agents?: AgentAdapter;
  readonly agentExecutor?: AgentExecutorBackend;
  readonly agentHost?: AgentExecutionHost;
  readonly prompts?: PromptAdapter;
  readonly input?: InputAdapter;
  readonly scripts?: ScriptAdapter;
  readonly capabilities?: CapabilityAdapter;
  readonly flows?: ExternalFlowAdapter;
  readonly formatters?: FormatterAdapter;
  readonly schemas?: SchemaAdapter;
  readonly policy?: VmPolicy;
  readonly trace?: TraceSink;
  readonly memoryPersistence?: MemoryPersistenceBinding;
}
