import type {
  AflModule,
  ComputeValue,
  Frag,
  ScriptLanguage,
  SymbolRef,
} from "./ir.js";
import type { AgentExecutionHost, AgentExecutorBackend } from "./agent-executor.js";

export interface Message {
  readonly role: string;
  readonly content: string;
}

export interface AgentRunRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly schema?: SymbolRef;
  readonly signal: AbortSignal;
}

export interface AgentRunResult {
  readonly output: string;
  readonly messages?: readonly Message[];
}

export interface AgentAdapter {
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

export interface MoveRequest {
  readonly move: SymbolRef;
  readonly args: readonly VmArgument[];
  readonly signal: AbortSignal;
}

export interface MoveAdapter {
  execute(request: MoveRequest): string | Frag | Promise<string | Frag>;
}

export interface FreedomMovePlan {
  readonly kind: "move";
  readonly move: SymbolRef;
  readonly args?: readonly VmArgument[];
}

export interface FreedomExistingFlowPlan {
  readonly kind: "flow";
  readonly flow: SymbolRef;
  readonly args?: readonly VmArgument[];
}

export interface FreedomGeneratedFlowPlan {
  readonly kind: "generated";
  readonly source: string;
  readonly entry: string;
  readonly args?: readonly VmArgument[];
}

export type FreedomPlan = FreedomMovePlan | FreedomExistingFlowPlan | FreedomGeneratedFlowPlan;

export interface FreedomRequest {
  readonly mode: "move" | "flow";
  readonly planner: SymbolRef;
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly moves?: readonly SymbolRef[];
  readonly prompt: Frag;
  readonly context: Frag;
  readonly signal: AbortSignal;
}

export interface FreedomAdapter {
  plan(request: FreedomRequest): FreedomPlan | Promise<FreedomPlan>;
}

export interface FreedomPolicyRequest {
  readonly module: AflModule;
  readonly plan: FreedomPlan;
  readonly runId: string;
  readonly node: string;
  readonly block: string;
}

export interface VmPolicy {
  readonly maxConcurrency?: number;
  readonly maxDispatchWorkers?: number;
  readonly maxDispatchTasks?: number;
  authorizeAgent?(request: AgentRunRequest): boolean | Promise<boolean>;
  authorizeCapability?(request: CapabilityRequest): boolean | Promise<boolean>;
  approveFreedom?(request: FreedomPolicyRequest): boolean | Promise<boolean>;
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
  | "freedom.planned"
  | "freedom.approved"
  | "freedom.rejected";

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
  readonly moves?: MoveAdapter;
  readonly freedom?: FreedomAdapter;
  readonly policy?: VmPolicy;
  readonly trace?: TraceSink;
}
