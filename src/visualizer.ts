import { buildInstructionDependencies } from "./dependencies.js";
import type {
  AflBlock,
  AflInstruction,
  AflModule,
  AflNode,
  FlowCallExpr,
  SourceSpan,
} from "./ir.js";

export type AflVisualNodeKind =
  | "model"
  | "operations"
  | "input"
  | "parallel"
  | "join"
  | "decision"
  | "return"
  | "fail"
  | "external"
  | "call"
  | "control";

export type AflVisualEdgeKind =
  | "dependency"
  | "control"
  | "branch"
  | "loop"
  | "parallel"
  | "dynamic"
  | "return";

export interface AflVisualNode {
  readonly id: string;
  readonly scopeId: string;
  readonly sourceNode: string;
  readonly block: string;
  readonly kind: AflVisualNodeKind;
  readonly title: string;
  readonly subtitle: string;
  readonly operations: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly optional: boolean;
}

export interface AflVisualEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: AflVisualEdgeKind;
  readonly label: string;
}

export interface AflVisualScope {
  readonly id: string;
  readonly parentId?: string;
  readonly sourceNode: string;
  readonly label: string;
  readonly invocation: string;
  readonly depth: number;
  readonly optional: boolean;
  readonly description: string;
}

export interface AflVisualGraph {
  readonly version: "afl.visual-graph/v0";
  readonly sourceName: string;
  readonly entry: string;
  readonly nodes: readonly AflVisualNode[];
  readonly edges: readonly AflVisualEdge[];
  readonly scopes: readonly AflVisualScope[];
  readonly statistics: {
    readonly modelCalls: number;
    readonly operationGroups: number;
    readonly expandedCalls: number;
    readonly dynamicCandidates: number;
  };
}

export interface AflVisualizationOptions {
  readonly entry?: string;
  readonly maxCallDepth?: number;
  readonly expandFreedomCandidates?: boolean;
}

interface Expansion {
  readonly entries: readonly string[];
  readonly returns: readonly string[];
}

interface InstructionUnit {
  readonly indexes: readonly number[];
  readonly entries: readonly string[];
  readonly exits: readonly string[];
  readonly taskChildren?: readonly string[];
}

interface BlockBuild {
  readonly block: AflBlock;
  readonly entries: readonly string[];
  readonly exits: readonly string[];
  readonly decision?: string;
  readonly returns: readonly string[];
}

const SINGULAR_OPERATIONS = new Set<AflInstruction["op"]>([
  "agent.do",
  "input",
  "call",
  "dispatch",
  "repeat",
  "sync",
  "fork",
  "agent.route",
  "agent.flow",
]);

export function buildAflVisualGraph(
  module: AflModule,
  source: string,
  options: AflVisualizationOptions = {},
): AflVisualGraph {
  return new VisualGraphBuilder(module, source, options).build();
}

class VisualGraphBuilder {
  private readonly sourceLines: readonly string[];
  private readonly nodesByName: ReadonlyMap<string, AflNode>;
  private readonly visualNodes: AflVisualNode[] = [];
  private readonly visualEdges: AflVisualEdge[] = [];
  private readonly scopes: AflVisualScope[] = [];
  private readonly edgeKeys = new Set<string>();
  private readonly maxCallDepth: number;
  private readonly expandFreedomCandidates: boolean;
  private nodeSequence = 0;
  private edgeSequence = 0;
  private scopeSequence = 0;
  private expandedCalls = 0;
  private dynamicCandidates = 0;

  constructor(
    private readonly module: AflModule,
    source: string,
    private readonly options: AflVisualizationOptions,
  ) {
    this.sourceLines = source.replace(/\r\n?/gu, "\n").split("\n");
    this.nodesByName = new Map(module.nodes.map((node) => [node.name, node]));
    this.maxCallDepth = options.maxCallDepth ?? 8;
    if (!Number.isSafeInteger(this.maxCallDepth) || this.maxCallDepth < 0) {
      throw new Error("AFL visualization maxCallDepth must be a non-negative integer");
    }
    this.expandFreedomCandidates = options.expandFreedomCandidates ?? true;
  }

