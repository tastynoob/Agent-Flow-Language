import type { AflVisualGraph } from "./visualizer.js";
import {
  layoutAflVisualGraph,
  type AflVisualLayouts,
} from "./visualizer-layout.js";

export interface AflHtmlVisualizationOptions {
  readonly title?: string;
  readonly layouts?: AflVisualLayouts;
}

export async function renderAflVisualGraphHtml(
  graph: AflVisualGraph,
  options: AflHtmlVisualizationOptions = {},
): Promise<string> {
  const title = options.title ?? `${graph.entry} · AFL Graph`;
  const layouts = options.layouts ?? await layoutAflVisualGraph(graph);
  const serializedLayouts = layouts.expanded === layouts.main ? { main: layouts.main } : layouts;
  const payloadJson = JSON.stringify({ graph, layouts: serializedLayouts }).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --surface: #ffffff;
      --surface-soft: #eef2f3;
      --border: #cbd3d6;
      --border-strong: #8c9a9f;
      --text: #172126;
      --muted: #5b696f;
      --model: #087f5b;
      --operations: #52616a;
      --parallel: #2463a6;
      --decision: #a45b00;
      --fail: #b42318;
      --return: #38761d;
      --external: #7b4ba0;
      --selected: #111827;
    }
    * { box-sizing: border-box; letter-spacing: 0; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      display: grid;
      grid-template-rows: 56px minmax(0, 1fr);
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input { font: inherit; }
    button { color: inherit; }
    .topbar {
      display: flex;
      align-items: center;
      gap: 18px;
      min-width: 0;
      padding: 0 14px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .brand { min-width: 0; display: flex; align-items: baseline; gap: 10px; }
    .brand strong { flex: none; font-size: 15px; font-weight: 720; }
    .brand span { min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .summary { display: flex; gap: 12px; color: var(--muted); white-space: nowrap; }
    .toolbar { margin-left: auto; display: flex; align-items: center; gap: 4px; }
    .icon-button, .command-button, .segment button {
      height: 30px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--surface);
      cursor: pointer;
    }
    .icon-button { width: 30px; padding: 0; font-size: 17px; line-height: 28px; }
    .command-button { padding: 0 10px; }
    button:hover { border-color: var(--border-strong); background: var(--surface-soft); }
    button:focus-visible, input:focus-visible { outline: 2px solid #236d9b; outline-offset: 1px; }
    .shell { min-height: 0; display: grid; grid-template-columns: 248px minmax(0, 1fr) 316px; }
    .sidebar, .inspector { min-height: 0; overflow: auto; background: var(--surface); }
    .sidebar { border-right: 1px solid var(--border); padding: 14px; }
    .inspector { border-left: 1px solid var(--border); padding: 14px; }
    .panel-section { padding: 0 0 15px; margin: 0 0 15px; border-bottom: 1px solid var(--border); }
    .panel-section:last-child { border-bottom: 0; margin-bottom: 0; }
    h2 { margin: 0 0 9px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; }
    .search {
      width: 100%; height: 34px; padding: 0 10px;
      border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--text);
    }
    .segment { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
    .segment button { min-width: 0; padding: 0 5px; font-size: 12px; }
    .segment button.active { background: #20323a; border-color: #20323a; color: #fff; }
    .toggle { display: flex; align-items: center; gap: 8px; margin-top: 11px; color: var(--muted); cursor: pointer; }
    .toggle input { width: 15px; height: 15px; accent-color: var(--model); }
    .scope-list { display: grid; gap: 2px; }
    .scope-button {
      width: 100%; min-height: 30px; padding: 5px 7px; overflow: hidden;
      border: 1px solid transparent; border-radius: 4px; background: transparent;
      text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
    }
    .scope-button.active { border-color: var(--border-strong); background: var(--surface-soft); }
    .scope-button.optional::after { content: "dynamic"; float: right; color: var(--decision); font-size: 10px; }
    .canvas { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: #f8fafb; }
    #graph { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
    #graph.dragging { cursor: grabbing; }
    .cluster rect { fill: #ffffff; fill-opacity: .38; stroke: #aab5b9; stroke-width: 1; stroke-dasharray: 5 4; rx: 6; }
    .cluster.optional rect { stroke: #bb7a19; stroke-dasharray: 3 4; }
    .cluster text { fill: #607077; font-size: 11px; font-weight: 650; }
    .visual-edge { cursor: pointer; transition: opacity 120ms ease; }
    .edge { fill: none; stroke: #87959a; stroke-width: 1.35; stroke-linejoin: round; }
    .edge-hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; }
    .edge.branch { stroke: var(--decision); }
    .edge.loop { stroke: #b42318; stroke-dasharray: 5 4; }
    .edge.parallel { stroke: var(--parallel); }
    .edge.dynamic { stroke: #9a6700; stroke-dasharray: 4 4; }
    .edge.return { stroke: var(--return); }
    .edge-label {
      fill: #59676c; stroke: #f8fafb; stroke-width: 4px; paint-order: stroke;
      font-size: 10px; text-anchor: middle; dominant-baseline: central;
    }
    .terminal circle { fill: #f8fafb; stroke: #748187; stroke-width: 1.5; }
    .terminal text { fill: #69767b; font-size: 9px; font-weight: 700; dominant-baseline: central; }
    .visual-edge:hover .edge, .visual-edge.selected .edge { stroke: var(--selected); stroke-width: 2.6; }
    .visual-edge.dimmed { opacity: .12; }
    .visual-node { cursor: pointer; transition: opacity 120ms ease; }
    .visual-node rect { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1.25; rx: 6; }
    .visual-node.model rect { stroke: var(--model); stroke-width: 2; }
    .visual-node.parallel rect, .visual-node.join rect { stroke: var(--parallel); }
    .visual-node.decision rect { stroke: var(--decision); stroke-width: 1.7; }
    .visual-node.fail rect { stroke: var(--fail); }
    .visual-node.return rect { stroke: var(--return); }
    .visual-node.external rect { stroke: var(--external); }
    .visual-node.selected rect { stroke: var(--selected); stroke-width: 3; }
    .visual-node.dimmed { opacity: .14; }
    .node-kind { font-size: 9px; font-weight: 750; text-transform: uppercase; }
    .node-title { fill: var(--text); font-size: 13px; font-weight: 700; }
    .node-subtitle { fill: var(--muted); font-size: 10px; }
    .node-operation { fill: #67767c; font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .model .node-kind { fill: var(--model); }
    .operations .node-kind { fill: var(--operations); }
    .parallel .node-kind, .join .node-kind { fill: var(--parallel); }
    .decision .node-kind { fill: var(--decision); }
    .fail .node-kind { fill: var(--fail); }
    .return .node-kind { fill: var(--return); }
    .external .node-kind { fill: var(--external); }
    .empty { display: none; position: absolute; inset: 0; place-items: center; color: var(--muted); pointer-events: none; }
    .empty.visible { display: grid; }
    .inspector-title { margin: 0 0 4px; font-size: 15px; overflow-wrap: anywhere; }
    .inspector-meta { color: var(--muted); overflow-wrap: anywhere; }
    .detail-list { display: grid; gap: 7px; margin-top: 12px; }
    .detail-row { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 8px; }
    .detail-row dt { color: var(--muted); }
    .detail-row dd { margin: 0; overflow-wrap: anywhere; }
    .source-lines { margin: 12px 0 0; display: grid; gap: 6px; }
    .source-line {
      margin: 0; padding: 8px; overflow: auto; border-left: 3px solid var(--border-strong);
      background: #f1f4f5; color: #26343a; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 10px; color: var(--muted); }
    .legend span { display: inline-flex; align-items: center; gap: 7px; }
    .swatch { width: 13px; height: 3px; flex: none; background: var(--operations); }
    .swatch.model { background: var(--model); }
    .swatch.parallel { background: var(--parallel); }
    .swatch.decision { background: var(--decision); }
    @media (max-width: 980px) {
      body { grid-template-rows: auto minmax(0, 1fr); overflow: auto; }
      .topbar { min-height: 56px; flex-wrap: wrap; gap: 8px 12px; padding: 9px 12px; }
      .summary { order: 3; width: 100%; overflow-x: auto; }
      .shell { grid-template-columns: 1fr; grid-template-rows: auto minmax(520px, 1fr) auto; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--border); max-height: 230px; }
      .inspector { border-left: 0; border-top: 1px solid var(--border); max-height: 300px; }
      .scope-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><strong>AFL Graph</strong><span>${escapeHtml(graph.entry)} · ${escapeHtml(graph.sourceName)}</span></div>
    <div class="summary" aria-label="Graph statistics">
      <span id="visible-node-count">${layouts.main.nodes.length} semantic nodes</span>
      <span id="visible-edge-count">${layouts.main.edges.length} computation paths</span>
      <span>${graph.statistics.expandedCalls} expanded calls</span>
    </div>
    <div class="toolbar">
      <button class="icon-button" id="zoom-out" type="button" title="缩小" aria-label="缩小">−</button>
      <button class="icon-button" id="zoom-in" type="button" title="放大" aria-label="放大">+</button>
      <button class="command-button" id="fit" type="button">适应视图</button>
    </div>
  </header>
  <div class="shell">
    <aside class="sidebar">
      <section class="panel-section">
        <h2>筛选</h2>
        <input class="search" id="search" type="search" placeholder="搜索模型、操作或 Node" aria-label="搜索图节点">
        <div class="segment" role="group" aria-label="聚焦节点类型" style="margin-top:8px">
          <button class="active" type="button" data-focus="all">全部</button>
          <button type="button" data-focus="model">模型</button>
          <button type="button" data-focus="control">分支</button>
        </div>
        <label class="toggle"><input id="dynamic" type="checkbox">显示动态候选</label>
      </section>
      <section class="panel-section">
        <h2>展开范围</h2>
        <div class="scope-list" id="scopes"></div>
      </section>
      <section class="panel-section">
        <h2>图例</h2>
        <div class="legend">
          <span><i class="swatch model"></i>模型调用</span>
          <span><i class="swatch"></i>计算路径</span>
          <span><i class="swatch parallel"></i>并发/汇合</span>
          <span><i class="swatch decision"></i>分支/循环</span>
        </div>
      </section>
    </aside>
    <main class="canvas" id="canvas">
      <svg id="graph" role="img" aria-label="AFL workflow graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#87959a"></path>
          </marker>
        </defs>
        <g id="viewport">
          <g id="cluster-layer"></g>
          <g id="edge-layer"></g>
          <g id="terminal-layer"></g>
          <g id="node-layer"></g>
        </g>
      </svg>
      <div class="empty" id="empty">没有模型调用或分支节点</div>
    </main>
    <aside class="inspector" id="inspector">
      <section class="panel-section">
        <h2>详情</h2>
        <h3 class="inspector-title" id="detail-title">${escapeHtml(graph.entry)}()</h3>
        <div class="inspector-meta" id="detail-subtitle">选择图节点查看对应 IR</div>
        <dl class="detail-list" id="detail-list"></dl>
        <div class="source-lines" id="source-lines"></div>
      </section>
    </aside>
  </div>
  <script id="afl-graph-data" type="application/json">${payloadJson}</script>
  <script>
    (() => {
      "use strict";
      const NS = "http://www.w3.org/2000/svg";
      const payload = JSON.parse(document.getElementById("afl-graph-data").textContent);
      const data = payload.graph;
      const layouts = payload.layouts;
      const svg = document.getElementById("graph");
      const canvas = document.getElementById("canvas");
      const viewport = document.getElementById("viewport");
      const clusterLayer = document.getElementById("cluster-layer");
      const edgeLayer = document.getElementById("edge-layer");
      const terminalLayer = document.getElementById("terminal-layer");
      const nodeLayer = document.getElementById("node-layer");
      const empty = document.getElementById("empty");
      const scopeMap = new Map(data.scopes.map(scope => [scope.id, scope]));
      const nodeMap = new Map(data.nodes.map(node => [node.id, node]));
      const state = {
        scale: 1, x: 24, y: 24, focus: "all", query: "", dynamic: false, scope: null,
        selected: null, selectionType: null
      };
      const positions = new Map();
      let contentWidth = 1;
      let contentHeight = 1;
      let dragging = null;

      const kindLabels = {
        model: "MODEL", operations: "OPS", input: "INPUT", parallel: "PARALLEL", join: "JOIN",
        decision: "BRANCH", return: "RETURN", fail: "FAIL", external: "EXTERNAL", call: "CALL", control: "CONTROL"
      };
      const controlKinds = new Set(["input", "parallel", "join", "decision", "return", "fail", "control"]);

      function visibleNodes() {
        return data.nodes.filter(node => positions.has(node.id));
      }

      function render() {
        const layout = activeLayout();
        document.getElementById("visible-node-count").textContent = layout.nodes.length + " semantic nodes";
        document.getElementById("visible-edge-count").textContent = layout.edges.length + " computation paths";
        positions.clear();
        for (const node of layout.nodes) positions.set(node.id, node);
        clusterLayer.replaceChildren();
        edgeLayer.replaceChildren();
        terminalLayer.replaceChildren();
        nodeLayer.replaceChildren();
        const nodes = visibleNodes();
        empty.classList.toggle("visible", nodes.length === 0);
        if (nodes.length === 0) return;
        contentWidth = layout.width;
        contentHeight = layout.height;
        drawClusters(layout);
        for (const edge of layout.edges) drawEdge(edge);
        for (const terminal of layout.terminals) drawTerminal(terminal);
        for (const node of nodes) drawNode(node);
        updateStyles();
      }

      function activeLayout() {
        return state.dynamic ? (layouts.expanded || layouts.main) : layouts.main;
      }

      function drawClusters(layout) {
        const scopes = [...layout.scopes].sort((left, right) => {
          return (scopeMap.get(left.id)?.depth || 0) - (scopeMap.get(right.id)?.depth || 0);
        });
        for (const bounds of scopes) {
          const scope = scopeMap.get(bounds.id);
          if (!scope) continue;
          const x = bounds.x;
          const y = bounds.y;
          const group = svgElement("g", { class: "cluster" + (scope.optional ? " optional" : ""), "data-scope": scope.id });
          group.append(svgElement("rect", { x, y, width: bounds.width, height: bounds.height }));
          const label = svgElement("text", { x: x + 9, y: y + 16 });
          label.textContent = scope.label;
          group.append(label);
          clusterLayer.append(group);
        }
      }

      function drawEdge(layoutEdge) {
        const group = svgElement("g", {
          class: "visual-edge",
          "data-edge": layoutEdge.id,
          tabindex: "0",
          role: "button",
          "aria-label": layoutEdge.label || "workflow path"
        });
        for (const section of layoutEdge.sections) {
          if (section.points.length < 2) continue;
          const path = section.points.map((point, index) => {
            return (index === 0 ? "M " : "L ") + point.x + " " + point.y;
          }).join(" ");
          group.append(svgElement("path", {
            class: "edge " + layoutEdge.kind,
            d: path,
            ...(section.terminal ? { "marker-end": "url(#arrow)" } : {})
          }));
          group.append(svgElement("path", { class: "edge-hit", d: path }));
        }
        if (layoutEdge.label && layoutEdge.labelPosition) {
          const label = svgElement("text", {
            class: "edge-label",
            x: layoutEdge.labelPosition.x,
            y: layoutEdge.labelPosition.y
          });
          label.textContent = shorten(layoutEdge.label, 64);
          group.append(label);
        }
        const tooltip = svgElement("title");
        tooltip.textContent = layoutEdge.label || "Direct workflow dependency";
        group.append(tooltip);
        group.addEventListener("click", event => { event.stopPropagation(); selectEdge(layoutEdge); });
        group.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEdge(layoutEdge); }
        });
        edgeLayer.append(group);
      }

      function drawTerminal(terminal) {
        const group = svgElement("g", { class: "terminal " + terminal.kind });
        group.append(svgElement("circle", { cx: terminal.x, cy: terminal.y, r: 4 }));
        const label = svgElement("text", { x: terminal.x + 9, y: terminal.y });
        label.textContent = terminal.kind === "start" ? "START" : "END";
        group.append(label);
        terminalLayer.append(group);
      }

      function drawNode(node) {
        const position = positions.get(node.id);
        const group = svgElement("g", {
          class: "visual-node " + node.kind,
          "data-node": node.id,
          tabindex: "0",
          role: "button",
          "aria-label": node.title + ", " + (kindLabels[node.kind] || node.kind)
        });
        group.append(svgElement("rect", position));
        const kind = svgElement("text", { class: "node-kind", x: position.x + 14, y: position.y + 18 });
        kind.textContent = kindLabels[node.kind] || node.kind.toUpperCase();
        group.append(kind);
        const title = svgElement("text", { class: "node-title", x: position.x + 14, y: position.y + 42 });
        title.textContent = shorten(node.title, 34);
        group.append(title);
        const subtitle = svgElement("text", { class: "node-subtitle", x: position.x + 14, y: position.y + 62 });
        subtitle.textContent = shorten(node.subtitle || node.sourceNode + " · " + node.block, 41);
        group.append(subtitle);
        const operation = svgElement("text", { class: "node-operation", x: position.x + 14, y: position.y + 84 });
        operation.textContent = shorten(node.operations[0] || "", 39);
        group.append(operation);
        group.addEventListener("click", event => { event.stopPropagation(); selectNode(node.id); });
        group.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id); }
        });
        nodeLayer.append(group);
      }

      function updateStyles() {
        const query = state.query.trim().toLowerCase();
        for (const element of nodeLayer.querySelectorAll(".visual-node")) {
          const node = nodeMap.get(element.dataset.node);
          const focusMatch = state.focus === "all"
            || (state.focus === "model" && node.kind === "model")
            || (state.focus === "control" && controlKinds.has(node.kind));
          const text = [node.title, node.subtitle, node.sourceNode, node.block, ...node.operations].join(" ").toLowerCase();
          const searchMatch = query === "" || text.includes(query);
          const scopeMatch = state.scope === null || isScopeWithin(node.scopeId, state.scope);
          const selected = state.selectionType === "node" && node.id === state.selected;
          element.classList.toggle("dimmed", !(focusMatch && searchMatch && scopeMatch) && !selected);
          element.classList.toggle("selected", selected);
        }
        for (const element of edgeLayer.querySelectorAll(".visual-edge")) {
          const edge = activeLayout().edges.find(item => item.id === element.dataset.edge);
          if (!edge) continue;
          const searchText = [edge.kind, edge.label, ...edge.operations].join(" ").toLowerCase();
          const searchMatch = query === "" || searchText.includes(query);
          const scopeMatch = state.scope === null || [edge.from, edge.to].some(id => {
            const node = nodeMap.get(id);
            return node && isScopeWithin(node.scopeId, state.scope);
          });
          const selected = state.selectionType === "edge" && edge.id === state.selected;
          element.classList.toggle("dimmed", !(searchMatch && scopeMatch) && !selected);
          element.classList.toggle("selected", selected);
        }
      }

      function selectNode(id) {
        state.selected = id;
        state.selectionType = "node";
        const node = nodeMap.get(id);
        const scope = scopeMap.get(node.scopeId);
        document.getElementById("detail-title").textContent = node.title;
        document.getElementById("detail-subtitle").textContent = node.subtitle || kindLabels[node.kind] || node.kind;
        const rows = [
          ["Kind", kindLabels[node.kind] || node.kind],
          ["IR Node", node.sourceNode],
          ["Block", node.block],
          ["Scope", scope?.label || node.scopeId],
          ["Lines", node.lineStart > 0
            ? (node.lineEnd > node.lineStart ? node.lineStart + "–" + node.lineEnd : String(node.lineStart))
            : "generated"]
        ];
        const list = document.getElementById("detail-list");
        list.replaceChildren(...rows.map(([term, value]) => {
          const wrapper = document.createElement("div");
          wrapper.className = "detail-row";
          const dt = document.createElement("dt"); dt.textContent = term;
          const dd = document.createElement("dd"); dd.textContent = value;
          wrapper.append(dt, dd);
          return wrapper;
        }));
        const lines = document.getElementById("source-lines");
        lines.replaceChildren(...node.operations.map(operation => {
          const pre = document.createElement("pre");
          pre.className = "source-line";
          pre.textContent = operation;
          return pre;
        }));
        updateStyles();
      }

      function selectEdge(edge) {
        state.selected = edge.id;
        state.selectionType = "edge";
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        document.getElementById("detail-title").textContent = edge.label || "Direct workflow path";
        document.getElementById("detail-subtitle").textContent = "Collapsed calculations on this edge";
        const rows = [
          ["Kind", edge.kind],
          ["From", from?.title || "entry"],
          ["To", to?.title || "exit"],
          ["IR ops", String(edge.operations.length)]
        ];
        const list = document.getElementById("detail-list");
        list.replaceChildren(...rows.map(([term, value]) => {
          const wrapper = document.createElement("div");
          wrapper.className = "detail-row";
          const dt = document.createElement("dt"); dt.textContent = term;
          const dd = document.createElement("dd"); dd.textContent = value;
          wrapper.append(dt, dd);
          return wrapper;
        }));
        const lines = document.getElementById("source-lines");
        const operations = edge.operations.length > 0 ? edge.operations : ["No collapsed calculation"];
        lines.replaceChildren(...operations.map(operation => {
          const pre = document.createElement("pre");
          pre.className = "source-line";
          pre.textContent = operation;
          return pre;
        }));
        updateStyles();
      }

      function renderScopes() {
        const list = document.getElementById("scopes");
        list.replaceChildren(...data.scopes.filter(scope => state.dynamic || !scope.optional).map(scope => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "scope-button" + (scope.optional ? " optional" : "");
          button.style.paddingLeft = (7 + Math.min(scope.depth, 5) * 12) + "px";
          button.textContent = scope.label;
          button.title = scope.description || scope.invocation;
          button.dataset.scope = scope.id;
          button.addEventListener("click", () => {
            state.scope = state.scope === scope.id ? null : scope.id;
            for (const item of list.querySelectorAll("button")) item.classList.toggle("active", item.dataset.scope === state.scope);
            updateStyles();
          });
          return button;
        }));
      }

      function isScopeWithin(scopeId, ancestorId) {
        let current = scopeMap.get(scopeId);
        while (current) {
          if (current.id === ancestorId) return true;
          current = current.parentId ? scopeMap.get(current.parentId) : null;
        }
        return false;
      }

      function applyTransform() {
        viewport.setAttribute("transform", "translate(" + state.x + " " + state.y + ") scale(" + state.scale + ")");
      }

      function fit() {
        const bounds = canvas.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        state.scale = Math.max(.12, Math.min(1.25, Math.min((bounds.width - 40) / contentWidth, (bounds.height - 40) / contentHeight)));
        state.x = (bounds.width - contentWidth * state.scale) / 2;
        state.y = (bounds.height - contentHeight * state.scale) / 2;
        applyTransform();
      }

      function zoom(factor, centerX = canvas.clientWidth / 2, centerY = canvas.clientHeight / 2) {
        const previous = state.scale;
        state.scale = Math.max(.1, Math.min(2.5, state.scale * factor));
        const ratio = state.scale / previous;
        state.x = centerX - (centerX - state.x) * ratio;
        state.y = centerY - (centerY - state.y) * ratio;
        applyTransform();
      }

      function svgElement(name, attributes = {}) {
        const element = document.createElementNS(NS, name);
        for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
        return element;
      }

      function shorten(value, length) {
        const text = String(value).replace(/\s+/g, " ").trim();
        return text.length <= length ? text : text.slice(0, length - 1) + "…";
      }

      document.getElementById("search").addEventListener("input", event => { state.query = event.target.value; updateStyles(); });
      document.querySelectorAll("[data-focus]").forEach(button => button.addEventListener("click", () => {
        state.focus = button.dataset.focus;
        document.querySelectorAll("[data-focus]").forEach(item => item.classList.toggle("active", item === button));
        updateStyles();
      }));
      document.getElementById("dynamic").addEventListener("change", event => {
        state.dynamic = event.target.checked;
        if (!state.dynamic) {
          if (state.scope && scopeMap.get(state.scope)?.optional) state.scope = null;
        }
        state.selected = null;
        state.selectionType = null;
        renderScopes();
        render(); fit();
      });
      document.getElementById("zoom-in").addEventListener("click", () => zoom(1.2));
      document.getElementById("zoom-out").addEventListener("click", () => zoom(1 / 1.2));
      document.getElementById("fit").addEventListener("click", fit);
      svg.addEventListener("wheel", event => {
        event.preventDefault();
        const bounds = canvas.getBoundingClientRect();
        zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - bounds.left, event.clientY - bounds.top);
      }, { passive: false });
      svg.addEventListener("pointerdown", event => {
        if (event.target.closest?.(".visual-node")) return;
        dragging = { x: event.clientX, y: event.clientY, originX: state.x, originY: state.y };
        svg.classList.add("dragging");
        svg.setPointerCapture(event.pointerId);
      });
      svg.addEventListener("pointermove", event => {
        if (!dragging) return;
        state.x = dragging.originX + event.clientX - dragging.x;
        state.y = dragging.originY + event.clientY - dragging.y;
        applyTransform();
      });
      svg.addEventListener("pointerup", event => {
        dragging = null; svg.classList.remove("dragging"); svg.releasePointerCapture(event.pointerId);
      });
      svg.addEventListener("click", () => {
        state.selected = null;
        state.selectionType = null;
        updateStyles();
      });
      window.addEventListener("resize", () => requestAnimationFrame(fit));

      renderScopes();
      render();
      requestAnimationFrame(fit);
    })();
  </script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
