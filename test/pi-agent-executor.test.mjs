import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AflVm,
  FileMemoryStateStore,
  FifoAgentApprovalQueue,
  MemoryTraceSink,
  MockAgentAdapter,
  PiAgentExecutorBackend,
  createPiCodingAgentBinding,
} from "../dist/src/index.js";

test("Pi backend completes a model-tool-model loop and reuses the native session", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const contexts = [];
  let toolCalls = 0;
  faux.setResponses([
    (context) => {
      contexts.push(structuredClone(context.messages));
      assert.equal(context.tools.some((tool) => tool.name === "afl_format_output"), false);
      assert.doesNotMatch(context.systemPrompt ?? "", /afl_format_output/u);
      return fauxAssistantMessage(
        fauxToolCall("lookup", { key: "alpha" }, { id: "lookup-1" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      contexts.push(structuredClone(context.messages));
      assert.equal(context.messages.some((message) => message.role === "toolResult"), true);
      return fauxAssistantMessage("first-result");
    },
    (context) => {
      contexts.push(structuredClone(context.messages));
      assert.equal(messageTexts(context.messages).includes("first-result"), true);
      return fauxAssistantMessage("second-result");
    },
  ]);

  const lookup = {
    name: "lookup",
    label: "Lookup",
    description: "Return a value for a key",
    parameters: Type.Object({ key: Type.String() }),
    async execute(_toolCallId, params) {
      toolCalls += 1;
      return {
        content: [{ type: "text", text: `value:${params.key}` }],
        details: undefined,
      };
    },
  };
  const trace = new MemoryTraceSink();
  const backend = new PiAgentExecutorBackend({
    models,
    agents: {
      "@agent.worker": {
        model: { provider: "faux", id: "faux-1" },
        tools: [lookup],
      },
    },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        first = worker.do "inspect"
        second = worker.do "continue"
        ret second
`, { agentExecutor: backend, trace });

  const result = await vm.run();
  assert.equal(result.output.content, "second-result");
  assert.equal(result.output.output, "reasoning");
  assert.equal(toolCalls, 1);
  assert.equal(faux.state.callCount, 3);
  assert.equal(contexts.length, 3);
  assert.equal(
    trace.events.some((event) => event.type === "agent.event" && event.details?.type === "tool.started"),
    true,
  );
  assert.equal(
    trace.events.some((event) => event.type === "agent.event" && event.details?.type === "tool.completed"),
    true,
  );
});

test("Pi Format Output tool validates and replaces activation-scoped candidates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      const output = context.tools.find((tool) => tool.name === "afl_format_output");
      assert.equal(output.description, "Before finishing, submit the result for this step. You may resubmit; the last accepted value is returned.");
      assert.equal(output.description.length < 120, true);
      assert.equal(output.parameters.properties.value.properties.status.description, "Completion state");
      assert.equal(output.parameters.properties.value.properties.count.description, "Number of completed items");
      assert.equal(output.parameters.properties.value.additionalProperties, false);
      assert.doesNotMatch(context.systemPrompt ?? "", /afl_format_output|Completion state|Number of completed items/u);
      return fauxAssistantMessage(
        fauxToolCall("afl_format_output", { value: { status: "draft", count: 1 } }, { id: "output-draft" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /Accepted \(revision 1\)/u);
      return fauxAssistantMessage(
        fauxToolCall("afl_format_output", { value: { status: "finish", count: 3 } }, { id: "output-finish" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /Accepted \(revision 2\)/u);
      return fauxAssistantMessage("Reasoning complete; this text is not the structured result.");
    },
    (context) => {
      assert.equal(context.tools.some((tool) => tool.name === "afl_format_output"), false);
      assert.doesNotMatch(context.systemPrompt ?? "", /afl_format_output/u);
      return fauxAssistantMessage("plain follow-up");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({ model: faux.getModel() }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "produce a result",
            [format: [
                status: "Completion state",
                count: "Number of completed items"
            ]]
        plain = worker.do "continue"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, '{"status":"finish","count":3}');
  assert.equal(result.output.output, "formatted");
  const state = await readMemoryState(root);
  const memory = Object.values(state.memories)[0];
  assert.deepEqual(memory.messages, [
    { role: "user", content: "produce a result" },
    { role: "assistant", content: '{"status":"finish","count":3}' },
    { role: "user", content: "continue" },
    { role: "assistant", content: "plain follow-up" },
  ]);
  assert.match(JSON.stringify(memory.continuation.state.payload), /Reasoning complete/u);
  assert.equal(memory.continuation.memoryRevision, 4);
});

test("Pi enum format accepts only declared values and marks the Frag as formatted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-format-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      const output = context.tools.find((tool) => tool.name === "afl_format_output");
      assert.deepEqual(output.parameters.properties.value.anyOf.map((entry) => entry.const), ["finish", "error"]);
      return fauxAssistantMessage(
        fauxToolCall("afl_format_output", { value: "unknown" }, { id: "invalid-status" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /unknown/u);
      return fauxAssistantMessage(
        fauxToolCall("afl_format_output", { value: "finish" }, { id: "valid-status" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /Accepted \(revision 1\)/u);
      return fauxAssistantMessage("The review is complete.");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({ model: faux.getModel() }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        reviewer = agent @agent.reviewer
        status = reviewer.do "review", [format: ["finish", "error"]]
        ret status
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.deepEqual(result.output, { kind: "frag", content: "finish", output: "formatted" });
});

test("Pi requires an accepted candidate for a formatted do", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-output-required-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("unsubmitted final text")]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({ model: faux.getModel() }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "produce a result", [format: ["finish", "error"]]
        ret result
`, { agentExecutor: backend });

  await assert.rejects(
    vm.run("main", [], { executionRoot: root }),
    { code: "AGENT_FORMAT_OUTPUT_MISSING" },
  );
});

test("Pi scopes AFL control tools to one Freedom activation and restores binding tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-freedom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const contexts = [];
  faux.setResponses([
    (context) => {
      contexts.push({ tools: context.tools.map((tool) => tool.name), messages: context.messages.length });
      assert.deepEqual(context.tools.map((tool) => tool.name), ["lookup", "afl_transaction_request"]);
      assert.equal(lastUserText(context.messages), "seed");
      assert.doesNotMatch(context.systemPrompt ?? "", /AFL Freedom Route activation/u);
      return fauxAssistantMessage("seed-complete");
    },
    (context) => {
      contexts.push({ tools: context.tools.map((tool) => tool.name), messages: context.messages.length });
      assert.deepEqual(context.tools.map((tool) => tool.name), [
        "afl_transaction_request",
        "afl_environment_get",
        "afl_route_add",
      ]);
      assert.match(context.tools[1].description, /Canonical AFL name: afl\.environment\.get/u);
      assert.match(context.tools[1].description, /every active AFL tool includes its own usage instructions/u);
      assert.match(context.tools[2].description, /args are positional/u);
      assert.match(context.tools[2].description, /not a business object/u);
      assert.match(context.tools[2].description, /never the child result/u);
      assert.doesNotMatch(context.systemPrompt ?? "", /AFL Freedom Route activation/u);
      assert.equal(messageTexts(context.messages).includes("seed"), true);
      assert.equal(messageTexts(context.messages).includes("seed-complete"), true);
      return fauxAssistantMessage(
        fauxToolCall("afl_environment_get", {}, { id: "afl-environment" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      contexts.push({ tools: context.tools.map((tool) => tool.name), messages: context.messages.length });
      assert.equal(context.messages.some((message) => message.role === "toolResult"), true);
      assert.deepEqual(context.tools.map((tool) => tool.name), [
        "afl_transaction_request",
        "afl_environment_get",
        "afl_route_add",
      ]);
      assert.match(context.tools[2].description, /Canonical AFL name: afl\.route\.add/u);
      assert.doesNotMatch(context.systemPrompt ?? "", /AFL Freedom Route activation/u);
      assert.equal(messageTexts(context.messages).includes("seed-complete"), true);
      return fauxAssistantMessage("route-complete");
    },
    (context) => {
      contexts.push({ tools: context.tools.map((tool) => tool.name), messages: context.messages.length });
      assert.deepEqual(context.tools.map((tool) => tool.name), ["lookup", "afl_transaction_request"]);
      assert.doesNotMatch(context.systemPrompt ?? "", /AFL Freedom Route activation/u);
      assert.equal(messageTexts(context.messages).includes("seed-complete"), true);
      assert.equal(context.messages.some((message) =>
        message.role === "user" && message.content.some((part) => part.type === "text" && part.text === "route")), true);
      assert.equal(context.messages.some((message) =>
        message.role === "assistant" && message.content.some((part) =>
          part.type === "text" && part.text === "route-complete")), true);
      return fauxAssistantMessage("ordinary-complete");
    },
  ]);
  const lookup = {
    name: "lookup",
    label: "Lookup",
    description: "Ordinary binding tool",
    parameters: Type.Object({ key: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "unused" }], details: undefined };
    },
  };
  const backend = new PiAgentExecutorBackend({
    models,
    agents: {
      "@agent.planner": {
        model: faux.getModel(),
        tools: [lookup],
      },
    },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        planner = agent @agent.planner
        seeded = planner.do "seed"
        jobs = planner.route "route"
        reports = sync jobs
        ordinary = planner.do "ordinary"
        ret ordinary
`, { agentExecutor: backend });
  const result = await vm.run("main", [], { executionRoot: root, runId: "pi-freedom" });
  assert.equal(result.output.content, "ordinary-complete");
  assert.equal(contexts.length, 4);

  const state = await readMemoryState(root);
  const continuation = Object.values(state.memories)[0].continuation.state.payload;
  const serialized = JSON.stringify(continuation);
  assert.doesNotMatch(serialized, /afl\.environment\.get/u);
  assert.match(serialized, /afl_environment_get/u);
  assert.match(serialized, /seed-complete/u);
  assert.match(serialized, /route-complete/u);
  assert.doesNotMatch(serialized, /AFL Freedom Route activation/u);
});

test("Pi session continuation persists tools and thinking and restores replay policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-continuation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const lookup = {
    name: "lookup",
    label: "Lookup",
    description: "Return a value",
    parameters: Type.Object({ key: Type.String() }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: `value:${params.key}` }], details: undefined };
    },
  };
  const source = `
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "turn"
        ret result
`;
  const backend = (thinkingReplay) => new PiAgentExecutorBackend({
    models,
    defaultBinding: {
      model: faux.getModel(),
      tools: [lookup],
      thinkingReplay,
    },
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("inspect with the lookup tool"),
      fauxToolCall("lookup", { key: "alpha" }, { id: "lookup-persisted" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxThinking("the tool result is sufficient"),
      { type: "text", text: "first-output" },
    ]),
  ]);
  await AflVm.fromSource(source, { agentExecutor: backend("include") }).run(
    "main",
    [],
    { runId: "pi-continuation", executionRoot: root },
  );

  const firstState = await readMemoryState(root);
  assert.equal(firstState.version, 0);
  const firstSlot = Object.values(firstState.memories)[0];
  assert.equal(firstSlot.continuation.memoryRevision, 2);
  assert.equal(firstSlot.continuation.state.backend, "pi");
  const serialized = JSON.stringify(firstSlot.continuation.state.payload);
  assert.match(serialized, /"type":"thinking"/u);
  assert.match(serialized, /"type":"tool\.call"/u);
  assert.match(serialized, /"type":"tool\.result"/u);

  faux.appendResponses([(context) => {
    assert.equal(context.messages.some((message) => message.role === "toolResult"), true);
    assert.equal(hasThinking(context.messages, "inspect with the lookup tool"), true);
    return fauxAssistantMessage("second-output");
  }]);
  await AflVm.fromSource(source, { agentExecutor: backend("include") }).run(
    "main",
    [],
    { runId: "pi-continuation", executionRoot: root },
  );

  faux.appendResponses([(context) => {
    assert.equal(context.messages.some((message) => message.role === "toolResult"), true);
    assert.equal(hasThinking(context.messages), false);
    return fauxAssistantMessage("third-output");
  }]);
  const result = await AflVm.fromSource(source, { agentExecutor: backend("exclude") }).run(
    "main",
    [],
    { runId: "pi-continuation", executionRoot: root },
  );
  assert.equal(result.output.content, "third-output");

  const finalState = await readMemoryState(root);
  const finalSlot = Object.values(finalState.memories)[0];
  const finalPayload = finalSlot.continuation.state.payload;
  assert.match(JSON.stringify(finalPayload), /inspect with the lookup tool/u);

  let incompatibleExecutorCalled = false;
  const incompatible = new MockAgentAdapter().on("@agent.worker", () => {
    incompatibleExecutorCalled = true;
    return "unexpected";
  });
  await assert.rejects(
    AflVm.fromSource(source, { agents: incompatible }).run(
      "main",
      [],
      { runId: "pi-continuation", executionRoot: root },
    ),
    { code: "AGENT_SESSION_INVALID" },
  );
  assert.equal(incompatibleExecutorCalled, false);
  assert.equal(Object.values((await readMemoryState(root)).memories)[0].revision, finalSlot.revision);
});

test("Pi persists a canonical-only lazy base as continuation references without duplicating Memory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-canonical-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const source = `
main():
    entry:
        source = agent @agent.worker
        source.memory.append user, "seed context"
        copied = source.memory.copy
        reviewer = agent @agent.worker
        branch = reviewer.with_memory copied
        result = branch.do "review"
        ret result
`;
  const backend = () => new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });

  faux.setResponses([(context) => {
    assert.equal(messageTexts(context.messages).filter((text) => text === "seed context").length, 1);
    return fauxAssistantMessage("first review");
  }]);
  await AflVm.fromSource(source, { agentExecutor: backend() }).run(
    "main",
    [],
    { runId: "canonical-base", executionRoot: root },
  );

  const firstState = await readMemoryState(root);
  const copied = Object.values(firstState.memories).find((memory) => memory.base !== undefined);
  assert.ok(copied);
  assert.deepEqual(copied.messages.map((message) => message.content), ["seed context", "review", "first review"]);
  assert.equal(
    copied.continuation.state.payload.records.some((record) =>
      record.type === "session.append" && record.role === "user"),
    true,
  );
  const copyFile = (await readRawJournals(root)).find((journal) => journal.header.base !== undefined);
  assert.ok(copyFile);
  assert.equal(JSON.stringify(copyFile.records).includes("seed context"), false);

  faux.appendResponses([(context) => {
    assert.equal(messageTexts(context.messages).filter((text) => text === "seed context").length, 1);
    assert.equal(messageTexts(context.messages).includes("first review"), true);
    return fauxAssistantMessage("second review");
  }]);
  const result = await AflVm.fromSource(source, { agentExecutor: backend() }).run(
    "main",
    [],
    { runId: "canonical-base", executionRoot: root },
  );
  assert.equal(result.output.content, "second review");
});

test("a persisted Memory without continuation can switch from a stateless executor to Pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-executor-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "turn"
        ret result
`;
  const stateless = new MockAgentAdapter().on("@agent.worker", () => "stateless output");
  await AflVm.fromSource(source, { agents: stateless }).run(
    "main",
    [],
    { runId: "executor-switch", executionRoot: root },
  );

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([(context) => {
    assert.equal(messageTexts(context.messages).includes("stateless output"), true);
    return fauxAssistantMessage("pi output");
  }]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const result = await AflVm.fromSource(source, { agentExecutor: backend }).run(
    "main",
    [],
    { runId: "executor-switch", executionRoot: root },
  );
  assert.equal(result.output.content, "pi output");

  const state = await readMemoryState(root);
  const memory = Object.values(state.memories)[0];
  assert.equal(memory.continuation.state.backend, "pi");
  assert.equal(memory.continuation.state.format, "pi.session/v0");
});

test("Pi appends thinking and tool calls before agent.do completes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-streaming-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let releaseTool;
  const toolGate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  let markToolEntered;
  const toolEntered = new Promise((resolve) => {
    markToolEntered = resolve;
  });
  t.after(() => releaseTool());
  const lookup = {
    name: "lookup",
    label: "Lookup",
    description: "Pause so the journal can be inspected",
    parameters: Type.Object({}),
    async execute() {
      markToolEntered();
      await toolGate;
      return { content: [{ type: "text", text: "tool-finished" }], details: undefined };
    },
  };
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("persist this before the tool returns"),
      fauxToolCall("lookup", {}, { id: "streamed-tool" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel(), tools: [lookup] },
  });
  const running = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "turn"
        ret result
`, { agentExecutor: backend }).run(
    "main",
    [],
    { runId: "streaming-continuation", executionRoot: root },
  );

  await toolEntered;
  const during = await readRawJournals(root);
  assert.equal(during.length, 1);
  const streamed = during[0].records.filter((record) => record.type === "assistant");
  assert.equal(streamed.length > 0, true);
  assert.match(JSON.stringify(streamed), /persist this before the tool returns/u);
  assert.match(JSON.stringify(streamed), /streamed-tool/u);
  assert.equal(during[0].records.some((record) => record.type === "do.end"), false);

  releaseTool();
  const result = await running;
  assert.equal(result.output.content, "finished");
  const after = await readRawJournals(root);
  assert.equal(after[0].records.some((record) => record.type === "tool.result"), true);
  assert.equal(after[0].records.some((record) => record.type === "do.end" && record.status === "ok"), true);
});

test("memory.copy can restore a complete Pi continuation under another Agent binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-copy-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const lookup = {
    name: "lookup",
    label: "Lookup",
    description: "Return a value",
    parameters: Type.Object({ key: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "copied-tool-result" }], details: undefined };
    },
  };
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("source-only thinking"),
      fauxToolCall("lookup", { key: "seed" }, { id: "copy-tool" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("seed-output"),
    (context) => {
      assert.equal(context.messages.some((message) => message.role === "toolResult"), true);
      assert.equal(hasThinking(context.messages), false);
      return fauxAssistantMessage("review-output");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    agents: {
      "@agent.source": { model: faux.getModel(), tools: [lookup] },
      "@agent.reviewer": { model: faux.getModel(), tools: [lookup], thinkingReplay: "exclude" },
    },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        source = agent @agent.source
        seed = source.do "seed"
        copied = source.memory.copy
        reviewer = agent @agent.reviewer
        branch = reviewer.with_memory copied
        result = branch.do "review"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { runId: "copy-journal", executionRoot: root });
  assert.equal(result.output.content, "review-output");
  const journals = await readRawJournals(root);
  const copy = journals.find((journal) => journal.header.base !== undefined);
  assert.ok(copy);
  assert.doesNotMatch(JSON.stringify(copy), /source-only thinking/u);
});

test("memory.copy freezes a Pi checkpoint used by agent.with_memory", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const contexts = new Map();
  faux.setResponses(Array.from({ length: 3 }, () => (context) => {
    const input = lastUserText(context.messages);
    contexts.set(input, messageTexts(context.messages));
    return fauxAssistantMessage(`out:${input}`);
  }));
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        source = agent @agent.worker
        seed = source.do "seed"
        copied = source.memory.copy
        later = source.do "source-later"
        branch = source.with_memory copied
        branch_result = branch.do "branch"
        ret branch_result
`, { agentExecutor: backend });

  const result = await vm.run();
  assert.equal(result.output.content, "out:branch");
  assert.equal(contexts.get("branch").includes("out:seed"), true);
  assert.equal(contexts.get("branch").includes("source-later"), false);
  assert.equal(contexts.get("source-later").includes("out:seed"), true);
});

test("agent.with_memory rebuilds Pi context when the source Workspace is incompatible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-checkpoint-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("seed-output"),
    (context) => {
      assert.equal(messageTexts(context.messages).includes("seed-output"), true);
      return fauxAssistantMessage("branch-output");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        first = agent @agent.worker, [workspace: "first/"]
        seed = first.do "seed"
        copied = first.memory.copy
        second = agent @agent.worker, [workspace: "second/"]
        branch = second.with_memory copied
        result = branch.do "branch"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "branch-output");
  assert.equal(faux.state.callCount, 2);
});

test("Pi transaction tool pauses for queued user work and then resumes the Agent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let installed = false;
  let presented;
  faux.setResponses([
    (context) => {
      const tool = context.tools.find((candidate) => candidate.name === "afl_transaction_request");
      assert.notEqual(tool, undefined);
      assert.match(tool.description, /does not grant permissions/u);
      return fauxAssistantMessage(fauxToolCall("afl_transaction_request", {
        title: "Install qsort compiler",
        request: "Install gcc in the execution environment",
        reason: "The compiler command is unavailable",
        resume_when: "gcc --version exits successfully",
      }, { id: "transaction-1" }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.equal(installed, true);
      assert.match(messageTexts(context.messages).join("\n"), /marked the requested action as completed/u);
      return fauxAssistantMessage("verified-and-continued");
    },
  ]);
  const queue = new FifoAgentApprovalQueue({
    presenter: {
      async present(request) {
        presented = request;
        installed = true;
        return "approved";
      },
    },
  });
  t.after(() => queue.close());
  const trace = new MemoryTraceSink();
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "compile the program"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      approvalQueue: queue,
    },
    trace,
  });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "verified-and-continued");
  assert.equal(presented.kind, "transaction");
  assert.equal(presented.subject.toolName, "afl.transaction.request");
  assert.equal(presented.subject.display.title, "Install qsort compiler");
  assert.equal(presented.subject.display.details.resumeWhen, "gcc --version exits successfully");
  const states = trace.events
    .filter((event) => event.type === "agent.event" && event.details?.type === "transaction.state")
    .map((event) => event.details.state);
  assert.deepEqual(states, ["queued", "presenting", "completed"]);
});

