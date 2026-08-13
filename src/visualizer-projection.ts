import type {
  AflVisualEdge,
  AflVisualEdgeKind,
  AflVisualGraph,
  AflVisualNode,
} from "./visualizer.js";

export interface AflProjectedNode {
  readonly id: string;
  readonly scopeId: string;
  readonly visible: boolean;
  readonly terminal?: "start" | "end";
}

export interface AflProjectedEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: AflVisualEdgeKind;
  readonly label: string;
  readonly operations: readonly string[];
  readonly sourceEdgeIds: readonly string[];
}

export interface AflProjectedGraph {
  readonly nodes: readonly AflProjectedNode[];
  readonly edges: readonly AflProjectedEdge[];
}

const ANCHOR_PREFIX = "afl-anchor:";

export function projectAflVisualGraph(
  graph: AflVisualGraph,
  includeOptional: boolean,
): AflProjectedGraph {
  const sourceNodes = graph.nodes.filter((node) => includeOptional || !node.optional);
  const sourceNodeIds = new Set(sourceNodes.map((node) => node.id));
  const sourceEdges = graph.edges.filter((edge) => sourceNodeIds.has(edge.from) && sourceNodeIds.has(edge.to));
  const nodesById = new Map(sourceNodes.map((node) => [node.id, node]));
  const outgoing = groupEdges(sourceEdges, "from");
  const incoming = groupEdges(sourceEdges, "to");
  const visibleIds = new Set(sourceNodes.filter(isVisibleNode).map((node) => node.id));
  const projectedNodes: AflProjectedNode[] = sourceNodes
    .filter(isVisibleNode)
    .map((node) => ({ id: node.id, scopeId: node.scopeId, visible: true }));
  const projectedEdges: AflProjectedEdge[] = [];
  const edgeKeys = new Set<string>();
  let edgeSequence = 0;
  let anchorSequence = 0;

  const addAnchor = (scopeId: string, terminal: "start" | "end"): string => {
    const id = `${ANCHOR_PREFIX}${++anchorSequence}`;
    projectedNodes.push({ id, scopeId, visible: false, terminal });
    return id;
  };

  const addEdge = (
    from: string,
    to: string,
    hidden: readonly AflVisualNode[],
    traversed: readonly AflVisualEdge[],
  ): void => {
    const operations = hidden.flatMap((node) => node.operations);
    const kind = strongestKind(traversed.map((edge) => edge.kind));
    const label = summarizePath(hidden, traversed);
    const sourceEdgeIds = traversed.map((edge) => edge.id);
    const key = JSON.stringify([from, to, kind, label, operations, sourceEdgeIds]);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    projectedEdges.push({
      id: `p${++edgeSequence}`,
      from,
      to,
      kind,
      label,
      operations,
      sourceEdgeIds,
    });
  };

  const walk = (
    sourceId: string,
    currentId: string,
    hidden: readonly AflVisualNode[],
    traversed: readonly AflVisualEdge[],
    visitedHidden: ReadonlySet<string>,
  ): void => {
    const nextEdges = outgoing.get(currentId) ?? [];
    if (nextEdges.length === 0) {
      if (hidden.length > 0 && !isAflVisualAnchor(sourceId)) {
        addEdge(sourceId, addAnchor(hidden[hidden.length - 1]!.scopeId, "end"), hidden, traversed);
      }
      return;
    }
    for (const edge of nextEdges) {
      const target = nodesById.get(edge.to);
      if (target === undefined) continue;
      const nextTraversed = [...traversed, edge];
      if (visibleIds.has(target.id)) {
        addEdge(sourceId, target.id, hidden, nextTraversed);
        continue;
      }
      if (visitedHidden.has(target.id)) continue;
      walk(
        sourceId,
        target.id,
        [...hidden, target],
        nextTraversed,
        new Set([...visitedHidden, target.id]),
      );
    }
  };

  for (const sourceId of visibleIds) {
    const nextEdges = outgoing.get(sourceId) ?? [];
    for (const edge of nextEdges) {
      const target = nodesById.get(edge.to);
      if (target === undefined) continue;
      if (visibleIds.has(target.id)) {
        addEdge(sourceId, target.id, [], [edge]);
      } else {
        walk(sourceId, target.id, [target], [edge], new Set([target.id]));
      }
    }
  }

  for (const root of sourceNodes) {
    if (visibleIds.has(root.id) || (incoming.get(root.id)?.length ?? 0) > 0) continue;
    const anchor = addAnchor(root.scopeId, "start");
    const before = projectedEdges.length;
    walk(anchor, root.id, [root], [], new Set([root.id]));
    if (projectedEdges.length === before) projectedNodes.pop();
  }

  return { nodes: projectedNodes, edges: projectedEdges };
}

export function isAflVisualAnchor(id: string): boolean {
  return id.startsWith(ANCHOR_PREFIX);
}

function isVisibleNode(node: AflVisualNode): boolean {
  return node.kind === "model" || node.kind === "decision";
}

function groupEdges(
  edges: readonly AflVisualEdge[],
  key: "from" | "to",
): ReadonlyMap<string, readonly AflVisualEdge[]> {
  const result = new Map<string, AflVisualEdge[]>();
  for (const edge of edges) {
    const items = result.get(edge[key]) ?? [];
    items.push(edge);
    result.set(edge[key], items);
  }
  return result;
}

function strongestKind(kinds: readonly AflVisualEdgeKind[]): AflVisualEdgeKind {
  for (const kind of ["loop", "dynamic", "branch", "parallel", "return", "control", "dependency"] as const) {
    if (kinds.includes(kind)) return kind;
  }
  return "dependency";
}

function summarizePath(
  hidden: readonly AflVisualNode[],
  traversed: readonly AflVisualEdge[],
): string {
  const parts = [
    ...traversed.map((edge) => edge.label).filter((label) => label !== ""),
    ...hidden.map(describeHiddenNode),
  ];
  return uniqueAdjacent(parts.filter((part) => part !== "")).join(" · ");
}

function describeHiddenNode(node: AflVisualNode): string {
  switch (node.kind) {
    case "operations":
      return node.subtitle || node.title;
    case "parallel":
      return "parallel";
    case "join":
      return "join";
    case "input":
      return "input";
    case "return":
      return "return";
    case "fail":
      return "fail";
    case "external":
      return `external ${node.title}`;
    case "call":
      return node.title;
    case "control":
      return node.title;
    case "model":
    case "decision":
      return "";
  }
}

function uniqueAdjacent(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (result[result.length - 1] !== value) result.push(value);
  }
  return result;
}
