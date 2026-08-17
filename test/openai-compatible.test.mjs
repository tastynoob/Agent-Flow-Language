import assert from "node:assert/strict";
import test from "node:test";

import {
  AflVmError,
  OpenAICompatibleAgentAdapter,
  symbol,
} from "../dist/src/index.js";

test("OpenAI-compatible adapter maps Agent Memory to chat completion", async () => {
  let captured;
  const adapter = new OpenAICompatibleAgentAdapter({
    baseUrl: "https://provider.example/v1/",
    apiKey: "secret",
    agents: {
      "@agent.coder": {
        model: "model-x",
        temperature: 0.2,
        maxTokens: 123,
        jsonOutput: true,
      },
    },
    fetch: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "result" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const controller = new AbortController();
  const result = await adapter.run({
    runId: "run",
    node: "main",
    block: "entry",
    agent: symbol("@agent.coder"),
    systemPrompt: "system",
    messages: [{ role: "user", content: "task" }],
    signal: controller.signal,
  });

  assert.deepEqual(result, { output: "result" });
  assert.equal(captured.url, "https://provider.example/v1/chat/completions");
  assert.equal(captured.init.headers.authorization, "Bearer secret");
  assert.deepEqual(captured.body.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
  ]);
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.equal(captured.body.model, "model-x");
  assert.equal(captured.body.max_tokens, 123);
});

test("OpenAI-compatible adapter redacts API keys from provider errors", async () => {
  const secret = "do-not-leak";
  const adapter = new OpenAICompatibleAgentAdapter({
    baseUrl: "https://provider.example/v1",
    apiKey: secret,
    agents: { "@agent.coder": { model: "model-x" } },
    fetch: async () => new Response(
      JSON.stringify({ error: `provider reflected ${secret}` }),
      { status: 401 },
    ),
  });

  await assert.rejects(
    adapter.run(request()),
    (error) => {
      assert.equal(error instanceof AflVmError, true);
      assert.equal(error.code, "LLM_HTTP_ERROR");
      assert.equal(JSON.stringify(error.serialize()).includes(secret), false);
      assert.equal(JSON.stringify(error.serialize()).includes("[REDACTED]"), true);
      return true;
    },
  );
});

test("OpenAI-compatible adapter propagates AbortSignal cancellation", async () => {
  const adapter = new OpenAICompatibleAgentAdapter({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    agents: { "@agent.coder": { model: "model-x" } },
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = adapter.run({ ...request(), signal: controller.signal });
  controller.abort(new AflVmError("TEST_ABORT", "stop"));
  await assert.rejects(pending, { code: "TEST_ABORT" });
});

function request() {
  return {
    runId: "run",
    node: "main",
    block: "entry",
    agent: symbol("@agent.coder"),
    messages: [{ role: "user", content: "task" }],
    signal: new AbortController().signal,
  };
}