test("Pi transaction tool returns an unavailable fallback when no human queue exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-transaction-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("afl_transaction_request", {
      title: "Install compiler",
      request: "Install gcc",
      reason: "gcc is missing",
    }, { id: "transaction-unavailable" }), { stopReason: "toolUse" }),
    (context) => {
      assert.match(
        messageTexts(context.messages).join("\n"),
        /transaction request could not be presented \[AGENT_APPROVAL_UNAVAILABLE\]/u,
      );
      return fauxAssistantMessage("reported-blocker");
    },
  ]);
  const trace = new MemoryTraceSink();
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "compile"
        ret result
`, { agentExecutor: backend, trace });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "reported-blocker");
  assert.equal(trace.events.some((event) =>
    event.type === "agent.event" && event.details?.type === "transaction.state" &&
    event.details.state === "unavailable"), true);
});

test("Pi soft policy block returns to the model without opening the approval queue", async (t) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("dangerous", { command: "change" }, { id: "dangerous-1" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(result.isError, true);
      return fauxAssistantMessage("continued-without-tool");
    },
  ]);
  let executions = 0;
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: {
      model: faux.getModel(),
      tools: [{
        name: "dangerous",
        label: "Dangerous",
        description: "A guarded tool",
        parameters: Type.Object({ command: Type.String() }),
        async execute() {
          executions += 1;
          return { content: [{ type: "text", text: "executed" }], details: undefined };
        },
      }],
    },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "work"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: { policies: [{
        name: "soft-block",
        evaluate: () => ({ verdict: "block", code: "TRY_SAFER", reason: "try another method" }),
      }] },
    },
    agentHost: {
      emit() {},
      async requestInput() {
        throw new Error("unexpected input request");
      },
    },
  });

  const result = await vm.run();
  assert.equal(result.output.content, "continued-without-tool");
  assert.equal(executions, 0);
});

test("Pi policy receives prepared and schema-validated tool arguments", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("prepared", { legacy: "normalized" }, { id: "prepared-1" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("continued"),
  ]);
  let executions = 0;
  let captured;
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: {
      model: faux.getModel(),
      tools: [{
        name: "prepared",
        label: "Prepared",
        description: "Normalize a legacy argument",
        parameters: Type.Object({ command: Type.String() }),
        prepareArguments(input) {
          return { command: input.legacy };
        },
        async execute() {
          executions += 1;
          return { content: [{ type: "text", text: "executed" }], details: undefined };
        },
      }],
    },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "work"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: {
        policies: [{
          name: "capture",
          evaluate(action) {
            captured = action;
            return { verdict: "deny", code: "TEST_BLOCK", reason: "blocked after prepare" };
          },
        }],
      },
    },
  });

  const result = await vm.run();
  assert.equal(result.output.content, "continued");
  assert.deepEqual(captured.effectiveInput, { command: "normalized" });
  assert.equal(Object.isFrozen(captured.effectiveInput), true);
  assert.equal(executions, 0);
});

test("AbortSignal interrupts an active Pi harness run", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("x".repeat(200))]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "slow"
        ret result
`, { agentExecutor: backend });
  const controller = new AbortController();
  const running = vm.run("main", [], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(running, { code: "AGENT_CANCELLED" });
});

