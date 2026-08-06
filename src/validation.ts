import { AflValidationError, type AflDiagnostic } from "./errors.js";
import {
  buildInstructionDependencies,
  hasDependencyCycle,
  instructionDestination,
  instructionReferences,
  valueReferences,
} from "./dependencies.js";
import type {
  AflBlock,
  AflInstruction,
  AflModule,
  AflNode,
  AflTerminator,
  FlowCallExpr,
  NameExpr,
  OperExpr,
  SourceSpan,
  ValueExpr,
} from "./ir.js";

export interface ValidationSuccess {
  readonly ok: true;
  readonly value: AflModule;
  readonly diagnostics: readonly [];
}

export interface ValidationFailure {
  readonly ok: false;
  readonly diagnostics: readonly AflDiagnostic[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

type ValueKind = "unknown" | "frag" | "compute" | "agent" | "memory" | "taskGroup";

export function validateModule(module: AflModule): ValidationResult {
  const diagnostics: AflDiagnostic[] = [];
  const nodes = new Map<string, AflNode>();
  for (const node of module.nodes) {
    if (nodes.has(node.name)) {
      add(diagnostics, module, node.span, "NODE_DUPLICATE", `node '${node.name}' is declared more than once`);
    } else {
      nodes.set(node.name, node);
    }
  }
  for (const node of module.nodes) {
    validateNode(module, node, nodes, diagnostics);
  }
  return diagnostics.length === 0
    ? { ok: true, value: module, diagnostics: [] }
    : { ok: false, diagnostics };
}

export function assertValidModule(module: AflModule): AflModule {
  const result = validateModule(module);
  if (!result.ok) {
    throw new AflValidationError(result.diagnostics);
  }
  return result.value;
}

function validateNode(
  module: AflModule,
  node: AflNode,
  nodes: ReadonlyMap<string, AflNode>,
  diagnostics: AflDiagnostic[],
): void {
  const parameters = new Set<string>();
  for (const parameter of node.parameters) {
    if (parameters.has(parameter)) {
      add(diagnostics, module, node.span, "PARAMETER_DUPLICATE", `parameter '${parameter}' is declared more than once`);
    }
    parameters.add(parameter);
  }

  const blocks = new Map<string, AflBlock>();
  for (const block of node.blocks) {
    if (blocks.has(block.name)) {
      add(diagnostics, module, block.span, "BLOCK_DUPLICATE", `block '${block.name}' is declared more than once`);
    } else {
      blocks.set(block.name, block);
    }
  }
  if (!blocks.has("entry")) {
    add(diagnostics, module, node.span, "ENTRY_MISSING", `node '${node.name}' requires an entry block`);
  }

  const definitions = collectDefinitions(module, node, diagnostics);
  const kinds = inferKinds(module, node, definitions, diagnostics);
  const predecessors = buildPredecessors(module, node, blocks, diagnostics);
  const availability = computeAvailability(node, blocks, predecessors, definitions);

  for (const block of node.blocks) {
    validateBlock(
      module,
      node,
      block,
      nodes,
      availability.get(block.name) ?? new Set(node.parameters),
      definitions.get(block.name) ?? new Map(),
      kinds,
      diagnostics,
    );
  }
  validateTaskGroups(module, node, kinds, diagnostics);
  validateMemoryBindings(module, node, diagnostics);
}

function collectDefinitions(
  module: AflModule,
  node: AflNode,
  diagnostics: AflDiagnostic[],
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const block of node.blocks) {
    const blockDefinitions = new Map<string, number>();
    block.instructions.forEach((instruction, index) => {
      const dst = instructionDestination(instruction);
      if (dst === undefined) return;
      if (blockDefinitions.has(dst)) {
        add(
          diagnostics,
          module,
          instruction.span,
          "DESTINATION_DUPLICATE",
          `block '${block.name}' defines '${dst}' more than once`,
        );
      } else {
        blockDefinitions.set(dst, index);
      }
    });
    result.set(block.name, blockDefinitions);
  }
  return result;
}

function inferKinds(
  module: AflModule,
  node: AflNode,
  definitions: ReadonlyMap<string, ReadonlyMap<string, number>>,
  diagnostics: AflDiagnostic[],
): Map<string, ValueKind> {
  const kinds = new Map<string, ValueKind>(node.parameters.map((name) => [name, "unknown"]));
  for (const block of node.blocks) {
    for (const [name, index] of definitions.get(block.name) ?? []) {
      const instruction = block.instructions[index]!;
      const kind = instructionResultKind(instruction);
      const previous = kinds.get(name);
      if (previous !== undefined && previous !== "unknown" && previous !== kind) {
        add(
          diagnostics,
          module,
          instruction.span,
          "VALUE_KIND_CONFLICT",
          `'${name}' is defined as both ${previous} and ${kind}`,
        );
      } else if (previous === undefined || previous === "unknown") {
        kinds.set(name, kind);
      }
    }
  }
  return kinds;
}

function buildPredecessors(
  module: AflModule,
  node: AflNode,
  blocks: ReadonlyMap<string, AflBlock>,
  diagnostics: AflDiagnostic[],
): Map<string, Set<string>> {
  const predecessors = new Map(node.blocks.map((block) => [block.name, new Set<string>()]));
  for (const block of node.blocks) {
    if (block.terminator.op !== "jump") continue;
    for (const target of [block.terminator.trueTarget, block.terminator.falseTarget]) {
      if (target === undefined) continue;
      if (!blocks.has(target)) {
        add(
          diagnostics,
          module,
          block.terminator.span,
          "JUMP_TARGET_UNKNOWN",
          `block '${block.name}' jumps to unknown block '${target}'`,
        );
      } else {
        predecessors.get(target)!.add(block.name);
      }
    }
  }
  return predecessors;
}

function computeAvailability(
  node: AflNode,
  blocks: ReadonlyMap<string, AflBlock>,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
  definitions: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, Set<string>> {
  const reachable = reachableBlocks(blocks);
  const universe = new Set<string>(node.parameters);
  for (const values of definitions.values()) {
    for (const name of values.keys()) universe.add(name);
  }
  const incoming = new Map<string, Set<string>>();
  for (const block of node.blocks) {
    incoming.set(
      block.name,
      block.name === "entry" ? new Set(node.parameters) : new Set(universe),
    );
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of node.blocks) {
      if (block.name === "entry") continue;
      const preds = [...(predecessors.get(block.name) ?? [])].filter((name) => reachable.has(name));
      const next = preds.length === 0
        ? new Set<string>()
        : intersectSets(preds.map((name) => {
            const output = new Set(incoming.get(name) ?? []);
            for (const defined of definitions.get(name)?.keys() ?? []) output.add(defined);
            return output;
          }));
      if (!equalSets(next, incoming.get(block.name) ?? new Set())) {
        incoming.set(block.name, next);
        changed = true;
      }
    }
  }
  return incoming;
}

function reachableBlocks(blocks: ReadonlyMap<string, AflBlock>): Set<string> {
  const reachable = new Set<string>();
  const pending = blocks.has("entry") ? ["entry"] : [];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const terminator = blocks.get(name)?.terminator;
    if (terminator?.op === "jump") {
      if (blocks.has(terminator.trueTarget)) pending.push(terminator.trueTarget);
      if (terminator.falseTarget !== undefined && blocks.has(terminator.falseTarget)) {
        pending.push(terminator.falseTarget);
      }
    }
  }
  return reachable;
}

