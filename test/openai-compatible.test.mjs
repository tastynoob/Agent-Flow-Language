import assert from "node:assert/strict";
import test from "node:test";

import {
  AflRuntime,
  OpenAICompatibleAgentAdapter,
} from "../dist/src/index.js";
import { e, n, oneFlowProgram, s } from "./helpers.mjs";

function chatProgram(outputSchema) {
  return oneFlowProgram(
    {
      input: s.string(),
      output: outputSchema,
      body: n.sequence("root", [
        n.invoke("generate", "writer", "generate", e.input(), {
          scope: "local",
          name: "result",
        }),
        n.return("return", e.local("result")),
      ]),
      locals: { result: { schema: outputSchema } },
    },
    {
      writer: {
        operations: {
          generate: { input: s.string(), output: outputSchema },
        },
      },
    },
  );
}

test("OpenAI-compatible adapter maps an Agent operation to JSON chat completion", async () => {
  const requests = [];
  const adapter = new OpenAICompatibleAgentAdapter({
    baseUrl: "https://llm.example.test/v1/",
    apiKey: () => "runtime-secret",
    operations: {
      "writer.generate": {
        model: "test-model",
        messages: (input) => [
          { role: "system", content: "Return JSON." },
          { role: "user", content: String(input) },
        ],
        output: "json",
        maxTokens: 128,
      },
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          id: "completion-1",
          choices: [{ message: { role: "assistant", content: '{"text":"done"}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const outputSchema = s.object(
    { text: s.string() },
    { required: ["text"], additionalProperties: false },
  );
  const runtime = new AflRuntime(chatProgram(outputSchema), { agents: adapter });

  const result = await runtime.run("write it");

  assert.deepEqual(result.output, { text: "done" });
  assert.equal(requests[0].url, "https://llm.example.test/v1/chat/completions");
  assert.equal(requests[0].init.headers.authorization, "Bearer runtime-secret");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[1].content, "write it");
});

test("OpenAI-compatible adapter normalizes HTTP errors without exposing credentials", async () => {
  const adapter = new OpenAICompatibleAgentAdapter({
    baseUrl: "https://llm.example.test",
    apiKey: "do-not-leak",
    operations: {
      "writer.generate": {
        model: "test-model",
        messages: () => [{ role: "user", content: "hello" }],
      },
    },
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
  });
  const runtime = new AflRuntime(chatProgram(s.string()), { agents: adapter });

  await assert.rejects(runtime.run("hello"), (error) => {
    assert.equal(error.code, "LLM_HTTP_ERROR");
    assert.equal(error.details.status, 429);
    assert.equal(JSON.stringify(error).includes("do-not-leak"), false);
    return true;
  });
});

test("OpenAI-compatible adapter preserves configuration errors", async () => {
  const adapter = new OpenAICompatibleAgentAdapter({
    baseUrl: "https://llm.example.test",
    apiKey: "",
    operations: {
      "writer.generate": {
        model: "test-model",
        messages: () => [{ role: "user", content: "hello" }],
      },
    },
    fetch: async () => {
      throw new Error("fetch must not run");
    },
  });
  const runtime = new AflRuntime(chatProgram(s.string()), { agents: adapter });

  await assert.rejects(runtime.run("hello"), (error) => {
    assert.equal(error.code, "LLM_API_KEY_MISSING");
    return true;
  });
});
