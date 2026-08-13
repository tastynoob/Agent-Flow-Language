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

test("list dispatch preserves declaration order and repeat uses a dynamic count", async () => {
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
        jobs = repeat count, @flow.worker(task)
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

test("repeat passes every flow-call argument to each child", async () => {
  const calls = [];
  const vm = AflVm.fromSource(`
main(left, right):
    entry:
        jobs = repeat 2, @flow.pair(left, right)
        results = sync jobs
        ret results
`, {
    agents,
    flows: {
      invoke(request) {
        const values = request.args.map(argumentText);
        calls.push(values);
        return frag(values.join(":"));
      },
    },
  });
  const result = await vm.run("main", [frag("left"), frag("right")]);
  assert.deepEqual(calls, [["left", "right"], ["left", "right"]]);
  assert.equal(result.output.content, '["left:right","left:right"]');
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
        result = call double(21)
        ret result
`, { agents });
  const result = await vm.run();
  assert.deepEqual(result.output, { kind: "frag", content: "42" });
});

test("dispatch enforces the configured total task limit", async () => {
  const vm = AflVm.fromSource(`
main():
    entry:
        jobs = repeat 3, @flow.worker("task")
        results = sync jobs
        ret results
`, {
    agents,
    policy: { maxDispatchTasks: 2 },
    flows: { invoke: () => frag("done") },
  });
  await assert.rejects(vm.run(), { code: "DISPATCH_TASK_LIMIT_EXCEEDED" });
});

test("match selects precomputed scalar routes in declaration order and uses default", async () => {
  const vm = AflVm.fromSource(`
main(route):
    entry:
        match route, [1: number, "1": string, "rtl": rtl], fallback
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

  await assert.rejects(vm.run("main", [["rtl"]]), { code: "MATCH_SELECTOR_NOT_SCALAR" });
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function argumentText(value) {
  return typeof value === "string" ? value : value.content;
}