test("Pi coding tools are created for each Agent primary Workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let observedWorkingDirectory;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "pwd" }, { id: "pwd-1" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      observedWorkingDirectory = result.content.map((block) => block.text ?? "").join("").trim();
      return fauxAssistantMessage("workspace-ok");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({ model: faux.getModel() }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: "work/"]
        result = worker.do "report the working directory"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "workspace-ok");
  assert.equal(observedWorkingDirectory, await realpath(join(root, "work")));
});

test("Pi activates only the AFL standard tools selected by each Agent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-tool-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen = [];
  faux.setResponses([
    (context) => {
      seen.push(context.tools.map((tool) => tool.name));
      return fauxAssistantMessage("reviewed");
    },
    (context) => {
      seen.push(context.tools.map((tool) => tool.name));
      return fauxAssistantMessage("planned");
    },
    (context) => {
      seen.push(context.tools.map((tool) => tool.name));
      return fauxAssistantMessage("coded");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({ model: faux.getModel() }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        reviewer = agent @agent.reviewer, [tools: "readonly"]
        reviewed = reviewer.do "review"
        planner = agent @agent.planner, [tools: "none"]
        planned = planner.do reviewed
        coder = agent @agent.coder, [tools: ["read", "write", "shell"]]
        coded = coder.do planned
        ret coded
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "coded");
  assert.deepEqual(seen.map((tools) => tools.toSorted()), [
    ["read", "list", "search", "afl_transaction_request"].toSorted(),
    ["afl_transaction_request"].toSorted(),
    ["read", "bash", "write", "afl_transaction_request"].toSorted(),
  ]);
});

test("Pi standard search tool finds literal text without shell access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "work"), { recursive: true });
  await writeFile(join(root, "work", "notes.txt"), "alpha\nneedle here\nomega\n", "utf8");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      assert.equal(context.tools.some((tool) => tool.name === "bash"), false);
      return fauxAssistantMessage(
        fauxToolCall("search", { query: "needle", path: "." }, { id: "search-1" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.match(result.content.map((block) => block.text ?? "").join(""), /notes\.txt:2:needle here/u);
      return fauxAssistantMessage("found");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({ model: faux.getModel() }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        reviewer = agent @agent.reviewer, [workspace: "work/", tools: ["search"]]
        result = reviewer.do "find needle"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "found");
});

test("Pi coding binding applies a default timeout to bash commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-bash-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1" }, { id: "timed-bash" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /timed out after 0\.05 seconds/iu);
      return fauxAssistantMessage("timeout-observed");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({
      model: faux.getModel(),
      bashTimeoutSeconds: 0.05,
    }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: "work/"]
        result = worker.do "run bounded command"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "timeout-observed");
});

test("Pi coding binding executes write and GCC tools inside bubblewrap", async (t) => {
  try {
    await access("/usr/bin/bwrap");
  } catch {
    return t.skip("bubblewrap is unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "afl-pi-bwrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const source = [
    "#include <stdio.h>",
    "int main(void) { puts(\"sandbox-ok\"); return 0; }",
    "",
  ].join("\n");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "main.c", content: source }, { id: "sandbox-write" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("bash", {
      command: "gcc -std=c11 -Wall -Wextra -Werror main.c -o main && ./main",
    }, { id: "sandbox-bash" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("sandbox-complete"),
  ]);
  const actions = [];
  const binding = createPiCodingAgentBinding({
    model: faux.getModel(),
    sandbox: { backend: "bubblewrap", network: "host" },
  });
  const backend = new PiAgentExecutorBackend({ models, defaultBinding: binding });
  assert.equal(backend.capabilities.sandboxEnforcement, true);
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: "work/"]
        result = worker.do "compile inside the sandbox"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: {
        requireCoverage: true,
        policies: [{
          name: "capture-sandbox",
          evaluate(action) {
            actions.push(action);
            return { verdict: "allow" };
          },
        }],
      },
    },
  });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "sandbox-complete");
  assert.equal(await readFile(join(root, "work", "main.c"), "utf8"), source);
  assert.deepEqual(actions.map((action) => [
    action.toolName,
    action.executionBoundary,
    action.display.details.workspace,
  ]), [
    ["write", "sandbox", "/workspace"],
    ["bash", "sandbox", "/workspace"],
  ]);
  assert.equal(actions[0].input.path, "main.c");
  assert.equal(actions[0].effectiveInput.path, "/workspace/main.c");
  assert.deepEqual(actions[1].effectiveInput, {
    command: "gcc -std=c11 -Wall -Wextra -Werror main.c -o main && ./main",
    timeout: 300,
    cwd: "/workspace",
    env: {},
    inheritEnv: true,
  });
});

