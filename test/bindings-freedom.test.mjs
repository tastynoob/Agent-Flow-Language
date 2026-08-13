import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AflVm,
  AFL_MESSAGE_ROLE_SCHEMA,
  MockAgentAdapter,
  frag,
  parseAfl,
  validateModule,
} from "../dist/src/index.js";

test("prompt, input, script, capability, schema, formatter, and external flow bindings compose", async () => {
  const seen = { schemas: [], capability: false, flow: false, formatter: false };
  const vm = AflVm.fromSource(`
identity(value):
    entry:
        ret value
main():
    entry:
        answer = input @prompt.question, @schema.Answer
        count = typescript "return args[0].length", answer
        page = invoke @mcp.page.read, answer, count
        local = call identity(page)
        jobs = dispatch [identity(local), @flow.echo(answer)]
        result = sync jobs, @format.join
        ret result
`, {
    agents: new MockAgentAdapter(),
    prompts: {
      render(request) {
        assert.equal(request.prompt.name, "@prompt.question");
        return "question?";
      },
    },
    input: {
      read(request) {
        assert.equal(request.prompt, "question?");
        return "answer";
      },
    },
    scripts: {
      execute(request) {
        assert.deepEqual(request.args, ["answer"]);
        return request.args[0].length;
      },
    },
    capabilities: {
      invoke(request) {
        seen.capability = true;
        assert.equal(request.capability.name, "@mcp.page.read");
        return "page";
      },
    },
    flows: {
      invoke(request) {
        seen.flow = true;
        return frag(`external:${request.args[0].content}`);
      },
    },
    formatters: {
      format(request) {
        seen.formatter = true;
        return request.values.map((value) => value.content).join("|");
      },
    },
    schemas: {
      validate(request) {
        seen.schemas.push([request.schema.name, request.content]);
      },
    },
  });

  const result = await vm.run();
  assert.equal(result.output.content, "page|external:answer");
  assert.deepEqual(seen.schemas, [["@schema.Answer", "answer"]]);
  assert.equal(seen.capability, true);
  assert.equal(seen.flow, true);
  assert.equal(seen.formatter, true);
});

test("agent.route registers allowed Nodes and returns a TaskGroup", async (t) => {
  const root = await temporaryRoot(t);
  const workspaces = new Map();
  const seenTools = [];
  const failures = [];
  let activations = 0;
  let nodeApprovals = 0;
  let departmentStarted = false;
  const backend = controlBackend(async (request, host) => {
    workspaces.set(request.agent.name, request.workspace.primary.root);
    if (request.agent.name === "@agent.department") {
      departmentStarted = true;
      assert.equal(request.control, undefined);
      return completed(`department:${request.memory.at(-1).content}`);
    }
    seenTools.push(request.control?.tools.map((tool) => tool.name) ?? []);
    const tools = Object.fromEntries(request.control.tools.map((tool) => [tool.name, tool]));
    assert.match(tools["afl.environment.get"].description, /already supplied by the user/u);
    assert.match(tools["afl.route.add"].description, /args are positional/u);
    assert.match(tools["afl.route.add"].description, /never the child result/u);
    assert.match(tools["afl.route.add"].description, /directly without afl\.environment\.get/u);
    assert.match(tools["afl.route.add"].description, /\{"ref":"param:<name>"\}/u);
    assert.match(tools["afl.route.add"].inputSchema.properties.args.description, /signature order/u);
    const environment = await host.executeControlTool({
      id: "environment",
      name: "afl.environment.get",
      input: {},
      signal: request.signal,
    });
    const view = JSON.parse(environment.content);
    assert.equal(view.ok, true);
    assert.equal(view.environment.nodes[0].description, "Handle one department task.");
    assert.equal(view.environment.parameters[0].ref, "param:task");
    assert.equal(Object.hasOwn(view.environment, "tools"), false);
    assert.deepEqual(view.environment.constraints, {
      requested: { min_routes: 1, max_routes: 1 },
      effective: { min_routes: 1, max_routes: 1 },
    });

    const bad = await host.executeControlTool({
      id: "bad-ref",
      name: "afl.route.add",
      input: { node: "department", args: [{ ref: "param:missing" }] },
      signal: request.signal,
    });
    failures.push(JSON.parse(bad.content).error.code);
    const registered = await host.executeControlTool({
      id: "department-call",
      name: "afl.route.add",
      input: { node: "department", args: [{ ref: "param:task" }] },
      signal: request.signal,
    });
    const result = JSON.parse(registered.content);
    assert.equal(result.ok, true);
    assert.equal(result.route, "route:1");
    assert.equal(result.node, "department");
    assert.equal(departmentStarted, false);
    const overflow = await host.executeControlTool({
      id: "department-overflow",
      name: "afl.route.add",
      input: { node: "department", args: [{ ref: "param:task" }] },
      signal: request.signal,
    });
    failures.push(JSON.parse(overflow.content).error.code);
    return completed("route-complete");
  });
  const vm = AflVm.fromSource(`
department(task):
    # @description Handle one department task.
    # @param task The controlled task.
    # @returns Department report.
    entry:
        worker = agent @agent.department
        result = worker.do task
        ret result
main(task):
    entry:
        planner = agent @agent.planner
        jobs = planner.route "choose", [nodes: [department], params: [task: task], min_routes: 1, max_routes: 1]
        reports = sync jobs
        ret reports
`, {
    agentExecutor: backend,
    policy: {
      maxConcurrency: 1,
      authorizeFreedom() {
        activations += 1;
        return true;
      },
      authorizeFreedomNode(request) {
        nodeApprovals += 1;
        assert.equal(request.target, "department");
        return true;
      },
    },
  });
  const result = await vm.run("main", ["edict"], {
    runId: "route-workspaces",
    executionRoot: root,
    maxSteps: 1_000,
  });
  assert.deepEqual(JSON.parse(result.output.content), ["department:edict"]);
  assert.deepEqual(seenTools, [["afl.environment.get", "afl.route.add"]]);
  assert.deepEqual(failures, ["FREEDOM_REF_UNKNOWN", "FREEDOM_ROUTE_MAX_EXCEEDED"]);
  assert.equal(activations, 1);
  assert.equal(nodeApprovals, 1);
  assert.notEqual(workspaces.get("@agent.planner"), workspaces.get("@agent.department"));
  const canonicalRoot = await realpath(root);
  const workspacePrefix = join(canonicalRoot, ".afl", "tmpworkspace", "route-workspaces");
  assert.equal(workspaces.get("@agent.planner").startsWith(workspacePrefix), true);
  assert.equal(workspaces.get("@agent.department").startsWith(workspacePrefix), true);
});

