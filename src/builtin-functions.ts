import { AflVmError } from "./errors.js";
import { isComputeValue, isFrag, type ComputeValue, type Frag, type SourceSpan } from "./ir.js";

export type AflBuiltinArgument = Frag | ComputeValue;

export interface AflBuiltinFunctionSpec {
  readonly name: `@afl.${string}`;
  readonly minArgs: number;
  readonly maxArgs: number;
}

const BUILTIN_FUNCTIONS = new Map<string, AflBuiltinFunctionSpec>([
  ["@afl.parse.json", { name: "@afl.parse.json", minArgs: 1, maxArgs: 1 }],
  ["@afl.parse.label", { name: "@afl.parse.label", minArgs: 2, maxArgs: 3 }],
]);

const LABEL_VALUE_WRAPPERS: readonly (readonly [string, string])[] = [
  ["**", "**"],
  ["__", "__"],
  ["`", "`"],
  ["\"", "\""],
  ["'", "'"],
];

export function isAflBuiltinName(name: string): boolean {
  return name.startsWith("@afl.");
}

export function getAflBuiltinFunction(name: string): AflBuiltinFunctionSpec | undefined {
  return BUILTIN_FUNCTIONS.get(name);
}

export function computeAflBuiltinFunction(
  name: string,
  args: readonly AflBuiltinArgument[],
  span: SourceSpan,
): ComputeValue {
  const spec = getAflBuiltinFunction(name);
  if (spec === undefined) {
    throw new AflVmError("BUILTIN_FUNCTION_UNKNOWN", `unknown AFL built-in function '${name}'`, { span });
  }
  if (args.length < spec.minArgs || args.length > spec.maxArgs) {
    throw new AflVmError(
      "BUILTIN_FUNCTION_ARITY",
      builtinArityMessage(spec, args.length),
      { span },
    );
  }
  if (name === "@afl.parse.json") {
    return parseJson(textArgument(args[0], name, 1, span), span);
  }
  if (name === "@afl.parse.label") {
    const text = textArgument(args[0], name, 1, span);
    const labels = stringListArgument(args[1], name, 2, true, span);
    const allowed = args[2] === undefined
      ? undefined
      : stringListArgument(args[2], name, 3, false, span);
    return parseLabel(text, labels, allowed, span);
  }
  throw new AflVmError("BUILTIN_FUNCTION_UNKNOWN", `unknown AFL built-in function '${name}'`, { span });
}

function parseJson(text: string, span: SourceSpan): ComputeValue {
  const exact = tryParseJson(text.trim());
  if (exact !== undefined) return exact;

  const candidates: Array<{ readonly end: number; readonly value: ComputeValue }> = [];
  const fences = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/giu;
  for (const match of text.matchAll(fences)) {
    const value = tryParseJson(match[1]!.trim());
    if (value !== undefined) {
      candidates.push({ end: (match.index ?? 0) + match[0].length, value });
    }
  }
  candidates.push(...balancedJsonCandidates(text));
  candidates.sort((left, right) => left.end - right.end);
  const selected = candidates.at(-1);
  if (selected !== undefined) return selected.value;
  throw new AflVmError("BUILTIN_PARSE_JSON_NOT_FOUND", "no complete JSON value was found", { span });
}

function balancedJsonCandidates(
  text: string,
): Array<{ readonly end: number; readonly value: ComputeValue }> {
  const candidates: Array<{ readonly end: number; readonly value: ComputeValue }> = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (stack.length === 0) {
      if (character === "{" || character === "[") {
        start = index;
        stack.push(character);
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const opening = stack.at(-1);
    if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) {
      stack.length = 0;
      start = -1;
      inString = false;
      escaped = false;
      continue;
    }
    stack.pop();
    if (stack.length !== 0 || start < 0) continue;
    const value = tryParseJson(text.slice(start, index + 1));
    if (value !== undefined) candidates.push({ end: index + 1, value });
    start = -1;
  }
  return candidates;
}

function tryParseJson(text: string): ComputeValue | undefined {
  if (text.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isComputeValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseLabel(
  text: string,
  labels: readonly string[],
  allowed: readonly string[] | undefined,
  span: SourceSpan,
): string {
  let selected: string | undefined;
  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = normalizeLabelLine(sourceLine);
    for (const label of labels) {
      const decoration = "(?:\\*\\*|__|`)?";
      const match = new RegExp(
        `^${decoration}${escapeRegExp(label)}${decoration}\\s*[:\\uFF1A]\\s*(.*?)\\s*$`,
        "iu",
      ).exec(line);
      if (match !== null) selected = normalizeLabelValue(match[1]!);
    }
  }
  if (selected === undefined || selected.length === 0) {
    throw new AflVmError(
      "BUILTIN_PARSE_LABEL_NOT_FOUND",
      `none of the requested labels (${labels.join(", ")}) was found`,
      { span },
    );
  }
  if (allowed === undefined) return selected;
  const canonical = allowed.find((value) => value.toLowerCase() === selected!.toLowerCase());
  if (canonical !== undefined) return canonical;
  throw new AflVmError(
    "BUILTIN_PARSE_LABEL_VALUE_INVALID",
    `label value '${selected}' is not in the allowed value list`,
    { span, details: { value: selected, allowed: [...allowed] } },
  );
}

function normalizeLabelLine(line: string): string {
  return line.trim()
    .replace(/^(?:(?:[-+*>]|\d+[.)])\s+|#{1,6}\s*)+/u, "")
    .trim();
}

function normalizeLabelValue(value: string): string {
  let result = value.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wrapper = LABEL_VALUE_WRAPPERS.find(([prefix, suffix]) =>
      result.length >= prefix.length + suffix.length &&
      result.startsWith(prefix) && result.endsWith(suffix));
    if (wrapper === undefined) break;
    const [prefix, suffix] = wrapper;
    result = result.slice(prefix.length, -suffix.length).trim();
    if (result.length === 0) {
      return result;
    }
  }
  return result;
}

function textArgument(
  value: AflBuiltinArgument | undefined,
  name: string,
  position: number,
  span: SourceSpan,
): string {
  if (typeof value === "string") return value;
  if (isFrag(value)) return value.content;
  throw invalidArgument(name, position, "a string or Frag", span);
}

function stringListArgument(
  value: AflBuiltinArgument | undefined,
  name: string,
  position: number,
  allowScalar: boolean,
  span: SourceSpan,
): readonly string[] {
  if (allowScalar && typeof value === "string" && value.trim().length > 0) return [value.trim()];
  if (allowScalar && isFrag(value) && value.content.trim().length > 0) return [value.content.trim()];
  if (Array.isArray(value) && value.length > 0 && value.every((item) =>
    typeof item === "string" && item.trim().length > 0)) {
    return value.map((item) => (item as string).trim());
  }
  throw invalidArgument(name, position, allowScalar ? "a label or non-empty label list" : "a non-empty string list", span);
}

function invalidArgument(name: string, position: number, expected: string, span: SourceSpan): AflVmError {
  return new AflVmError(
    "BUILTIN_FUNCTION_ARGUMENT_INVALID",
    `argument ${position} of '${name}' must be ${expected}`,
    { span },
  );
}

function builtinArityMessage(spec: AflBuiltinFunctionSpec, actual: number): string {
  const expected = spec.minArgs === spec.maxArgs
    ? String(spec.minArgs)
    : `${spec.minArgs}-${spec.maxArgs}`;
  return `'${spec.name}' expects ${expected} arguments, received ${actual}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