test("Pi sandbox can expose read-only listing without exposing elevation", async (t) => {
  try {
    await access("/usr/bin/bwrap");
  } catch {
    return t.skip("bubblewrap is unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "afl-pi-readonly-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contextRoot = join(root, "context");
  await mkdir(contextRoot);
  await writeFile(join(contextRoot, "brief.txt"), "bounded context\n", "utf8");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      assert.deepEqual(context.tools.map((tool) => tool.name), [
        "read",
        "list",
        "write",
        "afl_transaction_request",
      ]);
      assert.doesNotMatch(context.systemPrompt ?? "", /afl_elevated_tool/u);
      assert.equal((context.systemPrompt ?? "").includes(`${contextRoot} -> /readonly/0`), true);
      return fauxAssistantMessage(fauxToolCall("list", { path: "/readonly/0" }, { id: "readonly-list" }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /brief\.txt/u);
      return fauxAssistantMessage("listed");
    },
  ]);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({
      model: faux.getModel(),
      activeToolNames: ["read", "list", "write"],
      elevation: false,
      sandbox: { backend: "bubblewrap", network: "host" },
    }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: ["work/", "context/"]]
        result = worker.do "list context"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "listed");
});

test("Pi elevated tool retries a sandbox-blocked operation on the host after mandatory approval", async (t) => {
  try {
    await access("/usr/bin/bwrap");
  } catch {
    return t.skip("bubblewrap is unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "afl-pi-elevation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretPath = join(root, "host-only.txt");
  const command = `cat ${secretPath}`;
  await writeFile(secretPath, "host-elevation-ok\n", "utf8");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command }, { id: "sandbox-attempt" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /Command exited with code 1/u);
      return fauxAssistantMessage(fauxToolCall("afl_elevated_tool", {
        tool: "bash",
        arguments: { command },
        reason: "The safe read is blocked because the host path is outside bubblewrap mounts",
      }, { id: "elevated-attempt" }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /host-elevation-ok/u);
      return fauxAssistantMessage("elevation-complete");
    },
  ]);

  const actions = [];
  const approvals = [];
  const queue = new FifoAgentApprovalQueue({
    presenter: {
      async present(request) {
        approvals.push(request);
        return "approved";
      },
    },
  });
  t.after(() => queue.close());
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({
      model: faux.getModel(),
      sandbox: { backend: "bubblewrap", network: "host" },
    }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: "work/"]
        result = worker.do "read a host-only file after the sandbox blocks it"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: {
        requireCoverage: true,
        policies: [{
          name: "capture-elevation",
          evaluate(action) {
            actions.push(action);
            return { verdict: "allow" };
          },
        }],
      },
      approvalQueue: queue,
    },
  });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "elevation-complete");
  assert.deepEqual(actions.map((action) => [action.toolName, action.executionBoundary]), [
    ["bash", "sandbox"],
    ["bash", "host"],
  ]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, "tool-elevation");
  assert.equal(approvals[0].subject.toolName, "bash");
  assert.equal(approvals[0].subject.executionBoundary, "host");
  assert.match(approvals[0].reasons[0].reason, /outside bubblewrap mounts/u);
});