function validateBlock(
  module: AflModule,
  node: AflNode,
  block: AflBlock,
  nodes: ReadonlyMap<string, AflNode>,
  incoming: ReadonlySet<string>,
  localDefinitions: ReadonlyMap<string, number>,
  kinds: ReadonlyMap<string, ValueKind>,
  diagnostics: AflDiagnostic[],
): void {
  const available = new Set(incoming);
  for (const name of localDefinitions.keys()) available.add(name);
  block.instructions.forEach((instruction, consumer) => {
    for (const reference of instructionReferences(instruction)) {
      validateReference(module, reference, available, kinds, diagnostics);
    }
    validateInstructionKinds(module, instruction, kinds, diagnostics);
    validateCall(module, instruction, node, nodes, diagnostics);
    if (instruction.op === "fork" && instruction.actionReceiver !== instruction.dst) {
      add(
        diagnostics,
        module,
        instruction.span,
        "FORK_RECEIVER_MISMATCH",
        `fork startup receiver '${instruction.actionReceiver}' must match destination '${instruction.dst}'`,
      );
    }
  });

  if (hasDependencyCycle(buildInstructionDependencies(block))) {
    add(
      diagnostics,
      module,
      block.span,
      "DEPENDENCY_CYCLE",
      `block '${block.name}' contains a data or resource dependency cycle`,
    );
  }

  for (const reference of terminatorReferences(block.terminator)) {
    validateReference(module, reference, available, kinds, diagnostics);
  }
  if (block.terminator.op === "jump" && block.terminator.condition !== undefined) {
    expectKind(module, block.terminator.condition, kinds, ["compute", "unknown"], "jump condition", diagnostics);
  }
}

