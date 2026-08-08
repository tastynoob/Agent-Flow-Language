import assert from "node:assert/strict";
import test from "node:test";

import { AflIrBuilder, Agent } from "../dist/src/index.js";
import { AflValidationError } from "../dist/src/errors.js";
import { frag } from "../dist/src/ir.js";
import { parseAfl } from "../dist/src/parser.js";
import { AflVm } from "../dist/src/vm.js";

test("linear while/when control flow executes without callback nesting", async () => {
  const builder = new AflIrBuilder({ sourceName: "loop.generated.afl" });
  const main = builder.node("main", ["limit"]);
  const attempt = builder.variable("attempt", 0);

  builder.while(attempt.lessThan(main.params.limit));
  attempt.set(attempt.add(1));

  builder.when(attempt.equals(2));
  builder.continue();
  builder.end();

  builder.when(attempt.greaterThanOrEqual(4));
  builder.break();
  builder.end();

  builder.end();
  builder.ret(attempt);

  const source = builder.build();
  assert.match(source, /jump __afl_while_1_test/u);
  assert.match(source, /condition_1 = oper attempt < limit/u);
  assert.match(source, /jump __afl_while_1_end/u);

  const result = await AflVm.fromSource(source, {}).run("main", [10]);
  assert.equal(result.output, 4);
});

test("Agent values expose lazy text conditions for when/otherwise", () => {
  const builder = new AflIrBuilder({ sourceName: "agent.generated.afl" });
  const main = builder.node("main", ["task"], {
    description: "Run one coding task.",
    parameters: { task: "The requested work." },
    returns: "The completed result.",
  });
  const coder = builder.agent("@agent.coder", { name: "coder", workspace: "work/coder" });
  coder.sysprompt("Implement the task carefully.");
  const result = coder.do(main.params.task, { name: "result" });

  builder.when(result.startsWith("DONE:"));
  builder.ret(result);
  builder.otherwise();
  builder.fail("Agent returned an invalid result");
  builder.end();

  const source = builder.build();
  assert.match(
    source,
    /condition_1 = typescript "return String\(args\[0\]\)\.startsWith\(String\(args\[1\]\)\)", result, "DONE:"/u,
  );
  assert.match(source, /coder = agent @agent\.coder, "work\/coder"/u);
  assert.match(source, /result = coder\.do task/u);
  assert.deepEqual(parseAfl(source).nodes[0].documentation, {
    description: "Run one coding task.",
    parameters: { task: "The requested work." },
    returns: "The completed result.",
  });
});

test("node references generate validated local calls", async () => {
  const builder = new AflIrBuilder();
  const echo = builder.node("echo", ["value"]);
  builder.ret(echo.params.value);

  const main = builder.node("main", ["input"]);
  const result = echo.call(main.params.input);
  builder.ret(result);

  const source = builder.build();
  assert.match(source, /result_1 = call echo, input/u);
  const execution = await AflVm.fromSource(source, {}).run("main", [frag("hello")]);
  assert.deepEqual(execution.output, frag("hello"));
});

test("Agent options preserve role, schema, and an explicit Memory", () => {
  const builder = new AflIrBuilder();
  builder.node("main", ["task"]);
  const seed = builder.agent("@agent.seed", { name: "seed" });
  const memory = builder.assign("review_memory", "memory.copy seed.memory");
  const reviewer = new Agent(builder, "@agent.reviewer", {
    name: "reviewer",
    memory,
  });
  const result = reviewer.do(builder.ref("task"), {
    name: "result",
    role: "@role.review",
    schema: "@schema.Review",
  });
  builder.ret(result);

  const source = builder.build();
  assert.match(source, /reviewer = agent @agent\.reviewer,, review_memory/u);
  assert.match(source, /result = reviewer\.do @role\.review, task, @schema\.Review/u);

  const invalid = new AflIrBuilder();
  invalid.node("main");
  const coder = invalid.agent("@agent.coder");
  assert.throws(
    () => coder.do("review", { schema: "@prompt.not_a_schema" }),
    /must start with '@schema\.'/u,
  );
});

test("builder rejects malformed structure and lets the AFL validator check data flow", () => {
  const missingEnd = new AflIrBuilder();
  missingEnd.node("main");
  missingEnd.when(true);
  missingEnd.ret("done");
  assert.throws(() => missingEnd.build(), /unclosed when/u);

  const outsideLoop = new AflIrBuilder();
  outsideLoop.node("main");
  assert.throws(() => outsideLoop.break(), /require an open while/u);
  assert.throws(() => outsideLoop.emit("jump done"), /instead of emitting an AFL terminator/u);

  const unavailable = new AflIrBuilder({ sourceName: "invalid.generated.afl" });
  const main = unavailable.node("main", ["flag"]);
  unavailable.when(main.params.flag);
  const value = unavailable.assign("value", "prompt \"only on one branch\"");
  unavailable.end();
  unavailable.ret(value);
  assert.throws(() => unavailable.build(), (error) => {
    assert.equal(error instanceof AflValidationError, true);
    assert.equal(error.diagnostics.some((item) => item.code === "NAME_UNAVAILABLE"), true);
    return true;
  });
});