test("Pi soft policy block reaches approval only after the model actively requests elevation", async (t) => {
  try {
    await access("/usr/bin/bwrap");
  } catch {
    return t.skip("bubblewrap is unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "afl-pi-policy-elevation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = "printf policy-elevation-ok";
  const approvals = [];
  const actions = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command }, { id: "policy-blocked" }), {
      stopReason: "toolUse",
    }),
    (context) => {
      assert.equal(approvals.length, 0);
      assert.match(messageTexts(context.messages).join("\n"), /Try a safer alternative first/u);
      return fauxAssistantMessage(fauxToolCall("afl_elevated_tool", {
        tool: "bash",
        arguments: { command },
        reason: "The available safer alternative would require a disproportionate rewrite",
      }, { id: "policy-elevation" }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(messageTexts(context.messages).join("\n"), /policy-elevation-ok/u);
      return fauxAssistantMessage("policy-elevation-complete");
    },
  ]);
  const queue = new FifoAgentApprovalQueue({
    presenter: {
      async present(request) {
        approvals.push(request);
        return "approved";
      },
    },
  });
  t.after(() => queue.close());
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({
      model: faux.getModel(),
      sandbox: { backend: "bubblewrap", network: "host" },
    }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: "work/"]
        result = worker.do "retry a soft-blocked command only if alternatives are too costly"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: {
        requireCoverage: true,
        policies: [{
          name: "review-command",
          evaluate(action) {
            actions.push(action);
            return action.toolName === "bash" && action.input.command === command
              ? { verdict: "block", code: "COMMAND_REVIEW", reason: "Prefer a safer alternative" }
              : { verdict: "allow" };
          },
        }],
      },
      approvalQueue: queue,
    },
  });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "policy-elevation-complete");
  assert.deepEqual(actions.map((action) => [action.toolName, action.executionBoundary]), [
    ["bash", "sandbox"],
    ["bash", "sandbox"],
  ]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, "tool-elevation");
  assert.equal(approvals[0].subject.executionBoundary, "sandbox");
  assert.deepEqual(approvals[0].reasons.map((reason) => reason.policy), [
    "review-command",
    "agent-elevation",
  ]);
});

