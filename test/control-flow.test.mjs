import assert from "node:assert/strict";
import test from "node:test";

import {
  AflRuntime,
  MemoryTraceSink,
  MockAgentAdapter,
} from "../dist/src/index.js";
import { anyAgentOperation, defineProgram, e, n, oneFlowProgram, s, t } from "./helpers.mjs";

test("callFlow, fail, catch, finally, and delay compose with structured state", async () => {
  const program = defineProgram({
    irVersion: "0.1",
    name: "reliability-control-flow",
    entry: "main",
    flows: {
      double: {
        input: s.number(),
        output: s.number(),
        body: n.return(
          "double-return",
          e.binary("multiply", e.input(), e.literal(2)),
        ),
      },
      main: {
        input: s.number(),
        output: s.object(
          {
            value: s.number(),
            finalized: s.boolean(),
            errorCode: s.string(),
          },
          {
            required: ["value", "finalized", "errorCode"],
            additionalProperties: false,
          },
        ),
        locals: {
          value: { schema: s.number(), initial: 0 },
          caught: { schema: s.any(), initial: null },
          finalized: { schema: s.boolean(), initial: false },
        },
        body: n.sequence("main-root", [
          n.callFlow("call-double", "double", e.input(), t.local("value")),
          n.try(
            "recover",
            n.fail(
              "expected-failure",
              e.object({
                code: e.literal("EXPECTED"),
                message: e.literal("exercise catch"),
              }),
            ),
            {
              catch: {
                error: "caught",
                body: n.assign(
                  "increment-after-catch",
                  t.local("value"),
                  e.binary("add", e.local("value"), e.literal(1)),
                ),
              },
              finally: n.assign(
                "mark-finalized",
                t.local("finalized"),
                e.literal(true),
              ),
            },
          ),
          n.delay("yield", e.literal(0)),
          n.return(
            "main-return",
            e.object({
              value: e.local("value"),
              finalized: e.local("finalized"),
              errorCode: e.local("caught", ["code"]),
            }),
          ),
        ]),
      },
    },
  });
  const runtime = new AflRuntime(program, { agents: new MockAgentAdapter() });

  const result = await runtime.run(4);

  assert.deepEqual(result.output, {
    value: 9,
    finalized: true,
    errorCode: "EXPECTED",
  });
});

test("parallel allSettled records errors while race returns the first success", async () => {
  const flow = {
    input: s.null(),
    output: s.any(),
    locals: {
      settled: { schema: s.any(), initial: null },
      raced: { schema: s.any(), initial: null },
    },
    body: n.sequence("root", [
      n.parallel(
        "settle",
        [
          { id: "ok", body: n.return("settle-ok", e.literal("value")) },
          {
            id: "bad",
            body: n.fail(
              "settle-bad",
              e.object({
                code: e.literal("BRANCH_FAILED"),
                message: e.literal("expected"),
              }),
            ),
          },
        ],
        "allSettled",
        t.local("settled"),
      ),
      n.parallel(
        "race",
        [
          {
            id: "slow",
            body: n.sequence("slow-body", [
              n.delay("slow-delay", e.literal(30)),
              n.return("slow-return", e.literal("slow")),
            ]),
          },
          {
            id: "fast",
            body: n.sequence("fast-body", [
              n.delay("fast-delay", e.literal(0)),
              n.return("fast-return", e.literal("fast")),
            ]),
          },
        ],
        "race",
        t.local("raced"),
      ),
      n.return(
        "return",
        e.object({ settled: e.local("settled"), raced: e.local("raced") }),
      ),
    ]),
  };
  const trace = new MemoryTraceSink();
  const runtime = new AflRuntime(oneFlowProgram(flow), {
    agents: new MockAgentAdapter(),
    trace,
  });

  const result = await runtime.run(null);

  assert.deepEqual(result.output.settled.ok, {
    status: "fulfilled",
    value: "value",
  });
  assert.equal(result.output.settled.bad.status, "rejected");
  assert.equal(result.output.settled.bad.error.code, "BRANCH_FAILED");
  assert.deepEqual(result.output.raced, { branch: "fast", value: "fast" });
  assert.equal(trace.events.at(-1).type, "run.completed");
});

test("freedom can create a validated isolated flow revision", async () => {
  const flow = {
    input: s.string(),
    output: s.string(),
    locals: { result: { schema: s.string() } },
    body: n.sequence("root", [
      n.freedom(
        "revise-flow",
        "planner",
        "plan",
        e.input(),
        {
          maxNodes: 1,
          maxDepth: 1,
          allowedNodeKinds: ["return"],
          allowedAgents: [],
          allowedFlows: [],
          allowRevision: true,
        },
        t.local("result"),
      ),
      n.return("return", e.local("result")),
    ]),
  };
  const mock = new MockAgentAdapter().on("planner", "plan", (input) => ({
    kind: "revision",
    input,
    flow: {
      input: s.string(),
      output: s.string(),
      body: n.return(
        "revision-return",
        e.binary("concat", e.input(), e.literal(" via revision")),
      ),
    },
  }));
  const trace = new MemoryTraceSink();
  const runtime = new AflRuntime(
    oneFlowProgram(flow, { planner: { operations: { plan: anyAgentOperation } } }),
    { agents: mock, trace },
  );

  const result = await runtime.run("handled");

  assert.equal(result.output, "handled via revision");
  assert.equal(trace.events.some((event) => event.type === "revision.created"), true);
});