  build(): AflVisualGraph {
    const entry = this.options.entry ?? (this.nodesByName.has("main") ? "main" : this.module.nodes[0]?.name);
    if (entry === undefined) throw new Error("cannot visualize an empty AFL module");
    const node = this.nodesByName.get(entry);
    if (node === undefined) throw new Error(`AFL visualization entry '${entry}' does not exist`);

    const root = this.createScope(node, undefined, `${entry}()`, "entry", 0, false);
    this.expandNode(node, root, 0, [entry]);

    return {
      version: "afl.visual-graph/v0",
      sourceName: this.module.sourceName ?? "AFL workflow",
      entry,
      nodes: this.visualNodes,
      edges: this.visualEdges,
      scopes: this.scopes,
      statistics: {
        modelCalls: this.visualNodes.filter((item) => item.kind === "model").length,
        operationGroups: this.visualNodes.filter((item) => item.kind === "operations").length,
        expandedCalls: this.expandedCalls,
        dynamicCandidates: this.dynamicCandidates,
      },
    };
  }

  private expandNode(
    node: AflNode,
    scope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
  ): Expansion {
    const agents = this.collectAgentSymbols(node);
    const blocks = new Map<string, BlockBuild>();
    const blockIndexes = new Map(node.blocks.map((block, index) => [block.name, index]));
    for (const block of node.blocks) {
      blocks.set(block.name, this.buildBlock(node, block, scope, depth, callStack, agents));
    }

    for (const [blockName, built] of blocks) {
      const terminator = built.block.terminator;
      if (terminator.op === "jump") {
        const target = blocks.get(terminator.target);
        if (target !== undefined) {
          this.connectMany(
            built.exits,
            target.entries,
            this.isBackEdge(blockName, terminator.target, blockIndexes) ? "loop" : "control",
            "",
          );
        }
      } else if (terminator.op === "branch") {
        const trueBlock = blocks.get(terminator.trueTarget);
        if (trueBlock !== undefined) {
          this.connectMany(
            built.exits,
            trueBlock.entries,
            this.isBackEdge(blockName, terminator.trueTarget, blockIndexes) ? "loop" : "branch",
            "true",
          );
        }
        const falseBlock = blocks.get(terminator.falseTarget);
        if (falseBlock !== undefined) {
          this.connectMany(
            built.exits,
            falseBlock.entries,
            this.isBackEdge(blockName, terminator.falseTarget, blockIndexes) ? "loop" : "branch",
            "false",
          );
        }
      } else if (terminator.op === "match") {
        for (const entry of terminator.cases) {
          const target = blocks.get(entry.target);
          if (target === undefined) continue;
          this.connectMany(
            built.exits,
            target.entries,
            this.isBackEdge(blockName, entry.target, blockIndexes) ? "loop" : "branch",
            formatJumpCase(entry.value),
          );
        }
        const fallback = blocks.get(terminator.defaultTarget);
        if (fallback !== undefined) {
          this.connectMany(
            built.exits,
            fallback.entries,
            this.isBackEdge(blockName, terminator.defaultTarget, blockIndexes) ? "loop" : "branch",
            "default",
          );
        }
      }
    }

    const entry = blocks.get("entry");
    return {
      entries: entry?.entries ?? [],
      returns: [...blocks.values()].flatMap((block) => block.returns),
    };
  }

