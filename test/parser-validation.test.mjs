import assert from "node:assert/strict";
import test from "node:test";

import {
  AflParseError,
  parseAfl,
  validateModule,
} from "../dist/src/index.js";

test("parser accepts the flow-oriented instruction surface", () => {
  const module = parseAfl(`
worker(task):
    entry:
        agent = agent @agent.worker
        agent.sysprompt "work"
        request = prompt @prompt.task, task
        result = agent.seqdo user, request, @schema.Result
        ret result

main(task):
    entry:
        count = typescript "return 2", task
        one = call worker, task
        jobs = dispatch [worker(one), @flow.remote(task)]
        batch = dispatch count, worker, task
        reports = sync jobs, @format.json
        batch_reports = sync batch
        tool = invoke @mcp.tool.read, reports
        done = oper count == 2 & tool != ""
        jump done, branch, failed
    branch:
        seed = agent @agent.seed
        child = fork seed, child.do task
        memory = memory.copy child.memory
        applied = memory.apply child, memory
        result = freedom.move applied, [@move.retry, @move.ask], reports, batch_reports
        ret result
    failed:
        fail "unexpected"
`, "surface.afl");

  assert.deepEqual(module.nodes.map((node) => node.name), ["worker", "main"]);
  assert.equal(module.nodes[1].blocks[0].instructions[2].op, "dispatch.list");
  assert.equal(module.nodes[1].blocks[1].instructions[1].op, "fork");
});

test("parser reports stable source location for indentation errors", () => {
  assert.throws(
    () => parseAfl("main():\n   entry:\n        ret", "bad.afl"),
    (error) => {
      assert.equal(error instanceof AflParseError, true);
      assert.equal(error.diagnostics[0].code, "PARSE_INDENT_WIDTH");
      assert.equal(error.diagnostics[0].sourceName, "bad.afl");
      assert.equal(error.diagnostics[0].span.line, 2);
      return true;
    },
  );
});

test("validator permits later producers in a block and rejects dependency cycles", () => {
  const valid = validateModule(parseAfl(`
main():
    entry:
        answer = prompt "answer", later
        later = prompt "later"
        ret answer
`));
  assert.equal(valid.ok, true);

  const invalid = validateModule(parseAfl(`
main():
    entry:
        worker = agent @agent.worker
        first = worker.do later
        later = worker.do "second"
        ret first
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "DEPENDENCY_CYCLE"), true);
});

test("validator computes definite availability across CFG joins", () => {
  const result = validateModule(parseAfl(`
main():
    entry:
        jump true, left, right
    left:
        value = prompt "left"
        jump done
    right:
        jump done
    done:
        ret value
`));
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === "NAME_UNAVAILABLE"), true);
});

test("validator checks local call arity, fork receiver, and TaskGroup consumption", () => {
  const result = validateModule(parseAfl(`
worker(task):
    entry:
        ret task
main(task):
    entry:
        source = agent @agent.worker
        child = fork source, wrong.do task
        bad = call worker
        jobs = dispatch [worker(task)]
        ret bad
`));
  assert.equal(result.ok, false);
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.equal(codes.has("FORK_RECEIVER_MISMATCH"), true);
  assert.equal(codes.has("CALL_ARITY"), true);
  assert.equal(codes.has("TASK_GROUP_UNCONSUMED"), true);
});

test("validator rejects obviously bound or multiply-bound Memory", () => {
  const result = validateModule(parseAfl(`
main():
    entry:
        source = agent @agent.source
        copy = memory.copy source.memory
        first = memory.apply source, copy
        second = memory.apply source, copy
        third = memory.apply source, source.memory
        ret "done"
`));
  assert.equal(result.ok, false);
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.equal(codes.has("MEMORY_MULTIPLE_BIND"), true);
  assert.equal(codes.has("MEMORY_ALREADY_BOUND"), true);
});

test("TaskGroup validation follows mutually exclusive CFG paths", () => {
  const valid = validateModule(parseAfl(`
worker(task):
    entry:
        ret task
main(task, choose_left):
    entry:
        jobs = dispatch [worker(task)]
        jump choose_left, left, right
    left:
        left_result = sync jobs
        ret left_result
    right:
        right_result = sync jobs
        ret right_result
`));
  assert.equal(valid.ok, true);

  const invalid = validateModule(parseAfl(`
worker(task):
    entry:
        ret task
main(task, choose_left):
    entry:
        jobs = dispatch [worker(task)]
        jump choose_left, left, right
    left:
        result = sync jobs
        ret result
    right:
        ret task
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "TASK_GROUP_UNCONSUMED"), true);
});
