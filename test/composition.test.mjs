import assert from "node:assert/strict";
import test from "node:test";

import {
  AflVm,
  AflVmError,
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
  const list = AflVm.fromSource(`
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
  const batch = AflVm.fromSource(`
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
  const vm = AflVm.fromSource(`
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
          throw new AflVmError("CHILD_FAILED", "child failed");
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

  await assert.rejects(vm.run(), (error) => {
    assert.equal(error instanceof AflVmError, true);
    return true;
  });
  assert.equal(cancelled, true);
});

test("local call receives a separate invocation and normalizes compute output to Frag", async () => {
  const vm = AflVm.fromSource(`
double(value):
    entry:
        result = oper value * 2
        ret result
main():
    entry:
        result = call double, 21
        ret result
`, { agents });
  const result = await vm.run();
  assert.deepEqual(result.output, { kind: "frag", content: "42" });
});

test("dispatch enforces the configured total task limit", async () => {
  const vm = AflVm.fromSource(`
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
  await assert.rejects(vm.run(), { code: "DISPATCH_TASK_LIMIT_EXCEEDED" });
});

test("jump tables match precomputed scalar routes in declaration order and use default", async () => {
  const vm = AflVm.fromSource(`
main(route):
    entry:
        jump route, [1: number, "1": string, "rtl": rtl], fallback
    number:
        ret "number"
    string:
        ret "string"
    rtl:
        ret "rtl"
    fallback:
        ret "fallback"
`, { agents });

  assert.equal((await vm.run("main", [1])).output, "number");
  assert.equal((await vm.run("main", ["1"])).output, "string");
  assert.equal((await vm.run("main", ["rtl"])).output, "rtl");
  assert.equal((await vm.run("main", [frag("rtl")])).output, "rtl");
  assert.equal((await vm.run("main", ["unknown"])).output, "fallback");

  await assert.rejects(vm.run("main", [["rtl"]]), { code: "JUMP_TABLE_SELECTOR_NOT_SCALAR" });
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function argumentText(value) {
  return typeof value === "string" ? value : value.content;
}
