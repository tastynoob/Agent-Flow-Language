import type {
  AflBlock,
  AflInstruction,
  NameExpr,
  OperExpr,
  ValueExpr,
} from "./ir.js";

interface ResourceAccess {
  readonly key: string;
  readonly mode: "read" | "write";
}

export function buildInstructionDependencies(block: AflBlock): Array<Set<number>> {
  const dependencies = block.instructions.map(() => new Set<number>());
  const producers = new Map<string, number>();
  block.instructions.forEach((instruction, index) => {
    const destination = instructionDestination(instruction);
    if (destination !== undefined) producers.set(destination, index);
  });
  block.instructions.forEach((instruction, consumer) => {
    for (const reference of instructionReferences(instruction)) {
      const producer = producers.get(reference.name);
      if (producer !== undefined && producer !== consumer) dependencies[consumer]!.add(producer);
    }
  });

  const lastWriter = new Map<string, number>();
  const readers = new Map<string, Set<number>>();
  block.instructions.forEach((instruction, index) => {
    for (const access of resourceAccesses(instruction)) {
      const writer = lastWriter.get(access.key);
      if (writer !== undefined) dependencies[index]!.add(writer);
      if (access.mode === "write") {
        for (const reader of readers.get(access.key) ?? []) dependencies[index]!.add(reader);
        lastWriter.set(access.key, index);
        readers.set(access.key, new Set());
      } else {
        const current = readers.get(access.key) ?? new Set<number>();
        current.add(index);
        readers.set(access.key, current);
      }
    }
  });
  return dependencies;
}

export function hasDependencyCycle(dependencies: readonly ReadonlySet<number>[]): boolean {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (node: number): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dependency of dependencies[node] ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return dependencies.some((_item, index) => visit(index));
}

export function instructionDestination(instruction: AflInstruction): string | undefined {
  return "dst" in instruction ? instruction.dst : undefined;
}

export function instructionReferences(instruction: AflInstruction): NameExpr[] {
  switch (instruction.op) {
    case "agent":
      return [
        ...(instruction.workspace === undefined ? [] : valueReferences(instruction.workspace)),
        ...(instruction.memory === undefined ? [] : [instruction.memory]),
      ];
    case "agent.sysprompt":
      return [instruction.agent, ...valueReferences(instruction.prompt)];
    case "agent.do":
      return [instruction.agent, ...valueReferences(instruction.input)];
    case "prompt":
      return [...valueReferences(instruction.source), ...instruction.args.flatMap(valueReferences)];
    case "input":
      return valueReferences(instruction.prompt);
    case "oper":
      return valueReferences(instruction.expression);
    case "script":
      return instruction.args.flatMap(valueReferences);
    case "call":
      return instruction.args.flatMap(valueReferences);
    case "dispatch.list":
      return instruction.calls.flatMap((call) => call.args.flatMap(valueReferences));
    case "dispatch.batch":
      return [...valueReferences(instruction.count), ...valueReferences(instruction.task)];
    case "sync":
      return [instruction.taskGroup];
    case "fork":
      return [instruction.sourceAgent, ...valueReferences(instruction.action.input)];
    case "invoke":
      return instruction.args.flatMap(valueReferences);
    case "memory.append":
      return [instruction.memory, ...valueReferences(instruction.frag)];
    case "memory.copy":
      return [instruction.memory];
    case "memory.apply":
      return [instruction.sourceAgent, instruction.memory];
    case "freedom.move":
    case "freedom.flow":
      return [
        instruction.planner,
        ...(instruction.moves === undefined ? [] : valueReferences(instruction.moves)),
        ...valueReferences(instruction.prompt),
        ...valueReferences(instruction.context),
      ];
  }
}

export function valueReferences(expression: ValueExpr | OperExpr): NameExpr[] {
  switch (expression.kind) {
    case "name":
      return [expression];
    case "list":
      return expression.items.flatMap(valueReferences);
    case "record":
      return Object.values(expression.entries).flatMap(valueReferences);
    case "unary":
      return valueReferences(expression.operand);
    case "binary":
      return [...valueReferences(expression.left), ...valueReferences(expression.right)];
    default:
      return [];
  }
}

function resourceAccesses(instruction: AflInstruction): ResourceAccess[] {
  switch (instruction.op) {
    case "agent":
      return instruction.memory === undefined ? [] : [{ key: memoryResource(instruction.memory.name), mode: "write" }];
    case "agent.sysprompt":
      return [{ key: agentResource(instruction.agent.name), mode: "write" }];
    case "agent.do":
      return [
        { key: agentResource(instruction.agent.name), mode: "write" },
        { key: memoryResource(instruction.agent.name), mode: "write" },
      ];
    case "sync":
      return [{ key: `task:${instruction.taskGroup.name}`, mode: "write" }];
    case "fork":
      return [
        { key: agentResource(instruction.sourceAgent.name), mode: "read" },
        { key: memoryResource(instruction.sourceAgent.name), mode: "read" },
      ];
    case "memory.append":
      return [{ key: memoryResource(instruction.memory.name), mode: "write" }];
    case "memory.copy":
      return [{ key: memoryResource(instruction.memory.name), mode: "read" }];
    case "memory.apply":
      return [
        { key: agentResource(instruction.sourceAgent.name), mode: "read" },
        { key: memoryResource(instruction.memory.name), mode: "write" },
      ];
    case "freedom.move":
    case "freedom.flow":
      return [
        { key: agentResource(instruction.planner.name), mode: "read" },
        { key: memoryResource(instruction.planner.name), mode: "read" },
      ];
    default:
      return [];
  }
}

function agentResource(name: string): string {
  return `source-agent:${name}`;
}

function memoryResource(name: string): string {
  return `source-memory:${name}`;
}
