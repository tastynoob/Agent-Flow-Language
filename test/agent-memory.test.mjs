import assert from "node:assert/strict";
import test from "node:test";

import {
  AflVm,
  MockAgentAdapter,
  parseAfl,
} from "../dist/src/index.js";

test("coder-reviewer loop copies current context and returns defects for revision", async () => {
  const agents = new MockAgentAdapter();
  let coderRuns = 0;
  let reviewerRuns = 0;
  agents.on("@agent.coder", (request) => {
    coderRuns += 1;
    if (coderRuns === 1) return "draft-v1";
    assert.match(request.messages.at(-1).content, /P1: add tests/u);
    return "fixed-v2";
  });
  agents.on("@agent.reviewer", (request) => {
    reviewerRuns += 1;
    const contents = request.messages.map((message) => message.content);
    assert.equal(contents.includes(reviewerRuns === 1 ? "draft-v1" : "fixed-v2"), true);
    return reviewerRuns === 1
      ? "VERDICT: REVISE\nP1: add tests"
      : "The implementation is correct.\n\n**Status: APPROVED**";
  });

  const vm = AflVm.fromSource(`
main(task):
    entry:
        coder = agent @agent.coder
        code = coder.do task
        jump review
    review:
        review_memory = coder.memory.copy
        reviewer = agent @agent.reviewer, [memory: review_memory]
        review_result = reviewer.do "review"
        finish = typescript "const lines = String(args[0]).replaceAll('*', '').replaceAll('_', '').toLowerCase().split(String.fromCharCode(10)).map(line => line.trim()); return lines.some(line => ['finish', 'approved', 'pass'].some(verdict => line === verdict || line.startsWith('verdict: ' + verdict) || line.startsWith('status: ' + verdict)))", review_result
        branch finish, done, revise
    revise:
        fix = prompt "fix", review_result
        code = coder.do fix
        jump review
    done:
        ret code
`, {
    agents,
    scripts: {
      execute(request) {
        assert.equal(request.language, "typescript");
        return Function("args", `"use strict";\n${request.source}`)(request.args);
      },
    },
  });

  const result = await vm.run("main", ["build feature"]);
  assert.deepEqual(result.output, { kind: "frag", content: "fixed-v2" });
  assert.equal(coderRuns, 2);
  assert.equal(reviewerRuns, 2);
});

test("independent Agents run concurrently while one Agent remains ordered", async () => {
  let active = 0;
  let maximum = 0;
  const agents = new MockAgentAdapter();
  const handler = async (request) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(35);
    active -= 1;
    return request.messages.at(-1).content;
  };
  agents.on("@agent.left", handler).on("@agent.right", handler);
  const parallel = AflVm.fromSource(`
main():
    entry:
        left = agent @agent.left, [workspace: "left/"]
        right = agent @agent.right, [workspace: "right/"]
        left_result = left.do "left"
        right_result = right.do "right"
        result = prompt "joined", left_result, right_result
        ret result
`, { agents });
  await parallel.run();
  assert.equal(maximum, 2);

  active = 0;
  maximum = 0;
  const ordered = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.left
        first = worker.do "one"
        second = worker.do "two"
        ret second
`, { agents });
  await ordered.run();
  assert.equal(maximum, 1);
  const last = agents.calls.at(-1);
  assert.deepEqual(last.messages.map((message) => message.content).slice(-3), ["one", "one", "two"]);
});

test("fork snapshots source Memory and isolates branches in one inherited Workspace", async () => {
  const calls = [];
  let branchActive = 0;
  let branchMaximum = 0;
  const agents = new MockAgentAdapter();
  agents.on("@agent.worker", async (request) => {
    const input = request.messages.at(-1).content;
    calls.push({ input, messages: request.messages.map((message) => message.content) });
    if (input === "left-start" || input === "right-start") {
      branchActive += 1;
      branchMaximum = Math.max(branchMaximum, branchActive);
      await delay(30);
      branchActive -= 1;
    }
    return `out:${input}`;
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        source = agent @agent.worker
        seed = source.do "seed"
        left = source.fork "left-start"
        right = source.fork "right-start"
        left_result = left.do "left-end"
        right_result = right.do "right-end"
        source_result = source.do "source-end"
        result = prompt "done", left_result, right_result, source_result
        ret result
`, { agents });
  await vm.run();

  assert.equal(branchMaximum, 1);
  const leftEnd = calls.find((call) => call.input === "left-end");
  const rightEnd = calls.find((call) => call.input === "right-end");
  const sourceEnd = calls.find((call) => call.input === "source-end");
  assert.equal(leftEnd.messages.includes("right-start"), false);
  assert.equal(rightEnd.messages.includes("left-start"), false);
  assert.equal(sourceEnd.messages.includes("left-start"), false);
  assert.equal(leftEnd.messages.includes("out:seed"), true);
});

test("memory.append and agent.with_memory preserve roles without sharing source state", async () => {
  const agents = new MockAgentAdapter();
  const requests = [];
  agents.on("@agent.worker", (request) => {
    requests.push(request.messages.map((message) => ({ ...message })));
    return `out:${request.messages.at(-1).content}`;
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        source = agent @agent.worker
        seed = source.do "seed"
        copied = source.memory.copy
        copied.append tool, "observation"
        branch = source.with_memory copied
        branch_result = branch.do "branch"
        source_result = source.do "source"
        result = prompt "done", branch_result, source_result
        ret result
`, { agents });
  await vm.run();

  const branch = requests.find((messages) => messages.at(-1).content === "branch");
  const source = requests.find((messages) => messages.at(-1).content === "source");
  assert.deepEqual(branch.find((message) => message.content === "observation"), {
    role: "tool",
    content: "observation",
  });
  assert.equal(source.some((message) => message.content === "observation"), false);
});

test("aliased Agent parameters are ordered by VM handle identity", async () => {
  let active = 0;
  let maximum = 0;
  const order = [];
  const agents = new MockAgentAdapter().on("@agent.worker", async (request) => {
    active += 1;
    maximum = Math.max(maximum, active);
    const input = request.messages.at(-1).content;
    order.push(input);
    await delay(input === "one" ? 25 : 1);
    active -= 1;
    return input;
  });
  const vm = AflVm.fromSource(`
use_twice(first, second):
    entry:
        one = first.do "one"
        two = second.do "two"
        ret two
main():
    entry:
        worker = agent @agent.worker
        result = call use_twice(worker, worker)
        ret result
`, { agents });
  await vm.run();
  assert.equal(maximum, 1);
  assert.deepEqual(order, ["one", "two"]);
});

test("VM requires an Agent binding only when Agent work executes", async () => {
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "work"
        ret result
`, {});
  await assert.rejects(vm.run(), { code: "AGENT_ADAPTER_MISSING" });
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