  private buildBlock(
    sourceNode: AflNode,
    block: AflBlock,
    scope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
    agents: ReadonlyMap<string, string>,
  ): BlockBuild {
    const units: InstructionUnit[] = [];
    const indexToUnit = new Map<number, number>();
    const taskChildren = new Map<string, readonly string[]>();
    let index = 0;
    while (index < block.instructions.length) {
      const instruction = block.instructions[index]!;
      let unit: InstructionUnit;
      if (SINGULAR_OPERATIONS.has(instruction.op)) {
        unit = this.buildSingularInstruction(
          sourceNode,
          block,
          instruction,
          index,
          scope,
          depth,
          callStack,
          agents,
        );
        index += 1;
      } else {
        const start = index;
        const grouped: AflInstruction[] = [];
        while (index < block.instructions.length && !SINGULAR_OPERATIONS.has(block.instructions[index]!.op)) {
          grouped.push(block.instructions[index]!);
          index += 1;
        }
        unit = this.buildOperations(sourceNode, block, grouped, start, scope);
      }
      const unitIndex = units.length;
      units.push(unit);
      for (const instructionIndex of unit.indexes) indexToUnit.set(instructionIndex, unitIndex);
      const first = block.instructions[unit.indexes[0]!]!;
      if (unit.taskChildren !== undefined && "dst" in first) taskChildren.set(first.dst, unit.taskChildren);
    }

    const dependencies = buildInstructionDependencies(block);
    const incoming = units.map(() => new Set<number>());
    const outgoing = units.map(() => new Set<number>());
    dependencies.forEach((items, consumerInstruction) => {
      const consumerUnit = indexToUnit.get(consumerInstruction);
      if (consumerUnit === undefined) return;
      for (const producerInstruction of items) {
        const producerUnit = indexToUnit.get(producerInstruction);
        if (producerUnit === undefined || producerUnit === consumerUnit) continue;
        incoming[consumerUnit]!.add(producerUnit);
        outgoing[producerUnit]!.add(consumerUnit);
      }
    });
    incoming.forEach((producers, consumer) => {
      for (const producer of producers) {
        this.connectMany(units[producer]!.exits, units[consumer]!.entries, "dependency", "");
      }
    });

    units.forEach((unit) => {
      const first = block.instructions[unit.indexes[0]!]!;
      if (first.op !== "sync") return;
      const children = taskChildren.get(first.taskGroup.name);
      if (children !== undefined) this.connectMany(children, unit.entries, "parallel", "join");
    });

    const roots = units.filter((_unit, unitIndex) => incoming[unitIndex]!.size === 0).flatMap((unit) => unit.entries);
    const sinks = units.filter((_unit, unitIndex) => outgoing[unitIndex]!.size === 0).flatMap((unit) => unit.exits);
    const terminator = block.terminator;
    let entries = roots;
    let exits: readonly string[] = sinks;
    let decision: string | undefined;
    let returns: readonly string[] = [];

    if (terminator.op === "match" || terminator.op === "branch") {
      decision = this.addNode(scope, sourceNode.name, block.name, "decision", {
        title: terminator.op === "match" ? `Branch · ${terminator.cases.length + 1} paths` : "Branch",
        subtitle: this.sourceText(terminator.span),
        operations: [this.sourceText(terminator.span)],
        span: terminator.span,
      });
      this.connectMany(sinks, [decision], "control", "");
      if (entries.length === 0) entries = [decision];
      exits = [decision];
    } else if (terminator.op === "ret" || terminator.op === "fail") {
      const terminal = this.addNode(scope, sourceNode.name, block.name, terminator.op === "ret" ? "return" : "fail", {
        title: terminator.op === "ret" ? "Return" : "Fail",
        subtitle: this.sourceText(terminator.span),
        operations: [this.sourceText(terminator.span)],
        span: terminator.span,
      });
      this.connectMany(sinks, [terminal], terminator.op === "ret" ? "return" : "control", "");
      if (entries.length === 0) entries = [terminal];
      exits = [terminal];
      if (terminator.op === "ret") returns = [terminal];
    } else if (entries.length === 0) {
      const anchor = this.addNode(scope, sourceNode.name, block.name, "control", {
        title: `Block · ${block.name}`,
        subtitle: this.sourceText(terminator.span),
        operations: [this.sourceText(terminator.span)],
        span: block.span,
      });
      entries = [anchor];
      exits = [anchor];
    }

    return {
      block,
      entries: unique(entries),
      exits: unique(exits),
      ...(decision === undefined ? {} : { decision }),
      returns,
    };
  }

