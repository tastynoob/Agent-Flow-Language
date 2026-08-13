import assert from "node:assert/strict";
import test from "node:test";

import {
  AflVm,
  AflParseError,
  canonicalModuleDigest,
  parseAfl,
  validateModule,
} from "../dist/src/index.js";

test("Node documentation is validated and participates in the module digest", () => {
  const first = parseAfl(`
worker(task):
    # @description Execute the task carefully.
    # @param task The controlled task.
    # @returns A report.
    entry:
        ret task
`);
  const second = parseAfl(`
worker(task):
    # @description Execute the task quickly.
    # @param task The controlled task.
    # @returns A report.
    entry:
        ret task
`);
  assert.deepEqual(first.nodes[0].documentation, {
    description: "Execute the task carefully.",
    parameters: { task: "The controlled task." },
    returns: "A report.",
  });
  assert.notEqual(canonicalModuleDigest(first), canonicalModuleDigest(second));

  const invalid = validateModule(parseAfl(`
worker(task):
    # @param missing This parameter is not in the signature.
    entry:
        ret task
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "NODE_DOCUMENTATION_PARAM_UNKNOWN"), true);
});

test("parser accepts the flow-oriented instruction surface", () => {
  const module = parseAfl(`
worker(task):
    entry:
        agent = agent @agent.worker
        agent.sysprompt "work"
        request = prompt @prompt.task, task
        result = agent.do user, request, @schema.Result
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
        routed = freedom.route applied, reports, [min_routes: 1, max_routes: 8], [worker], [reports: reports, batch: batch_reports]
        result = sync routed
        ret result
    failed:
        fail "unexpected"
`, "surface.afl");

  assert.deepEqual(module.nodes.map((node) => node.name), ["worker", "main"]);
  assert.equal(module.nodes[1].blocks[0].instructions[2].op, "dispatch.list");
  assert.equal(module.nodes[1].blocks[1].instructions[1].op, "fork");
});

test("parser uses bracket literals for both lists and records", async () => {
  const module = parseAfl(`
main():
    entry:
        list = prompt [1, "two", [nested: true]]
        record = prompt [alpha: 1, nested: [items: [1, 2]], "dash-key": "value", "__proto__": "data"]
        empty_list = prompt []
        empty_record = prompt [:]
        planner = agent @agent.planner
        jobs = freedom.route planner, "route", [], [], []
        reports = sync jobs
        ret record
`);
  const instructions = module.nodes[0].blocks[0].instructions;
  assert.equal(instructions[0].source.kind, "list");
  assert.equal(instructions[0].source.items[2].kind, "record");
  assert.equal(instructions[1].source.kind, "record");
  assert.equal(instructions[1].source.entries["dash-key"].value, "value");
  assert.equal(instructions[1].source.entries.__proto__.value, "data");
  assert.equal(instructions[2].source.kind, "list");
  assert.deepEqual(instructions[2].source.items, []);
  assert.equal(instructions[3].source.kind, "record");
  assert.deepEqual(instructions[3].source.entries, {});
  assert.equal(instructions[5].constraint.kind, "record");
  assert.equal(instructions[5].params.kind, "record");
  const result = await AflVm.fromSource(`
main():
    entry:
        ret ["__proto__": "data"]
`, {}).run("main");
  assert.equal(Object.hasOwn(result.output, "__proto__"), true);
  assert.equal(result.output.__proto__, "data");

  assert.throws(() => parseAfl(`
main():
    entry:
        value = prompt [1, key: 2]
        ret value
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_COLLECTION_MIXED");
    return true;
  });

  assert.throws(() => parseAfl(`
main():
    entry:
        value = prompt {key: "removed"}
        ret value
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_NAME");
    return true;
  });
});

test("parser rejects removed seqdo syntax", () => {
  assert.throws(() => parseAfl(`
main(task):
    entry:
        worker = agent @agent.worker
        result = worker.seqdo task
        ret result
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_OPCODE");
    return true;
  });

  assert.throws(() => parseAfl(`
main(task):
    entry:
        worker = agent @agent.worker
        branch = fork worker, branch.seqdo task
        ret branch
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_FORK_ACTION");
    return true;
  });

  assert.throws(() => parseAfl(`
main():
    entry:
        planner = agent @agent.planner
        result = freedom.move planner, [], "route", "context"
        ret result
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_OPCODE");
    return true;
  });
});

