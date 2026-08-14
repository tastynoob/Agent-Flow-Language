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
  MatchCase,
  NameExpr,
  NodeDocumentation,
  OperExpr,
  RecordExpr,
  SourceSpan,
  SymbolExpr,
  ValueExpr,
} from "./ir.js";
import {
  expandAgentToolProfile,
  isAgentStandardToolName,
  isAgentToolProfileName,
} from "./standard-agent-tools.js";

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
    const parameterSource = match[2]!.trim();
    const parameters = parameterSource === ""
      ? []
      : splitRequiredItems(parameterSource, header, sourceName, "node parameter list");
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
  const assignment = splitAssignment(line.text);
  if (assignment !== undefined) {
    const [dst, rhs] = assignment;
    requireName(dst, line, sourceName, "destination");
    return parseAssignedInstruction(dst, rhs, line, sourceName);
  }

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
    const target = line.text.slice(5).trim();
    requireName(target, line, sourceName, "jump target");
    return { op: "jump", target, span: line.span };
  }

  if (line.text.startsWith("branch ")) {
    const operands = requireOperandCount(
      splitRequiredItems(line.text.slice(7), line, sourceName, "branch"),
      3,
      line,
      sourceName,
      "branch",
    );
    const trueTarget = operands[1]!.trim();
    const falseTarget = operands[2]!.trim();
    requireName(trueTarget, line, sourceName, "branch target");
    requireName(falseTarget, line, sourceName, "branch target");
    return {
      op: "branch",
      condition: parseValue(operands[0]!, line, sourceName),
      trueTarget,
      falseTarget,
      span: line.span,
    };
  }

  if (line.text.startsWith("match ")) {
    const operands = requireOperandCount(
      splitRequiredItems(line.text.slice(6), line, sourceName, "match"),
      3,
      line,
      sourceName,
      "match",
    );
    const defaultTarget = operands[2]!.trim();
    requireName(defaultTarget, line, sourceName, "match default target");
    return {
      op: "match",
      selector: parseValue(operands[0]!, line, sourceName),
      cases: parseMatchCases(operands[1]!, line, sourceName),
      defaultTarget,
      span: line.span,
    };
  }

  const memoryAppend = /^(.+)\.append\s+(.+)$/u.exec(line.text);
  if (memoryAppend !== null) {
    const operands = requireOperandCount(
      splitRequiredItems(memoryAppend[2]!, line, sourceName, "Memory append"),
      2,
      line,
      sourceName,
      "Memory append",
    );
    const role = operands[0]!.trim();
    requireRole(role, line, sourceName);
    return {
      op: "memory.append",
      memory: parseName(memoryAppend[1]!, line, sourceName),
      role,
      frag: parseValue(operands[1]!, line, sourceName),
      span: line.span,
    };
  }

  const systemPrompt = /^([A-Za-z_][A-Za-z0-9_]*)\.system_prompt\s+(.+)$/u.exec(line.text);
  if (systemPrompt !== null) {
    return {
      op: "agent.system_prompt",
      agent: parseName(systemPrompt[1]!, line, sourceName),
      prompt: parseValue(systemPrompt[2]!, line, sourceName),
      span: line.span,
    };
  }

  throw parseError("PARSE_INSTRUCTION", "expected an assignment, effect instruction, or terminator", line, sourceName);
}

