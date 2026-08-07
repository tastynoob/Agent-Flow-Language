import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
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
        memory.append source.memory, user, "seed context"
        copied = memory.copy source.memory
        reviewer = agent @agent.worker
        branch = memory.apply reviewer, copied
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
        copied = memory.copy source.memory
        reviewer = agent @agent.reviewer
        branch = memory.apply reviewer, copied
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

test("memory.copy freezes a Pi checkpoint used by memory.apply", async () => {
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
        copied = memory.copy source.memory
        later = source.do "source-later"
        branch = memory.apply source, copied
        branch_result = branch.do "branch"
        ret branch_result
`, { agentExecutor: backend });

  const result = await vm.run();
  assert.equal(result.output.content, "out:branch");
  assert.equal(contexts.get("branch").includes("out:seed"), true);
  assert.equal(contexts.get("branch").includes("source-later"), false);
  assert.equal(contexts.get("source-later").includes("out:seed"), true);
});

test("memory.apply rebuilds Pi context when the source Workspace is incompatible", async (t) => {
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
        first = agent @agent.worker, "first/"
        seed = first.do "seed"
        copied = memory.copy first.memory
        second = agent @agent.worker, "second/"
        branch = memory.apply second, copied
        result = branch.do "branch"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "branch-output");
  assert.equal(faux.state.callCount, 2);
});

test("Pi tool interception blocks a host-denied call without executing the tool", async () => {
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
  let approvals = 0;
  const backend = new PiAgentExecutorBackend({
    models,
    approval: "always",
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
    agentHost: {
      emit() {},
      async requestApproval() {
        approvals += 1;
        return "denied";
      },
      async requestInput() {
        throw new Error("unexpected input request");
      },
    },
  });

  const result = await vm.run();
  assert.equal(result.output.content, "continued-without-tool");
  assert.equal(approvals, 1);
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
        worker = agent @agent.worker, "work/"
        result = worker.do "report the working directory"
        ret result
`, { agentExecutor: backend });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content, "workspace-ok");
  assert.equal(observedWorkingDirectory, await realpath(join(root, "work")));
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
        memory.append worker.memory, tool, "native detail"
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
