import type { AgentStandardToolName, ComputeValue, PrimitiveValue } from "../ir.js";
import { isComputeValue } from "../ir.js";
import { parseAfl } from "../parser.js";
import { AGENT_TOOL_PROFILES, type AgentToolProfileName } from "../standard-agent-tools.js";
import { assertValidModule } from "../validation.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SYMBOL = /^@[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u;
const ROLE = /^(?:system|user|assistant|tool|@role\.[A-Za-z_][A-Za-z0-9_.]*)$/u;
const RESERVED_PREFIX = "__afl_";

const STARTS_WITH_SCRIPT = "return String(args[0]).startsWith(String(args[1]))";
const ENDS_WITH_SCRIPT = "return String(args[0]).endsWith(String(args[1]))";
const INCLUDES_SCRIPT = "return String(args[0]).includes(String(args[1]))";

export type AflOperand = AflValue | AflExpression | ComputeValue;
export type AflConditionInput = AflCondition | AflValue | boolean;

export interface AflIrBuilderOptions {
  readonly sourceName?: string;
}

export interface AflNodeDocumentation {
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly returns?: string;
}

export interface AflAgentOptions {
  readonly name?: string;
  readonly workspace?: string | readonly string[] | AflValue;
  readonly memory?: AflValue;
  readonly tools?: AgentToolProfileName | readonly AgentStandardToolName[];
}

export interface AflAgentDoOptions {
  readonly name?: string;
  readonly role?: string;
  readonly schema?: string;
}

type ExpressionEmitter = (builder: AflIrBuilder, destination: string) => void;

/** A lazy AFL value expression. It emits an instruction only when consumed. */
export class AflExpression {
  protected readonly owner: AflIrBuilder;
  protected readonly scope: symbol;
  private readonly emitter: ExpressionEmitter;

  /** @internal Construct expressions through AflValue helpers or AflIrBuilder methods. */
  constructor(owner: AflIrBuilder, scope: symbol, emitter: ExpressionEmitter) {
    this.owner = owner;
    this.scope = scope;
    this.emitter = emitter;
  }

  /** @internal */
  _emitTo(builder: AflIrBuilder, scope: symbol, destination: string): void {
    this.assertOwner(builder, scope);
    this.emitter(builder, destination);
  }

  /** @internal */
  _materialize(builder: AflIrBuilder, scope: symbol, hint = "value"): AflValue {
    this.assertOwner(builder, scope);
    const destination = builder._allocateValue(hint);
    this.emitter(builder, destination);
    return new AflValue(builder, scope, destination);
  }

  private assertOwner(builder: AflIrBuilder, scope: symbol): void {
    if (builder !== this.owner || scope !== this.scope) {
      throw new Error("AFL expressions cannot cross builder or node boundaries");
    }
  }
}

/** A lazy boolean expression accepted by when() and while(). */
export class AflCondition extends AflExpression {
  not(): AflCondition {
    const current = this;
    return new AflCondition(this.owner, this.scope, (builder, destination) => {
      const value = current._materialize(builder, builder._currentScope(), "condition");
      builder._emitAssignment(destination, `oper !${value.reference}`);
    });
  }

  and(other: AflConditionInput): AflCondition {
    return this.combine("&", other);
  }

  or(other: AflConditionInput): AflCondition {
    return this.combine("|", other);
  }

  private combine(operator: "&" | "|", other: AflConditionInput): AflCondition {
    const current = this;
    return new AflCondition(this.owner, this.scope, (builder, destination) => {
      const left = current._materialize(builder, builder._currentScope(), "condition");
      const right = builder._conditionSource(other);
      builder._emitAssignment(destination, `oper ${left.reference} ${operator} ${right}`);
    });
  }
}

/** A reference to an AFL parameter, instruction result, symbol, or path. */
export class AflValue {
  readonly reference: string;
  protected readonly owner: AflIrBuilder;
  protected readonly scope: symbol;

  /** @internal Construct values through AflIrBuilder. */
  constructor(owner: AflIrBuilder, scope: symbol, reference: string) {
    this.owner = owner;
    this.scope = scope;
    this.reference = reference;
  }