function validateReference(
  module: AflModule,
  reference: NameExpr,
  available: ReadonlySet<string>,
  kinds: ReadonlyMap<string, ValueKind>,
  diagnostics: AflDiagnostic[],
): void {
  if (!available.has(reference.name)) {
    add(diagnostics, module, reference.span, "NAME_UNAVAILABLE", `'${reference.name}' is not definitely available`);
    return;
  }
  if (reference.path[0] === "memory") {
    const kind = kinds.get(reference.name) ?? "unknown";
    if (kind !== "agent" && kind !== "unknown") {
      add(diagnostics, module, reference.span, "MEMORY_PATH_INVALID", `only an Agent exposes '.memory', but '${reference.name}' is ${kind}`);
    }
  }
}

function validateInstructionKinds(
  module: AflModule,
  instruction: AflInstruction,
  kinds: ReadonlyMap<string, ValueKind>,
  diagnostics: AflDiagnostic[],
): void {
  switch (instruction.op) {
    case "agent":
      if (instruction.memory !== undefined) expectNameKind(module, instruction.memory, kinds, ["memory", "unknown"], "Agent Memory", diagnostics);
      break;
    case "agent.sysprompt":
      expectNameKind(module, instruction.agent, kinds, ["agent", "unknown"], "system prompt receiver", diagnostics);
      break;
    case "agent.do":
      expectNameKind(module, instruction.agent, kinds, ["agent", "unknown"], "Agent work receiver", diagnostics);
      break;
    case "dispatch.batch":
      expectKind(module, instruction.count, kinds, ["compute", "unknown"], "dispatch count", diagnostics);
      break;
    case "sync":
      expectNameKind(module, instruction.taskGroup, kinds, ["taskGroup", "unknown"], "sync operand", diagnostics);
      break;
    case "fork":
      expectNameKind(module, instruction.sourceAgent, kinds, ["agent", "unknown"], "fork source", diagnostics);
      break;
    case "memory.append":
      expectNameKind(module, instruction.memory, kinds, ["memory", "unknown"], "memory.append target", diagnostics);
      break;
    case "memory.copy":
      expectNameKind(module, instruction.memory, kinds, ["memory", "unknown"], "memory.copy source", diagnostics);
      break;
    case "memory.apply":
      expectNameKind(module, instruction.sourceAgent, kinds, ["agent", "unknown"], "memory.apply source", diagnostics);
      expectNameKind(module, instruction.memory, kinds, ["memory", "unknown"], "memory.apply Memory", diagnostics);
      break;
    case "freedom.move":
    case "freedom.flow":
      expectNameKind(module, instruction.planner, kinds, ["agent", "unknown"], "freedom planner", diagnostics);
      break;
    default:
      break;
  }
}

