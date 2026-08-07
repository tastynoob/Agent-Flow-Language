import { AflParseError, type AflDiagnostic } from "./errors.js";
import type {
  AflBlock,
  AflInstruction,
  AflModule,
  AflNode,
  AflTerminator,
  FlowCallExpr,
  FlowTarget,
  ForkAction,
  NameExpr,
  NodeDocumentation,
  OperExpr,
  RecordExpr,
  SourceSpan,
  SymbolExpr,
  ValueExpr,
} from "./ir.js";

interface SourceLine {
  readonly number: number;
  readonly indent: number;
  readonly text: string;
  readonly span: SourceSpan;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ROLE_NAMES = new Set(["system", "user", "assistant", "tool"]);

export function parseAfl(source: string, sourceName?: string): AflModule {
  const diagnostics: AflDiagnostic[] = [];
  const lines = prepareLines(source, sourceName, diagnostics);
  const rawLines = source.replace(/\r\n?/gu, "\n").split("\n");
  if (diagnostics.length > 0) {
    throw new AflParseError(diagnostics);
  }

  const nodes: AflNode[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const header = lines[cursor]!;
    if (header.indent !== 0) {
      throw parseError("PARSE_NODE_INDENT", "node declaration must start at column 1", header, sourceName);
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\):$/u.exec(header.text);
    if (match === null) {
      throw parseError("PARSE_NODE_HEADER", "expected node declaration 'name(args):'", header, sourceName);
    }
    const name = match[1]!;
    const parameters = splitTopLevel(match[2]!).map((item) => item.trim()).filter(Boolean);
    for (const parameter of parameters) {
      if (!NAME.test(parameter)) {
        throw parseError("PARSE_PARAMETER", `invalid parameter '${parameter}'`, header, sourceName);
      }
    }
    const documentation = parseNodeDocumentation(rawLines, header, sourceName);
    cursor += 1;
    const blocks: AflBlock[] = [];
    while (cursor < lines.length && lines[cursor]!.indent > 0) {
      const blockHeader = lines[cursor]!;
      if (blockHeader.indent !== 4 || !/^([A-Za-z_][A-Za-z0-9_]*):$/u.test(blockHeader.text)) {
        throw parseError("PARSE_BLOCK_HEADER", "expected block label indented by four spaces", blockHeader, sourceName);
      }
      const blockName = blockHeader.text.slice(0, -1);
      cursor += 1;
      const instructions: AflInstruction[] = [];
      let terminator: AflTerminator | undefined;
      while (cursor < lines.length && lines[cursor]!.indent > 4) {
        const line = lines[cursor]!;
        if (line.indent !== 8) {
          throw parseError("PARSE_INSTRUCTION_INDENT", "instruction must be indented by eight spaces", line, sourceName);
        }
        const parsed = parseStatement(line, sourceName);
        if (isTerminator(parsed)) {
          if (terminator !== undefined) {
            throw parseError("PARSE_TERMINATOR_DUPLICATE", "basic block has more than one terminator", line, sourceName);
          }
          terminator = parsed;
        } else {
          if (terminator !== undefined) {
            throw parseError("PARSE_AFTER_TERMINATOR", "instruction cannot follow a block terminator", line, sourceName);
          }
          instructions.push(parsed);
        }
        cursor += 1;
      }
      if (terminator === undefined) {
        throw parseError("PARSE_TERMINATOR_MISSING", `block '${blockName}' requires a terminator`, blockHeader, sourceName);
      }
      blocks.push({ name: blockName, instructions, terminator, span: blockHeader.span });
    }
    if (blocks.length === 0) {
      throw parseError("PARSE_BLOCK_MISSING", `node '${name}' requires at least one block`, header, sourceName);
    }
    nodes.push({
      name,
      parameters,
      ...(documentation === undefined ? {} : { documentation }),
      blocks,
      span: header.span,
    });
  }

  return { nodes, ...(sourceName === undefined ? {} : { sourceName }) };
}

function parseNodeDocumentation(
  rawLines: readonly string[],
  header: SourceLine,
  sourceName?: string,
): NodeDocumentation | undefined {
  let description: string | undefined;
  let returns: string | undefined;
  const parameters: Record<string, string> = {};
  let found = false;
  for (let index = header.number; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent !== 4 || !trimmed.startsWith("#")) break;
    const directive = /^#\s+@(description|param|returns)\b\s*(.*)$/u.exec(trimmed);
    if (directive === null) continue;
    found = true;
    const line = sourceLineForDocumentation(raw, index + 1);
    const kind = directive[1]!;
    const body = directive[2]!.trim();
    if (kind === "description") {
      if (body.length === 0) {
        throw parseError("PARSE_NODE_DOCUMENTATION", "@description requires text", line, sourceName);
      }
      if (description !== undefined) {
        throw parseError("PARSE_NODE_DOCUMENTATION", "Node has more than one @description", line, sourceName);
      }
      description = body;
      continue;
    }
    if (kind === "returns") {
      if (body.length === 0) {
        throw parseError("PARSE_NODE_DOCUMENTATION", "@returns requires text", line, sourceName);
      }
      if (returns !== undefined) {
        throw parseError("PARSE_NODE_DOCUMENTATION", "Node has more than one @returns", line, sourceName);
      }
      returns = body;
      continue;
    }
    const parameter = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/u.exec(body);
    if (parameter === null) {
      throw parseError("PARSE_NODE_DOCUMENTATION", "@param requires a parameter name and text", line, sourceName);
    }
    const name = parameter[1]!;
    if (parameters[name] !== undefined) {
      throw parseError("PARSE_NODE_DOCUMENTATION", `@param '${name}' is documented more than once`, line, sourceName);
    }
    parameters[name] = parameter[2]!.trim();
  }
  if (!found) return undefined;
  return {
    ...(description === undefined ? {} : { description }),
    parameters,
    ...(returns === undefined ? {} : { returns }),
  };
}