test("agent operands reserve Workspace before optional Memory", () => {
  const module = parseAfl(`
main(memory, main_workspace):
    entry:
        default_agent = agent @agent.default
        path_agent = agent @agent.path, "worker/"
        list_agent = agent @agent.list, [main_workspace, "docs/"]
        memory_agent = agent @agent.memory,, memory
        full_agent = agent @agent.full, main_workspace, memory
        ret "done"
`);
  const instructions = module.nodes[0].blocks[0].instructions;
  assert.equal(instructions[0].workspace, undefined);
  assert.equal(instructions[1].workspace.kind, "literal");
  assert.equal(instructions[2].workspace.kind, "list");
  assert.equal(instructions[3].workspace, undefined);
  assert.equal(instructions[3].memory.name, "memory");
  assert.equal(instructions[4].workspace.name, "main_workspace");
  assert.equal(instructions[4].memory.name, "memory");

  for (const source of [
    "worker = agent @agent.worker,",
    "worker = agent @agent.worker,,",
    "worker = agent @agent.worker, \"work/\",",
  ]) {
    assert.throws(() => parseAfl(`main():\n    entry:\n        ${source}\n        ret \"done\"\n`), {
      name: "AflParseError",
    });
  }

  const singlePathList = validateModule(parseAfl(`
main():
    entry:
        worker = agent @agent.worker, ["work/"]
        ret "done"
`));
  assert.equal(singlePathList.ok, false);
  assert.equal(singlePathList.diagnostics.some((item) => item.code === "AGENT_WORKSPACE_INVALID"), true);

  const oldMemoryPosition = validateModule(parseAfl(`
main():
    entry:
        source = agent @agent.source
        memory = memory.copy source.memory
        reviewer = agent @agent.reviewer, memory
        ret "done"
`));
  assert.equal(oldMemoryPosition.ok, false);
  assert.equal(oldMemoryPosition.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);

  const memoryInsideWorkspaceList = validateModule(parseAfl(`
main():
    entry:
        source = agent @agent.source
        memory = memory.copy source.memory
        reviewer = agent @agent.reviewer, [memory, "docs/"]
        ret "done"
`));
  assert.equal(memoryInsideWorkspaceList.ok, false);
  assert.equal(memoryInsideWorkspaceList.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);
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

test("freedom.route produces a TaskGroup that must be synced", () => {
  const invalid = validateModule(parseAfl(`
main():
    entry:
        planner = agent @agent.planner
        jobs = freedom.route planner, "route", [], [], []
        ret "done"
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "TASK_GROUP_UNCONSUMED"), true);

  const valid = validateModule(parseAfl(`
main():
    entry:
        planner = agent @agent.planner
        jobs = freedom.route planner, "route", [], [], []
        reports = sync jobs
        ret reports
`));
  assert.equal(valid.ok, true);
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

test("jump tables preserve ordered scalar cases and validate every target", () => {
  const module = parseAfl(`
main(route):
    entry:
        jump route, ["research": research, "rtl": rtl, 3: numbered], fallback
    research:
        ret "research"
    rtl:
        ret "rtl"
    numbered:
        ret "numbered"
    fallback:
        ret "fallback"
`);
  const terminator = module.nodes[0].blocks[0].terminator;
  assert.equal(terminator.op, "jump.table");
  assert.deepEqual(terminator.cases, [
    { value: "research", target: "research" },
    { value: "rtl", target: "rtl" },
    { value: 3, target: "numbered" },
  ]);
  assert.equal(validateModule(module).ok, true);

  const fragSelector = validateModule(parseAfl(`
main():
    entry:
        route = prompt "rtl"
        jump route, ["rtl": rtl], fallback
    rtl:
        ret
    fallback:
        ret
`));
  assert.equal(fragSelector.ok, true);

  const invalid = validateModule(parseAfl(`
main(route):
    entry:
        jump route, ["known": missing], fallback
    fallback:
        ret "fallback"
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "JUMP_TARGET_UNKNOWN"), true);

  const nonScalar = validateModule(parseAfl(`
main():
    entry:
        jump ["rtl"], ["rtl": rtl], fallback
    rtl:
        ret
    fallback:
        ret
`));
  assert.equal(nonScalar.ok, false);
  assert.equal(nonScalar.diagnostics.some((item) => item.code === "JUMP_TABLE_SELECTOR_NOT_SCALAR"), true);

  const directNode = module.nodes[0];
  const directEntry = directNode.blocks[0];
  const directTerminator = directEntry.terminator;
  const invalidDirectIr = {
    ...module,
    nodes: [{
      ...directNode,
      blocks: [{
        ...directEntry,
        terminator: {
          ...directTerminator,
          cases: [
            { value: "same", target: "research" },
            { value: "same", target: "rtl" },
          ],
        },
      }, ...directNode.blocks.slice(1)],
    }],
  };
  const directValidation = validateModule(invalidDirectIr);
  assert.equal(directValidation.ok, false);
  assert.equal(directValidation.diagnostics.some((item) => item.code === "JUMP_TABLE_CASE_DUPLICATE"), true);

  assert.throws(() => parseAfl(`
main(route):
    entry:
        jump route, ["same": first, "same": second], fallback
    first:
        ret
    second:
        ret
    fallback:
        ret
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_JUMP_TABLE_CASE_DUPLICATE");
    return true;
  });
});
