import assert from "node:assert/strict";
import test from "node:test";

import {
  AflRuntime,
  FlowRuntimeError,
  MemoryCheckpointAdapter,
  MemoryTraceSink,
  MockAgentAdapter,
  QueueEventAdapter,
} from "../dist/src/index.js";
import { anyAgentOperation, e, n, oneFlowProgram, s, t } from "./helpers.mjs";

test("coder-reviewer loop revises until the structured review is accepted", async () => {
  const reviewSchema = s.object(
    {
      status: s.enum(["accepted", "revision_required", "blocked"]),
      issues: s.array(s.string()),
    },
    { required: ["status", "issues"], additionalProperties: false },
  );
  const flow = {
    input: s.object({ task: s.string() }, { required: ["task"], additionalProperties: false }),
    output: s.string(),
    state: {
      artifact: { schema: s.string(), initial: "" },
      review: {
        schema: reviewSchema,
        initial: { status: "revision_required", issues: ["not reviewed"] },
      },
    },
    body: n.sequence("root", [
      n.invoke("create", "coder", "create", e.input("task"), t.state("artifact")),
      n.loop(
        "review-loop",
        e.binary("neq", e.state("review", ["status"]), e.literal("accepted")),
        n.sequence("review-iteration", [
          n.invoke(
            "review",
            "reviewer",
            "review",
            e.state("artifact"),
            t.state("review"),
          ),
          n.branch(
            "needs-revision",
            [
              {
                when: e.binary(
                  "eq",
                  e.state("review", ["status"]),
                  e.literal("revision_required"),
                ),
                then: n.invoke(
                  "revise",
                  "coder",
                  "revise",
                  e.object({
                    artifact: e.state("artifact"),
                    issues: e.state("review", ["issues"]),
                  }),
                  t.state("artifact"),
                ),
              },
            ],
            n.noop("review-complete"),
          ),
        ]),
        4,
      ),
      n.return("return-artifact", e.state("artifact")),
    ]),
  };
  const agents = {
    coder: {
      operations: {
        create: { input: s.string(), output: s.string() },
        revise: {
          input: s.object(
            { artifact: s.string(), issues: s.array(s.string()) },
            { required: ["artifact", "issues"], additionalProperties: false },
          ),
          output: s.string(),
        },
      },
    },
    reviewer: {
      operations: {
        review: { input: s.string(), output: reviewSchema },
      },
    },
  };
  let reviewCount = 0;
  const mock = new MockAgentAdapter()
    .on("coder", "create", () => "draft")
    .on("coder", "revise", ({ artifact }) => `${artifact}-fixed`)
    .on("reviewer", "review", () => {
      reviewCount += 1;
      return reviewCount === 1
        ? { status: "revision_required", issues: ["missing test"] }
        : { status: "accepted", issues: [] };
    });
  const trace = new MemoryTraceSink();
  const runtime = new AflRuntime(oneFlowProgram(flow, agents), {
    agents: mock,
    trace,
  });

  const result = await runtime.run({ task: "implement feature" }, { runId: "review-run" });

  assert.equal(result.output, "draft-fixed");
  assert.deepEqual(
    mock.calls.map((call) => `${call.agent}.${call.operation}`),
    ["coder.create", "reviewer.review", "coder.revise", "reviewer.review"],
  );
  assert.equal(trace.events[0].type, "run.started");
  assert.equal(trace.events.at(-1).type, "run.completed");
  assert.deepEqual(
    trace.events.map((event) => event.sequence),
    Array.from({ length: trace.events.length }, (_value, index) => index + 1),
  );
});

test("parallel branches use isolated frames and collect explicit results", async () => {
  const branch = (id, value) => ({
    id,
    body: n.sequence(`${id}-body`, [
      n.assign(`${id}-assign`, t.local("value"), e.literal(value)),
      n.return(`${id}-return`, e.local("value")),
    ]),
  });
  const flow = {
    input: s.null(),
    output: s.any(),
    locals: {
      value: { schema: s.string(), initial: "parent" },
      results: { schema: s.any(), initial: null },
    },
    body: n.sequence("root", [
      n.parallel(
        "parallel",
        [branch("left", "L"), branch("right", "R")],
        "all",
        t.local("results"),
      ),
      n.return(
        "return",
        e.object({ results: e.local("results"), parentValue: e.local("value") }),
      ),
    ]),
  };
  const runtime = new AflRuntime(oneFlowProgram(flow), { agents: new MockAgentAdapter() });

  const result = await runtime.run(null);

  assert.deepEqual(result.output, {
    results: { left: "L", right: "R" },
    parentValue: "parent",
  });
});