  equals(other: AflOperand): AflCondition {
    return this.compare("==", other);
  }

  notEquals(other: AflOperand): AflCondition {
    return this.compare("!=", other);
  }

  lessThan(other: AflOperand): AflCondition {
    return this.compare("<", other);
  }

  lessThanOrEqual(other: AflOperand): AflCondition {
    return this.compare("<=", other);
  }

  greaterThan(other: AflOperand): AflCondition {
    return this.compare(">", other);
  }

  greaterThanOrEqual(other: AflOperand): AflCondition {
    return this.compare(">=", other);
  }

  add(other: AflOperand): AflExpression {
    return this.binary("+", other);
  }

  subtract(other: AflOperand): AflExpression {
    return this.binary("-", other);
  }

  multiply(other: AflOperand): AflExpression {
    return this.binary("*", other);
  }

  divide(other: AflOperand): AflExpression {
    return this.binary("/", other);
  }

  startsWith(prefix: AflOperand): AflCondition {
    return this.textCondition(STARTS_WITH_SCRIPT, prefix);
  }

  endsWith(suffix: AflOperand): AflCondition {
    return this.textCondition(ENDS_WITH_SCRIPT, suffix);
  }

  includes(value: AflOperand): AflCondition {
    return this.textCondition(INCLUDES_SCRIPT, value);
  }

  /** @internal */
  _toAfl(builder: AflIrBuilder, scope: symbol): string {
    if (builder !== this.owner || scope !== this.scope) {
      throw new Error("AFL values cannot cross builder or node boundaries");
    }
    return this.reference;
  }

  toString(): string {
    return this.reference;
  }

  private compare(
    operator: "==" | "!=" | "<" | "<=" | ">" | ">=",
    other: AflOperand,
  ): AflCondition {
    const current = this;
    return new AflCondition(this.owner, this.scope, (builder, destination) => {
      const left = current._toAfl(builder, builder._currentScope());
      const right = builder._operandSource(other);
      builder._emitAssignment(destination, `oper ${left} ${operator} ${right}`);
    });
  }

  private binary(operator: "+" | "-" | "*" | "/", other: AflOperand): AflExpression {
    const current = this;
    return new AflExpression(this.owner, this.scope, (builder, destination) => {
      const left = current._toAfl(builder, builder._currentScope());
      const right = builder._operandSource(other);
      builder._emitAssignment(destination, `oper ${left} ${operator} ${right}`);
    });
  }

  private textCondition(script: string, other: AflOperand): AflCondition {
    const current = this;
    return new AflCondition(this.owner, this.scope, (builder, destination) => {
      const left = current._toAfl(builder, builder._currentScope());
      const right = builder._operandSource(other);
      builder._emitAssignment(destination, `typescript ${quote(script)}, ${left}, ${right}`);
    });
  }
}

/** A stable AFL name that can be rebound in later block activations. */
export class AflVariable extends AflValue {
  set(value: AflOperand): this {
    this.owner._setVariable(this, value);
    return this;
  }
}

export class AflNodeRef<Parameters extends readonly string[] = readonly string[]> {
  readonly name: string;
  readonly parameters: Parameters;
  readonly params: Readonly<Record<Parameters[number], AflValue>>;
  private readonly owner: AflIrBuilder;

  /** @internal Construct nodes through AflIrBuilder.node(). */
  constructor(owner: AflIrBuilder, name: string, parameters: Parameters, scope: symbol) {
    this.owner = owner;
    this.name = name;
    this.parameters = parameters;
    this.params = Object.freeze(Object.fromEntries(
      parameters.map((parameter) => [parameter, new AflValue(owner, scope, parameter)]),
    )) as Readonly<Record<Parameters[number], AflValue>>;
  }

  param<Name extends Parameters[number]>(name: Name): AflValue {
    const value: AflValue | undefined = this.params[name];
    if (value === undefined) throw new Error(`node '${this.name}' has no parameter '${name}'`);
    return value;
  }