  private buildSingularInstruction(
    sourceNode: AflNode,
    block: AflBlock,
    instruction: AflInstruction,
    index: number,
    scope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
    agents: ReadonlyMap<string, string>,
  ): InstructionUnit {
    switch (instruction.op) {
      case "agent.do": {
        const receiver = instruction.agent.name;
        const id = this.addNode(scope, sourceNode.name, block.name, "model", {
          title: `${receiver} · model call`,
          subtitle: [agents.get(receiver), formatLabel(instruction.format)].filter(Boolean).join(" · "),
          operations: [this.sourceText(instruction.span)],
          span: instruction.span,
        });
        return unit(index, id);
      }
      case "fork": {
        const id = this.addNode(scope, sourceNode.name, block.name, "model", {
          title: `${instruction.dst} · forked model call`,
          subtitle: `from ${instruction.sourceAgent.name}`,
          operations: [this.sourceText(instruction.span)],
          span: instruction.span,
        });
        return unit(index, id);
      }
      case "input": {
        const id = this.addNode(scope, sourceNode.name, block.name, "input", {
          title: `Input · ${instruction.dst}`,
          subtitle: instruction.schema?.name ?? "human or host input",
          operations: [this.sourceText(instruction.span)],
          span: instruction.span,
        });
        return unit(index, id);
      }
      case "call":
        return this.buildCall(sourceNode, block, instruction.target.name, instruction.target.kind, instruction.span, index, scope, depth, callStack, "call");
      case "dispatch":
        return this.buildDispatch(sourceNode, block, instruction.calls, instruction.span, index, scope, depth, callStack, instruction.dst);
      case "repeat":
        return this.buildRepeat(sourceNode, block, instruction, index, scope, depth, callStack);
      case "sync": {
        const id = this.addNode(scope, sourceNode.name, block.name, "join", {
          title: `Join · ${instruction.taskGroup.name}`,
          subtitle: instruction.formatter?.name ?? "ordered results",
          operations: [this.sourceText(instruction.span)],
          span: instruction.span,
        });
        return unit(index, id);
      }
      case "agent.route":
      case "agent.flow": {
        const mode = instruction.op === "agent.route" ? "dynamic route" : "dynamic flow";
        const id = this.addNode(scope, sourceNode.name, block.name, "model", {
          title: `${instruction.agent.name} · ${mode}`,
          subtitle: `${instruction.nodes.length} candidate Nodes`,
          operations: [this.sourceText(instruction.span)],
          span: instruction.span,
        });
        const childReturns: string[] = [];
        if (this.expandFreedomCandidates) {
          for (const candidate of instruction.nodes) {
            if (candidate.kind !== "local") continue;
            const expansion = this.expandCallTarget(
              candidate.name,
              scope,
              depth,
              callStack,
              `candidate of ${instruction.agent.name}`,
              true,
            );
            this.connectMany([id], expansion.entries, "dynamic", "may route");
            childReturns.push(...expansion.returns);
            this.dynamicCandidates += 1;
          }
        }
        return {
          indexes: [index],
          entries: [id],
          exits: [id],
          ...(instruction.op === "agent.route" ? { taskChildren: childReturns } : {}),
        };
      }
      default:
        throw new Error(`unexpected singular AFL instruction '${instruction.op}'`);
    }
  }

