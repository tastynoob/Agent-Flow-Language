import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAflVisualGraph,
  layoutAflVisualGraph,
  parseAfl,
  projectAflVisualGraph,
  renderAflVisualGraphHtml,
  validateModule,
} from "../dist/src/index.js";

const WORKFLOW = `
worker(task):
    # @description Execute one bounded task.
    # @param task Work request.
    # @returns Work report.
    entry:
        worker = agent @agent.worker
        worker.sysprompt "Execute the task."
        request = prompt "Work request", task
        result = worker.do request
        ret result

classify(task):
    # @description Classify a completed result.
    # @param task Result to classify.
    # @returns Classification report.
    entry:
        accepted = oper task != ""
        jump accepted, accepted, rejected
    accepted:
        report = prompt "accepted", task
        ret report
    rejected:
        fail "empty result"

main(task):
    entry:
        prepared = prompt "Prepare", task
        first = call worker, prepared
        jobs = dispatch [worker(first), classify(first)]
        reports = sync jobs
        ret reports
`;

test("visual graph groups operations and expands calls, parallel work, and branches", () => {
  const module = parseAfl(WORKFLOW, "workflow.afl");
  assert.equal(validateModule(module).ok, true);

  const graph = buildAflVisualGraph(module, WORKFLOW);
  assert.equal(graph.version, "afl.visual-graph/v0");
  assert.equal(graph.entry, "main");
  assert.equal(graph.scopes.length, 4);
  assert.equal(graph.statistics.expandedCalls, 3);
  assert.equal(graph.statistics.modelCalls, 2);
  assert.equal(graph.nodes.some((node) => node.kind === "call" && node.title.includes("worker")), false);
  assert.equal(graph.nodes.some((node) => node.kind === "parallel"), true);
  assert.equal(graph.nodes.some((node) => node.kind === "join"), true);
  assert.equal(graph.nodes.some((node) => node.kind === "decision"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "parallel" && edge.label === "join"), true);
  assert.equal(graph.edges.some((edge) => edge.kind === "branch" && edge.label === "false"), true);

  const setup = graph.nodes.find((node) =>
    node.kind === "operations" &&
    node.sourceNode === "worker" &&
    node.operations.some((operation) => operation.includes("agent @agent.worker"))
  );
  assert.ok(setup);
  assert.equal(setup.operations.length, 3);
  assert.ok(setup.lineEnd > setup.lineStart);
});

test("visual graph expands Freedom candidates as optional scopes", () => {
  const source = WORKFLOW + `
route(task):
    entry:
        planner = agent @agent.planner
        jobs = freedom.route planner, task, {min_routes: 1, max_routes: 2}, [worker, classify], {task: task}
        reports = sync jobs
        ret reports
`;
  const module = parseAfl(source, "route.afl");
  assert.equal(validateModule(module).ok, true);

  const graph = buildAflVisualGraph(module, source, { entry: "route" });
  assert.equal(graph.statistics.dynamicCandidates, 2);
  assert.equal(graph.scopes.filter((scope) => scope.optional).length, 2);
  assert.equal(graph.nodes.some((node) => node.kind === "model" && node.title.includes("dynamic route")), true);
  assert.equal(graph.edges.filter((edge) => edge.kind === "dynamic").length, 2);

  const compact = buildAflVisualGraph(module, source, {
    entry: "route",
    expandFreedomCandidates: false,
  });
  assert.equal(compact.scopes.length, 1);
  assert.equal(compact.statistics.dynamicCandidates, 0);
});

test("visual graph stops recursive expansion at a call reference", () => {
  const source = `
recursive(value):
    entry:
        next = call recursive, value
        ret next
`;
  const graph = buildAflVisualGraph(parseAfl(source), source, { entry: "recursive" });
  const reference = graph.nodes.find((node) => node.kind === "call");
  assert.ok(reference);
  assert.equal(reference.subtitle, "recursive call");
});

test("visual graph preserves loop edges and dependency order", () => {
  const source = `
dependency(task):
    entry:
        worker = agent @agent.worker
        result = worker.do request
        request = prompt "Request", task
        ret result

loop(value):
    entry:
        again = oper value != "done"
        jump again, repeat, done
    repeat:
        value = prompt "Next value", value
        jump entry
    done:
        ret value
`;
  const module = parseAfl(source);
  assert.equal(validateModule(module).ok, true);

  const dependencyGraph = buildAflVisualGraph(module, source, { entry: "dependency" });
  const request = dependencyGraph.nodes.find((node) =>
    node.operations.some((operation) => operation.includes("request = prompt"))
  );
  const model = dependencyGraph.nodes.find((node) => node.kind === "model");
  assert.ok(request);
  assert.ok(model);
  assert.equal(dependencyGraph.edges.some((edge) => edge.from === request.id && edge.to === model.id), true);

  const loopGraph = buildAflVisualGraph(module, source, { entry: "loop" });
  assert.equal(loopGraph.edges.some((edge) => edge.kind === "loop"), true);
});

