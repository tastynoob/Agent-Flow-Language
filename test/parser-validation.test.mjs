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
        agent.system_prompt "work"
        request = prompt @prompt.task, task
        result = agent.do request, [role: user, format: [status: "Completion state", value: "Result payload"]]
        ret result

main(task):
    entry:
        count = typescript "return 2", task
        one = call worker(task)
        jobs = dispatch [worker(one), @flow.remote(task)]
        batch = repeat count, worker(task)
        reports = sync jobs, @format.json
        batch_reports = sync batch
        tool = invoke @mcp.tool.read, reports
        done = oper count == 2 & tool != ""
        branch done, branch, failed
    branch:
        seed = agent @agent.seed
        child = seed.fork task
        memory = child.memory.copy
        applied = child.with_memory memory
        routed = applied.route reports, [nodes: [worker], params: [reports: reports, batch: batch_reports], min_routes: 1, max_routes: 8]
        result = sync routed
        ret result
    failed:
        fail "unexpected"
`, "surface.afl");

  assert.deepEqual(module.nodes.map((node) => node.name), ["worker", "main"]);
  assert.equal(module.nodes[1].blocks[0].instructions[2].op, "dispatch");
  assert.equal(module.nodes[1].blocks[1].instructions[1].op, "fork");
});

test("single and triple-quoted strings preserve useful text without JSON escapes", async () => {
  const vm = AflVm.fromSource(`
main():
    entry:
        label = prompt 'can\\'t # stop'
        record = oper ['dash-key': 'value']
        matches = oper record['dash-key'] == 'value'
        text = prompt '''
        first line
            indented line
        # literal comment
        '''
        ret text
`, {});

  const result = await vm.run();
  assert.equal(result.output.content, "first line\n    indented line\n# literal comment");
  const module = vm.module;
  assert.equal(module.nodes[0].blocks[0].instructions[0].source.value, "can't # stop");
  assert.equal(module.nodes[0].blocks[0].instructions[2].expression.kind, "binary");
});

test("prompt records render labeled Markdown sections without confusing content Markdown", async () => {
  const vm = AflVm.fromSource(`
main():
    entry:
        result = prompt "user prompt",
            [
                "A handoff": "first line / second line",
                nested: [
                    "B handoff": "quoted line",
                    deeper: [
                        "C handoff": "deep result"
                    ],
                    records: [
                        [name: "first", value: "one"],
                        [name: "second", value: "two"]
                    ]
                ]
            ],
            [1, 2]
        ret result
`, {});

  const result = await vm.run();
  assert.equal(result.output.content, [
    "user prompt",
    "",
    "* A handoff:",
    "  > first line / second line",
    "",
    "* nested:",
    "  * B handoff:",
    "    > quoted line",
    "",
    "  * deeper:",
    "    * C handoff:",
    "      > deep result",
    "",
    "  * records:",
    "    > -",
    "    >   * name:",
    "    >     > first",
    "    > ",
    "    >   * value:",
    "    >     > one",
    "    > -",
    "    >   * name:",
    "    >     > second",
    "    > ",
    "    >   * value:",
    "    >     > two",
    "",
    "[1,2]",
  ].join("\n"));
  assert.match(result.output.content, /\* A handoff:\n  > first line \/ second line/u);
  assert.doesNotMatch(result.output.content, /\* first line \/ second line/u);
  assert.match(result.output.content, /\* nested:\n  \* B handoff:\n    > quoted line/u);

  const invalidLabel = validateModule(parseAfl(`
main():
    entry:
        result = prompt ["bad\\nlabel": "content"]
        ret result
`));
  assert.equal(invalidLabel.ok, false);
  assert.equal(
    invalidLabel.diagnostics.some((item) => item.code === "PROMPT_SECTION_LABEL_INVALID"),
    true,
  );
});

test("tabs are rejected even inside triple-quoted strings", () => {
  assert.throws(() => parseAfl(`
main():
    entry:
        text = prompt '''
\tcontent
        '''
        ret text
`), (error) => error instanceof AflParseError &&
    error.diagnostics.some((item) => item.code === "PARSE_TAB_INDENT"));
});

test("a top-level trailing comma opens an indented instruction continuation", () => {
  const module = parseAfl(`
worker(task):
    entry:
        ret task

