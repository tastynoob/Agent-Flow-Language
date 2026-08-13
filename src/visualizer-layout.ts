import * as ElkModule from "elkjs/lib/elk.bundled.js";
import type {
  ELK as ElkInstance,
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  ElkPort,
} from "elkjs";

import type { AflVisualEdgeKind, AflVisualGraph, AflVisualScope } from "./visualizer.js";
import {
  projectAflVisualGraph,
  type AflProjectedEdge,
  type AflProjectedNode,
} from "./visualizer-projection.js";

export interface AflVisualLayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AflVisualLayoutScope {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AflVisualLayoutTerminal {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly kind: "start" | "end";
}

export interface AflVisualLayoutEdgeSection {
  readonly points: readonly AflVisualPoint[];
  readonly terminal: boolean;
}

export interface AflVisualLayoutEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: AflVisualEdgeKind;
  readonly label: string;
  readonly operations: readonly string[];
  readonly sourceEdgeIds: readonly string[];
  readonly sections: readonly AflVisualLayoutEdgeSection[];
  readonly labelPosition?: {
    readonly x: number;
    readonly y: number;
  };
}

export interface AflVisualPoint {
  readonly x: number;
  readonly y: number;
}

export interface AflVisualLayout {
  readonly engine: "elk.layered";
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly AflVisualLayoutNode[];
  readonly edges: readonly AflVisualLayoutEdge[];
  readonly scopes: readonly AflVisualLayoutScope[];
  readonly terminals: readonly AflVisualLayoutTerminal[];
}

export interface AflVisualLayouts {
  readonly main: AflVisualLayout;
  readonly expanded: AflVisualLayout;
}

export interface AflVisualLayoutOptions {
  readonly nodeWidth?: number;
  readonly nodeHeight?: number;
}

const ROOT_ID = "afl-layout-root";
const SCOPE_PREFIX = "afl-scope:";
const ElkConstructor = ElkModule.default.default;

export async function layoutAflVisualGraph(
  graph: AflVisualGraph,
  options: AflVisualLayoutOptions = {},
): Promise<AflVisualLayouts> {
  const elk = new ElkConstructor({ algorithms: ["layered"] });
  const mainPromise = layoutVariant(elk, graph, false, options);
  if (!graph.nodes.some((node) => node.optional)) {
    const main = await mainPromise;
    return { main, expanded: main };
  }
  const [main, expanded] = await Promise.all([
    mainPromise,
    layoutVariant(elk, graph, true, options),
  ]);
  return { main, expanded };
}

async function layoutVariant(
  elk: ElkInstance,
  graph: AflVisualGraph,
  includeOptional: boolean,
  options: AflVisualLayoutOptions,
): Promise<AflVisualLayout> {
  const nodeWidth = options.nodeWidth ?? 252;
  const nodeHeight = options.nodeHeight ?? 100;
  const projection = projectAflVisualGraph(graph, includeOptional);
  const sourceNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const visibleScopeIds = collectVisibleScopes(graph.scopes, projection.nodes.map((node) => node.scopeId));
  const scopeElements = new Map<string, ElkNode>();
  const nodeElements = new Map<string, ElkNode>();
  const rootScope = graph.scopes.find((scope) => scope.parentId === undefined);
  const rootChildren: ElkNode[] = [];

  for (const scope of graph.scopes) {
    if (scope.parentId === undefined || !visibleScopeIds.has(scope.id)) continue;
    scopeElements.set(scope.id, {
      id: scopeElementId(scope.id),
      children: [],
      layoutOptions: {
        "elk.padding": "[top=34,left=18,bottom=18,right=18]",
        "elk.spacing.nodeNode": "42",
      },
    });
  }

  for (const scope of graph.scopes) {
    const element = scopeElements.get(scope.id);
    if (element === undefined) continue;
    const parent = scope.parentId === rootScope?.id ? undefined : scope.parentId;
    if (parent === undefined) {
      rootChildren.push(element);
    } else {
      scopeElements.get(parent)?.children?.push(element);
    }
  }

  for (const node of projection.nodes) {
    const element: ElkNode = {
      id: node.id,
      width: node.visible ? nodeWidth : 2,
      height: node.visible ? nodeHeight : 2,
      ports: [],
      layoutOptions: {
        "elk.portConstraints": "FIXED_ORDER",
      },
    };
    nodeElements.set(node.id, element);
    if (node.scopeId === rootScope?.id) {
      rootChildren.push(element);
    } else {
      const scope = scopeElements.get(node.scopeId);
      if (scope === undefined) rootChildren.push(element);
      else scope.children?.push(element);
    }
  }

  const portIndexes = new Map<string, number>();
  const elkEdges = projection.edges.map((edge) => buildElkEdge(edge, nodeElements, portIndexes));
  const input: ElkNode = {
    id: ROOT_ID,
    children: rootChildren,
    edges: elkEdges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
      "elk.spacing.nodeNode": "46",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "14",
      "elk.layered.spacing.nodeNodeBetweenLayers": "82",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      "elk.layered.crossingMinimization.greedySwitchHierarchical.type": "TWO_SIDED",
      "elk.layered.considerModelOrder.strategy": "NONE",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.edgeStraightening": "IMPROVE_STRAIGHTNESS",
      "elk.layered.thoroughness": "20",
    },
  };
  const output = await elk.layout(input);
  return collectLayout(output, projection.nodes, projection.edges, sourceNodes);
}

