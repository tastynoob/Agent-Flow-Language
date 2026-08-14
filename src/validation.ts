import { resolve } from "node:path";

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
import { workspacePathOverlap } from "./workspace.js";
import { isAgentStandardToolName } from "./standard-agent-tools.js";

export interface ValidationSuccess {
  readonly ok: true;
  readonly value: AflModule;
  readonly diagnostics: readonly AflDiagnostic[];
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
  const errors = diagnostics.filter((item) => item.severity !== "warning");
  return errors.length === 0
    ? { ok: true, value: module, diagnostics }
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
  for (const documented of Object.keys(node.documentation?.parameters ?? {})) {
    if (!parameters.has(documented)) {
      add(
        diagnostics,
        module,
        node.span,
        "NODE_DOCUMENTATION_PARAM_UNKNOWN",
        `@param '${documented}' does not exist in node '${node.name}'`,
      );
    }
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
  validateFreedomWorkspaceWarnings(module, node, nodes, diagnostics);
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
    for (const target of terminatorTargets(block.terminator)) {
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
    if (terminator !== undefined) {
      for (const target of terminatorTargets(terminator)) {
        if (blocks.has(target)) pending.push(target);
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
  if (block.terminator.op === "branch") {
    expectKind(module, block.terminator.condition, kinds, ["compute", "unknown"], "branch condition", diagnostics);
  } else if (block.terminator.op === "match") {
    expectKind(module, block.terminator.selector, kinds, ["compute", "frag", "unknown"], "match selector", diagnostics);
    if (block.terminator.selector.kind === "list" || block.terminator.selector.kind === "record") {
      add(
        diagnostics,
        module,
        block.terminator.selector.span,
        "MATCH_SELECTOR_NOT_SCALAR",
        "match selector must be null, boolean, number, string, Frag, or an unknown compute value",
      );
    }
    if (block.terminator.cases.length === 0) {
      add(
        diagnostics,
        module,
        block.terminator.span,
        "MATCH_EMPTY",
        "match requires at least one case",
      );
    }
    const caseValues: Array<null | boolean | number | string> = [];
    for (const entry of block.terminator.cases) {
      if (!isMatchCaseValue(entry.value)) {
        add(
          diagnostics,
          module,
          block.terminator.span,
          "MATCH_CASE_INVALID",
          "match case values must be finite null, boolean, number, or string literals",
        );
      } else if (caseValues.some((value) => value === entry.value)) {
        add(
          diagnostics,
          module,
          block.terminator.span,
          "MATCH_CASE_DUPLICATE",
          `match repeats case ${JSON.stringify(entry.value)}`,
        );
      } else {
        caseValues.push(entry.value);
      }
    }
  }
}

function isMatchCaseValue(value: unknown): value is null | boolean | number | string {
  return value === null || typeof value === "boolean" || typeof value === "string" ||
    typeof value === "number" && Number.isFinite(value);
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
      if (instruction.tools !== undefined) {
        const seen = new Set<string>();
        for (const tool of instruction.tools) {
          if (!isAgentStandardToolName(tool)) {
            add(diagnostics, module, instruction.span, "AGENT_TOOL_UNKNOWN", `unknown standard Agent tool '${tool}'`);
          } else if (seen.has(tool)) {
            add(diagnostics, module, instruction.span, "AGENT_TOOL_DUPLICATE", `Agent tool '${tool}' is repeated`);
          }
          seen.add(tool);
        }
      }
      if (instruction.workspace !== undefined) {
        validateWorkspaceExpression(module, instruction.workspace, kinds, diagnostics);
        expectKind(module, instruction.workspace, kinds, ["compute", "unknown"], "Agent Workspace", diagnostics);
      }
      if (instruction.memory !== undefined) expectNameKind(module, instruction.memory, kinds, ["memory", "unknown"], "Agent Memory", diagnostics);
      break;
    case "agent.system_prompt":
      expectNameKind(module, instruction.agent, kinds, ["agent", "unknown"], "system prompt receiver", diagnostics);
      break;
    case "agent.do":
      expectNameKind(module, instruction.agent, kinds, ["agent", "unknown"], "Agent work receiver", diagnostics);
      break;
    case "repeat":
      expectKind(module, instruction.count, kinds, ["compute", "unknown"], "repeat count", diagnostics);
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
    case "agent.with_memory":
      expectNameKind(module, instruction.agent, kinds, ["agent", "unknown"], "with_memory receiver", diagnostics);
      expectNameKind(module, instruction.memory, kinds, ["memory", "unknown"], "with_memory Memory", diagnostics);
      break;
    case "agent.route":
    case "agent.flow":
      expectNameKind(module, instruction.agent, kinds, ["agent", "unknown"], "Agent control receiver", diagnostics);
      validateAgentControlLimits(module, instruction.minRoutes, instruction.maxRoutes, instruction.span, diagnostics);
      if (instruction.minRoutes !== undefined) {
        expectKind(module, instruction.minRoutes, kinds, ["compute", "unknown"], "min_routes", diagnostics);
      }
      if (instruction.maxRoutes !== undefined) {
        expectKind(module, instruction.maxRoutes, kinds, ["compute", "unknown"], "max_routes", diagnostics);
      }
      for (const value of Object.values(instruction.params.entries)) {
        expectKind(module, value, kinds, ["frag", "compute", "unknown"], "Agent controlled param", diagnostics);
      }
      break;
    default:
      break;
  }
}

function validateAgentControlLimits(
  module: AflModule,
  minimum: ValueExpr | undefined,
  maximum: ValueExpr | undefined,
  span: SourceSpan,
  diagnostics: AflDiagnostic[],
): void {
  if (minimum?.kind === "literal" &&
      (typeof minimum.value !== "number" || !Number.isSafeInteger(minimum.value) || minimum.value < 0)) {
    add(
      diagnostics,
      module,
      minimum.span,
      "FREEDOM_CONSTRAINT_INVALID",
      "min_routes must be a non-negative integer",
    );
  }
  if (maximum?.kind === "literal" &&
      (typeof maximum.value !== "number" || !Number.isSafeInteger(maximum.value) || maximum.value <= 0)) {
    add(
      diagnostics,
      module,
      maximum.span,
      "FREEDOM_CONSTRAINT_INVALID",
      "max_routes must be a positive integer",
    );
  }
  if (minimum?.kind === "literal" && typeof minimum.value === "number" &&
      maximum?.kind === "literal" && typeof maximum.value === "number" &&
      Number.isSafeInteger(minimum.value) && Number.isSafeInteger(maximum.value) &&
      minimum.value >= 0 && maximum.value > 0 && minimum.value > maximum.value) {
    add(
      diagnostics,
      module,
      span,
      "FREEDOM_CONSTRAINT_INVALID",
      `min_routes=${minimum.value} cannot exceed max_routes=${maximum.value}`,
    );
  }
}

function validateWorkspaceExpression(
  module: AflModule,
  expression: ValueExpr,
  kinds: ReadonlyMap<string, ValueKind>,
  diagnostics: AflDiagnostic[],
): void {
  if (expression.kind === "literal") {
    if (typeof expression.value !== "string" || expression.value.trim().length === 0) {
      add(diagnostics, module, expression.span, "AGENT_WORKSPACE_INVALID", "Agent Workspace must be a non-empty path");
    }
    return;
  }
  if (expression.kind === "name") return;
  if (expression.kind === "list") {
    for (const item of expression.items) {
      if (item.kind === "name") {
        expectNameKind(module, item, kinds, ["compute", "unknown"], "Agent Workspace path", diagnostics);
      }
    }
  }
  if (expression.kind !== "list" || expression.items.length < 2 || expression.items.some((item) =>
    item.kind !== "name" &&
    (item.kind !== "literal" || typeof item.value !== "string" || item.value.trim().length === 0))) {
    add(
      diagnostics,
      module,
      expression.span,
      "AGENT_WORKSPACE_INVALID",
      "Agent Workspace must be a path or a list containing a primary path and at least one read-only path",
    );
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
  } else if (instruction.op === "dispatch") {
    calls.push(...instruction.calls);
  } else if (instruction.op === "repeat") {
    calls.push({ target: instruction.target, args: instruction.args, span: instruction.span });
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
  if (instruction.op === "agent.route" || instruction.op === "agent.flow") {
    const seen = new Set<string>();
    for (const candidate of instruction.nodes) {
      if (seen.has(candidate.name)) {
        add(
          diagnostics,
          module,
          candidate.span,
          "FREEDOM_NODE_DUPLICATE",
          `Freedom Node '${candidate.name}' is listed more than once`,
        );
        continue;
      }
      seen.add(candidate.name);
      if (!nodes.has(candidate.name)) {
        add(
          diagnostics,
          module,
          candidate.span,
          "FREEDOM_NODE_UNKNOWN",
          `Freedom Node '${candidate.name}' is not declared`,
        );
      }
    }
    if (instruction.op === "agent.flow") {
      const agents = new Set<string>();
      for (const candidate of instruction.agents) {
        if (agents.has(candidate.name)) {
          add(
            diagnostics,
            module,
            candidate.span,
            "FREEDOM_AGENT_DUPLICATE",
            `Freedom Agent '${candidate.name}' is listed more than once`,
          );
        }
        agents.add(candidate.name);
      }
    }
  }
}

function validateFreedomWorkspaceWarnings(
  module: AflModule,
  currentNode: AflNode,
  nodes: ReadonlyMap<string, AflNode>,
  diagnostics: AflDiagnostic[],
): void {
  const plannerWorkspaces = new Map<string, StaticWorkspaceSet>();
  for (const block of currentNode.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== "agent") continue;
      const workspace = staticWorkspaceSet(instruction.workspace);
      if (workspace !== undefined) plannerWorkspaces.set(instruction.dst, workspace);
    }
  }
  for (const block of currentNode.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== "agent.route" && instruction.op !== "agent.flow") continue;
      const agentWorkspace = plannerWorkspaces.get(instruction.agent.name);
      if (agentWorkspace === undefined) continue;
      for (const candidate of instruction.nodes) {
        const target = nodes.get(candidate.name);
        if (target === undefined) continue;
        const overlaps = collectStaticAgentWorkspaces(target, nodes, new Set())
          .find((workspace) => staticWorkspaceConflict(workspace, agentWorkspace));
        if (overlaps === undefined) continue;
        addWarning(
          diagnostics,
          module,
          instruction.span,
          "FREEDOM_WORKSPACE_OVERLAP",
          `Agent control Node '${candidate.name}' contains an Agent Workspace that may overlap receiver '${instruction.agent.name}'`,
        );
      }
    }
  }
}

