import type {
  AgentDeclaration,
  AgentOperationDeclaration,
  AflProgram,
  FreedomPlan,
  JsonValue,
} from "./ir.js";
import type { SerializedFlowError } from "./errors.js";

export interface AgentInvokeRequest {
  runId: string;
  flowId: string;
  nodeId: string;
  agent: string;
  operation: string;
  declaration: AgentDeclaration;
  operationDeclaration: AgentOperationDeclaration;
  input: JsonValue;
  signal: AbortSignal;
}

export interface AgentAdapter {
  invoke(request: AgentInvokeRequest): Promise<JsonValue>;
}

export interface EventEmitRequest {
  runId: string;
  flowId: string;
  nodeId: string;
  event: string;
  payload: JsonValue;
  signal: AbortSignal;
}

export interface EventWaitRequest {
  runId: string;
  flowId: string;
  nodeId: string;
  event: string;
  signal: AbortSignal;
}

export interface EventAdapter {
  emit(request: EventEmitRequest): Promise<void>;
  wait(request: EventWaitRequest): Promise<JsonValue>;
}

export interface CheckpointRequest {
  runId: string;
  flowId: string;
  nodeId: string;
  label?: string;
  input: JsonValue;
  state: Record<string, JsonValue>;
  traceSequence: number;
  signal: AbortSignal;
}

export interface CheckpointAdapter {
  save(request: CheckpointRequest): Promise<void>;
}

export interface FreedomPolicyRequest {
  program: AflProgram;
  runId: string;
  flowId: string;
  nodeId: string;
  plan: FreedomPlan;
  planHash: string;
}

export interface RuntimePolicy {
  authorizeAgent?(request: AgentInvokeRequest): boolean | Promise<boolean>;
  approveFreedom?(request: FreedomPolicyRequest): boolean | Promise<boolean>;
}

export type TraceEventType =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "flow.started"
  | "flow.completed"
  | "flow.failed"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "event.emitted"
  | "event.received"
  | "checkpoint.created"
  | "freedom.plan.created"
  | "freedom.plan.accepted"
  | "freedom.plan.rejected"
  | "revision.created";

export interface TraceEvent {
  sequence: number;
  timestamp: string;
  runId: string;
  type: TraceEventType;
  flowId?: string;
  nodeId?: string;
  details?: JsonValue;
  error?: SerializedFlowError;
}

export interface TraceSink {
  emit(event: TraceEvent): void | Promise<void>;
}

export interface RuntimeBindings {
  agents: AgentAdapter;
  events?: EventAdapter;
  checkpoints?: CheckpointAdapter;
  policy?: RuntimePolicy;
  trace?: TraceSink;
}