main(task):
    entry:
        planner = agent @agent.planner
        jobs = planner.route 'route work',
            [nodes: [
                worker
            ],
            params: [
                task: task,
                config: [
                    mode: 'fast',
                    labels: ['a', 'b']
                ]
            ],
            min_routes: 1,
            max_routes: 2]
        ret jobs
`);

  const route = module.nodes[1].blocks[0].instructions[1];
  assert.equal(route.op, "agent.route");
  assert.equal(route.prompt.value, "route work");
  assert.equal(route.nodes[0].name, "worker");
  assert.equal(route.params.entries.config.kind, "record");
  assert.equal(route.params.entries.config.entries.labels.kind, "list");
  assert.equal(route.minRoutes.value, 1);
  assert.equal(route.maxRoutes.value, 2);
});

test("an open collection does not enable instruction continuation without a trailing comma", () => {
  assert.throws(() => parseAfl(`
main():
    entry:
        value = prompt [
            'one',
            'two'
        ]
        ret value
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    return true;
  });
});

test("Agent work accepts inline enum and object formats", () => {
  const module = parseAfl(`
main():
    entry:
        reviewer = agent @agent.reviewer
        status = reviewer.do 'review', [format: ['finish', 'error']]
        report = reviewer.do 'report',
            [format: [
                type: 'Result type',
                value: 'Result payload'
            ]]
        ret report
`);
  assert.deepEqual(module.nodes[0].blocks[0].instructions[1].format, {
    kind: "enum",
    values: ["finish", "error"],
  });
  assert.deepEqual(module.nodes[0].blocks[0].instructions[2].format, {
    kind: "object",
    fields: { type: "Result type", value: "Result payload" },
  });

  assert.throws(() => parseAfl(`
main():
    entry:
        reviewer = agent @agent.reviewer
        result = reviewer.do 'review', [format: []]
        ret result
`), (error) => error instanceof AflParseError &&
    error.diagnostics.some((item) => item.code === "PARSE_AGENT_FORMAT"));

  assert.throws(() => parseAfl(`
main():
    entry:
        reviewer = agent @agent.reviewer
        result = reviewer.do 'review', [format: [finish, 'error']]
        ret result
`), (error) => error instanceof AflParseError &&
    error.diagnostics.some((item) => item.code === "PARSE_AGENT_FORMAT"));

  assert.throws(() => parseAfl(`
main():
    entry:
        reviewer = agent @agent.reviewer
        result = reviewer.do 'review', [schema: @schema.Result]
        ret result
`), (error) => error instanceof AflParseError &&
    error.diagnostics.some((item) => item.code === "PARSE_OPTIONS_FIELD"));
});

test("inline output format data participates fully in the module digest", () => {
  const source = (description) => parseAfl(`
main():
    entry:
        reviewer = agent @agent.reviewer
        result = reviewer.do 'review', [format: [span: '${description}']]
        ret result
`);
  assert.notEqual(canonicalModuleDigest(source("first")), canonicalModuleDigest(source("second")));
});

test("VM validates formatted candidates against the inline object contract", async () => {
  const backend = {
    name: "format-test",
    capabilities: {
      nativeSession: false,
      checkpoint: false,
      fork: false,
      workspaceContext: true,
      readOnlyWorkspaceContext: true,
      structuredOutput: true,
      interrupt: true,
      dynamicControlTools: false,
      standardTools: false,
      interactiveApproval: false,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: ["afl.message-role/v0"], importRoles: ["*"] },
      validateImport() {},
    },
    async execute(request, host) {
      assert.deepEqual(request.format, {
        kind: "object",
        fields: { type: "Result type", value: "Result payload" },
      });
      const rejected = await host.submitFormattedOutput({
        id: "bad",
        content: '{"type":"finish","extra":true}',
        signal: request.signal,
      });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.code, "AGENT_FORMAT_OBJECT_INVALID");
      const output = '{"type":"finish","value":42}';
      assert.deepEqual(await host.submitFormattedOutput({
        id: "good",
        content: output,
        signal: request.signal,
      }), { status: "accepted" });
      return { output, stopReason: "completed" };
    },
  };
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do 'work', [format: [type: 'Result type', value: 'Result payload']]
        ret result
`, { agentExecutor: backend });

  const result = await vm.run();
  assert.deepEqual(result.output, {
    kind: "frag",
    content: '{"type":"finish","value":42}',
    output: "formatted",
  });
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
        jobs = planner.route "route"
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
  assert.equal(instructions[5].minRoutes, undefined);
  assert.equal(instructions[5].maxRoutes, undefined);
  assert.equal(instructions[5].params.kind, "record");
  const appendText = parseAfl(`