function sourceLineForDocumentation(raw: string, number: number): SourceLine {
  const indent = raw.length - raw.trimStart().length;
  return {
    number,
    indent,
    text: raw.slice(indent),
    span: { line: number, column: indent + 1, endColumn: raw.length + 1 },
  };
}

function prepareLines(
  source: string,
  sourceName: string | undefined,
  diagnostics: AflDiagnostic[],
): SourceLine[] {
  const result: SourceLine[] = [];
  source.replace(/\r\n?/gu, "\n").split("\n").forEach((raw, index) => {
    const lineNumber = index + 1;
    if (raw.includes("\t")) {
      diagnostics.push({
        code: "PARSE_TAB_INDENT",
        message: "tabs are not allowed in AFL source",
        span: { line: lineNumber, column: 1, endColumn: raw.length + 1 },
        ...(sourceName === undefined ? {} : { sourceName }),
      });
      return;
    }
    const withoutComment = stripComment(raw).trimEnd();
    if (withoutComment.trim().length === 0) {
      return;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    if (indent % 4 !== 0) {
      diagnostics.push({
        code: "PARSE_INDENT_WIDTH",
        message: "indentation must use multiples of four spaces",
        span: { line: lineNumber, column: 1, endColumn: indent + 1 },
        ...(sourceName === undefined ? {} : { sourceName }),
      });
      return;
    }
    result.push({
      number: lineNumber,
      indent,
      text: withoutComment.slice(indent),
      span: { line: lineNumber, column: indent + 1, endColumn: withoutComment.length + 1 },
    });
  });
  return result;
}

function stripComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "#" && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseStatement(line: SourceLine, sourceName?: string): AflInstruction | AflTerminator {
  if (line.text === "ret") {
    return { op: "ret", span: line.span };
  }
  if (line.text.startsWith("ret ")) {
    return { op: "ret", value: parseValue(line.text.slice(4), line, sourceName), span: line.span };
  }
  if (line.text.startsWith("fail ")) {
    return { op: "fail", error: parseValue(line.text.slice(5), line, sourceName), span: line.span };
  }
  if (line.text.startsWith("jump ")) {
    const operands = splitTopLevel(line.text.slice(5));
    if (operands.length === 1) {
      const target = operands[0]!.trim();
      requireName(target, line, sourceName, "jump target");
      return { op: "jump", trueTarget: target, span: line.span };
    }
    if (operands.length === 3) {
      const trueTarget = operands[1]!.trim();
      const falseTarget = operands[2]!.trim();
      requireName(trueTarget, line, sourceName, "jump target");
      requireName(falseTarget, line, sourceName, "jump target");
      return {
        op: "jump",
        condition: parseValue(operands[0]!, line, sourceName),
        trueTarget,
        falseTarget,
        span: line.span,
      };
    }
    throw parseError("PARSE_JUMP", "jump expects one target or condition, true target, false target", line, sourceName);
  }

  if (line.text.startsWith("memory.append ")) {
    const operands = requireOperandCount(splitTopLevel(line.text.slice(14)), 3, line, sourceName, "memory.append");
    const role = operands[1]!.trim();
    requireRole(role, line, sourceName);
    return {
      op: "memory.append",
      memory: parseName(operands[0]!, line, sourceName),
      role,
      frag: parseValue(operands[2]!, line, sourceName),
      span: line.span,
    };
  }

  const systemPrompt = /^([A-Za-z_][A-Za-z0-9_]*)\.sysprompt\s+(.+)$/u.exec(line.text);
  if (systemPrompt !== null) {
    return {
      op: "agent.sysprompt",
      agent: parseName(systemPrompt[1]!, line, sourceName),
      prompt: parseValue(systemPrompt[2]!, line, sourceName),
      span: line.span,
    };
  }

  const assignment = splitAssignment(line.text);
  if (assignment === undefined) {
    throw parseError("PARSE_INSTRUCTION", "expected an assignment, effect instruction, or terminator", line, sourceName);
  }
  const [dst, rhs] = assignment;
  requireName(dst, line, sourceName, "destination");
  return parseAssignedInstruction(dst, rhs, line, sourceName);
}

function parseAssignedInstruction(
  dst: string,
  rhs: string,
  line: SourceLine,
  sourceName?: string,
): AflInstruction {
  if (rhs.startsWith("agent ")) {
    const operands = splitTopLevel(rhs.slice(6));
    if (operands.length < 1 || operands.length > 3 || operands[0]!.trim().length === 0) {
      throw parseError("PARSE_AGENT", "agent expects a symbol, optional Workspace, and optional Memory", line, sourceName);
    }
    if (operands.length === 2 && operands[1]!.trim().length === 0) {
      throw parseError("PARSE_AGENT", "agent cannot end with an empty Workspace operand", line, sourceName);
    }
    if (operands.length === 3 && operands[2]!.trim().length === 0) {
      throw parseError("PARSE_AGENT", "agent cannot end with an empty Memory operand", line, sourceName);
    }
    return {
      op: "agent",
      dst,
      agent: parseSymbol(operands[0]!, line, sourceName),
      ...(operands[1] === undefined || operands[1].trim().length === 0
        ? {}
        : { workspace: parseValue(operands[1], line, sourceName) }),
      ...(operands[2] === undefined ? {} : { memory: parseName(operands[2], line, sourceName) }),
      span: line.span,
    };
  }

  const agentWork = /^([A-Za-z_][A-Za-z0-9_]*)\.do\s+(.+)$/u.exec(rhs);
  if (agentWork !== null) {
    return {
      op: "agent.do",
      dst,
      agent: parseName(agentWork[1]!, line, sourceName),
      ...parseAgentWorkOperands(agentWork[2]!, line, sourceName),
      span: line.span,
    };
  }

  if (rhs.startsWith("prompt ")) {
    const operands = splitTopLevel(rhs.slice(7));
    if (operands.length === 0) {
      throw parseError("PARSE_PROMPT", "prompt expects a source", line, sourceName);
    }
    return {
      op: "prompt",
      dst,
      source: parseValue(operands[0]!, line, sourceName),
      args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }

  if (rhs.startsWith("input ")) {
    const operands = splitTopLevel(rhs.slice(6));
    if (operands.length < 1 || operands.length > 2) {
      throw parseError("PARSE_INPUT", "input expects a prompt and optional schema", line, sourceName);
    }
    return {
      op: "input",
      dst,
      prompt: parseValue(operands[0]!, line, sourceName),
      ...(operands[1] === undefined ? {} : { schema: parseSchema(operands[1], line, sourceName) }),
      span: line.span,
    };
  }

  if (rhs.startsWith("oper ")) {
    return { op: "oper", dst, expression: parseOper(rhs.slice(5), line, sourceName), span: line.span };
  }

  for (const language of ["python", "typescript", "shell"] as const) {
    const prefix = `${language} `;
    if (rhs.startsWith(prefix)) {
      const operands = splitTopLevel(rhs.slice(prefix.length));
      if (operands.length === 0) {
        throw parseError("PARSE_SCRIPT", `${language} expects a quoted script`, line, sourceName);
      }
      const source = parseStringLiteral(operands[0]!, line, sourceName);
      return {
        op: "script",
        dst,
        language,
        source,
        args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
        span: line.span,
      };
    }
  }

  if (rhs.startsWith("call ")) {
    const operands = splitTopLevel(rhs.slice(5));
    if (operands.length === 0) {
      throw parseError("PARSE_CALL", "call expects a flow", line, sourceName);
    }
    return {
      op: "call",
      dst,
      target: parseFlowTarget(operands[0]!, line, sourceName),
      args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }

  if (rhs.startsWith("dispatch ")) {
    const body = rhs.slice(9).trim();
    if (body.startsWith("[")) {
      if (!body.endsWith("]")) {
        throw parseError("PARSE_DISPATCH_LIST", "dispatch list is missing closing ']'", line, sourceName);
      }
      const calls = splitTopLevel(body.slice(1, -1)).filter((item) => item.trim().length > 0)
        .map((item) => parseFlowCall(item, line, sourceName));
      return { op: "dispatch.list", dst, calls, span: line.span };
    }
    const operands = requireOperandCount(splitTopLevel(body), 3, line, sourceName, "dispatch batch");
    return {
      op: "dispatch.batch",
      dst,
      count: parseValue(operands[0]!, line, sourceName),
      target: parseFlowTarget(operands[1]!, line, sourceName),
      task: parseValue(operands[2]!, line, sourceName),
      span: line.span,
    };
  }

  if (rhs.startsWith("fork ")) {
    const operands = requireOperandCount(splitTopLevel(rhs.slice(5)), 2, line, sourceName, "fork");
    const actionMatch = /^([A-Za-z_][A-Za-z0-9_]*)\.do\s+(.+)$/u.exec(operands[1]!.trim());
    if (actionMatch === null) {
      throw parseError("PARSE_FORK_ACTION", "fork action must be 'dst.do ...'", line, sourceName);
    }
    const action: ForkAction = {
      ...parseAgentWorkOperands(actionMatch[2]!, line, sourceName),
      span: line.span,
    };
    return {
      op: "fork",
      dst,
      sourceAgent: parseName(operands[0]!, line, sourceName),
      actionReceiver: actionMatch[1]!,
      action,
      span: line.span,
    };
  }

  if (rhs.startsWith("sync ")) {
    const operands = splitTopLevel(rhs.slice(5));
    if (operands.length < 1 || operands.length > 2) {
      throw parseError("PARSE_SYNC", "sync expects a TaskGroup and optional formatter", line, sourceName);
    }
    return {
      op: "sync",
      dst,
      taskGroup: parseName(operands[0]!, line, sourceName),
      ...(operands[1] === undefined ? {} : { formatter: parseSymbol(operands[1], line, sourceName) }),
      span: line.span,
    };
  }

  if (rhs.startsWith("invoke ")) {
    const operands = splitTopLevel(rhs.slice(7));
    if (operands.length === 0) {
      throw parseError("PARSE_INVOKE", "invoke expects a capability symbol", line, sourceName);
    }
    return {
      op: "invoke",
      dst,
      capability: parseSymbol(operands[0]!, line, sourceName),
      args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }

  if (rhs.startsWith("memory.copy ")) {
    return { op: "memory.copy", dst, memory: parseName(rhs.slice(12), line, sourceName), span: line.span };
  }

  if (rhs.startsWith("memory.apply ")) {
    const operands = requireOperandCount(splitTopLevel(rhs.slice(13)), 2, line, sourceName, "memory.apply");
    return {
      op: "memory.apply",
      dst,
      sourceAgent: parseName(operands[0]!, line, sourceName),
      memory: parseName(operands[1]!, line, sourceName),
      span: line.span,
    };
  }

  if (rhs.startsWith("freedom.route ")) {
    const operands = splitTopLevel(rhs.slice(13));
    if (operands.length !== 5) {
      throw parseError(
        "PARSE_FREEDOM_ROUTE",
        "freedom.route expects planner, prompt, constraint, Node allowlist, and controlled params",
        line,
        sourceName,
      );
    }
    return {
      op: "freedom.route",
      dst,
      planner: parseName(operands[0]!, line, sourceName),
      prompt: parseValue(operands[1]!, line, sourceName),
      constraint: parseRecord(operands[2]!, line, sourceName, "Freedom constraint"),
      nodes: parseLocalNodeList(operands[3]!, line, sourceName),
      params: parseRecord(operands[4]!, line, sourceName, "Freedom controlled params"),
      span: line.span,
    };
  }

  if (rhs.startsWith("freedom.flow ")) {
    const operands = splitTopLevel(rhs.slice(13));
    if (operands.length !== 6) {
      throw parseError(
        "PARSE_FREEDOM_FLOW",
        "freedom.flow expects writer, prompt, constraint, Node allowlist, Agent allowlist, and controlled params",
        line,
        sourceName,
      );
    }
    return {
      op: "freedom.flow",
      dst,
      planner: parseName(operands[0]!, line, sourceName),
      prompt: parseValue(operands[1]!, line, sourceName),
      constraint: parseRecord(operands[2]!, line, sourceName, "Freedom constraint"),
      nodes: parseLocalNodeList(operands[3]!, line, sourceName),
      agents: parseAgentSymbolList(operands[4]!, line, sourceName),
      params: parseRecord(operands[5]!, line, sourceName, "Freedom controlled params"),
      span: line.span,
    };
  }

  throw parseError("PARSE_OPCODE", `unknown instruction '${rhs.split(/\s/u, 1)[0] ?? rhs}'`, line, sourceName);
}

function parseAgentWorkOperands(
  text: string,
  line: SourceLine,
  sourceName?: string,
): { role?: string; input: ValueExpr; schema?: SymbolExpr } {
  const operands = splitTopLevel(text);
  if (operands.length === 0 || operands.length > 3) {
    throw parseError("PARSE_AGENT_WORK", "Agent work expects input with optional role and schema", line, sourceName);
  }
  let role: string | undefined;
  if (operands.length >= 2 && isRole(operands[0]!.trim())) {
    role = operands.shift()!.trim();
  }
  let schema: SymbolExpr | undefined;
  if (operands.length === 2 && operands[1]!.trim().startsWith("@schema.")) {
    schema = parseSchema(operands.pop()!, line, sourceName);
  }
  if (operands.length !== 1) {
    throw parseError("PARSE_AGENT_WORK", "Agent work has an invalid role/input/schema combination", line, sourceName);
  }
  return {
    ...(role === undefined ? {} : { role }),
    input: parseValue(operands[0]!, line, sourceName),
    ...(schema === undefined ? {} : { schema }),
  };
}

function parseFlowCall(text: string, line: SourceLine, sourceName?: string): FlowCallExpr {
  const trimmed = text.trim();
  const open = findTopLevelCharacter(trimmed, "(");
  if (open <= 0 || !trimmed.endsWith(")")) {
    throw parseError("PARSE_FLOW_CALL", `invalid flow call '${trimmed}'`, line, sourceName);
  }
  const target = parseFlowTarget(trimmed.slice(0, open), line, sourceName);
  const argsText = trimmed.slice(open + 1, -1);
  const args = argsText.trim().length === 0
    ? []
    : splitTopLevel(argsText).map((item) => parseValue(item, line, sourceName));
  return { target, args, span: line.span };
}

function parseFlowTarget(text: string, line: SourceLine, sourceName?: string): FlowTarget {
  const value = text.trim();
  if (value.startsWith("@")) {
    const symbol = parseSymbol(value, line, sourceName);
    if (!symbol.name.startsWith("@flow.")) {
      throw parseError("PARSE_FLOW_SYMBOL", "external flow symbol must start with '@flow.'", line, sourceName);
    }
    return { kind: "external", name: symbol.name, span: line.span };
  }
  requireName(value, line, sourceName, "flow name");
  return { kind: "local", name: value, span: line.span };
}

function parseLocalNodeList(text: string, line: SourceLine, sourceName?: string): FlowTarget[] {
  const value = text.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw parseError("PARSE_FREEDOM_NODES", "Freedom Node allowlist must be a list", line, sourceName);
  }
  const body = value.slice(1, -1).trim();
  if (body.length === 0) return [];
  return splitTopLevel(body).map((item) => {
    const name = item.trim();
    requireName(name, line, sourceName, "Freedom Node");
    return { kind: "local", name, span: line.span };
  });
}

function parseAgentSymbolList(text: string, line: SourceLine, sourceName?: string): SymbolExpr[] {
  const value = text.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw parseError("PARSE_FREEDOM_AGENTS", "Freedom Agent allowlist must be a list", line, sourceName);
  }
  const body = value.slice(1, -1).trim();
  if (body.length === 0) return [];
  return splitTopLevel(body).map((item) => {
    const agent = parseSymbol(item, line, sourceName);
    if (!agent.name.startsWith("@agent.")) {
      throw parseError(
        "PARSE_FREEDOM_AGENT_SYMBOL",
        "Freedom Agent symbols must start with '@agent.'",
        line,
        sourceName,
      );
    }
    return agent;
  });
}

function parseRecord(
  text: string,
  line: SourceLine,
  sourceName: string | undefined,
  label: string,
): RecordExpr {
  const value = parseValue(text, line, sourceName);
  if (value.kind !== "record") {
    throw parseError("PARSE_FREEDOM_RECORD", `${label} must be a record`, line, sourceName);
  }
  return value;
}

function parseSchema(text: string, line: SourceLine, sourceName?: string): SymbolExpr {
  const value = parseSymbol(text, line, sourceName);
  if (!value.name.startsWith("@schema.")) {
    throw parseError("PARSE_SCHEMA_SYMBOL", "schema symbol must start with '@schema.'", line, sourceName);
  }
  return value;
}

function parseSymbol(text: string, line: SourceLine, sourceName?: string): SymbolExpr {
  const value = text.trim();
  if (!/^@[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(value)) {
    throw parseError("PARSE_SYMBOL", `invalid external symbol '${value}'`, line, sourceName);
  }
  return { kind: "symbol", name: value as `@${string}`, span: line.span };
}

function parseName(text: string, line: SourceLine, sourceName?: string): NameExpr {
  const value = text.trim();
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/u.exec(value);
  if (match === null) {
    throw parseError("PARSE_NAME", `invalid name reference '${value}'`, line, sourceName);
  }
  const path = parsePath(match[2]!, line, sourceName);
  return { kind: "name", name: match[1]!, path, span: line.span };
}

function parsePath(text: string, line: SourceLine, sourceName?: string): Array<string | number> {
  const path: Array<string | number> = [];
  let rest = text;
  while (rest.length > 0) {
    const field = /^\.([A-Za-z_][A-Za-z0-9_]*)(.*)$/u.exec(rest);
    if (field !== null) {
      path.push(field[1]!);
      rest = field[2]!;
      continue;
    }
    const index = /^\[(\d+|"(?:[^"\\]|\\.)*")\](.*)$/u.exec(rest);
    if (index !== null) {
      path.push(index[1]!.startsWith('"') ? JSON.parse(index[1]!) as string : Number(index[1]));
      rest = index[2]!;
      continue;
    }
    throw parseError("PARSE_PATH", `invalid reference path '${text}'`, line, sourceName);
  }
  return path;
}

function parseValue(text: string, line: SourceLine, sourceName?: string): ValueExpr {
  const value = text.trim();
  if (value.startsWith('"')) {
    return { kind: "literal", value: parseStringLiteral(value, line, sourceName), span: line.span };
  }
  if (value === "true" || value === "false") {
    return { kind: "literal", value: value === "true", span: line.span };
  }
  if (value === "null") {
    return { kind: "literal", value: null, span: line.span };
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw parseError("PARSE_NUMBER", `invalid number '${value}'`, line, sourceName);
    }
    return { kind: "literal", value: number, span: line.span };
  }
  if (value.startsWith("@")) {
    return parseSymbol(value, line, sourceName);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1);
    return {
      kind: "list",
      items: body.trim().length === 0 ? [] : splitTopLevel(body).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const body = value.slice(1, -1);
    const entries: Record<string, ValueExpr> = {};
    for (const item of body.trim().length === 0 ? [] : splitTopLevel(body)) {
      const colon = findTopLevelCharacter(item, ":");
      if (colon <= 0) {
        throw parseError("PARSE_RECORD", `invalid record entry '${item.trim()}'`, line, sourceName);
      }
      const rawKey = item.slice(0, colon).trim();
      const key = rawKey.startsWith('"') ? parseStringLiteral(rawKey, line, sourceName) : rawKey;
      requireName(key, line, sourceName, "record key");
      entries[key] = parseValue(item.slice(colon + 1), line, sourceName);
    }
    return { kind: "record", entries, span: line.span };
  }
  return parseName(value, line, sourceName);
}

function parseStringLiteral(text: string, line: SourceLine, sourceName?: string): string {
  const value = text.trim();
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") {
      throw new TypeError("not a string");
    }
    return parsed;
  } catch (error) {
    throw parseError("PARSE_STRING", `invalid JSON string literal '${value}'`, line, sourceName, error);
  }
}