test("Pi elevated tool rejects direct elevation without a matching sandbox failure", async (t) => {
  try {
    await access("/usr/bin/bwrap");
  } catch {
    return t.skip("bubblewrap is unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "afl-pi-direct-elevation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("afl_elevated_tool", {
      tool: "bash",
      arguments: { command: "pwd" },
      reason: "Skip the sandbox",
    }, { id: "direct-elevation" }), { stopReason: "toolUse" }),
    (context) => {
      assert.match(
        messageTexts(context.messages).join("\n"),
        /must retry the same arguments from a soft policy block or failed sandbox execution/u,
      );
      return fauxAssistantMessage("direct-elevation-blocked");
    },
  ]);
  let approvals = 0;
  const queue = new FifoAgentApprovalQueue({
    presenter: {
      async present() {
        approvals += 1;
        return "approved";
      },
    },
  });
  t.after(() => queue.close());
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: createPiCodingAgentBinding({
      model: faux.getModel(),
      sandbox: { backend: "bubblewrap", network: "host" },
    }),
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [workspace: "work/"]
        result = worker.do "try to elevate directly"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: { policies: [{ name: "allow", evaluate: () => ({ verdict: "allow" }) }] },
      approvalQueue: queue,
    },
  });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "direct-elevation-blocked");
  assert.equal(approvals, 0);
});