main():
    entry:
        value = prompt "text.append here"
        branch = prompt "ordinary destination"
        ret value
`);
  assert.equal(appendText.nodes[0].blocks[0].instructions[0].op, "prompt");
  assert.equal(appendText.nodes[0].blocks[0].instructions[1].dst, "branch");
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

test("oper constructs list and record compute values", async () => {
  const vm = AflVm.fromSource(`
main(revision):
    entry:
        state = oper [revision: revision, lifecycle: "repair", flags: [true, false]]
        ret state
`, {});

  const result = await vm.run("main", [3]);
  assert.deepEqual(result.output, {
    revision: 3,
    lifecycle: "repair",
    flags: [true, false],
  });
});

test("comma-separated syntax rejects empty items consistently", () => {
  const sources = [
    `main(task,):\n    entry:\n        ret task\n`,
    `main():\n    entry:\n        value = prompt [1,]\n        ret value\n`,
    `worker(task):\n    entry:\n        ret task\nmain(task):\n    entry:\n        value = call worker(task,)\n        ret value\n`,
    `worker(task):\n    entry:\n        ret task\nmain(task):\n    entry:\n        jobs = dispatch [worker(task),]\n        result = sync jobs\n        ret result\n`,
    `main():\n    entry:\n        worker = agent @agent.worker, [workspace: "work/",]\n        ret "done"\n`,
    `main(task):\n    entry:\n        worker = agent @agent.worker\n        result = worker.do task, [role: user,]\n        ret result\n`,
    `main(route):\n    entry:\n        match route, ["known": done,], fallback\n    done:\n        ret "done"\n    fallback:\n        ret "fallback"\n`,
  ];
  for (const source of sources) {
    assert.throws(() => parseAfl(source), (error) => {
      assert.equal(error instanceof AflParseError, true);
      assert.equal(error.diagnostics[0].code, "PARSE_EMPTY_ITEM");
      return true;
    });
  }
});

test("parser rejects the removed v0 surface syntax", () => {
  const instructions = [
    `worker = agent @agent.worker, "work/"`,
    `result = worker.do user, task`,
    `result = call worker, task`,
    `jobs = dispatch 2, worker, task`,
    `memory = memory.copy worker.memory`,
    `branch = memory.apply worker, memory`,
    `branch = fork worker, branch.do task`,
    `jobs = freedom.route worker, task, [:], [worker], [:]`,
  ];
  for (const instruction of instructions) {
    assert.throws(() => parseAfl(`main(task):\n    entry:\n        worker = agent @agent.worker\n        ${instruction}\n        ret task\n`), {
      name: "AflParseError",
    });
  }
  assert.throws(() => parseAfl(`main():\n    entry:\n        worker = agent @agent.worker\n        worker.sysprompt "old"\n        ret "done"\n`), {
    name: "AflParseError",
  });
  assert.throws(() => parseAfl(`main():\n    entry:\n        jump true, done, failed\n    done:\n        ret "done"\n    failed:\n        ret "failed"\n`), {
    name: "AflParseError",
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
    assert.equal(error.diagnostics[0].code, "PARSE_OPCODE");
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
        path_agent = agent @agent.path, [workspace: "worker/"]
        list_agent = agent @agent.list, [workspace: [main_workspace, "docs/"]]
        memory_agent = agent @agent.memory, [memory: memory]
        full_agent = agent @agent.full, [workspace: main_workspace, memory: memory]
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
        worker = agent @agent.worker, [workspace: ["work/"]]
        ret "done"
`));
  assert.equal(singlePathList.ok, false);
  assert.equal(singlePathList.diagnostics.some((item) => item.code === "AGENT_WORKSPACE_INVALID"), true);

  const oldMemoryPosition = validateModule(parseAfl(`
main():
    entry:
        source = agent @agent.source
        memory = source.memory.copy
        reviewer = agent @agent.reviewer, [workspace: memory]
        ret "done"
`));
  assert.equal(oldMemoryPosition.ok, false);
  assert.equal(oldMemoryPosition.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);

  const memoryInsideWorkspaceList = validateModule(parseAfl(`
main():
    entry:
        source = agent @agent.source
        memory = source.memory.copy
        reviewer = agent @agent.reviewer, [workspace: [memory, "docs/"]]
        ret "done"
`));
  assert.equal(memoryInsideWorkspaceList.ok, false);
  assert.equal(memoryInsideWorkspaceList.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);
});