  call(...args: readonly AflOperand[]): AflValue {
    return this.owner._callNode(this, args);
  }
}

/** A stateful Agent handle bound to the current generated node. */
export class Agent {
  readonly symbol: string;
  readonly value: AflValue;
  private readonly owner: AflIrBuilder;

  constructor(owner: AflIrBuilder, symbol: string, options: AflAgentOptions = {}) {
    this.owner = owner;
    this.symbol = symbol;
    this.value = owner._declareAgent(symbol, options);
  }

  systemPrompt(prompt: AflOperand): this {
    this.owner._agentSystemPrompt(this, prompt);
    return this;
  }

  do(input: AflOperand, options: AflAgentDoOptions = {}): AflValue {
    return this.owner._agentDo(this, input, options);
  }

  get memory(): AflValue {
    return this.owner._path(this.value, "memory");
  }
}

interface MutableBlock {
  readonly name: string;
  readonly instructions: string[];
  terminator?: string;
}

interface NodeState {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly documentation?: AflNodeDocumentation;
  readonly scope: symbol;
  readonly blocks: MutableBlock[];
  readonly usedNames: Set<string>;
  active: MutableBlock | undefined;
  controlIndex: number;
  valueIndex: number;
}

interface WhenControl {
  readonly kind: "when";
  readonly elseLabel: string;
  readonly endLabel: string;
  phase: "then" | "else";
  thenFallsThrough: boolean;
}

interface WhileControl {
  readonly kind: "while";
  readonly testLabel: string;
  readonly endLabel: string;
}

interface MatchControl {
  readonly kind: "match";
  readonly id: number;
  readonly dispatch: MutableBlock;
  readonly selector: string;
  readonly endLabel: string;
  readonly cases: Array<{ readonly value: PrimitiveValue; readonly label: string }>;
  defaultLabel?: string;
  phase: "waiting" | "case" | "default";
  fallsThrough: boolean;
}

type Control = WhenControl | WhileControl | MatchControl;

/** Builds AFL source directly; it does not expose or retain a second IR. */
export class AflIrBuilder {
  private readonly sourceName: string;
  private readonly nodeNames = new Set<string>();
  private readonly completedNodes: string[] = [];
  private readonly controls: Control[] = [];
  private current: NodeState | undefined;
  private output: string | undefined;

  constructor(options: AflIrBuilderOptions = {}) {
    this.sourceName = options.sourceName ?? "<generated>";
  }

  node(name: string, documentation?: AflNodeDocumentation): AflNodeRef<readonly []>;
  node<const Parameters extends readonly string[]>(
    name: string,
    parameters: Parameters,
    documentation?: AflNodeDocumentation,
  ): AflNodeRef<Parameters>;
  node(
    name: string,
    parametersOrDocumentation: readonly string[] | AflNodeDocumentation = [],
    possibleDocumentation?: AflNodeDocumentation,
  ): AflNodeRef<readonly string[]> {
    this.assertMutable();
    this.finalizeCurrentNode();
    requireName(name, "node name");
    if (this.nodeNames.has(name)) throw new Error(`node '${name}' is already declared`);
    this.nodeNames.add(name);

    const hasParameters = Array.isArray(parametersOrDocumentation);
    const parameters = hasParameters
      ? [...parametersOrDocumentation]
      : [];
    const documentation: AflNodeDocumentation | undefined = hasParameters
      ? possibleDocumentation
      : parametersOrDocumentation as AflNodeDocumentation;
    const seen = new Set<string>();
    for (const parameter of parameters) {
      requireUserName(parameter, "node parameter");
      if (seen.has(parameter)) throw new Error(`node '${name}' repeats parameter '${parameter}'`);
      seen.add(parameter);
    }
    validateDocumentation(name, parameters, documentation);

    const entry: MutableBlock = { name: "entry", instructions: [] };
    const state: NodeState = {
      name,
      parameters,
      ...(documentation === undefined ? {} : { documentation }),
      scope: Symbol(name),
      blocks: [entry],
      usedNames: new Set(parameters),
      active: entry,
      controlIndex: 0,
      valueIndex: 0,
    };
    this.current = state;
    return new AflNodeRef(this, name, parameters, state.scope);
  }