function collectStaticAgentWorkspaces(
  node: AflNode,
  nodes: ReadonlyMap<string, AflNode>,
  visited: Set<string>,
): StaticWorkspaceSet[] {
  if (visited.has(node.name)) return [];
  visited.add(node.name);
  const result: StaticWorkspaceSet[] = [];
  for (const block of node.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op === "agent") {
        const workspace = staticWorkspaceSet(instruction.workspace);
        if (workspace !== undefined) result.push(workspace);
      }
      for (const target of localInstructionTargets(instruction)) {
        const child = nodes.get(target);
        if (child !== undefined) result.push(...collectStaticAgentWorkspaces(child, nodes, visited));
      }
    }
  }
  return result;
}

function localInstructionTargets(instruction: AflInstruction): string[] {
  if (instruction.op === "call") {
    return instruction.target.kind === "local" ? [instruction.target.name] : [];
  }
  if (instruction.op === "dispatch") {
    return instruction.calls.filter((call) => call.target.kind === "local").map((call) => call.target.name);
  }
  if (instruction.op === "repeat") {
    return instruction.target.kind === "local" ? [instruction.target.name] : [];
  }
  return [];
}

interface StaticWorkspaceSet {
  readonly primary: string;
  readonly readOnly: readonly string[];
}

function staticWorkspaceSet(expression: ValueExpr | undefined): StaticWorkspaceSet | undefined {
  if (expression?.kind === "literal" && typeof expression.value === "string") {
    return { primary: resolve("/__afl_execution_root__", expression.value), readOnly: [] };
  }
  if (expression?.kind !== "list") return undefined;
  const paths = expression.items.map((item) =>
    item.kind === "literal" && typeof item.value === "string"
      ? resolve("/__afl_execution_root__", item.value)
      : undefined);
  if (paths.length < 2 || paths.some((path) => path === undefined)) return undefined;
  return { primary: paths[0]!, readOnly: paths.slice(1) as string[] };
}