test("Agent tools accept standard profiles and explicit lists", () => {
  const module = parseAfl(`
main():
    entry:
        planner = agent @agent.planner, [tools: "none"]
        reviewer = agent @agent.reviewer, [tools: "readonly"]
        coder = agent @agent.coder, [tools: ["read", "write", "shell"]]
        ret "done"
`);
  const instructions = module.nodes[0].blocks[0].instructions;
  assert.deepEqual(instructions[0].tools, []);
  assert.deepEqual(instructions[1].tools, ["read", "list", "search"]);
  assert.deepEqual(instructions[2].tools, ["read", "write", "shell"]);

  for (const tools of ['"unknown"', '["read", "read"]', '["custom"]', 'tool_name']) {
    assert.throws(
      () => parseAfl(`main():\n    entry:\n        worker = agent @agent.worker, [tools: ${tools}]\n        ret "done"\n`),
      (error) => error instanceof AflParseError && error.diagnostics[0].code === "PARSE_AGENT_TOOLS",
    );
  }
});

test("validator rejects invalid Agent tools in directly constructed IR", () => {
  const module = parseAfl(`
main():
    entry:
        worker = agent @agent.worker
        ret "done"
`);
  const instruction = module.nodes[0].blocks[0].instructions[0];
  const invalid = {
    ...module,
    nodes: [{
      ...module.nodes[0],
      blocks: [{
        ...module.nodes[0].blocks[0],
        instructions: [{ ...instruction, tools: ["read", "read", "custom"] }],
      }],
    }],
  };
  const result = validateModule(invalid);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === "AGENT_TOOL_DUPLICATE"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "AGENT_TOOL_UNKNOWN"), true);
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
        branch true, left, right
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

test("validator checks local call arity and TaskGroup consumption", () => {
  const result = validateModule(parseAfl(`
worker(task):
    entry:
        ret task
main(task):
    entry:
        source = agent @agent.worker
        child = source.fork task
        bad = call worker()
        jobs = dispatch [worker(task)]
        ret bad
`));
  assert.equal(result.ok, false);
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.equal(codes.has("CALL_ARITY"), true);
  assert.equal(codes.has("TASK_GROUP_UNCONSUMED"), true);
});

test("agent.route produces a TaskGroup that must be synced", () => {
  const invalid = validateModule(parseAfl(`
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route"
        ret "done"
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "TASK_GROUP_UNCONSUMED"), true);

  const valid = validateModule(parseAfl(`
main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "route"
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
        copy = source.memory.copy
        first = source.with_memory copy
        second = source.with_memory copy
        third = source.with_memory source.memory
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
        branch choose_left, left, right
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
        branch choose_left, left, right
    left:
        result = sync jobs
        ret result
    right:
        ret task
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "TASK_GROUP_UNCONSUMED"), true);
});

test("match preserves ordered scalar cases and validates every target", () => {
  const module = parseAfl(`
main(route):
    entry:
        match route, ["research": research, "rtl": rtl, 3: numbered], fallback
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
  assert.equal(terminator.op, "match");
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
        match route, ["rtl": rtl], fallback
    rtl:
        ret
    fallback:
        ret
`));
  assert.equal(fragSelector.ok, true);

  const invalid = validateModule(parseAfl(`
main(route):
    entry:
        match route, ["known": missing], fallback
    fallback:
        ret "fallback"
`));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.diagnostics.some((item) => item.code === "JUMP_TARGET_UNKNOWN"), true);

  const nonScalar = validateModule(parseAfl(`
main():
    entry:
        match ["rtl"], ["rtl": rtl], fallback
    rtl:
        ret
    fallback:
        ret
`));
  assert.equal(nonScalar.ok, false);
  assert.equal(nonScalar.diagnostics.some((item) => item.code === "MATCH_SELECTOR_NOT_SCALAR"), true);

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
  assert.equal(directValidation.diagnostics.some((item) => item.code === "MATCH_CASE_DUPLICATE"), true);

  assert.throws(() => parseAfl(`
main(route):
    entry:
        match route, ["same": first, "same": second], fallback
    first:
        ret
    second:
        ret
    fallback:
        ret
`), (error) => {
    assert.equal(error instanceof AflParseError, true);
    assert.equal(error.diagnostics[0].code, "PARSE_MATCH_CASE_DUPLICATE");
    return true;
  });
});