function collectVisibleScopes(
  scopes: readonly AflVisualScope[],
  directScopeIds: readonly string[],
): ReadonlySet<string> {
  const byId = new Map(scopes.map((scope) => [scope.id, scope]));
  const result = new Set<string>();
  for (const scopeId of directScopeIds) {
    let scope = byId.get(scopeId);
    while (scope !== undefined) {
      result.add(scope.id);
      scope = scope.parentId === undefined ? undefined : byId.get(scope.parentId);
    }
  }
  return result;
}

function buildElkEdge(
  edge: AflProjectedEdge,
  nodes: ReadonlyMap<string, ElkNode>,
  portIndexes: Map<string, number>,
): ElkExtendedEdge {
  const loop = edge.kind === "loop";
  const sourceSide = loop ? "EAST" : "SOUTH";
  const targetSide = loop ? "EAST" : "NORTH";
  const sourcePort = addPort(nodes.get(edge.from), edge.id, "source", sourceSide, portIndexes);
  const targetPort = addPort(nodes.get(edge.to), edge.id, "target", targetSide, portIndexes);
  return {
    id: edge.id,
    sources: [sourcePort],
    targets: [targetPort],
    ...(edge.label === "" ? {} : {
      labels: [{
        text: shortenLabel(edge.label),
        width: Math.max(24, shortenLabel(edge.label).length * 7 + 10),
        height: 16,
      }],
    }),
  };
}

function addPort(
  node: ElkNode | undefined,
  edgeId: string,
  role: "source" | "target",
  side: "NORTH" | "SOUTH" | "EAST",
  indexes: Map<string, number>,
): string {
  if (node === undefined) throw new Error(`cannot lay out edge '${edgeId}': endpoint node is missing`);
  const key = `${node.id}:${side}`;
  const index = indexes.get(key) ?? 0;
  indexes.set(key, index + 1);
  const id = `afl-port:${edgeId}:${role}`;
  const port: ElkPort = {
    id,
    width: 2,
    height: 2,
    layoutOptions: {
      "elk.port.side": side,
      "elk.port.index": String(index),
    },
  };
  node.ports?.push(port);
  return id;
}