function staticWorkspaceConflict(child: StaticWorkspaceSet, writer: StaticWorkspaceSet): boolean {
  if ([writer.primary, ...writer.readOnly].some((path) => workspacePathOverlap(child.primary, path))) {
    return true;
  }
  return child.readOnly.some((path) => workspacePathOverlap(path, writer.primary));
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
      if (isTaskGroupProducer(instruction)) {
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
      isTaskGroupProducer(instruction) && instruction.dst === name
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
    const targets = terminatorTargets(block.terminator);
    if (targets.length === 0) {
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
    for (const target of targets) pending.push({ block: target, outstanding });
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
        : instruction.op === "agent.with_memory"
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
    case "agent.with_memory":
    case "fork":
      return "agent";
    case "memory.copy":
      return "memory";
    case "dispatch":
    case "repeat":
    case "agent.route":
      return "taskGroup";
    case "oper":
    case "script":
      return "compute";
    default:
      return "frag";
  }
}

function isTaskGroupProducer(
  instruction: AflInstruction,
): instruction is Extract<AflInstruction, { readonly op: "dispatch" | "repeat" | "agent.route" }> {
  return instruction.op === "dispatch" || instruction.op === "repeat" ||
    instruction.op === "agent.route";
}

function terminatorReferences(terminator: AflTerminator): NameExpr[] {
  if (terminator.op === "jump") return [];
  if (terminator.op === "branch") return valueReferences(terminator.condition);
  if (terminator.op === "match") return valueReferences(terminator.selector);
  if (terminator.op === "ret") {
    return terminator.value === undefined ? [] : valueReferences(terminator.value);
  }
  return valueReferences(terminator.error);
}

function terminatorTargets(terminator: AflTerminator): readonly string[] {
  if (terminator.op === "jump") return [terminator.target];
  if (terminator.op === "branch") return [terminator.trueTarget, terminator.falseTarget];
  if (terminator.op === "match") {
    return [...terminator.cases.map((entry) => entry.target), terminator.defaultTarget];
  }
  return [];
}

function expectKind(
  module: AflModule,
  expression: ValueExpr,
  kinds: ReadonlyMap<string, ValueKind>,
  expected: readonly ValueKind[],
  label: string,
  diagnostics: AflDiagnostic[],
): void {
  if (expression.kind === "name") {
    expectNameKind(module, expression, kinds, expected, label, diagnostics);
    return;
  }
  if (expression.kind === "symbol") {
    add(diagnostics, module, expression.span, "VALUE_KIND_INVALID", `${label} requires ${expected.join(" or ")}, but the value is a symbol`);
  }
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

function addWarning(
  diagnostics: AflDiagnostic[],
  module: AflModule,
  span: SourceSpan,
  code: string,
  message: string,
): void {
  diagnostics.push({
    code,
    message,
    severity: "warning",
    span,
    ...(module.sourceName === undefined ? {} : { sourceName: module.sourceName }),
  });
}
