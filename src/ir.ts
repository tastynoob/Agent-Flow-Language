export interface SourceSpan {
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
}

export type PrimitiveValue = null | boolean | number | string;

export type ComputeValue =
  | PrimitiveValue
  | ComputeValue[]
  | { readonly [key: string]: ComputeValue };

export interface Frag {
  readonly kind: "frag";
  readonly content: string;
}

export interface SymbolRef {
  readonly kind: "symbol";
  readonly name: `@${string}`;
}

export type PathSegment = string | number;

export interface LiteralExpr {
  readonly kind: "literal";
  readonly value: ComputeValue;
  readonly span: SourceSpan;
}

export interface NameExpr {
  readonly kind: "name";
  readonly name: string;
  readonly path: readonly PathSegment[];
  readonly span: SourceSpan;
}

export interface SymbolExpr {
  readonly kind: "symbol";
  readonly name: `@${string}`;
  readonly span: SourceSpan;
}

export interface ListExpr {
  readonly kind: "list";
  readonly items: readonly ValueExpr[];
  readonly span: SourceSpan;
}

export interface RecordExpr {
  readonly kind: "record";
  readonly entries: Readonly<Record<string, ValueExpr>>;
  readonly span: SourceSpan;
}

export interface UnaryExpr {
  readonly kind: "unary";
  readonly operator: "!" | "-";
  readonly operand: OperExpr;
  readonly span: SourceSpan;
}

export interface BinaryExpr {
  readonly kind: "binary";
  readonly operator:
    | "|"
    | "&"
    | "=="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "+"
    | "-"
    | "*"
    | "/";
  readonly left: OperExpr;
  readonly right: OperExpr;
  readonly span: SourceSpan;
}

export type ValueExpr = LiteralExpr | NameExpr | SymbolExpr | ListExpr | RecordExpr;
export type OperExpr = ValueExpr | UnaryExpr | BinaryExpr;

export interface FlowTarget {
  readonly kind: "local" | "external";
  readonly name: string;
  readonly span: SourceSpan;
}

export interface FlowCallExpr {
  readonly target: FlowTarget;
  readonly args: readonly ValueExpr[];
  readonly span: SourceSpan;
}

interface InstructionBase {
  readonly span: SourceSpan;
}

export interface AgentInstruction extends InstructionBase {
  readonly op: "agent";
  readonly dst: string;
  readonly agent: SymbolExpr;
  readonly workspace?: ValueExpr;
  readonly memory?: NameExpr;
}

export interface SystemPromptInstruction extends InstructionBase {
  readonly op: "agent.system_prompt";
  readonly agent: NameExpr;
  readonly prompt: ValueExpr;
}

export interface AgentWorkInstruction extends InstructionBase {
  readonly op: "agent.do";
  readonly dst: string;
  readonly agent: NameExpr;
  readonly role?: string;
  readonly input: ValueExpr;
  readonly schema?: SymbolExpr;
}

export interface PromptInstruction extends InstructionBase {
  readonly op: "prompt";
  readonly dst: string;
  readonly source: ValueExpr;
  readonly args: readonly ValueExpr[];
}

export interface InputInstruction extends InstructionBase {
  readonly op: "input";
  readonly dst: string;
  readonly prompt: ValueExpr;
  readonly schema?: SymbolExpr;
}

export interface OperInstruction extends InstructionBase {
  readonly op: "oper";
  readonly dst: string;
  readonly expression: OperExpr;
}

export type ScriptLanguage = "python" | "typescript" | "shell";

export interface ScriptInstruction extends InstructionBase {
  readonly op: "script";
  readonly dst: string;
  readonly language: ScriptLanguage;
  readonly source: string;
  readonly args: readonly ValueExpr[];
}

export interface CallInstruction extends InstructionBase {
  readonly op: "call";
  readonly dst: string;
  readonly target: FlowTarget;
  readonly args: readonly ValueExpr[];
}

export interface DispatchInstruction extends InstructionBase {
  readonly op: "dispatch";
  readonly dst: string;
  readonly calls: readonly FlowCallExpr[];
}

export interface RepeatInstruction extends InstructionBase {
  readonly op: "repeat";
  readonly dst: string;
  readonly count: ValueExpr;
  readonly target: FlowTarget;
  readonly args: readonly ValueExpr[];
}

export interface SyncInstruction extends InstructionBase {
  readonly op: "sync";
  readonly dst: string;
  readonly taskGroup: NameExpr;
  readonly formatter?: SymbolExpr;
}

export interface ForkAction {
  readonly role?: string;
  readonly input: ValueExpr;
  readonly schema?: SymbolExpr;
  readonly span: SourceSpan;
}

