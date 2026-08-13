import { AflVmError } from "./errors.js";
import {
  isComputeValue,
  isFrag,
  type ComputeValue,
  type Frag,
  type NameExpr,
  type OperExpr,
  type SourceSpan,
  type ValueExpr,
} from "./ir.js";
import {
  isAgentHandle,
  isMemoryHandle,
  isSymbolRef,
  isTaskGroupHandle,
  type VmValue,
} from "./vm-values.js";

export interface ValueEnvironment {
  readonly values: ReadonlyMap<string, VmValue>;
}

export function evaluateValue(expression: ValueExpr, environment: ValueEnvironment): VmValue {
  switch (expression.kind) {
    case "literal":
      return cloneCompute(expression.value);
    case "symbol":
      return { kind: "symbol", name: expression.name };
    case "name":
      return resolveName(expression, environment);
    case "list": {
      const values = expression.items.map((item) => evaluateValue(item, environment));
      if (!values.every(isComputeValue)) {
        throw vmType("VALUE_LIST_NOT_COMPUTE", "list values must contain compute values", expression.span);
      }
      return values;
    }
    case "record": {
      const result: Record<string, ComputeValue> = {};
      for (const [key, item] of Object.entries(expression.entries)) {
        const value = evaluateValue(item, environment);
        if (!isComputeValue(value)) {
          throw vmType("VALUE_RECORD_NOT_COMPUTE", "record values must contain compute values", item.span);
        }
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
  }
}

export function evaluateOper(expression: OperExpr, environment: ValueEnvironment): ComputeValue {
  if (expression.kind !== "unary" && expression.kind !== "binary") {
    return expectComputeOperand(evaluateValue(expression, environment), expression.span);
  }
  if (expression.kind === "unary") {
    const operand = evaluateOper(expression.operand, environment);
    if (expression.operator === "!") {
      return !expectBoolean(operand, expression.span);
    }
    return -expectNumber(operand, expression.span);
  }
  if (expression.operator === "&") {
    const left = expectBoolean(evaluateOper(expression.left, environment), expression.left.span);
    return left && expectBoolean(evaluateOper(expression.right, environment), expression.right.span);
  }
  if (expression.operator === "|") {
    const left = expectBoolean(evaluateOper(expression.left, environment), expression.left.span);
    return left || expectBoolean(evaluateOper(expression.right, environment), expression.right.span);
  }
  const left = evaluateOper(expression.left, environment);
  const right = evaluateOper(expression.right, environment);
  switch (expression.operator) {
    case "==":
      return equalCompute(left, right);
    case "!=":
      return !equalCompute(left, right);
    case "+":
      if (typeof left === "number" && typeof right === "number") return left + right;
      if (typeof left === "string" && typeof right === "string") return left + right;
      throw vmType("OPER_TYPE_INVALID", "'+' requires two numbers or two strings", expression.span);
    case "-":
      return expectNumber(left, expression.left.span) - expectNumber(right, expression.right.span);
    case "*":
      return expectNumber(left, expression.left.span) * expectNumber(right, expression.right.span);
    case "/": {
      const divisor = expectNumber(right, expression.right.span);
      if (divisor === 0) throw vmType("OPER_DIVIDE_BY_ZERO", "division by zero", expression.span);
      return expectNumber(left, expression.left.span) / divisor;
    }
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(expression.operator, left, right, expression.span);
  }
}

export function asFrag(value: VmValue, span: SourceSpan, label = "value"): Frag {
  if (isFrag(value)) return value;
  if (typeof value === "string") return { kind: "frag", content: value };
  throw vmType("FRAG_REQUIRED", `${label} must be a Frag or string`, span);
}

export function asCompute(value: VmValue, span: SourceSpan, label = "value"): ComputeValue {
  if (isFrag(value)) return value.content;
  if (isComputeValue(value)) return value;
  throw vmType("COMPUTE_REQUIRED", `${label} cannot be used as a compute value`, span);
}

export function asAgent(value: VmValue, span: SourceSpan) {
  if (!isAgentHandle(value)) throw vmType("AGENT_REQUIRED", "value must be an Agent handle", span);
  return value;
}

export function asMemory(value: VmValue, span: SourceSpan) {
  if (!isMemoryHandle(value)) throw vmType("MEMORY_REQUIRED", "value must be a Memory handle", span);
  return value;
}

export function asTaskGroup(value: VmValue, span: SourceSpan) {
  if (!isTaskGroupHandle(value)) throw vmType("TASK_GROUP_REQUIRED", "value must be a TaskGroup handle", span);
  return value;
}

export function asSymbol(value: VmValue, span: SourceSpan) {
  if (!isSymbolRef(value)) throw vmType("SYMBOL_REQUIRED", "value must be an external symbol", span);
  return value;
}

export function formatCompute(value: ComputeValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function resolveName(expression: NameExpr, environment: ValueEnvironment): VmValue {
  const initial = environment.values.get(expression.name);
  if (initial === undefined) {
    throw vmType("VALUE_UNAVAILABLE", `value '${expression.name}' is unavailable`, expression.span);
  }
  let value: VmValue = initial;
  for (const segment of expression.path) {
    if (isAgentHandle(value) && segment === "memory") {
      value = value.memory;
      continue;
    }
    if (isFrag(value) && segment === "content") {
      value = value.content;
      continue;
    }
    if (isComputeValue(value) && typeof value === "object" && value !== null) {
      const next: ComputeValue | undefined = Array.isArray(value) && typeof segment === "number"
        ? value[segment]
        : !Array.isArray(value) && typeof segment === "string"
          ? value[segment]
          : undefined;
      if (next !== undefined) {
        value = next;
        continue;
      }
    }
    throw vmType(
      "VALUE_PATH_INVALID",
      `path segment '${String(segment)}' is unavailable on '${expression.name}'`,
      expression.span,
    );
  }
  return value;
}

function expectComputeOperand(value: VmValue, span: SourceSpan): ComputeValue {
  return isFrag(value) ? value.content : asCompute(value, span, "oper operand");
}

function expectBoolean(value: ComputeValue, span: SourceSpan): boolean {
  if (typeof value !== "boolean") throw vmType("BOOLEAN_REQUIRED", "operand must be boolean", span);
  return value;
}

function expectNumber(value: ComputeValue, span: SourceSpan): number {
  if (typeof value !== "number") throw vmType("NUMBER_REQUIRED", "operand must be numeric", span);
  return value;
}

function compare(operator: "<" | "<=" | ">" | ">=", left: ComputeValue, right: ComputeValue, span: SourceSpan): boolean {
  if ((typeof left !== "number" || typeof right !== "number") &&
      (typeof left !== "string" || typeof right !== "string")) {
    throw vmType("OPER_TYPE_INVALID", `operator '${operator}' requires comparable operands`, span);
  }
  if (typeof left === "number" && typeof right === "number") {
    if (operator === "<") return left < right;
    if (operator === "<=") return left <= right;
    if (operator === ">") return left > right;
    return left >= right;
  }
  const order = String(left).localeCompare(String(right));
  if (operator === "<") return order < 0;
  if (operator === "<=") return order <= 0;
  if (operator === ">") return order > 0;
  return order >= 0;
}

function equalCompute(left: ComputeValue, right: ComputeValue): boolean {
  if (typeof left === "object" && left !== null || typeof right === "object" && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return Object.is(left, right);
}

function cloneCompute<T extends ComputeValue>(value: T): T {
  return structuredClone(value);
}

function vmType(code: string, message: string, span: SourceSpan): AflVmError {
  return new AflVmError(code, message, { span });
}
