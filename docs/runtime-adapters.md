# Runtime adapters

AFL IR 只声明逻辑 Agent operation。provider、model、API key、prompt rendering、skill、MCP 和 tool 都在部署时通过 adapter 绑定，不进入 portable `.aflir`。

## OpenAI-compatible chat adapter

`OpenAICompatibleAgentAdapter` 将 `(agent, operation)` 映射为 chat completion。它支持文本和 JSON output，并使用 runtime 的 `AbortSignal` 传播 timeout/cancellation。

```ts
import { OpenAICompatibleAgentAdapter } from "@afl-lang/core";

const agents = new OpenAICompatibleAgentAdapter({
  baseUrl: process.env.AFL_CHAT_BASE_URL!,
  apiKey: () => process.env.AFL_CHAT_API_KEY!,
  operations: {
    "reviewer.review": {
      model: process.env.AFL_CHAT_MODEL!,
      messages: (input) => [
        { role: "system", content: "Return the review as JSON." },
        { role: "user", content: JSON.stringify(input) },
      ],
      output: "json",
    },
  },
});
```

adapter 遵循 OpenAI-compatible 的非流式 `POST /chat/completions` 形状。DeepSeek 的官方 [Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion) 使用该路径；其 [JSON Output 指南](https://api-docs.deepseek.com/guides/json_mode/) 要求请求设置 `response_format: {"type": "json_object"}`，adapter 在 `output: "json"` 时自动设置。

## 安全边界

- 不要把 key 写入 IR、prompt package、trace 或 adapter 示例；
- key 由环境变量或 secret manager 在 runtime 启动时提供；
- `RuntimePolicy.authorizeAgent` 在 HTTP 请求前执行 capability/permission 检查；
- adapter 只返回 JSON，runtime 随后按 Agent operation output schema 再验证；
- live API 测试必须显式启用，默认测试使用注入的 mock Fetch API。