test("Freedom derives its control scope only from the instruction op", async (t) => {
  const root = await temporaryRoot(t);
  const module = parseAfl(`
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route"
        reports = sync jobs
        ret reports
`);
  const instruction = module.nodes[0].blocks[0].instructions.find((item) =>
    item.op === "agent.route");
  assert.ok(instruction);
  instruction.mode = "flow";

  let authorizedMode;
  const vm = new AflVm(module, {
    agentExecutor: controlBackend(async (request) => {
      assert.deepEqual(
        request.control?.tools.map((tool) => tool.name),
        ["afl.environment.get", "afl.route.add"],
      );
      return completed("no route selected");
    }),
    policy: {
      authorizeFreedom(request) {
        authorizedMode = request.mode;
        return true;
      },
    },
  });
  const result = await vm.run("main", [], { executionRoot: root, runId: "op-only-mode" });
  assert.deepEqual(result.output, frag("[]"));
  assert.equal(authorizedMode, "route");
});

test("agent.route can use its injected tool contract without an environment lookup", async (t) => {
  const root = await temporaryRoot(t);
  let active = 0;
  let maximumActive = 0;
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  const backend = controlBackend(async (request, host) => {
    if (request.control === undefined) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) releaseBoth();
      await Promise.race([
        bothStarted,
        new Promise((_resolve, reject) => request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        )),
      ]);
      active -= 1;
      return completed(request.agent.name);
    }
    assert.match(
      request.control.tools.find((tool) => tool.name === "afl.route.add").description,
      /Call once for each desired TaskGroup job/u,
    );
    const calls = await Promise.all([
      host.executeControlTool({
        id: "first",
        name: "afl.route.add",
        input: { node: "first", args: [] },
        signal: request.signal,
      }),
      host.executeControlTool({
        id: "second",
        name: "afl.route.add",
        input: { node: "second", args: [] },
        signal: request.signal,
      }),
    ]);
    assert.equal(calls.every((call) => JSON.parse(call.content).ok), true);
    return completed("parallel-complete");
  });
  const vm = AflVm.fromSource(`
first():
    entry:
        worker = agent @agent.first
        result = worker.do "first"
        ret result
second():
    entry:
        worker = agent @agent.second
        result = worker.do "second"
        ret result
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route both", [nodes: [first, second], min_routes: 2, max_routes: 2]
        reports = sync jobs
        ret reports
`, {
    agentExecutor: backend,
    policy: { maxConcurrency: 2 },
  });
  const result = await vm.run("main", [], {
    executionRoot: root,
    runId: "parallel-route",
    signal: AbortSignal.timeout(2_000),
  });
  assert.deepEqual(JSON.parse(result.output.content), ["@agent.first", "@agent.second"]);
  assert.equal(maximumActive, 2);
});