function validateCall(
  module: AflModule,
  instruction: AflInstruction,
  currentNode: AflNode,
  nodes: ReadonlyMap<string, AflNode>,
  diagnostics: AflDiagnostic[],
): void {
  const calls: FlowCallExpr[] = [];
  if (instruction.op === "call") {
    calls.push({ target: instruction.target, args: instruction.args, span: instruction.span });
  } else if (instruction.op === "dispatch.list") {
    calls.push(...instruction.calls);
  } else if (instruction.op === "dispatch.batch") {
    calls.push({ target: instruction.target, args: [instruction.task], span: instruction.span });
  }
  for (const call of calls) {
    if (call.target.kind === "external") continue;
    const target = nodes.get(call.target.name);
    if (target === undefined) {
      add(diagnostics, module, call.span, "FLOW_UNKNOWN", `flow '${call.target.name}' is not declared`);
    } else if (target.parameters.length !== call.args.length) {
      add(
        diagnostics,
        module,
        call.span,
        "CALL_ARITY",
        `flow '${target.name}' expects ${target.parameters.length} arguments, received ${call.args.length}`,
      );
    }
    if (call.target.name === currentNode.name && currentNode.blocks.length === 0) {
      add(diagnostics, module, call.span, "CALL_INVALID", "recursive call target has no blocks");
    }
  }
}

function validateTaskGroups(
  module: AflModule,
  node: AflNode,
  _kinds: ReadonlyMap<string, ValueKind>,
  diagnostics: AflDiagnostic[],
): void {
  const groups = new Map<string, SourceSpan>();
  for (const block of node.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op === "dispatch.list" || instruction.op === "dispatch.batch") {
        groups.set(instruction.dst, instruction.span);
      }
    }
  }
  const blocks = new Map(node.blocks.map((block) => [block.name, block]));
  for (const [name, definitionSpan] of groups) {
    validateTaskGroupPaths(module, node, blocks, name, definitionSpan, diagnostics);
  }
}