function parseAssignedInstruction(
  dst: string,
  rhs: string,
  line: SourceLine,
  sourceName?: string,
): AflInstruction {
  if (rhs.startsWith("agent ")) {
    const operands = splitRequiredItems(rhs.slice(6), line, sourceName, "agent");
    if (operands.length < 1 || operands.length > 2) {
      throw parseError("PARSE_AGENT", "agent expects a symbol and optional options", line, sourceName);
    }
    const options = operands[1] === undefined
      ? new Map<string, string>()
      : parseOptions(operands[1], line, sourceName, "Agent options", ["workspace", "memory", "tools"]);
    return {
      op: "agent",
      dst,
      agent: parseSymbol(operands[0]!, line, sourceName),
      ...(options.get("workspace") === undefined
        ? {}
        : { workspace: parseValue(options.get("workspace")!, line, sourceName) }),
      ...(options.get("memory") === undefined
        ? {}
        : { memory: parseName(options.get("memory")!, line, sourceName) }),
      ...(options.get("tools") === undefined
        ? {}
        : { tools: parseAgentTools(options.get("tools")!, line, sourceName) }),
      span: line.span,
    };
  }

  const agentWork = /^([A-Za-z_][A-Za-z0-9_]*)\.do\s+(.+)$/u.exec(rhs);
  if (agentWork !== null) {
    return {
      op: "agent.do",
      dst,
      agent: parseName(agentWork[1]!, line, sourceName),
      ...parseAgentWorkOperands(agentWork[2]!, line, sourceName, "Agent do"),
      span: line.span,
    };
  }

  if (rhs.startsWith("prompt ")) {
    const operands = splitRequiredItems(rhs.slice(7), line, sourceName, "prompt");
    return {
      op: "prompt",
      dst,
      source: parseValue(operands[0]!, line, sourceName),
      args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }

  if (rhs.startsWith("input ")) {
    const operands = splitRequiredItems(rhs.slice(6), line, sourceName, "input");
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

  if (rhs.startsWith("compute ")) {
    const operands = splitRequiredItems(rhs.slice(8), line, sourceName, "compute");
    return {
      op: "compute",
      dst,
      function: parseSymbol(operands[0]!, line, sourceName),
      args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }

  for (const language of ["python", "typescript", "shell"] as const) {
    const prefix = `${language} `;
    if (rhs.startsWith(prefix)) {
      const operands = splitRequiredItems(rhs.slice(prefix.length), line, sourceName, language);
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
    const call = parseFlowCall(rhs.slice(5), line, sourceName);
    return {
      op: "call",
      dst,
      target: call.target,
      args: call.args,
      span: line.span,
    };
  }

  if (rhs.startsWith("dispatch ")) {
    const body = rhs.slice(9).trim();
    if (body.startsWith("[")) {
      if (!body.endsWith("]")) {
        throw parseError("PARSE_DISPATCH_LIST", "dispatch list is missing closing ']'", line, sourceName);
      }
      const listBody = body.slice(1, -1).trim();
      const calls = listBody === ""
        ? []
        : splitRequiredItems(listBody, line, sourceName, "dispatch list")
            .map((item) => parseFlowCall(item, line, sourceName));
      return { op: "dispatch", dst, calls, span: line.span };
    }
    throw parseError("PARSE_DISPATCH", "dispatch expects a list of flow calls", line, sourceName);
  }

  if (rhs.startsWith("repeat ")) {
    const operands = requireOperandCount(
      splitRequiredItems(rhs.slice(7), line, sourceName, "repeat"),
      2,
      line,
      sourceName,
      "repeat",
    );
    const call = parseFlowCall(operands[1]!, line, sourceName);
    return {
      op: "repeat",
      dst,
      count: parseValue(operands[0]!, line, sourceName),
      target: call.target,
      args: call.args,
      span: line.span,
    };
  }

  const fork = /^([A-Za-z_][A-Za-z0-9_]*)\.fork\s+(.+)$/u.exec(rhs);
  if (fork !== null) {
    const action: ForkAction = {
      ...parseAgentWorkOperands(fork[2]!, line, sourceName, "Agent fork"),
      span: line.span,
    };
    return {
      op: "fork",
      dst,
      sourceAgent: parseName(fork[1]!, line, sourceName),
      action,
      span: line.span,
    };
  }

  if (rhs.startsWith("sync ")) {
    const operands = splitRequiredItems(rhs.slice(5), line, sourceName, "sync");
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
    const operands = splitRequiredItems(rhs.slice(7), line, sourceName, "invoke");
    return {
      op: "invoke",
      dst,
      capability: parseSymbol(operands[0]!, line, sourceName),
      args: operands.slice(1).map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
  }

  const memoryCopy = /^(.+)\.copy$/u.exec(rhs);
  if (memoryCopy !== null) {
    return { op: "memory.copy", dst, memory: parseName(memoryCopy[1]!, line, sourceName), span: line.span };
  }

  const withMemory = /^([A-Za-z_][A-Za-z0-9_]*)\.with_memory\s+(.+)$/u.exec(rhs);
  if (withMemory !== null) {
    return {
      op: "agent.with_memory",
      dst,
      agent: parseName(withMemory[1]!, line, sourceName),
      memory: parseName(withMemory[2]!, line, sourceName),
      span: line.span,
    };
  }

  const agentControl = /^([A-Za-z_][A-Za-z0-9_]*)\.(route|flow)\s+(.+)$/u.exec(rhs);
  if (agentControl !== null) {
    return parseAgentControlInstruction(
      dst,
      agentControl[1]!,
      agentControl[2]! as "route" | "flow",
      agentControl[3]!,
      line,
      sourceName,
    );
  }

  throw parseError("PARSE_OPCODE", `unknown instruction '${rhs.split(/\s/u, 1)[0] ?? rhs}'`, line, sourceName);
}

function parseAgentTools(
  text: string,
  line: SourceLine,
  sourceName?: string,
): readonly import("./ir.js").AgentStandardToolName[] {
  const value = parseValue(text, line, sourceName);
  if (value.kind === "literal" && typeof value.value === "string") {
    if (!isAgentToolProfileName(value.value)) {
      throw parseError(
        "PARSE_AGENT_TOOLS",
        `unknown Agent tool profile '${value.value}'`,
        line,
        sourceName,
      );
    }
    return [...expandAgentToolProfile(value.value)];
  }
  if (value.kind !== "list") {
    throw parseError(
      "PARSE_AGENT_TOOLS",
      "Agent tools must be a profile string or a list of standard tool names",
      line,
      sourceName,
    );
  }
  const tools = value.items.map((item) => {
    if (item.kind !== "literal" || typeof item.value !== "string" || !isAgentStandardToolName(item.value)) {
      throw parseError(
        "PARSE_AGENT_TOOLS",
        "Agent tool lists may contain only read, list, search, write, edit, or shell",
        line,
        sourceName,
      );
    }
    return item.value;
  });
  if (new Set(tools).size !== tools.length) {
    throw parseError("PARSE_AGENT_TOOLS", "Agent tool lists cannot contain duplicates", line, sourceName);
  }
  return tools;
}

function parseAgentWorkOperands(
  text: string,
  line: SourceLine,
  sourceName: string | undefined,
  label: string,
): { role?: string; input: ValueExpr; schema?: SymbolExpr } {
  const operands = splitRequiredItems(text, line, sourceName, label);
  if (operands.length < 1 || operands.length > 2) {
    throw parseError("PARSE_AGENT_WORK", `${label} expects input and optional options`, line, sourceName);
  }
  const options = operands[1] === undefined
    ? new Map<string, string>()
    : parseOptions(operands[1], line, sourceName, `${label} options`, ["role", "schema"]);
  const role = options.get("role")?.trim();
  if (role !== undefined) requireRole(role, line, sourceName);
  const schema = options.get("schema") === undefined
    ? undefined
    : parseSchema(options.get("schema")!, line, sourceName);
  return {
    ...(role === undefined ? {} : { role }),
    input: parseValue(operands[0]!, line, sourceName),
    ...(schema === undefined ? {} : { schema }),
  };
}

function parseAgentControlInstruction(
  dst: string,
  agent: string,
  mode: "route" | "flow",
  text: string,
  line: SourceLine,
  sourceName?: string,
): AflInstruction {
  const operands = splitRequiredItems(text, line, sourceName, `Agent ${mode}`);
  if (operands.length < 1 || operands.length > 2) {
    throw parseError(
      mode === "route" ? "PARSE_FREEDOM_ROUTE" : "PARSE_FREEDOM_FLOW",
      `Agent ${mode} expects prompt and optional options`,
      line,
      sourceName,
    );
  }
  const allowed = mode === "flow"
    ? ["nodes", "agents", "params", "min_routes", "max_routes"]
    : ["nodes", "params", "min_routes", "max_routes"];
  const options = operands[1] === undefined
    ? new Map<string, string>()
    : parseOptions(operands[1], line, sourceName, `Agent ${mode} options`, allowed);
  const nodes = parseLocalNodeList(options.get("nodes") ?? "[]", line, sourceName);
  const params = parseRecord(options.get("params") ?? "[:]", line, sourceName, `Agent ${mode} params`);
  const base = {
    dst,
    agent: parseName(agent, line, sourceName),
    prompt: parseValue(operands[0]!, line, sourceName),
    nodes,
    params,
    ...(options.get("min_routes") === undefined
      ? {}
      : { minRoutes: parseValue(options.get("min_routes")!, line, sourceName) }),
    ...(options.get("max_routes") === undefined
      ? {}
      : { maxRoutes: parseValue(options.get("max_routes")!, line, sourceName) }),
    span: line.span,
  };
  if (mode === "route") return { op: "agent.route", ...base };
  return {
    op: "agent.flow",
    ...base,
    agents: parseAgentSymbolList(options.get("agents") ?? "[]", line, sourceName),
  };
}

function parseOptions(
  text: string,
  line: SourceLine,
  sourceName: string | undefined,
  label: string,
  allowed: readonly string[],
): Map<string, string> {
  const source = text.trim();
  if (!source.startsWith("[") || !source.endsWith("]")) {
    throw parseError("PARSE_OPTIONS", `${label} must be enclosed in '[' and ']'`, line, sourceName);
  }
  const body = source.slice(1, -1).trim();
  if (body === ":") return new Map();
  if (body === "") {
    throw parseError("PARSE_OPTIONS", `${label} uses '[:]' for empty options`, line, sourceName);
  }
  const result = new Map<string, string>();
  const allowedFields = new Set(allowed);
  for (const item of splitRequiredItems(body, line, sourceName, label)) {
    const colon = findTopLevelCharacter(item, ":");
    if (colon <= 0) {
      throw parseError("PARSE_OPTIONS", `invalid ${label} entry '${item}'`, line, sourceName);
    }
    const key = item.slice(0, colon).trim();
    requireName(key, line, sourceName, `${label} field`);
    if (!allowedFields.has(key)) {
      throw parseError("PARSE_OPTIONS_FIELD", `unknown ${label} field '${key}'`, line, sourceName);
    }
    if (result.has(key)) {
      throw parseError("PARSE_OPTIONS_FIELD_DUPLICATE", `${label} repeats field '${key}'`, line, sourceName);
    }
    const value = item.slice(colon + 1).trim();
    if (value === "") {
      throw parseError("PARSE_OPTIONS", `${label} field '${key}' requires a value`, line, sourceName);
    }
    result.set(key, value);
  }
  return result;
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
    : splitRequiredItems(argsText, line, sourceName, "flow call arguments")
        .map((item) => parseValue(item, line, sourceName));
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
  return splitRequiredItems(body, line, sourceName, "Freedom Node allowlist").map((item) => {
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
  return splitRequiredItems(body, line, sourceName, "Freedom Agent allowlist").map((item) => {
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
  const source = text.trim();
  const value = parseValue(source, line, sourceName);
  if (value.kind !== "record") {
    throw parseError("PARSE_FREEDOM_RECORD", `${label} must be a record`, line, sourceName);
  }
  return value;
}

function parseMatchCases(
  text: string,
  line: SourceLine,
  sourceName?: string,
): MatchCase[] {
  const value = text.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw parseError("PARSE_MATCH", "match cases must be enclosed in '[' and ']'", line, sourceName);
  }
  const body = value.slice(1, -1).trim();
  if (body === "") {
    throw parseError("PARSE_MATCH_EMPTY", "match requires at least one case", line, sourceName);
  }
  const cases: MatchCase[] = [];
  for (const item of splitRequiredItems(body, line, sourceName, "match table")) {
    const colon = findTopLevelCharacter(item, ":");
    if (colon <= 0) {
      throw parseError("PARSE_MATCH_CASE", `invalid match case '${item.trim()}'`, line, sourceName);
    }
    const expression = parseValue(item.slice(0, colon), line, sourceName);
    if (expression.kind !== "literal" || !isMatchScalar(expression.value)) {
      throw parseError(
        "PARSE_MATCH_CASE",
        "match case values must be null, boolean, number, or string literals",
        line,
        sourceName,
      );
    }
    const target = item.slice(colon + 1).trim();
    requireName(target, line, sourceName, "match target");
    if (cases.some((entry) => entry.value === expression.value)) {
      throw parseError(
        "PARSE_MATCH_CASE_DUPLICATE",
        `match repeats case ${JSON.stringify(expression.value)}`,
        line,
        sourceName,
      );
    }
    cases.push({ value: expression.value, target });
  }
  return cases;
}

function isMatchScalar(value: unknown): value is null | boolean | number | string {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
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
    const body = value.slice(1, -1).trim();
    if (body === ":") return { kind: "record", entries: {}, span: line.span };
    const items = body === "" ? [] : splitRequiredItems(body, line, sourceName, "collection literal");
    const record = items.length > 0 && items.every((item) => findTopLevelCharacter(item, ":") > 0);
    const mixed = items.some((item) => findTopLevelCharacter(item, ":") > 0) && !record;
    if (mixed) {
      throw parseError("PARSE_COLLECTION_MIXED", "collection literal cannot mix list items and record entries", line, sourceName);
    }
    if (record) {
      const entries: Record<string, ValueExpr> = {};
      for (const item of items) {
        const colon = findTopLevelCharacter(item, ":");
        const rawKey = item.slice(0, colon).trim();
        const quotedKey = rawKey.startsWith('"');
        const key = quotedKey ? parseStringLiteral(rawKey, line, sourceName) : rawKey;
        if (!quotedKey) requireName(key, line, sourceName, "record key");
        if (Object.hasOwn(entries, key)) {
          throw parseError("PARSE_RECORD_KEY_DUPLICATE", `record repeats key '${key}'`, line, sourceName);
        }
        Object.defineProperty(entries, key, {
          value: parseValue(item.slice(colon + 1), line, sourceName),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return { kind: "record", entries, span: line.span };
    }
    return {
      kind: "list",
      items: items.map((item) => parseValue(item, line, sourceName)),
      span: line.span,
    };
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
  const source = text.trim();
  if (source.startsWith("[") && source.endsWith("]")) {
    return parseValue(source, line, sourceName);
  }
  const parser = new OperParser(tokenizeOper(source, line, sourceName), line, sourceName);
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

function splitRequiredItems(
  text: string,
  line: SourceLine,
  sourceName: string | undefined,
  label: string,
): string[] {
  const values = splitTopLevel(text);
  if (values.some((value) => value.length === 0)) {
    throw parseError("PARSE_EMPTY_ITEM", `${label} cannot contain an empty item`, line, sourceName);
  }
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
  return value.op === "jump" || value.op === "branch" || value.op === "match" || value.op === "ret" || value.op === "fail";
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