test("agent.route defers child failure to sync", async (t) => {
  const root = await temporaryRoot(t);
  const backend = controlBackend(async (request, host) => {
    const registered = await host.executeControlTool({
      id: "failing",
      name: "afl.route.add",
      input: { node: "failing", args: [] },
      signal: request.signal,
    });
    assert.equal(JSON.parse(registered.content).ok, true);
    return completed("routing finished");
  });
  const vm = AflVm.fromSource(`
failing():
    entry:
        fail "child failed"
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route", [nodes: [failing], min_routes: 1, max_routes: 1]
        reports = sync jobs
        ret reports
`, { agentExecutor: backend });
  await assert.rejects(
    vm.run("main", [], { executionRoot: root, runId: "route-child-failure" }),
    { code: "FLOW_FAILED", message: "child failed" },
  );
});

test("agent.flow executes a Node immediately and returns the writer summary", async (t) => {
  const root = await temporaryRoot(t);
  let childCompleted = false;
  const backend = controlBackend(async (request, host) => {
    if (request.control === undefined) {
      childCompleted = true;
      return completed(`department:${request.memory.at(-1).content}`);
    }
    assert.deepEqual(
      request.control.tools.map((tool) => tool.name),
      ["afl.environment.get", "afl.node.execute", "afl.ir.validate", "afl.ir.execute"],
    );
    const executed = await host.executeControlTool({
      id: "department",
      name: "afl.node.execute",
      input: { node: "department", args: [{ ref: "param:task" }] },
      signal: request.signal,
    });
    const result = JSON.parse(executed.content);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { type: "frag", content: "department:job" });
    assert.equal(childCompleted, true);
    return completed("flow-summary");
  });
  const vm = AflVm.fromSource(`
department(task):
    entry:
        worker = agent @agent.department
        result = worker.do task
        ret result
main():
    entry:
        writer = agent @agent.writer
        summary = writer.flow "execute", [nodes: [department], params: [task: "job"], min_routes: 1, max_routes: 1]
        ret summary
`, { agentExecutor: backend });
  const result = await vm.run("main", [], { executionRoot: root, runId: "flow-node-execute" });
  assert.equal(result.output.content, "flow-summary");
});