  private buildOperations(
    sourceNode: AflNode,
    block: AflBlock,
    instructions: readonly AflInstruction[],
    startIndex: number,
    scope: AflVisualScope,
  ): InstructionUnit {
    const operations = instructions.map((instruction) => this.sourceText(instruction.span));
    const only = instructions.length === 1 ? instructions[0] : undefined;
    let title = `Operations · ${instructions.length}`;
    let subtitle = unique(instructions.map((instruction) => instruction.op)).join(" · ");
    if (only?.op === "invoke") {
      title = only.capability.name;
      subtitle = "capability";
    } else if (only?.op === "agent") {
      title = `Prepare · ${only.dst}`;
      subtitle = only.agent.name;
    } else if (instructions.every((instruction) => instruction.op === "agent" || instruction.op === "agent.system_prompt")) {
      title = "Agent setup";
      subtitle = `${instructions.length} operations`;
    }
    const id = this.addNode(scope, sourceNode.name, block.name, "operations", {
      title,
      subtitle,
      operations,
      span: mergeSpans(instructions.map((instruction) => instruction.span)),
      lineEnd: instructions[instructions.length - 1]!.span.line,
    });
    return {
      indexes: instructions.map((_instruction, offset) => startIndex + offset),
      entries: [id],
      exits: [id],
    };
  }

  private buildCall(
    sourceNode: AflNode,
    block: AflBlock,
    targetName: string,
    targetKind: "local" | "external",
    span: SourceSpan,
    index: number,
    scope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
    invocation: string,
  ): InstructionUnit {
    if (targetKind === "external") {
      const id = this.addNode(scope, sourceNode.name, block.name, "external", {
        title: targetName,
        subtitle: "external flow",
        operations: [this.sourceText(span)],
        span,
      });
      return unit(index, id);
    }
    const expansion = this.expandCallTarget(targetName, scope, depth, callStack, invocation, scope.optional);
    return { indexes: [index], entries: expansion.entries, exits: expansion.returns };
  }

  private buildDispatch(
    sourceNode: AflNode,
    block: AflBlock,
    calls: readonly FlowCallExpr[],
    span: SourceSpan,
    index: number,
    scope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
    destination: string,
  ): InstructionUnit {
    const split = this.addNode(scope, sourceNode.name, block.name, "parallel", {
      title: `Parallel · ${calls.length} calls`,
      subtitle: destination,
      operations: [this.sourceText(span)],
      span,
    });
    const returns: string[] = [];
    calls.forEach((call, callIndex) => {
      const built = call.target.kind === "local"
        ? this.expandCallTarget(call.target.name, scope, depth, callStack, `parallel ${callIndex + 1}`, scope.optional)
        : this.externalExpansion(sourceNode, block, call.target.name, call.span, scope);
      this.connectMany([split], built.entries, "parallel", `${callIndex + 1}`);
      returns.push(...built.returns);
    });
    return { indexes: [index], entries: [split], exits: [split], taskChildren: returns };
  }

  private buildRepeat(
    sourceNode: AflNode,
    block: AflBlock,
    instruction: Extract<AflInstruction, { readonly op: "repeat" }>,
    index: number,
    scope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
  ): InstructionUnit {
    const split = this.addNode(scope, sourceNode.name, block.name, "parallel", {
      title: "Parallel repeat",
      subtitle: `${instruction.target.name} · runtime count`,
      operations: [this.sourceText(instruction.span)],
      span: instruction.span,
    });
    const child = instruction.target.kind === "local"
      ? this.expandCallTarget(instruction.target.name, scope, depth, callStack, "repeat template", scope.optional)
      : this.externalExpansion(sourceNode, block, instruction.target.name, instruction.span, scope);
    this.connectMany([split], child.entries, "parallel", "0..N");
    return { indexes: [index], entries: [split], exits: [split], taskChildren: child.returns };
  }

  private externalExpansion(
    sourceNode: AflNode,
    block: AflBlock,
    target: string,
    span: SourceSpan,
    scope: AflVisualScope,
  ): Expansion {
    const id = this.addNode(scope, sourceNode.name, block.name, "external", {
      title: target,
      subtitle: "external flow",
      operations: [this.sourceText(span)],
      span,
    });
    return { entries: [id], returns: [id] };
  }