test("Pi Memory facet rejects unsupported AFL roles before model execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-pi-memory-role-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = new PiAgentExecutorBackend({
    models,
    defaultBinding: { model: faux.getModel() },
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        worker.memory.append tool, "native detail"
        result = worker.do "continue"
        ret result
`, { agentExecutor: backend });

  await assert.rejects(
    vm.run("main", [], { executionRoot: root }),
    { code: "AGENT_MEMORY_ROLE_UNSUPPORTED" },
  );
  assert.equal(faux.state.callCount, 0);
});

function lastUserText(messages) {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return textContent(message.content);
}

function messageTexts(messages) {
  return messages.flatMap((message) => {
    if (message.role === "toolResult") return message.content.map((block) => block.text ?? "");
    return [textContent(message.content)];
  });
}

function textContent(content) {
  if (typeof content === "string") return content;
  return content.map((block) => block.text ?? "").join("");
}

function hasThinking(messages, text) {
  return messages.some((message) => message.role === "assistant" &&
    message.content.some((block) => block.type === "thinking" &&
      (text === undefined || block.thinking === text)));
}

async function readMemoryState(root) {
  const directory = join(root, ".afl", "memory");
  const [runDirectory] = await readdir(directory);
  const [program] = parsePrettyJsonStream(
    await readFile(join(directory, runDirectory, "program.jsons"), "utf8"),
  );
  return FileMemoryStateStore.create(directory).loadRun(
    program.run_id,
    new AbortController().signal,
  );
}

async function readRawJournals(root) {
  const directory = join(root, ".afl", "memory");
  const [runDirectory] = await readdir(directory);
  const runPath = join(directory, runDirectory);
  const filenames = (await readdir(runPath)).filter((name) => name !== "program.jsons");
  return Promise.all(filenames.map(async (filename) => {
    const values = parsePrettyJsonStream(await readFile(join(runPath, filename), "utf8"));
    return { filename, header: values[0], records: values.slice(1) };
  }));
}

function parsePrettyJsonStream(text) {
  return text.trim().split(/\n\s*\n(?=\{)/u).map((value) => JSON.parse(value));
}