export interface ForkInstruction extends InstructionBase {
  readonly op: "fork";
  readonly dst: string;
  readonly sourceAgent: NameExpr;
  readonly action: ForkAction;
}

export interface InvokeInstruction extends InstructionBase {
  readonly op: "invoke";
  readonly dst: string;
  readonly capability: SymbolExpr;
  readonly args: readonly ValueExpr[];
}

export interface MemoryAppendInstruction extends InstructionBase {
  readonly op: "memory.append";
  readonly memory: NameExpr;
  readonly role: string;
  readonly frag: ValueExpr;
}

export interface MemoryCopyInstruction extends InstructionBase {
  readonly op: "memory.copy";
  readonly dst: string;
  readonly memory: NameExpr;
}

export interface AgentWithMemoryInstruction extends InstructionBase {
  readonly op: "agent.with_memory";
  readonly dst: string;
  readonly agent: NameExpr;
  readonly memory: NameExpr;
}

export type AgentControlMode = "route" | "flow";

interface AgentControlInstructionBase extends InstructionBase {
  readonly dst: string;
  readonly agent: NameExpr;
  readonly prompt: ValueExpr;
  readonly nodes: readonly FlowTarget[];
  readonly params: RecordExpr;
  readonly minRoutes?: ValueExpr;
  readonly maxRoutes?: ValueExpr;
}

export interface AgentRouteInstruction extends AgentControlInstructionBase {
  readonly op: "agent.route";
}

export interface AgentFlowInstruction extends AgentControlInstructionBase {
  readonly op: "agent.flow";
  readonly agents: readonly SymbolExpr[];
}

export type AgentControlInstruction = AgentRouteInstruction | AgentFlowInstruction;

export type AflInstruction =
  | AgentInstruction
  | SystemPromptInstruction
  | AgentWorkInstruction
  | PromptInstruction
  | InputInstruction
  | OperInstruction
  | ScriptInstruction
  | CallInstruction
  | DispatchInstruction
  | RepeatInstruction
  | SyncInstruction
  | ForkInstruction
  | InvokeInstruction
  | MemoryAppendInstruction
  | MemoryCopyInstruction
  | AgentWithMemoryInstruction
  | AgentControlInstruction;

export interface JumpTerminator extends InstructionBase {
  readonly op: "jump";
  readonly target: string;
}

export interface BranchTerminator extends InstructionBase {
  readonly op: "branch";
  readonly condition: ValueExpr;
  readonly trueTarget: string;
  readonly falseTarget: string;
}

export interface MatchCase {
  readonly value: PrimitiveValue;
  readonly target: string;
}

export interface MatchTerminator extends InstructionBase {
  readonly op: "match";
  readonly selector: ValueExpr;
  readonly cases: readonly MatchCase[];
  readonly defaultTarget: string;
}

export interface ReturnTerminator extends InstructionBase {
  readonly op: "ret";
  readonly value?: ValueExpr;
}

export interface FailTerminator extends InstructionBase {
  readonly op: "fail";
  readonly error: ValueExpr;
}

export type AflTerminator = JumpTerminator | BranchTerminator | MatchTerminator | ReturnTerminator | FailTerminator;

export interface AflBlock {
  readonly name: string;
  readonly instructions: readonly AflInstruction[];
  readonly terminator: AflTerminator;
  readonly span: SourceSpan;
}

export interface AflNode {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly documentation?: NodeDocumentation;
  readonly blocks: readonly AflBlock[];
  readonly span: SourceSpan;
}

export interface NodeDocumentation {
  readonly description?: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly returns?: string;
}

export interface AflModule {
  readonly nodes: readonly AflNode[];
  readonly sourceName?: string;
}

export function frag(content: string): Frag {
  return { kind: "frag", content };
}

export function isFrag(value: unknown): value is Frag {
  return isObject(value) && value.kind === "frag" && typeof value.content === "string";
}

export function symbol(name: string): SymbolRef {
  if (!name.startsWith("@")) {
    throw new TypeError("symbol name must start with '@'");
  }
  return { kind: "symbol", name: name as `@${string}` };
}

export function isComputeValue(value: unknown): value is ComputeValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isComputeValue);
  }
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (isAflRuntimeValue(value)) return false;
  return Object.values(value).every(isComputeValue);
}

function isAflRuntimeValue(value: Record<string, unknown>): boolean {
  if (value.kind === "frag") return typeof value.content === "string";
  if (value.kind === "symbol") return typeof value.name === "string" && value.name.startsWith("@");
  if (value.kind === "memory") return typeof value.id === "string" && Array.isArray(value.messages);
  if (value.kind === "agent") return typeof value.id === "string" && typeof value.memory === "object";
  return value.kind === "taskGroup" && typeof value.id === "string" && Array.isArray(value.tasks);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
