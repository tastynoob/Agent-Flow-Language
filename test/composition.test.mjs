import assert from "node:assert/strict";
import test from "node:test";

import {
  AflRuntime,
  FlowRuntimeError,
  MockAgentAdapter,
  frag,
  parseAfl,
} from "../dist/src/index.js";

const agents = new MockAgentAdapter();

test("list dispatch preserves declaration order and batch dispatch uses dynamic count", async () => {
  const started = [];
  const flows = {
    async invoke(request) {
      const value = argumentText(request.args[0]);
      started.push(value);
      await delay(value === "slow" ? 35 : 5);
      return frag(`done:${value}`);
    },
  };
  const list = AflRuntime.fromSource(`
main():
    entry:
        jobs = dispatch [@flow.worker("slow"), @flow.worker("fast")]
        results = sync jobs
        ret results
`, { agents, flows });
  const listResult = await list.run();
  assert.equal(listResult.output.content, '["done:slow","done:fast"]');
  assert.deepEqual(new Set(started), new Set(["slow", "fast"]));

  let calls = 0;
  const batch = AflRuntime.fromSource(`
main(task):
    entry:
        count = typescript "return Number(args[0])", "3"
        jobs = dispatch count, @flow.worker, task
        results = sync jobs
        ret results
`, {
    agents,
    scripts: {
      execute(request) {
        assert.equal(request.language, "typescript");
        return Number(request.args[0]);
      },
    },
    flows: {
      invoke(request) {
        calls += 1;
        return frag(`${request.args[0].content}:${calls}`);
      },
    },
  });
  const batchResult = await batch.run("main", [frag("work")]);
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(batchResult.output.content), ["work:1", "work:2", "work:3"]);
});

test("dispatch child failure aborts unfinished siblings", async () => {
  let cancelled = false;
  const runtime = AflRuntime.fromSource(`
main():
    entry:
        jobs = dispatch [@flow.worker("wait"), @flow.worker("fail"), @flow.worker("wait-too")]
        results = sync jobs
        ret results
`, {
    agents,
    policy: { maxDispatchWorkers: 3 },
    flows: {
      async invoke(request) {
        const value = argumentText(request.args[0]);
        if (value === "fail") {
          await delay(5);
          throw new FlowRuntimeError("CHILD_FAILED", "child failed");
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          request.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            cancelled = true;
            reject(request.signal.reason);
          }, { once: true });
        });
        return frag("late");
      },
    },
  });

  await assert.rejects(runtime.run(), (error) => {
    assert.equal(error instanceof FlowRuntimeError, true);
    return true;
  });
  assert.equal(cancelled, true);
});

test("local call receives a separate invocation and normalizes compute output to Frag", async () => {
  const runtime = AflRuntime.fromSource(`
double(value):
    entry:
        result = oper value * 2
        ret result
main():
    entry:
        result = call double, 21
        ret result
`, { agents });
  const result = await runtime.run();
  assert.deepEqual(result.output, { kind: "frag", content: "42" });
});

test("dispatch enforces the configured total task limit", async () => {
  const runtime = AflRuntime.fromSource(`
main():
    entry:
        jobs = dispatch 3, @flow.worker, "task"
        results = sync jobs
        ret results
`, {
    agents,
    policy: { maxDispatchTasks: 2 },
    flows: { invoke: () => frag("done") },
  });
  await assert.rejects(runtime.run(), { code: "DISPATCH_TASK_LIMIT_EXCEEDED" });
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function argumentText(value) {
  return typeof value === "string" ? value : value.content;
}