  agent(symbol: string, options: AflAgentOptions = {}): Agent {
    return new Agent(this, symbol, options);
  }

  ref(reference: string): AflValue {
    const state = this.requireCurrent();
    requireLine(reference, "AFL reference");
    const root = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(reference)?.[1];
    if (root === undefined) throw new Error(`invalid AFL reference '${reference}'`);
    return new AflValue(this, state.scope, reference);
  }

  symbol(symbol: string): AflValue {
    requireSymbol(symbol, "AFL symbol");
    return new AflValue(this, this.requireCurrent().scope, symbol);
  }

  variable(name: string, initial: AflOperand): AflVariable {
    const state = this.requireCurrent();
    requireUserName(name, "variable name");
    if (state.usedNames.has(name)) throw new Error(`AFL name '${name}' is already in use`);
    const variable = new AflVariable(this, state.scope, name);
    this._setVariable(variable, initial);
    state.usedNames.add(name);
    return variable;
  }

  emit(instruction: string): this {
    const line = requireLine(instruction, "AFL instruction");
    if (/^(?:jump|branch|match|ret|fail)(?:\s|$)/u.test(line)) {
      throw new Error("use structured control methods such as when/while/match/ret/fail instead of emitting an AFL terminator directly");
    }
    if (line.startsWith("#")) throw new Error("emit() expects an AFL instruction, not a comment");
    const destination = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1];
    if (destination?.startsWith(RESERVED_PREFIX) === true) {
      throw new Error(`AFL names starting with '${RESERVED_PREFIX}' are reserved by the generator`);
    }
    this.appendInstruction(line);
    if (destination !== undefined) this.requireCurrent().usedNames.add(destination);
    return this;
  }

  assign(name: string, instruction: string): AflValue {
    requireUserName(name, "assignment name");
    const rhs = requireLine(instruction, "AFL assignment body");
    this.emit(`${name} = ${rhs}`);
    return new AflValue(this, this.requireCurrent().scope, name);
  }

  oper(expression: string, name?: string): AflValue {
    const destination = name === undefined ? this.allocateValue("value") : this.claimName(name);
    this._emitAssignment(destination, `oper ${requireLine(expression, "oper expression")}`);
    return new AflValue(this, this._currentScope(), destination);
  }

  typescript(source: string, args: readonly AflOperand[] = [], name?: string): AflValue {
    const destination = name === undefined ? this.allocateValue("value") : this.claimName(name);
    const operands = args.map((argument) => this._operandSource(argument));
    this._emitAssignment(
      destination,
      `typescript ${quote(source)}${operands.length === 0 ? "" : `, ${operands.join(", ")}`}`,
    );
    return new AflValue(this, this._currentScope(), destination);
  }

  when(condition: AflConditionInput): this {
    this.requireActive();
    const id = this.nextControlId();
    const conditionSource = this._conditionSource(condition);
    const thenLabel = `${RESERVED_PREFIX}when_${id}_then`;
    const elseLabel = `${RESERVED_PREFIX}when_${id}_else`;
    const endLabel = `${RESERVED_PREFIX}when_${id}_end`;
    this.closeActive(`branch ${conditionSource}, ${thenLabel}, ${elseLabel}`);
    this.openBlock(thenLabel);
    this.controls.push({
      kind: "when",
      elseLabel,
      endLabel,
      phase: "then",
      thenFallsThrough: false,
    });
    return this;
  }

  otherwise(): this {
    const control = this.controls.at(-1);
    if (control?.kind !== "when" || control.phase !== "then") {
      throw new Error("otherwise() must match the nearest open when()");
    }
    control.thenFallsThrough = this.closeFallthrough(control.endLabel);
    control.phase = "else";
    this.openBlock(control.elseLabel);
    return this;
  }

  while(condition: AflConditionInput): this {
    this.requireActive();
    const id = this.nextControlId();
    const testLabel = `${RESERVED_PREFIX}while_${id}_test`;
    const bodyLabel = `${RESERVED_PREFIX}while_${id}_body`;
    const endLabel = `${RESERVED_PREFIX}while_${id}_end`;
    this.closeActive(`jump ${testLabel}`);
    this.openBlock(testLabel);
    const conditionSource = this._conditionSource(condition);
    this.closeActive(`branch ${conditionSource}, ${bodyLabel}, ${endLabel}`);
    this.openBlock(bodyLabel);
    this.controls.push({ kind: "while", testLabel, endLabel });
    return this;
  }

  match(selector: AflOperand): this {
    const dispatch = this.requireActive();
    const id = this.nextControlId();
    const selectorSource = this._operandSource(selector);
    const endLabel = `${RESERVED_PREFIX}match_${id}_end`;
    this.requireCurrent().active = undefined;
    this.controls.push({
      kind: "match",
      id,
      dispatch,
      selector: selectorSource,
      endLabel,
      cases: [],
      phase: "waiting",
      fallsThrough: false,
    });
    return this;
  }

  case(value: PrimitiveValue): this {
    const control = this.requireMatch("case()");
    if (control.phase === "default") throw new Error("case() cannot follow default() in match()");
    if (!isMatchScalar(value)) throw new TypeError("case() requires null, boolean, number, or string");
    if (control.cases.some((entry) => entry.value === value)) {
      throw new Error(`match() repeats case ${JSON.stringify(value)}`);
    }
    if (control.phase === "case") {
      control.fallsThrough = this.closeFallthrough(control.endLabel) || control.fallsThrough;
    }
    const label = `${RESERVED_PREFIX}match_${control.id}_case_${control.cases.length + 1}`;
    control.cases.push({ value, label });
    control.phase = "case";
    this.openBlock(label);
    return this;
  }

  default(): this {
    const control = this.requireMatch("default()");
    if (control.defaultLabel !== undefined) throw new Error("match() can contain only one default()");
    if (control.phase === "case") {
      control.fallsThrough = this.closeFallthrough(control.endLabel) || control.fallsThrough;
    }
    const label = `${RESERVED_PREFIX}match_${control.id}_default`;
    control.defaultLabel = label;
    control.phase = "default";
    this.openBlock(label);
    return this;
  }

  end(): this {
    const control = this.controls.at(-1);
    if (control === undefined) throw new Error("end() has no open when(), while(), or match() to close");
    if (control.kind === "match") {
      if (control.cases.length === 0) throw new Error("match() requires at least one case()");
      if (control.defaultLabel === undefined) throw new Error("match() requires default()");
      this.controls.pop();
      if (control.phase !== "waiting") {
        control.fallsThrough = this.closeFallthrough(control.endLabel) || control.fallsThrough;
      }
      const cases = control.cases.map((entry) => `${serializeCompute(entry.value)}: ${entry.label}`).join(", ");
      control.dispatch.terminator = `match ${control.selector}, [${cases}], ${control.defaultLabel}`;
      if (control.fallsThrough) this.openBlock(control.endLabel);
      return this;
    }
    this.controls.pop();
    if (control.kind === "while") {
      this.closeFallthrough(control.testLabel);
      this.openBlock(control.endLabel);
      return this;
    }

    if (control.phase === "then") {
      this.closeFallthrough(control.endLabel);
      this.openBlock(control.elseLabel);
      this.closeActive(`jump ${control.endLabel}`);
      this.openBlock(control.endLabel);
      return this;
    }

    const elseFallsThrough = this.closeFallthrough(control.endLabel);
    if (control.thenFallsThrough || elseFallsThrough) this.openBlock(control.endLabel);
    return this;
  }

  break(): this {
    const loop = this.findLoop();
    this.closeActive(`jump ${loop.endLabel}`);
    return this;
  }

  continue(): this {
    const loop = this.findLoop();
    this.closeActive(`jump ${loop.testLabel}`);
    return this;
  }

  ret(value?: AflOperand): this {
    const suffix = value === undefined ? "" : ` ${this._operandSource(value)}`;
    this.closeActive(`ret${suffix}`);
    return this;
  }

  fail(error: AflOperand): this {
    this.closeActive(`fail ${this._operandSource(error)}`);
    return this;
  }

  build(): string {
    if (this.output !== undefined) return this.output;
    this.finalizeCurrentNode();
    if (this.completedNodes.length === 0) throw new Error("AFL generator requires at least one node");
    const source = `${this.completedNodes.join("\n\n")}\n`;
    assertValidModule(parseAfl(source, this.sourceName));
    this.output = source;
    return source;
  }

  toString(): string {
    return this.build();
  }

  /** @internal */
  _currentScope(): symbol {
    return this.requireCurrent().scope;
  }

  /** @internal */
  _allocateValue(hint: string): string {
    return this.allocateValue(hint);
  }

  /** @internal */
  _operandSource(value: AflOperand): string {
    const state = this.requireCurrent();
    if (value instanceof AflValue) return value._toAfl(this, state.scope);
    if (value instanceof AflExpression) return value._materialize(this, state.scope).reference;
    if (!isComputeValue(value)) throw new TypeError("AFL operands must be values, expressions, or compute literals");
    return serializeCompute(value);
  }

  /** @internal */
  _conditionSource(condition: AflConditionInput): string {
    if (condition instanceof AflCondition) {
      return condition._materialize(this, this._currentScope(), "condition").reference;
    }
    if (condition instanceof AflValue) return condition._toAfl(this, this._currentScope());
    if (typeof condition === "boolean") return String(condition);
    throw new TypeError("when() and while() require an AFL condition, value, or boolean");
  }

  /** @internal */
  _emitAssignment(destination: string, body: string): void {
    requireName(destination, "assignment destination");
    this.appendInstruction(`${destination} = ${body}`);
    this.requireCurrent().usedNames.add(destination);
  }

  /** @internal */
  _setVariable(variable: AflVariable, value: AflOperand): void {
    const state = this.requireCurrent();
    variable._toAfl(this, state.scope);
    if (value instanceof AflExpression) {
      value._emitTo(this, state.scope, variable.reference);
    } else {
      this._emitAssignment(variable.reference, `oper ${this._operandSource(value)}`);
    }
  }

  /** @internal */
  _callNode(node: AflNodeRef, args: readonly AflOperand[]): AflValue {
    if (args.length !== node.parameters.length) {
      throw new Error(`node '${node.name}' expects ${node.parameters.length} arguments, received ${args.length}`);
    }
    const destination = this.allocateValue("result");
    const operands = args.map((argument) => this._operandSource(argument));
    this._emitAssignment(
      destination,
      `call ${node.name}(${operands.join(", ")})`,
    );
    return new AflValue(this, this._currentScope(), destination);
  }

  /** @internal */
  _declareAgent(symbol: string, options: AflAgentOptions): AflValue {
    requireSymbol(symbol, "Agent symbol");
    const hint = symbol.split(".").at(-1) ?? "agent";
    const destination = options.name === undefined ? this.allocateValue(hint) : this.claimName(options.name);
    const workspace = options.workspace === undefined
      ? undefined
      : options.workspace instanceof AflValue
        ? options.workspace._toAfl(this, this._currentScope())
        : serializeCompute(typeof options.workspace === "string" ? options.workspace : [...options.workspace]);
    const memory = options.memory?._toAfl(this, this._currentScope());
    if (typeof options.tools === "string" && !Object.hasOwn(AGENT_TOOL_PROFILES, options.tools)) {
      throw new TypeError(`unknown Agent tool profile '${options.tools}'`);
    }
    const tools = options.tools === undefined
      ? undefined
      : serializeCompute(typeof options.tools === "string" ? options.tools : [...options.tools]);
    const optionEntries = [
      ...(workspace === undefined ? [] : [`workspace: ${workspace}`]),
      ...(memory === undefined ? [] : [`memory: ${memory}`]),
      ...(tools === undefined ? [] : [`tools: ${tools}`]),
    ];
    this._emitAssignment(
      destination,
      `agent ${symbol}${optionEntries.length === 0 ? "" : `, [${optionEntries.join(", ")}]`}`,
    );
    return new AflValue(this, this._currentScope(), destination);
  }

  /** @internal */
  _agentSystemPrompt(agent: Agent, prompt: AflOperand): void {
    const handle = agent.value._toAfl(this, this._currentScope());
    this.appendInstruction(`${handle}.system_prompt ${this._operandSource(prompt)}`);
  }

  /** @internal */
  _agentDo(agent: Agent, input: AflOperand, options: AflAgentDoOptions): AflValue {
    const handle = agent.value._toAfl(this, this._currentScope());
    if (options.role !== undefined && !ROLE.test(options.role)) {
      throw new Error(`invalid Agent role '${options.role}'`);
    }
    if (options.schema !== undefined) requireSchemaSymbol(options.schema, "Agent schema");
    const destination = options.name === undefined ? this.allocateValue("result") : this.claimName(options.name);
    const optionEntries = [
      ...(options.role === undefined ? [] : [`role: ${options.role}`]),
      ...(options.schema === undefined ? [] : [`schema: ${options.schema}`]),
    ];
    this._emitAssignment(
      destination,
      `${handle}.do ${this._operandSource(input)}${optionEntries.length === 0 ? "" : `, [${optionEntries.join(", ")}]`}`,
    );
    return new AflValue(this, this._currentScope(), destination);
  }

  /** @internal */
  _path(value: AflValue, segment: string): AflValue {
    const source = value._toAfl(this, this._currentScope());
    requireName(segment, "path segment");
    return new AflValue(this, this._currentScope(), `${source}.${segment}`);
  }

  private assertMutable(): void {
    if (this.output !== undefined) throw new Error("AFL builder is already built");
  }

  private requireCurrent(): NodeState {
    this.assertMutable();
    if (this.current === undefined) throw new Error("declare a node before emitting AFL instructions");
    return this.current;
  }

  private requireActive(): MutableBlock {
    const active = this.requireCurrent().active;
    if (active === undefined) throw new Error("the current control-flow path is already terminated");
    return active;
  }

  private appendInstruction(instruction: string): void {
    this.requireActive().instructions.push(instruction);
  }

  private closeActive(terminator: string): void {
    const state = this.requireCurrent();
    const active = this.requireActive();
    active.terminator = terminator;
    state.active = undefined;
  }

  private closeFallthrough(target: string): boolean {
    if (this.requireCurrent().active === undefined) return false;
    this.closeActive(`jump ${target}`);
    return true;
  }

  private openBlock(name: string): void {
    const state = this.requireCurrent();
    if (state.active !== undefined) throw new Error("cannot open a block before terminating the current block");
    const block: MutableBlock = { name, instructions: [] };
    state.blocks.push(block);
    state.active = block;
  }

  private nextControlId(): number {
    const state = this.requireCurrent();
    state.controlIndex += 1;
    return state.controlIndex;
  }

  private findLoop(): WhileControl {
    this.requireActive();
    for (let index = this.controls.length - 1; index >= 0; index -= 1) {
      const control = this.controls[index]!;
      if (control.kind === "while") return control;
    }
    throw new Error("break() and continue() require an open while()");
  }

  private requireMatch(method: string): MatchControl {
    const control = this.controls.at(-1);
    if (control?.kind !== "match") throw new Error(`${method} must match the nearest open match()`);
    return control;
  }

  private allocateValue(hint: string): string {
    const state = this.requireCurrent();
    const base = sanitizeName(hint) || "value";
    while (true) {
      state.valueIndex += 1;
      const candidate = `${base}_${state.valueIndex}`;
      if (state.usedNames.has(candidate)) continue;
      state.usedNames.add(candidate);
      return candidate;
    }
  }

  private claimName(name: string): string {
    requireUserName(name, "AFL value name");
    const state = this.requireCurrent();
    if (state.usedNames.has(name)) throw new Error(`AFL name '${name}' is already in use`);
    state.usedNames.add(name);
    return name;
  }

  private finalizeCurrentNode(): void {
    const state = this.current;
    if (state === undefined) return;
    if (this.controls.length > 0) {
      const control = this.controls.at(-1)!;
      throw new Error(`node '${state.name}' has an unclosed ${control.kind}(); call end()`);
    }
    if (state.active !== undefined) {
      throw new Error(`node '${state.name}' has a reachable path without ret() or fail()`);
    }
    this.completedNodes.push(renderNode(state));
    this.current = undefined;
  }
}

