import { FlowRuntimeError } from "./errors.js";
import type { Expr, JsonValue } from "./ir.js";
import { cloneJson, isRecord } from "./value.js";

export interface EvaluationFrame {
  input: JsonValue;
  state: Readonly<Record<string, JsonValue | undefined>>;
  locals: Readonly<Record<string, JsonValue | undefined>>;
}

export function evaluateExpr(expression: Expr, frame: EvaluationFrame): JsonValue {
  switch (expression.kind) {
    case "literal":
      return cloneJson(expression.value);
    case "ref": {
      let value: JsonValue | undefined;
      if (expression.scope === "input") {
        value = frame.input;
        if (expression.name !== undefined) {
          if (!isRecord(value) || !(expression.name in value)) {
            throw new FlowRuntimeError(
              "EXPRESSION_PATH_MISSING",
              `input property '${expression.name}' does not exist`,
            );
          }
          value = value[expression.name] as JsonValue;
        }
      } else {
        const slots = expression.scope === "state" ? frame.state : frame.locals;
        if (expression.name === undefined || !(expression.name in slots)) {
          throw new FlowRuntimeError(
            "EXPRESSION_SLOT_UNINITIALIZED",
            `${expression.scope} slot '${String(expression.name)}' is uninitialized`,
          );
        }
        value = slots[expression.name];
      }
      if (value === undefined) {
        throw new FlowRuntimeError(
          "EXPRESSION_SLOT_UNINITIALIZED",
          `${expression.scope} slot '${String(expression.name)}' is uninitialized`,
        );
      }
      return cloneJson(readPath(value, expression.path ?? []));
    }
    case "object":
      return Object.fromEntries(
        Object.entries(expression.entries).map(([key, value]) => [
          key,
          evaluateExpr(value, frame),
        ]),
      );
    case "array":
      return expression.items.map((item) => evaluateExpr(item, frame));
    case "unary": {
      const value = evaluateExpr(expression.value, frame);
      if (expression.op === "isNull") {
        return value === null;
      }
      if (expression.op === "not") {
        return !expectBoolean(value, "not");
      }
      return -expectNumber(value, "negate");
    }
    case "binary":
      return evaluateBinary(expression, frame);
  }
}

function evaluateBinary(
  expression: Extract<Expr, { kind: "binary" }>,
  frame: EvaluationFrame,
): JsonValue {
  const left = evaluateExpr(expression.left, frame);
  if (expression.op === "and") {
    return expectBoolean(left, "and")
      ? expectBoolean(evaluateExpr(expression.right, frame), "and")
      : false;
  }
  if (expression.op === "or") {
    return expectBoolean(left, "or")
      ? true
      : expectBoolean(evaluateExpr(expression.right, frame), "or");
  }
  if (expression.op === "coalesce") {
    return left === null ? evaluateExpr(expression.right, frame) : left;
  }

  const right = evaluateExpr(expression.right, frame);
  switch (expression.op) {
    case "eq":
      return jsonEquals(left, right);
    case "neq":
      return !jsonEquals(left, right);
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return compare(left, right, expression.op);
    case "add":
      return expectNumber(left, "add") + expectNumber(right, "add");
    case "subtract":
      return expectNumber(left, "subtract") - expectNumber(right, "subtract");
    case "multiply":
      return expectNumber(left, "multiply") * expectNumber(right, "multiply");
    case "divide": {
      const divisor = expectNumber(right, "divide");
      if (divisor === 0) {
        throw new FlowRuntimeError("EXPRESSION_DIVIDE_BY_ZERO", "cannot divide by zero");
      }
      return expectNumber(left, "divide") / divisor;
    }
    case "concat":
      if (typeof left === "string" && typeof right === "string") {
        return left + right;
      }
      if (Array.isArray(left) && Array.isArray(right)) {
        return [...left.map(cloneJson), ...right.map(cloneJson)];
      }
      throw typeError("concat", "two strings or two arrays");
    case "in":
      if (Array.isArray(right)) {
        return right.some((item) => jsonEquals(left, item));
      }
      if (isRecord(right) && typeof left === "string") {
        return left in right;
      }
      throw typeError("in", "an array, or an object with a string key");
  }
}

function readPath(root: JsonValue, path: ReadonlyArray<string | number>): JsonValue {
  let current = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current) || part < 0 || part >= current.length) {
        throw new FlowRuntimeError(
          "EXPRESSION_PATH_MISSING",
          `array index '${part}' does not exist`,
        );
      }
      current = current[part] as JsonValue;
    } else {
      if (!isRecord(current) || !(part in current)) {
        throw new FlowRuntimeError(
          "EXPRESSION_PATH_MISSING",
          `object property '${part}' does not exist`,
        );
      }
      current = current[part] as JsonValue;
    }
  }
  return current;
}

function compare(
  left: JsonValue,
  right: JsonValue,
  operator: "lt" | "lte" | "gt" | "gte",
): boolean {
  if (
    !(
      (typeof left === "number" && typeof right === "number") ||
      (typeof left === "string" && typeof right === "string")
    )
  ) {
    throw typeError(operator, "two numbers or two strings of the same type");
  }
  switch (operator) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
  }
}

function expectBoolean(value: JsonValue, operator: string): boolean {
  if (typeof value !== "boolean") {
    throw typeError(operator, "boolean operands");
  }
  return value;
}

function expectNumber(value: JsonValue, operator: string): number {
  if (typeof value !== "number") {
    throw typeError(operator, "number operands");
  }
  return value;
}

function typeError(operator: string, expected: string): FlowRuntimeError {
  return new FlowRuntimeError(
    "EXPRESSION_TYPE_MISMATCH",
    `operator '${operator}' requires ${expected}`,
  );
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index] as JsonValue))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && jsonEquals(left[key] as JsonValue, right[key] as JsonValue),
      )
    );
  }
  return false;
}