function collectLayout(
  root: ElkNode,
  projectedNodes: readonly AflProjectedNode[],
  sourceEdges: readonly AflProjectedEdge[],
  sourceNodes: ReadonlyMap<string, { readonly id: string }>,
): AflVisualLayout {
  const allNodes: AflVisualLayoutNode[] = [];
  const scopes: AflVisualLayoutScope[] = [];
  const containerOffsets = new Map<string, AflVisualPoint>([[root.id, { x: 0, y: 0 }]]);
  flattenNodes(root, 0, 0, allNodes, scopes, containerOffsets);
  const positions = new Map(allNodes.map((node) => [node.id, node]));
  const nodes = allNodes.filter((node) => sourceNodes.has(node.id));
  const projectedById = new Map(projectedNodes.map((node) => [node.id, node]));
  const terminals = allNodes.flatMap((node): AflVisualLayoutTerminal[] => {
    const terminal = projectedById.get(node.id)?.terminal;
    return terminal === undefined ? [] : [{
      id: node.id,
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
      kind: terminal,
    }];
  });
  const sourceById = new Map(sourceEdges.map((edge) => [edge.id, edge]));
  const edges = collectElkEdges(root).map(({ edge, ownerId }) => {
    const source = sourceById.get(edge.id);
    if (source === undefined) throw new Error(`ELK returned unknown edge '${edge.id}'`);
    const offset = containerOffsets.get(edge.container ?? ownerId) ?? { x: 0, y: 0 };
    const sections = edge.sections?.map((section) => toLayoutSection(section, offset)) ?? fallbackSections(source, positions);
    const label = edge.labels?.[0];
    return {
      id: edge.id,
      from: source.from,
      to: source.to,
      kind: source.kind,
      label: source.label,
      operations: source.operations,
      sourceEdgeIds: source.sourceEdgeIds,
      sections,
      ...(label?.x === undefined || label.y === undefined
        ? {}
        : { labelPosition: {
          x: offset.x + label.x + (label.width ?? 0) / 2,
          y: offset.y + label.y + (label.height ?? 0) / 2,
        } }),
    };
  });
  return {
    engine: "elk.layered",
    width: finiteDimension(root.width, "width"),
    height: finiteDimension(root.height, "height"),
    nodes,
    edges,
    scopes,
    terminals,
  };
}

function flattenNodes(
  parent: ElkNode,
  parentX: number,
  parentY: number,
  nodes: AflVisualLayoutNode[],
  scopes: AflVisualLayoutScope[],
  containerOffsets: Map<string, AflVisualPoint>,
): void {
  for (const child of parent.children ?? []) {
    const x = parentX + finiteCoordinate(child.x, child.id, "x");
    const y = parentY + finiteCoordinate(child.y, child.id, "y");
    const width = finiteDimension(child.width, `${child.id} width`);
    const height = finiteDimension(child.height, `${child.id} height`);
    containerOffsets.set(child.id, { x, y });
    if (child.id.startsWith(SCOPE_PREFIX)) {
      scopes.push({ id: child.id.slice(SCOPE_PREFIX.length), x, y, width, height });
    } else {
      nodes.push({ id: child.id, x, y, width, height });
    }
    flattenNodes(child, x, y, nodes, scopes, containerOffsets);
  }
}

function collectElkEdges(
  node: ElkNode,
): readonly { readonly edge: ElkExtendedEdge; readonly ownerId: string }[] {
  return [
    ...(node.edges ?? []).map((edge) => ({ edge, ownerId: node.id })),
    ...(node.children ?? []).flatMap(collectElkEdges),
  ];
}

function toLayoutSection(
  section: ElkEdgeSection,
  offset: AflVisualPoint,
): AflVisualLayoutEdgeSection {
  return {
    points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      .map((point) => copyPoint(point, offset)),
    terminal: (section.outgoingSections?.length ?? 0) === 0,
  };
}

function fallbackSections(
  edge: AflProjectedEdge,
  positions: ReadonlyMap<string, AflVisualLayoutNode>,
): readonly AflVisualLayoutEdgeSection[] {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (from === undefined || to === undefined) return [];
  return [{
    points: [
      { x: from.x + from.width / 2, y: from.y + from.height },
      { x: to.x + to.width / 2, y: to.y },
    ],
    terminal: true,
  }];
}

function copyPoint(point: ElkPoint, offset: AflVisualPoint): AflVisualPoint {
  return { x: point.x + offset.x, y: point.y + offset.y };
}

function finiteCoordinate(value: number | undefined, id: string, axis: "x" | "y"): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`ELK did not return a finite ${axis} coordinate for '${id}'`);
  }
  return value;
}

function finiteDimension(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`ELK did not return a valid ${label}`);
  }
  return value;
}

function scopeElementId(scopeId: string): string {
  return `${SCOPE_PREFIX}${scopeId}`;
}

function shortenLabel(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