test("ELK layout covers graph nodes, edges, scopes, and dynamic variants", async () => {
  const source = WORKFLOW + `
route(task):
    entry:
        planner = agent @agent.planner
        jobs = freedom.route planner, task, {min_routes: 1, max_routes: 2}, [worker, classify], {task: task}
        reports = sync jobs
        ret reports
`;
  const graph = buildAflVisualGraph(parseAfl(source), source, { entry: "route" });
  const layouts = await layoutAflVisualGraph(graph);
  const mainProjection = projectAflVisualGraph(graph, false);
  const expandedProjection = projectAflVisualGraph(graph, true);

  assert.equal(layouts.main.engine, "elk.layered");
  assert.equal(layouts.main.nodes.length, mainProjection.nodes.filter((node) => node.visible).length);
  assert.equal(layouts.expanded.nodes.length, expandedProjection.nodes.filter((node) => node.visible).length);
  assert.equal(layouts.main.edges.length, mainProjection.edges.length);
  assert.equal(layouts.expanded.edges.length, expandedProjection.edges.length);
  assert.equal(layouts.expanded.scopes.length, graph.scopes.length - 1);
  assert.equal(layouts.expanded.nodes.every((layoutNode) => {
    const node = graph.nodes.find((item) => item.id === layoutNode.id);
    return node?.kind === "model" || node?.kind === "decision";
  }), true);
  assert.equal(layouts.expanded.edges.some((edge) => edge.operations.length > 0), true);
  assert.equal(layouts.main.terminals.some((terminal) => terminal.kind === "start"), true);
  assert.equal(layouts.main.terminals.some((terminal) => terminal.kind === "end"), true);
  assert.equal(layouts.expanded.nodes.every((node) =>
    [node.x, node.y, node.width, node.height].every(Number.isFinite)
  ), true);
  assert.equal(layouts.expanded.edges.every((edge) =>
    edge.sections.length > 0 && edge.sections.every((section) => section.points.length >= 2)
  ), true);
  const expandedNodes = new Map(layouts.expanded.nodes.map((node) => [node.id, node]));
  assert.equal(layouts.expanded.edges.every((edge) => {
    const from = expandedNodes.get(edge.from);
    const to = expandedNodes.get(edge.to);
    const startsAtSource = from === undefined || edge.sections.some((section) => pointTouchesNode(section.points[0], from));
    const endsAtTarget = to === undefined || edge.sections.some((section) => pointTouchesNode(section.points.at(-1), to));
    return startsAtSource && endsAtTarget;
  }), true);
  assert.equal(countOrthogonalCrossings(layouts.main), 0);
});

test("HTML renderer embeds a self-contained, script-safe graph", async () => {
  const module = parseAfl(WORKFLOW, "workflow-</script><script>alert(1)</script>.afl");
  const graph = buildAflVisualGraph(module, WORKFLOW);
  const html = await renderAflVisualGraphHtml(graph, { title: "Workflow <graph>" });

  assert.match(html, /<svg id="graph"/u);
  assert.match(html, /id="afl-graph-data"/u);
  assert.match(html, /elk\.layered/u);
  assert.match(html, /function selectEdge/u);
  assert.match(html, /Collapsed calculations on this edge/u);
  assert.match(html, /Workflow &lt;graph&gt;/u);
  assert.doesNotMatch(html, /workflow-<\/script><script>/u);
  assert.match(html, /\\u003c\/script>/u);
});

function countOrthogonalCrossings(layout) {
  const segments = layout.edges.flatMap((edge) => edge.sections.flatMap((section) =>
    section.points.slice(1).map((point, index) => ({ edgeId: edge.id, from: section.points[index], to: point }))
  ));
  let crossings = 0;
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const left = segments[leftIndex];
      const right = segments[rightIndex];
      if (left.edgeId === right.edgeId) continue;
      const leftHorizontal = left.from.y === left.to.y;
      const rightHorizontal = right.from.y === right.to.y;
      if (leftHorizontal === rightHorizontal) continue;
      const horizontal = leftHorizontal ? left : right;
      const vertical = leftHorizontal ? right : left;
      const minX = Math.min(horizontal.from.x, horizontal.to.x);
      const maxX = Math.max(horizontal.from.x, horizontal.to.x);
      const minY = Math.min(vertical.from.y, vertical.to.y);
      const maxY = Math.max(vertical.from.y, vertical.to.y);
      if (
        vertical.from.x > minX && vertical.from.x < maxX &&
        horizontal.from.y > minY && horizontal.from.y < maxY
      ) crossings += 1;
    }
  }
  return crossings;
}

function pointTouchesNode(point, node) {
  if (point === undefined) return false;
  const epsilon = 2.001;
  const withinX = point.x >= node.x - epsilon && point.x <= node.x + node.width + epsilon;
  const withinY = point.y >= node.y - epsilon && point.y <= node.y + node.height + epsilon;
  const onX = Math.abs(point.x - node.x) <= epsilon || Math.abs(point.x - node.x - node.width) <= epsilon;
  const onY = Math.abs(point.y - node.y) <= epsilon || Math.abs(point.y - node.y - node.height) <= epsilon;
  return withinX && withinY && (onX || onY);
}
