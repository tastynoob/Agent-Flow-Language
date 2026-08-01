import type {
  AflProgram,
  AssignNode,
  AwaitEventNode,
  BinaryOperator,
  BranchCase,
  BranchNode,
  CallFlowNode,
  CheckpointNode,
  DataSchema,
  DelayNode,
  EmitNode,
  Expr,
  FailNode,
  FlowNode,
  ForEachNode,
  FreedomConstraints,
  FreedomNode,
  InvokeNode,
  JsonPrimitive,
  JsonValue,
  LoopNode,
  NoopNode,
  ParallelBranch,
  ParallelMode,
  ParallelNode,
  RetryNode,
  RetryPolicy,
  ReturnNode,
  SequenceNode,
  SlotTarget,
  TimeoutNode,
  TryNode,
  UnaryOperator,
} from "./ir.js";
import { assertValidProgram } from "./validation.js";

export const schema = {
  any: (): DataSchema => ({ type: "any" }),
  null: (): DataSchema => ({ type: "null" }),
  boolean: (): DataSchema => ({ type: "boolean" }),
  number: (
    options: { integer?: boolean; minimum?: number; maximum?: number } = {},
  ): DataSchema => ({ type: "number", ...options }),
  string: (
    options: { minLength?: number; maxLength?: number; pattern?: string } = {},
  ): DataSchema => ({ type: "string", ...options }),
  enum: (values: JsonPrimitive[]): DataSchema => ({ type: "enum", values }),
  array: (
    items: DataSchema,
    options: { minItems?: number; maxItems?: number } = {},
  ): DataSchema => ({ type: "array", items, ...options }),
  object: (
    properties: Record<string, DataSchema>,
    options: { required?: string[]; additionalProperties?: boolean } = {},
  ): DataSchema => ({ type: "object", properties, ...options }),
  oneOf: (variants: DataSchema[]): DataSchema => ({ type: "oneOf", variants }),
  ref: (name: string): DataSchema => ({ type: "ref", name }),
};

export const expression = {
  literal: (value: JsonValue): Expr => ({ kind: "literal", value }),
  input: (name?: string, path?: Array<string | number>): Expr => ({
    kind: "ref",
    scope: "input",
    ...(name === undefined ? {} : { name }),
    ...(path === undefined ? {} : { path }),
  }),
  state: (name: string, path?: Array<string | number>): Expr => ({
    kind: "ref",
    scope: "state",
    name,
    ...(path === undefined ? {} : { path }),
  }),
  local: (name: string, path?: Array<string | number>): Expr => ({
    kind: "ref",
    scope: "local",
    name,
    ...(path === undefined ? {} : { path }),
  }),
  object: (entries: Record<string, Expr>): Expr => ({ kind: "object", entries }),
  array: (items: Expr[]): Expr => ({ kind: "array", items }),
  unary: (op: UnaryOperator, value: Expr): Expr => ({ kind: "unary", op, value }),
  binary: (op: BinaryOperator, left: Expr, right: Expr): Expr => ({
    kind: "binary",
    op,
    left,
    right,
  }),
};

export const target = {
  state: (name: string): SlotTarget => ({ scope: "state", name }),
  local: (name: string): SlotTarget => ({ scope: "local", name }),
};

export const node = {
  noop: (id: string): NoopNode => ({ kind: "noop", id }),
  sequence: (id: string, steps: FlowNode[]): SequenceNode => ({
    kind: "sequence",
    id,
    steps,
  }),
  assign: (id: string, assignmentTarget: SlotTarget, value: Expr): AssignNode => ({
    kind: "assign",
    id,
    target: assignmentTarget,
    value,
  }),
  invoke: (
    id: string,
    agent: string,
    operation: string,
    input: Expr,
    assign?: SlotTarget,
  ): InvokeNode => ({
    kind: "invoke",
    id,
    agent,
    operation,
    input,
    ...(assign === undefined ? {} : { assign }),
  }),
  callFlow: (
    id: string,
    flow: string,
    input: Expr,
    assign?: SlotTarget,
  ): CallFlowNode => ({
    kind: "callFlow",
    id,
    flow,
    input,
    ...(assign === undefined ? {} : { assign }),
  }),
  branch: (id: string, cases: BranchCase[], defaultNode?: FlowNode): BranchNode => ({
    kind: "branch",
    id,
    cases,
    ...(defaultNode === undefined ? {} : { default: defaultNode }),
  }),
  loop: (
    id: string,
    condition: Expr,
    body: FlowNode,
    maxIterations: number,
  ): LoopNode => ({ kind: "loop", id, condition, body, maxIterations }),
  forEach: (
    id: string,
    items: Expr,
    item: string,
    body: FlowNode,
    options: { index?: string; maxConcurrency?: number; assign?: SlotTarget } = {},
  ): ForEachNode => ({ kind: "forEach", id, items, item, body, ...options }),
  parallel: (
    id: string,
    branches: ParallelBranch[],
    mode: ParallelMode,
    assign?: SlotTarget,
  ): ParallelNode => ({
    kind: "parallel",
    id,
    branches,
    mode,
    ...(assign === undefined ? {} : { assign }),
  }),
  retry: (
    id: string,
    body: FlowNode,
    maxAttempts: number,
    backoff?: RetryPolicy,
  ): RetryNode => ({
    kind: "retry",
    id,
    body,
    maxAttempts,
    ...(backoff === undefined ? {} : { backoff }),
  }),
  timeout: (id: string, body: FlowNode, timeoutMs: number): TimeoutNode => ({
    kind: "timeout",
    id,
    body,
    timeoutMs,
  }),
  try: (
    id: string,
    body: FlowNode,
    options: { catch?: { error: string; body: FlowNode }; finally?: FlowNode } = {},
  ): TryNode => ({ kind: "try", id, body, ...options }),
  delay: (id: string, durationMs: Expr): DelayNode => ({
    kind: "delay",
    id,
    durationMs,
  }),
  emit: (id: string, event: string, payload: Expr): EmitNode => ({
    kind: "emit",
    id,
    event,
    payload,
  }),
  awaitEvent: (
    id: string,
    event: string,
    options: { assign?: SlotTarget; timeoutMs?: number } = {},
  ): AwaitEventNode => ({ kind: "awaitEvent", id, event, ...options }),
  checkpoint: (id: string, label?: string): CheckpointNode => ({
    kind: "checkpoint",
    id,
    ...(label === undefined ? {} : { label }),
  }),
  freedom: (
    id: string,
    planner: string,
    operation: string,
    context: Expr,
    constraints: FreedomConstraints,
    assign?: SlotTarget,
  ): FreedomNode => ({
    kind: "freedom",
    id,
    planner,
    operation,
    context,
    constraints,
    ...(assign === undefined ? {} : { assign }),
  }),
  return: (id: string, value: Expr): ReturnNode => ({ kind: "return", id, value }),
  fail: (id: string, error: Expr): FailNode => ({ kind: "fail", id, error }),
};

export function defineProgram(program: AflProgram): AflProgram {
  return assertValidProgram(program);
}
