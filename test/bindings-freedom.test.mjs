import assert from "node:assert/strict";
import test from "node:test";

import {
  AflVm,
  AflVmError,
  MockAgentAdapter,
  frag,
  symbol,
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
        local = call identity, page
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

test("freedom.move executes only a selected candidate after policy approval", async () => {
  let approved = false;
  const vm = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        result = freedom.move planner, [@move.retry, @move.ask], "choose", "context"
        ret result
`, {
    agents: new MockAgentAdapter(),
    freedom: {
      plan() {
        return { kind: "move", move: symbol("@move.ask"), args: [frag("details")] };
      },
    },
    moves: {
      execute(request) {
        assert.equal(request.move.name, "@move.ask");
        return `executed:${request.args[0].content}`;
      },
    },
    policy: {
      approveFreedom(request) {
        approved = request.plan.kind === "move";
        return true;
      },
    },
  });
  const result = await vm.run();
  assert.equal(result.output.content, "executed:details");
  assert.equal(approved, true);
});

test("freedom rejects out-of-scope moves and validates generated AFL before execution", async () => {
  const outOfScope = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        result = freedom.move planner, [@move.allowed], "choose", "context"
        ret result
`, {
    agents: new MockAgentAdapter(),
    freedom: { plan: () => ({ kind: "move", move: symbol("@move.denied") }) },
    moves: { execute: () => "should not run" },
  });
  await assert.rejects(outOfScope.run(), { code: "FREEDOM_MOVE_OUT_OF_SCOPE" });

  const generated = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        result = freedom.flow planner, "plan", "context"
        ret result
`, {
    agents: new MockAgentAdapter(),
    freedom: {
      plan: () => ({
        kind: "generated",
        source: "generated(value):\n    entry:\n        result = prompt \"generated\", value\n        ret result\n",
        entry: "generated",
        args: [frag("ok")],
      }),
    },
  });
  const result = await generated.run();
  assert.equal(result.output.content, "generated\n\nok");

  const invalid = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        result = freedom.flow planner, "plan", "context"
        ret result
`, {
    agents: new MockAgentAdapter(),
    freedom: { plan: () => ({ kind: "generated", source: "not afl", entry: "main" }) },
  });
  await assert.rejects(invalid.run());
});