function renderNode(node: NodeState): string {
  const lines = [`${node.name}(${node.parameters.join(", ")}):`];
  const documentation = node.documentation;
  if (documentation?.description !== undefined) {
    lines.push(`    # @description ${documentation.description}`);
  }
  for (const parameter of node.parameters) {
    const description = documentation?.parameters?.[parameter];
    if (description !== undefined) lines.push(`    # @param ${parameter} ${description}`);
  }
  if (documentation?.returns !== undefined) lines.push(`    # @returns ${documentation.returns}`);
  node.blocks.forEach((block, index) => {
    if (index > 0 || lines.length > 1) lines.push("");
    lines.push(`    ${block.name}:`);
    lines.push(...block.instructions.map((instruction) => `        ${instruction}`));
    if (block.terminator === undefined) throw new Error(`generated block '${block.name}' has no terminator`);
    lines.push(`        ${block.terminator}`);
  });
  return lines.join("\n");
}

function validateDocumentation(
  node: string,
  parameters: readonly string[],
  documentation: AflNodeDocumentation | undefined,
): void {
  if (documentation === undefined) return;
  if (documentation.description !== undefined) requireDocumentationLine(documentation.description, "description");
  if (documentation.returns !== undefined) requireDocumentationLine(documentation.returns, "returns");
  const known = new Set(parameters);
  for (const [parameter, description] of Object.entries(documentation.parameters ?? {})) {
    if (!known.has(parameter)) throw new Error(`documentation for node '${node}' references unknown parameter '${parameter}'`);
    requireDocumentationLine(description, `parameter '${parameter}'`);
  }
}