test("retry rolls failed frame mutations back before the next attempt", async () => {
  const flow = {
    input: s.null(),
    output: s.number({ integer: true }),
    state: { count: { schema: s.number({ integer: true }), initial: 0 } },
    body: n.sequence("root", [
      n.retry(
        "retry",
        n.sequence("attempt", [
          n.assign(
            "increment",
            t.state("count"),
            e.binary("add", e.state("count"), e.literal(1)),
          ),
          n.invoke("flaky-call", "worker", "flaky", e.literal(null)),
        ]),
        3,
      ),
      n.return("return", e.state("count")),
    ]),
  };
  let attempts = 0;
  const mock = new MockAgentAdapter().on("worker", "flaky", () => {
    attempts += 1;
    if (attempts < 3) {
      throw new FlowRuntimeError("TRANSIENT", "try again");
    }
    return null;
  });
  const runtime = new AflRuntime(
    oneFlowProgram(flow, { worker: { operations: { flaky: anyAgentOperation } } }),
    { agents: mock },
  );

  const result = await runtime.run(null);

  assert.equal(attempts, 3);
  assert.equal(result.output, 1);
});

test("timeout cancels an adapter and does not commit its isolated frame", async () => {
  const flow = {
    input: s.null(),
    output: s.null(),
    body: n.timeout(
      "deadline",
      n.invoke("slow-call", "worker", "slow", e.literal(null)),
      10,
    ),
  };
  const mock = new MockAgentAdapter().on("worker", "slow", (_input, request) =>
    new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), {
        once: true,
      });
    }),
  );
  const runtime = new AflRuntime(
    oneFlowProgram(flow, { worker: { operations: { slow: anyAgentOperation } } }),
    { agents: mock },
  );

  await assert.rejects(runtime.run(null), (error) => {
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.nodeId, "deadline");
    return true;
  });
});

test("events and checkpoints stay behind adapters", async () => {
  const flow = {
    input: s.null(),
    output: s.string(),
    state: { status: { schema: s.string(), initial: "waiting" } },
    locals: { payload: { schema: s.string() } },
    body: n.sequence("root", [
      n.emit("emit", "approval.requested", e.literal("ticket-1")),
      n.awaitEvent("wait", "approval.requested", { assign: t.local("payload") }),
      n.assign("approved", t.state("status"), e.literal("approved")),
      n.checkpoint("checkpoint", "after-approval"),
      n.return("return", e.local("payload")),
    ]),
  };
  const events = new QueueEventAdapter();
  const checkpoints = new MemoryCheckpointAdapter();
  const runtime = new AflRuntime(oneFlowProgram(flow), {
    agents: new MockAgentAdapter(),
    events,
    checkpoints,
  });

  const result = await runtime.run(null);

  assert.equal(result.output, "ticket-1");
  assert.equal(events.emitted.length, 1);
  assert.equal(checkpoints.checkpoints.length, 1);
  assert.deepEqual(checkpoints.checkpoints[0].state, { status: "approved" });
});

test("freedom validates and runs a constrained continuation", async () => {
  const flow = {
    input: s.string(),
    output: s.string(),
    locals: { result: { schema: s.string() } },
    body: n.sequence("root", [
      n.freedom(
        "fallback",
        "planner",
        "plan",
        e.input(),
        {
          maxNodes: 2,
          maxDepth: 1,
          allowedNodeKinds: ["return"],
          allowedAgents: [],
          allowedFlows: [],
          allowRevision: false,
        },
        t.local("result"),
      ),
      n.return("return", e.local("result")),
    ]),
  };
  const mock = new MockAgentAdapter().on("planner", "plan", () => ({
    kind: "continuation",
    body: n.return("dynamic-return", e.literal("handled freely")),
  }));
  const trace = new MemoryTraceSink();
  const runtime = new AflRuntime(
    oneFlowProgram(flow, { planner: { operations: { plan: anyAgentOperation } } }),
    { agents: mock, trace },
  );

  const result = await runtime.run("unknown task");

  assert.equal(result.output, "handled freely");
  assert.equal(trace.events.some((event) => event.type === "freedom.plan.accepted"), true);
});

test("freedom rejects plans that exceed the declared behavior boundary", async () => {
  const flow = {
    input: s.null(),
    output: s.null(),
    body: n.freedom(
      "fallback",
      "planner",
      "plan",
      e.literal(null),
      {
        maxNodes: 1,
        maxDepth: 1,
        allowedNodeKinds: ["return"],
        allowedAgents: [],
        allowedFlows: [],
        allowRevision: false,
      },
    ),
  };
  const mock = new MockAgentAdapter().on("planner", "plan", () => ({
    kind: "continuation",
    body: n.invoke("disallowed", "planner", "plan", e.literal(null)),
  }));
  const runtime = new AflRuntime(
    oneFlowProgram(flow, { planner: { operations: { plan: anyAgentOperation } } }),
    { agents: mock },
  );

  await assert.rejects(runtime.run(null), (error) => {
    assert.equal(error.code, "FREEDOM_PLAN_INVALID");
    assert.equal(error.details.issues.some((issue) => issue.code === "FREEDOM_NODE_KIND_DENIED"), true);
    return true;
  });
});
