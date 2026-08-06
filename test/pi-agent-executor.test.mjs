import assert from "node:assert/strict";
import test from "node:test";

import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  AflVm,
  MemoryTraceSink,
  PiAgentExecutorBackend,
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