test("agent.flow validates and executes scoped IR without leaking tools into ordinary do", async (t) => {
  const root = await temporaryRoot(t);
  const observedTools = [];
  let irApprovals = 0;
  const generatedSource = `generated(task):
    entry:
        result = call department(task)
        ret result
`;
  const backend = controlBackend(async (request, host) => {
    observedTools.push(request.control?.tools.map((tool) => tool.name) ?? []);
    if (request.agent.name === "@agent.department") {
      return completed(`generated:${request.memory.at(-1).content}`);
    }
    if (request.control === undefined) return completed("ordinary-complete");
    const environment = JSON.parse((await host.executeControlTool({
      id: "environment",
      name: "afl.environment.get",
      input: { include: ["nodes"] },
      signal: request.signal,
    })).content);
    assert.deepEqual(environment.environment.nodes.map((node) => node.name), ["department"]);
    assert.equal(Object.hasOwn(environment.environment, "syntax"), false);
    const invalid = await host.executeControlTool({
      id: "invalid",
      name: "afl.ir.validate",
      input: {
        source: `bad(task):\n    entry:\n        result = invoke @mcp.unsafe, task\n        ret result\n`,
        entry: "bad",
        args: [{ ref: "param:task" }],
      },
      signal: request.signal,
    });
    assert.equal(JSON.parse(invalid.content).ok, false);
    const workspaceWarning = await host.executeControlTool({
      id: "workspace-warning",
      name: "afl.ir.validate",
      input: {
        source: `overlap():\n    entry:\n        worker = agent @agent.worker, [workspace: \"writer/child\"]\n        result = worker.do \"task\"\n        ret result\n`,
        entry: "overlap",
      },
      signal: request.signal,
    });
    const warningResult = JSON.parse(workspaceWarning.content);
    assert.equal(warningResult.ok, true);
    assert.equal(warningResult.diagnostics.some((item) =>
      item.code === "FREEDOM_WORKSPACE_OVERLAP" && item.severity === "warning"), true);
    const validated = await host.executeControlTool({
      id: "validate",
      name: "afl.ir.validate",
      input: { source: generatedSource, entry: "generated", args: [{ ref: "param:task" }] },
      signal: request.signal,
    });
    const validation = JSON.parse(validated.content);
    assert.equal(validation.ok, true);
    assert.match(validation.digest, /^sha256:/u);
    const overflow = await host.executeControlTool({
      id: "execute-overflow",
      name: "afl.ir.execute",
      input: {
        source: `over(task):\n    entry:\n        jobs = dispatch [department(task), department(task)]\n        reports = sync jobs\n        ret reports\n`,
        entry: "over",
        args: [{ ref: "param:task" }],
      },
      signal: request.signal,
    });
    const overflowResult = JSON.parse(overflow.content);
    assert.equal(overflowResult.ok, false);
    assert.equal(overflowResult.error.code, "FREEDOM_ROUTE_MAX_EXCEEDED");
    const executed = await host.executeControlTool({
      id: "execute",
      name: "afl.ir.execute",
      input: {
        source: generatedSource,
        entry: "generated",
        args: [{ ref: "param:task" }],
        expectedDigest: validation.digest,
      },
      signal: request.signal,
    });
    const result = JSON.parse(executed.content);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { type: "frag", content: "generated:job" });
    return completed("flow-complete");
  });
  const vm = AflVm.fromSource(`
department(task):
    entry:
        worker = agent @agent.department
        result = worker.do task
        ret result
main(task):
    entry:
        writer = agent @agent.writer, [workspace: "writer"]
        planned = writer.flow "plan", [nodes: [department], agents: [@agent.worker], params: [task: task], min_routes: 1, max_routes: 1]
        ordinary = writer.do "after"
        ret ordinary
`, {
    agentExecutor: backend,
    policy: {
      maxConcurrency: 1,
      authorizeFreedomIr() {
        irApprovals += 1;
        return true;
      },
    },
  });
  const result = await vm.run("main", ["job"], { executionRoot: root, runId: "flow-tools" });
  assert.equal(result.output.content, "ordinary-complete");
  assert.deepEqual(observedTools, [
    ["afl.environment.get", "afl.node.execute", "afl.ir.validate", "afl.ir.execute"],
    [],
    [],
  ]);
  assert.equal(irApprovals, 2);
});

test("Freedom reports static Workspace overlap and rejects it at runtime", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "shared"), { recursive: true });
  let childExecuted = false;
  const source = `
department(task):
    entry:
        worker = agent @agent.department, [workspace: "shared/child"]
        result = worker.do task
        ret result
main():
    entry:
        planner = agent @agent.planner, [workspace: ["planner", "shared"]]
        jobs = planner.route "plan", [nodes: [department]]
        reports = sync jobs
        ret reports
`;
  const validation = validateModule(parseAfl(source));
  assert.equal(validation.ok, true);
  assert.equal(validation.diagnostics.some((item) =>
    item.code === "FREEDOM_WORKSPACE_OVERLAP" && item.severity === "warning"), true);

  const backend = controlBackend(async (request, host) => {
    if (request.agent.name === "@agent.department") {
      childExecuted = true;
      return completed("unexpected");
    }
    const response = await host.executeControlTool({
      id: "overlap",
      name: "afl.route.add",
      input: { node: "department", args: [{ string: "task" }] },
      signal: request.signal,
    });
    const result = JSON.parse(response.content);
    assert.equal(result.ok, true);
    return completed("overlap-handled");
  });
  await assert.rejects(
    AflVm.fromSource(source, { agentExecutor: backend }).run(
      "main",
      [],
      { executionRoot: root, runId: "overlap" },
    ),
    { code: "FREEDOM_WORKSPACE_OVERLAP" },
  );
  assert.equal(childExecuted, false);
});

test("Freedom controlled params reject VM handles hidden behind unknown Node parameters", async () => {
  const vm = AflVm.fromSource(`
route(planner, leaked):
    entry:
        jobs = planner.route "route", [params: [leaked: leaked]]
        reports = sync jobs
        ret reports
main():
    entry:
        planner = agent @agent.planner
        result = call route(planner, planner)
        ret result
`, { agentExecutor: controlBackend(async () => completed("unexpected")) });
  await assert.rejects(vm.run(), { code: "FREEDOM_PARAM_INVALID" });
});