function parseOper(text: string, line: SourceLine, sourceName?: string): OperExpr {
  const parser = new OperParser(tokenizeOper(text, line, sourceName), line, sourceName);
  return parser.parse();
}

type OperTokenType = "literal" | "name" | "operator" | "left" | "right" | "eof";

interface OperToken {
  readonly type: OperTokenType;
  readonly value: string;
}

function tokenizeOper(text: string, line: SourceLine, sourceName?: string): OperToken[] {
  const tokens: OperToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        const current = text[end]!;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
        end += 1;
      }
      if (end >= text.length) {
        throw parseError("PARSE_OPER_STRING", "unterminated string in oper expression", line, sourceName);
      }
      tokens.push({ type: "literal", value: text.slice(index, end + 1) });
      index = end + 1;
      continue;
    }
    const operator = ["==", "!=", "<=", ">=", "|", "&", "!", "<", ">", "+", "-", "*", "/"]
      .find((candidate) => text.startsWith(candidate, index));
    if (operator !== undefined) {
      tokens.push({ type: "operator", value: operator });
      index += operator.length;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "left", value: char });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "right", value: char });
      index += 1;
      continue;
    }
    const number = /^(?:0|[1-9]\d*)(?:\.\d+)?/u.exec(text.slice(index));
    if (number !== null) {
      tokens.push({ type: "literal", value: number[0] });
      index += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[(?:\d+|"(?:[^"\\]|\\.)*")\]))*/u.exec(text.slice(index));
    if (name !== null) {
      const type = new Set(["true", "false", "null"]).has(name[0]) ? "literal" : "name";
      tokens.push({ type, value: name[0] });
      index += name[0].length;
      continue;
    }
    throw parseError("PARSE_OPER_TOKEN", `unexpected token '${char}' in oper expression`, line, sourceName);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class OperParser {
  private cursor = 0;

  constructor(
    private readonly tokens: readonly OperToken[],
    private readonly line: SourceLine,
    private readonly sourceName?: string,
  ) {}

  parse(): OperExpr {
    const expression = this.parseBinary(1);
    if (this.peek().type !== "eof") {
      throw parseError("PARSE_OPER_TRAILING", `unexpected '${this.peek().value}' in oper expression`, this.line, this.sourceName);
    }
    return expression;
  }

  private parseBinary(minimumPrecedence: number): OperExpr {
    let left = this.parseUnary();
    while (this.peek().type === "operator") {
      const operator = this.peek().value;
      const precedence = precedenceOf(operator);
      if (precedence < minimumPrecedence) break;
      this.cursor += 1;
      const right = this.parseBinary(precedence + 1);
      left = {
        kind: "binary",
        operator: operator as Extract<OperExpr, { kind: "binary" }>["operator"],
        left,
        right,
        span: this.line.span,
      };
    }
    return left;
  }

  private parseUnary(): OperExpr {
    const token = this.peek();
    if (token.type === "operator" && (token.value === "!" || token.value === "-")) {
      this.cursor += 1;
      return {
        kind: "unary",
        operator: token.value,
        operand: this.parseUnary(),
        span: this.line.span,
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): OperExpr {
    const token = this.peek();
    if (token.type === "left") {
      this.cursor += 1;
      const expression = this.parseBinary(1);
      if (this.peek().type !== "right") {
        throw parseError("PARSE_OPER_PAREN", "missing ')' in oper expression", this.line, this.sourceName);
      }
      this.cursor += 1;
      return expression;
    }
    this.cursor += 1;
    if (token.type === "name") {
      return parseName(token.value, this.line, this.sourceName);
    }
    if (token.type === "literal") {
      return parseValue(token.value, this.line, this.sourceName);
    }
    throw parseError("PARSE_OPER_VALUE", `expected value, found '${token.value}'`, this.line, this.sourceName);
  }

  private peek(): OperToken {
    return this.tokens[this.cursor] ?? { type: "eof", value: "" };
  }
}

function precedenceOf(operator: string): number {
  if (operator === "|") return 1;
  if (operator === "&") return 2;
  if (["==", "!=", "<", "<=", ">", ">="].includes(operator)) return 3;
  if (operator === "+" || operator === "-") return 4;
  if (operator === "*" || operator === "/") return 5;
  return -1;
}

function splitAssignment(text: string): [string, string] | undefined {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && "([{ ".includes(char) && char !== " ") depth += 1;
    else if (!quoted && ")] }".includes(char) && char !== " ") depth -= 1;
    else if (
      !quoted && depth === 0 && char === "=" &&
      text[index - 1] !== "=" && text[index + 1] !== "="
    ) {
      return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
    }
  }
  return undefined;
}

export function splitTopLevel(text: string): string[] {
  const values: string[] = [];
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && "([{ ".includes(char) && char !== " ") depth += 1;
    else if (!quoted && ")] }".includes(char) && char !== " ") depth -= 1;
    else if (!quoted && depth === 0 && char === ",") {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(text.slice(start).trim());
  return values;
}

function findTopLevelCharacter(text: string, target: string): number {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && depth === 0 && char === target) return index;
    else if (!quoted && "([{ ".includes(char) && char !== " ") depth += 1;
    else if (!quoted && ")] }".includes(char) && char !== " ") depth -= 1;
  }
  return -1;
}