function validateTaskGroupPaths(
  module: AflModule,
  node: AflNode,
  blocks: ReadonlyMap<string, AflBlock>,
  name: string,
  definitionSpan: SourceSpan,
  diagnostics: AflDiagnostic[],
): void {
  const pending: Array<{ block: string; outstanding: boolean }> = [{ block: "entry", outstanding: false }];
  const visited = new Set<string>();
  const reported = new Set<string>();
  let observedSync = false;
  while (pending.length > 0) {
    const state = pending.pop()!;
    const stateKey = `${state.block}:${state.outstanding ? 1 : 0}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);
    const block = blocks.get(state.block);
    if (block === undefined) continue;
    const defines = block.instructions.some((instruction) =>
      (instruction.op === "dispatch.list" || instruction.op === "dispatch.batch") && instruction.dst === name
    );
    const syncs = block.instructions.filter((instruction) =>
      instruction.op === "sync" && instruction.taskGroup.name === name
    );
    let outstanding = state.outstanding;
    if (defines) {
      if (outstanding) {
        reportOnce(
          reported,
          "redefine",
          diagnostics,
          module,
          block.span,
          "TASK_GROUP_REDEFINED",
          `TaskGroup '${name}' is redefined before its previous instance is synced`,
        );
      }
      outstanding = true;
    }
    if (syncs.length > 0) {
      observedSync = true;
      if (!outstanding) {
        reportOnce(
          reported,
          "sync-without-group",
          diagnostics,
          module,
          syncs[0]!.span,
          "TASK_GROUP_SYNC_INVALID",
          `TaskGroup '${name}' can be synced without an outstanding instance`,
        );
      }
      if (syncs.length > 1) {
        reportOnce(
          reported,
          "multiple-sync",
          diagnostics,
          module,
          syncs[1]!.span,
          "TASK_GROUP_MULTIPLE_SYNC",
          `TaskGroup '${name}' is synced more than once in block '${block.name}'`,
        );
      }
      outstanding = false;
    }
    if (block.terminator.op !== "jump") {
      if (outstanding) {
        reportOnce(
          reported,
          "exit-outstanding",
          diagnostics,
          module,
          block.terminator.span,
          "TASK_GROUP_UNCONSUMED",
          `node '${node.name}' can exit with TaskGroup '${name}' unsynced`,
        );
      }
      continue;
    }
    pending.push({ block: block.terminator.trueTarget, outstanding });
    if (block.terminator.falseTarget !== undefined) {
      pending.push({ block: block.terminator.falseTarget, outstanding });
    }
  }
  if (!observedSync) {
    reportOnce(
      reported,
      "never-sync",
      diagnostics,
      module,
      definitionSpan,
      "TASK_GROUP_UNCONSUMED",
      `TaskGroup '${name}' is never synced`,
    );
  }
}

function reportOnce(
  reported: Set<string>,
  key: string,
  diagnostics: AflDiagnostic[],
  module: AflModule,
  span: SourceSpan,
  code: string,
  message: string,
): void {
  if (reported.has(key)) return;
  reported.add(key);
  add(diagnostics, module, span, code, message);
}

function validateMemoryBindings(
  module: AflModule,
  node: AflNode,
  diagnostics: AflDiagnostic[],
): void {
  for (const block of node.blocks) {
    const bindings = new Map<string, SourceSpan[]>();
    for (const instruction of block.instructions) {
      const memory = instruction.op === "agent"
        ? instruction.memory
        : instruction.op === "memory.apply"
          ? instruction.memory
          : undefined;
      if (memory === undefined) continue;
      if (memory.path[0] === "memory") {
        add(
          diagnostics,
          module,
          memory.span,
          "MEMORY_ALREADY_BOUND",
          `Memory '${memory.name}.memory' is already bound to its Agent`,
        );
        continue;
      }
      const uses = bindings.get(memory.name) ?? [];
      uses.push(memory.span);
      bindings.set(memory.name, uses);
    }
    for (const [name, uses] of bindings) {
      if (uses.length <= 1) continue;
      for (const span of uses.slice(1)) {
        add(
          diagnostics,
          module,
          span,
          "MEMORY_MULTIPLE_BIND",
          `Memory '${name}' is bound to more than one Agent in block '${block.name}'`,
        );
      }
    }
  }
}

function instructionResultKind(instruction: AflInstruction): ValueKind {
  switch (instruction.op) {
    case "agent":
    case "memory.apply":
    case "fork":
      return "agent";
    case "memory.copy":
      return "memory";
    case "dispatch.list":
    case "dispatch.batch":
      return "taskGroup";
    case "oper":
    case "script":
      return "compute";
    default:
      return "frag";
  }
}

function terminatorReferences(terminator: AflTerminator): NameExpr[] {
  if (terminator.op === "jump") {
    return terminator.condition === undefined ? [] : valueReferences(terminator.condition);
  }
  if (terminator.op === "ret") {
    return terminator.value === undefined ? [] : valueReferences(terminator.value);
  }
  return valueReferences(terminator.error);
}

function expectKind(
  module: AflModule,
  expression: ValueExpr,
  kinds: ReadonlyMap<string, ValueKind>,
  expected: readonly ValueKind[],
  label: string,
  diagnostics: AflDiagnostic[],
): void {
  if (expression.kind !== "name") return;
  expectNameKind(module, expression, kinds, expected, label, diagnostics);
}

function expectNameKind(
  module: AflModule,
  expression: NameExpr,
  kinds: ReadonlyMap<string, ValueKind>,
  expected: readonly ValueKind[],
  label: string,
  diagnostics: AflDiagnostic[],
): void {
  let kind = kinds.get(expression.name) ?? "unknown";
  if (expression.path[0] === "memory" && (kind === "agent" || kind === "unknown")) {
    kind = "memory";
  }
  if (!expected.includes(kind)) {
    add(diagnostics, module, expression.span, "VALUE_KIND_INVALID", `${label} requires ${expected.join(" or ")}, but '${expression.name}' is ${kind}`);
  }
}

function intersectSets(sets: readonly Set<string>[]): Set<string> {
  const first = sets[0];
  if (first === undefined) return new Set();
  return new Set([...first].filter((value) => sets.slice(1).every((set) => set.has(value))));
}

function equalSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function add(
  diagnostics: AflDiagnostic[],
  module: AflModule,
  span: SourceSpan,
  code: string,
  message: string,
): void {
  diagnostics.push({
    code,
    message,
    span,
    ...(module.sourceName === undefined ? {} : { sourceName: module.sourceName }),
  });
}
