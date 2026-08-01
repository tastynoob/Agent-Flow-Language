export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DataSchema =
  | { type: "any" }
  | { type: "null" }
  | { type: "boolean" }
  | {
      type: "number";
      integer?: boolean;
      minimum?: number;
      maximum?: number;
    }
  | {
      type: "string";
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | { type: "enum"; values: JsonPrimitive[] }
  | {
      type: "array";
      items: DataSchema;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "object";
      properties: Record<string, DataSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | { type: "oneOf"; variants: DataSchema[] }
  | { type: "ref"; name: string };

export interface AgentOperationDeclaration {
  input: DataSchema;
  output: DataSchema;
}

export interface AgentDeclaration {
  description?: string;
  capabilities?: string[];
  operations: Record<string, AgentOperationDeclaration>;
}

export interface SlotDeclaration {
  schema: DataSchema;
  initial?: JsonValue;
}

export type RefScope = "input" | "state" | "local";

export type UnaryOperator = "not" | "negate" | "isNull";

export type BinaryOperator =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "and"
  | "or"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "concat"
  | "coalesce"
  | "in";

export type Expr =
  | { kind: "literal"; value: JsonValue }
  | {
      kind: "ref";
      scope: RefScope;
      name?: string;
      path?: Array<string | number>;
    }
  | { kind: "object"; entries: Record<string, Expr> }
  | { kind: "array"; items: Expr[] }
  | { kind: "unary"; op: UnaryOperator; value: Expr }
  | { kind: "binary"; op: BinaryOperator; left: Expr; right: Expr };

export interface SlotTarget {
  scope: "state" | "local";
  name: string;
}

export interface NodeBase {
  id: string;
  metadata?: Record<string, JsonValue>;
}

export interface NoopNode extends NodeBase {
  kind: "noop";
}

export interface SequenceNode extends NodeBase {
  kind: "sequence";
  steps: FlowNode[];
}

export interface AssignNode extends NodeBase {
  kind: "assign";
  target: SlotTarget;
  value: Expr;
}

export interface InvokeNode extends NodeBase {
  kind: "invoke";
  agent: string;
  operation: string;
  input: Expr;
  assign?: SlotTarget;
}

export interface CallFlowNode extends NodeBase {
  kind: "callFlow";
  flow: string;
  input: Expr;
  assign?: SlotTarget;
}

export interface BranchCase {
  when: Expr;
  then: FlowNode;
}

export interface BranchNode extends NodeBase {
  kind: "branch";
  cases: BranchCase[];
  default?: FlowNode;
}

export interface LoopNode extends NodeBase {
  kind: "loop";
  condition: Expr;
  body: FlowNode;
  maxIterations: number;
}

export interface ForEachNode extends NodeBase {
  kind: "forEach";
  items: Expr;
  item: string;
  index?: string;
  body: FlowNode;
  maxConcurrency?: number;
  assign?: SlotTarget;
}

export type ParallelMode = "all" | "allSettled" | "race";

export interface ParallelBranch {
  id: string;
  body: FlowNode;
}

export interface ParallelNode extends NodeBase {
  kind: "parallel";
  branches: ParallelBranch[];
  mode: ParallelMode;
  assign?: SlotTarget;
}

export interface RetryPolicy {
  kind: "fixed" | "exponential";
  delayMs: number;
  maxDelayMs?: number;
}

export interface RetryNode extends NodeBase {
  kind: "retry";
  body: FlowNode;
  maxAttempts: number;
  backoff?: RetryPolicy;
}

export interface TimeoutNode extends NodeBase {
  kind: "timeout";
  body: FlowNode;
  timeoutMs: number;
}

export interface CatchClause {
  error: string;
  body: FlowNode;
}

export interface TryNode extends NodeBase {
  kind: "try";
  body: FlowNode;
  catch?: CatchClause;
  finally?: FlowNode;
}

export interface DelayNode extends NodeBase {
  kind: "delay";
  durationMs: Expr;
}

export interface EmitNode extends NodeBase {
  kind: "emit";
  event: string;
  payload: Expr;
}

export interface AwaitEventNode extends NodeBase {
  kind: "awaitEvent";
  event: string;
  assign?: SlotTarget;
  timeoutMs?: number;
}

export interface CheckpointNode extends NodeBase {
  kind: "checkpoint";
  label?: string;
}

export interface FreedomConstraints {
  maxNodes: number;
  maxDepth: number;
  allowedNodeKinds?: FlowNode["kind"][];
  allowedAgents?: string[];
  allowedFlows?: string[];
  allowRevision?: boolean;
}

export interface FreedomNode extends NodeBase {
  kind: "freedom";
  planner: string;
  operation: string;
  context: Expr;
  constraints: FreedomConstraints;
  assign?: SlotTarget;
}

export interface ReturnNode extends NodeBase {
  kind: "return";
  value: Expr;
}

export interface FailNode extends NodeBase {
  kind: "fail";
  error: Expr;
}

export type FlowNode =
  | NoopNode
  | SequenceNode
  | AssignNode
  | InvokeNode
  | CallFlowNode
  | BranchNode
  | LoopNode
  | ForEachNode
  | ParallelNode
  | RetryNode
  | TimeoutNode
  | TryNode
  | DelayNode
  | EmitNode
  | AwaitEventNode
  | CheckpointNode
  | FreedomNode
  | ReturnNode
  | FailNode;

export interface FlowDefinition {
  input: DataSchema;
  output: DataSchema;
  state?: Record<string, SlotDeclaration>;
  locals?: Record<string, SlotDeclaration>;
  body: FlowNode;
}

export interface AflProgram {
  irVersion: "0.1";
  name: string;
  entry: string;
  schemas?: Record<string, DataSchema>;
  agents?: Record<string, AgentDeclaration>;
  flows: Record<string, FlowDefinition>;
  metadata?: Record<string, JsonValue>;
}

export type FreedomPlan =
  | { kind: "continuation"; body: FlowNode }
  | { kind: "revision"; flow: FlowDefinition; input: JsonValue };

export const FLOW_NODE_KINDS: ReadonlySet<FlowNode["kind"]> = new Set([
  "noop",
  "sequence",
  "assign",
  "invoke",
  "callFlow",
  "branch",
  "loop",
  "forEach",
  "parallel",
  "retry",
  "timeout",
  "try",
  "delay",
  "emit",
  "awaitEvent",
  "checkpoint",
  "freedom",
  "return",
  "fail",
]);
