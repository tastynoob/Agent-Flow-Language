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
  readonly memory?: NameExpr;
}

export interface SystemPromptInstruction extends InstructionBase {
  readonly op: "agent.sysprompt";
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

export interface DispatchListInstruction extends InstructionBase {
  readonly op: "dispatch.list";
  readonly dst: string;
  readonly calls: readonly FlowCallExpr[];
}

export interface DispatchBatchInstruction extends InstructionBase {
  readonly op: "dispatch.batch";
  readonly dst: string;
  readonly count: ValueExpr;
  readonly target: FlowTarget;
  readonly task: ValueExpr;
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
  readonly actionReceiver: string;
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

export interface MemoryApplyInstruction extends InstructionBase {
  readonly op: "memory.apply";
  readonly dst: string;
  readonly sourceAgent: NameExpr;
  readonly memory: NameExpr;
}

export type FreedomMode = "move" | "flow";

export interface FreedomInstruction extends InstructionBase {
  readonly op: "freedom.move" | "freedom.flow";
  readonly dst: string;
  readonly mode: FreedomMode;
  readonly planner: NameExpr;
  readonly moves?: ValueExpr;
  readonly prompt: ValueExpr;
  readonly context: ValueExpr;
  readonly schema?: SymbolExpr;
}

export type AflInstruction =
  | AgentInstruction
  | SystemPromptInstruction
  | AgentWorkInstruction
  | PromptInstruction
  | InputInstruction
  | OperInstruction
  | ScriptInstruction
  | CallInstruction
  | DispatchListInstruction
  | DispatchBatchInstruction
  | SyncInstruction
  | ForkInstruction
  | InvokeInstruction
  | MemoryAppendInstruction
  | MemoryCopyInstruction
  | MemoryApplyInstruction
  | FreedomInstruction;

export interface JumpTerminator extends InstructionBase {
  readonly op: "jump";
  readonly condition?: ValueExpr;
  readonly trueTarget: string;
  readonly falseTarget?: string;
}

export interface ReturnTerminator extends InstructionBase {
  readonly op: "ret";
  readonly value?: ValueExpr;
}

export interface FailTerminator extends InstructionBase {
  readonly op: "fail";
  readonly error: ValueExpr;
}

export type AflTerminator = JumpTerminator | ReturnTerminator | FailTerminator;

export interface AflBlock {
  readonly name: string;
  readonly instructions: readonly AflInstruction[];
  readonly terminator: AflTerminator;
  readonly span: SourceSpan;
}

export interface AflNode {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly blocks: readonly AflBlock[];
  readonly span: SourceSpan;
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
  return isObject(value) && Object.values(value).every(isComputeValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