function requireDocumentationLine(value: string, label: string): void {
  if (value.trim().length === 0 || /[\r\n]/u.test(value)) {
    throw new Error(`node ${label} must be non-empty single-line text`);
  }
}

function requireName(value: string, label: string): void {
  if (!NAME.test(value)) throw new Error(`${label} '${value}' is not a valid AFL name`);
}

function requireUserName(value: string, label: string): void {
  requireName(value, label);
  if (value.startsWith(RESERVED_PREFIX)) {
    throw new Error(`${label} cannot start with reserved prefix '${RESERVED_PREFIX}'`);
  }
}

function requireSymbol(value: string, label: string): void {
  if (!SYMBOL.test(value)) throw new Error(`${label} '${value}' is not a valid AFL symbol`);
}

function requireSchemaSymbol(value: string, label: string): void {
  requireSymbol(value, label);
  if (!value.startsWith("@schema.")) {
    throw new Error(`${label} '${value}' must start with '@schema.'`);
  }
}

function requireLine(value: string, label: string): string {
  const line = value.trim();
  if (line.length === 0 || /[\r\n]/u.test(line)) throw new Error(`${label} must be one non-empty line`);
  return line;
}

function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/gu, "_").replace(/^[^A-Za-z_]+/u, "");
  return sanitized.startsWith(RESERVED_PREFIX) ? `value_${sanitized}` : sanitized;
}

function isMatchScalar(value: ComputeValue): value is PrimitiveValue {
  return value === null || typeof value === "boolean" || typeof value === "string" ||
    typeof value === "number" && Number.isFinite(value);
}

function serializeCompute(value: ComputeValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("AFL compute value is not serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(serializeCompute).join(", ")}]`;
  const entries = Object.entries(value);
  if (entries.length === 0) return "[:]";
  return `[${entries.map(([key, item]) => `${serializeRecordKey(key)}: ${serializeCompute(item)}`).join(", ")}]`;
}

function serializeRecordKey(key: string): string {
  return NAME.test(key) ? key : JSON.stringify(key);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