function requireOperandCount(
  operands: string[],
  expected: number,
  line: SourceLine,
  sourceName: string | undefined,
  instruction: string,
): string[] {
  if (operands.length !== expected) {
    throw parseError("PARSE_OPERAND_COUNT", `${instruction} expects ${expected} operands`, line, sourceName);
  }
  return operands;
}

function requireName(value: string, line: SourceLine, sourceName: string | undefined, label: string): void {
  if (!NAME.test(value)) {
    throw parseError("PARSE_NAME", `invalid ${label} '${value}'`, line, sourceName);
  }
}

function requireRole(value: string, line: SourceLine, sourceName?: string): void {
  if (!isRole(value)) {
    throw parseError("PARSE_ROLE", `invalid role '${value}'`, line, sourceName);
  }
}

function isRole(value: string): boolean {
  return ROLE_NAMES.has(value) || /^@role\.[A-Za-z_][A-Za-z0-9_.]*$/u.test(value);
}

function isTerminator(value: AflInstruction | AflTerminator): value is AflTerminator {
  return value.op === "jump" || value.op === "ret" || value.op === "fail";
}

function parseError(
  code: string,
  message: string,
  line: SourceLine,
  sourceName?: string,
  cause?: unknown,
): AflParseError {
  return new AflParseError([{
    code,
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
    span: line.span,
    ...(sourceName === undefined ? {} : { sourceName }),
  }]);
}