test("Freedom route constraints cannot expand VM policy limits", async (t) => {
  const root = await temporaryRoot(t);
  let executed = false;
  const vm = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route", [max_routes: 3]
        reports = sync jobs
        ret reports
`, {
    agentExecutor: controlBackend(async () => {
      executed = true;
      return completed("unexpected");
    }),
    policy: { freedomLimits: { maxRoutes: 2 } },
  });
  await assert.rejects(
    vm.run("main", [], { executionRoot: root, runId: "constraint-cap" }),
    { code: "FREEDOM_CONSTRAINT_INVALID" },
  );
  assert.equal(executed, false);
});

test("Freedom rejects VM scheduling fields in instruction constraints", () => {
  assert.throws(() => AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route", [max_parallel: 2]
        reports = sync jobs
        ret reports
`, { agentExecutor: controlBackend(async () => completed("unexpected")) }), (error) =>
    error.diagnostics?.some((item) => item.code === "PARSE_OPTIONS_FIELD") === true);
});

test("Freedom returns an empty TaskGroup for an empty Route and an empty Frag for an empty Flow", async (t) => {
  const root = await temporaryRoot(t);
  const route = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "optional route", [min_routes: 0, max_routes: 1]
        reports = sync jobs
        ret reports
`, { agentExecutor: controlBackend(async () => completed("unexecuted route claim")) });
  const routeResult = await route.run("main", [], { executionRoot: root, runId: "empty-route" });
  assert.deepEqual(routeResult.output, frag("[]"));

  const validationOnly = AflVm.fromSource(`
main():
    entry:
        writer = agent @agent.writer
        result = writer.flow "validate only", [min_routes: 0, max_routes: 1]
        ret result
`, {
    agentExecutor: controlBackend(async (request, host) => {
      const validation = await host.executeControlTool({
        id: "validate-only",
        name: "afl.ir.validate",
        input: { source: "generated():\n    entry:\n        ret \"ok\"\n", entry: "generated" },
        signal: request.signal,
      });
      assert.equal(JSON.parse(validation.content).ok, true);
      return completed("validated but unexecuted claim");
    }),
  });
  const validationResult = await validationOnly.run(
    "main",
    [],
    { executionRoot: root, runId: "empty-flow" },
  );
  assert.deepEqual(validationResult.output, frag(""));
});

test("Freedom preserves the writer result after IR execution without a routed Node", async (t) => {
  const root = await temporaryRoot(t);
  const source = "generated():\n    entry:\n        ret \"executed\"\n";
  const vm = AflVm.fromSource(`
main():
    entry:
        writer = agent @agent.writer
        result = writer.flow "execute IR", [min_routes: 0, max_routes: 1]
        ret result
`, {
    agentExecutor: controlBackend(async (request, host) => {
      const validated = JSON.parse((await host.executeControlTool({
        id: "validate",
        name: "afl.ir.validate",
        input: { source, entry: "generated" },
        signal: request.signal,
      })).content);
      assert.equal(validated.ok, true);
      const executed = JSON.parse((await host.executeControlTool({
        id: "execute",
        name: "afl.ir.execute",
        input: { source, entry: "generated", expectedDigest: validated.digest },
        signal: request.signal,
      })).content);
      assert.equal(executed.ok, true);
      return completed("executed IR summary");
    }),
  });
  const result = await vm.run("main", [], { executionRoot: root, runId: "ir-only-flow" });
  assert.equal(result.output.content, "executed IR summary");
});

test("Freedom fails when the planner returns below min_routes", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
available():
    entry:
        ret "unused"
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route", [nodes: [available], min_routes: 1, max_routes: 1]
        reports = sync jobs
        ret reports
`, { agentExecutor: controlBackend(async () => completed("too-early")) });
  await assert.rejects(
    vm.run("main", [], { executionRoot: root, runId: "route-minimum" }),
    { code: "FREEDOM_ROUTE_MIN_NOT_REACHED" },
  );
});

function controlBackend(execute) {
  return {
    name: "control-test",
    capabilities: {
      nativeSession: false,
      checkpoint: false,
      fork: false,
      workspaceContext: true,
      readOnlyWorkspaceContext: true,
      structuredOutput: false,
      interrupt: true,
      dynamicControlTools: true,
      interactiveApproval: false,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: [AFL_MESSAGE_ROLE_SCHEMA], importRoles: ["user", "assistant"] },
      validateImport() {},
    },
    execute,
  };
}

function completed(output) {
  return { output, stopReason: "completed" };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "afl-freedom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