  private expandCallTarget(
    targetName: string,
    parentScope: AflVisualScope,
    depth: number,
    callStack: readonly string[],
    invocation: string,
    optional: boolean,
  ): Expansion {
    const target = this.nodesByName.get(targetName);
    if (target === undefined || depth >= this.maxCallDepth || callStack.includes(targetName)) {
      const label = target === undefined ? "missing local Node" : callStack.includes(targetName) ? "recursive call" : "depth limit";
      const id = this.addNode(parentScope, parentScope.sourceNode, "call", "call", {
        title: `Call · ${targetName}`,
        subtitle: label,
        operations: [invocation],
        span: { line: 0, column: 0, endColumn: 0 },
      });
      return { entries: [id], returns: [id] };
    }
    const childScope = this.createScope(target, parentScope.id, `${targetName}()`, invocation, depth + 1, optional);
    this.expandedCalls += 1;
    return this.expandNode(target, childScope, depth + 1, [...callStack, targetName]);
  }

  private createScope(
    node: AflNode,
    parentId: string | undefined,
    label: string,
    invocation: string,
    depth: number,
    optional: boolean,
  ): AflVisualScope {
    const scope: AflVisualScope = {
      id: `s${++this.scopeSequence}`,
      ...(parentId === undefined ? {} : { parentId }),
      sourceNode: node.name,
      label,
      invocation,
      depth,
      optional,
      description: node.documentation?.description ?? "",
    };
    this.scopes.push(scope);
    return scope;
  }

  private addNode(
    scope: AflVisualScope,
    sourceNode: string,
    block: string,
    kind: AflVisualNodeKind,
    value: {
      readonly title: string;
      readonly subtitle: string;
      readonly operations: readonly string[];
      readonly span: SourceSpan;
      readonly lineEnd?: number;
    },
  ): string {
    const id = `n${++this.nodeSequence}`;
    this.visualNodes.push({
      id,
      scopeId: scope.id,
      sourceNode,
      block,
      kind,
      title: value.title,
      subtitle: value.subtitle,
      operations: value.operations,
      lineStart: value.span.line,
      lineEnd: value.lineEnd ?? value.span.line,
      optional: scope.optional,
    });
    return id;
  }

  private addEdge(from: string, to: string, kind: AflVisualEdgeKind, label: string): void {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}\u0000${label}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.visualEdges.push({ id: `e${++this.edgeSequence}`, from, to, kind, label });
  }

  private connectMany(
    from: readonly string[],
    to: readonly string[],
    kind: AflVisualEdgeKind,
    label: string,
  ): void {
    for (const source of from) for (const destination of to) this.addEdge(source, destination, kind, label);
  }

  private collectAgentSymbols(node: AflNode): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const block of node.blocks) {
      for (const instruction of block.instructions) {
        if (instruction.op === "agent") result.set(instruction.dst, instruction.agent.name);
      }
    }
    return result;
  }

  private sourceText(span: SourceSpan): string {
    if (span.line <= 0) return "";
    return this.sourceLines[span.line - 1]?.trim() ?? "";
  }

  private isBackEdge(
    from: string,
    to: string,
    indexes: ReadonlyMap<string, number>,
  ): boolean {
    return (indexes.get(to) ?? Number.MAX_SAFE_INTEGER) <= (indexes.get(from) ?? -1);
  }
}

function formatLabel(format: import("./ir.js").AgentOutputFormat | undefined): string | undefined {
  if (format === undefined) return undefined;
  return format.kind === "enum"
    ? `${format.values.length} output choices`
    : `${Object.keys(format.fields).length} output fields`;
}

function formatJumpCase(value: null | boolean | number | string): string {
  return JSON.stringify(value);
}

function unit(index: number, id: string): InstructionUnit {
  return { indexes: [index], entries: [id], exits: [id] };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function mergeSpans(spans: readonly SourceSpan[]): SourceSpan {
  const first = spans[0] ?? { line: 0, column: 0, endColumn: 0 };
  const last = spans.at(-1) ?? first;
  return { line: first.line, column: first.column, endColumn: last.endColumn };
}
