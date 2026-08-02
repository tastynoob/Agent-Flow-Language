import type { AgentAdapter, AgentRunRequest, AgentRunResult, Message } from "./adapters.js";
import { FlowRuntimeError } from "./errors.js";

export interface OpenAICompatibleAgentBinding {
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonOutput?: boolean;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface OpenAICompatibleAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey: string | (() => string);
  readonly agents: Readonly<Record<string, OpenAICompatibleAgentBinding>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

export class OpenAICompatibleAgentAdapter implements AgentAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string | (() => string);
  private readonly agents: Readonly<Record<string, OpenAICompatibleAgentBinding>>;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenAICompatibleAdapterOptions) {
    if (options.baseUrl.trim().length === 0) throw new TypeError("baseUrl must be non-empty");
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.agents = options.agents;
    this.headers = options.headers ?? {};
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (this.fetchImplementation === undefined) throw new TypeError("a Fetch API implementation is required");
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const binding = this.agents[request.agent.name];
    if (binding === undefined) {
      throw new FlowRuntimeError(
        "AGENT_SYMBOL_UNBOUND",
        `no OpenAI-compatible binding for '${request.agent.name}'`,
      );
    }
    const messages = requestMessages(request);
    const apiKey = resolveApiKey(this.apiKey);
    const body = {
      ...(binding.extraBody ?? {}),
      model: binding.model,
      messages,
      stream: false,
      ...(binding.temperature === undefined ? {} : { temperature: binding.temperature }),
      ...(binding.maxTokens === undefined ? {} : { max_tokens: binding.maxTokens }),
      ...(binding.jsonOutput === true ? { response_format: { type: "json_object" } } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...this.headers,
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      throw new FlowRuntimeError("LLM_TRANSPORT_ERROR", "chat completion request failed", { cause: error });
    }

    const raw = await response.text();
    const redacted = redact(raw, apiKey);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new FlowRuntimeError("LLM_RESPONSE_NOT_JSON", "chat endpoint returned invalid JSON", {
        details: { status: response.status, body: redacted.slice(0, 4096) },
        cause: error,
      });
    }
    if (!response.ok) {
      throw new FlowRuntimeError("LLM_HTTP_ERROR", `chat endpoint returned HTTP ${response.status}`, {
        details: { status: response.status, body: safeResponseDetail(payload, apiKey) },
      });
    }
    return { output: readAssistantContent(payload) };
  }
}

function requestMessages(request: AgentRunRequest): Message[] {
  const result: Message[] = [];
  if (request.systemPrompt !== undefined) result.push({ role: "system", content: request.systemPrompt });
  for (const message of request.messages) {
    if (!new Set(["system", "user", "assistant", "tool"]).has(message.role)) {
      throw new FlowRuntimeError(
        "LLM_MESSAGE_ROLE_UNSUPPORTED",
        `OpenAI-compatible chat does not support role '${message.role}'`,
      );
    }
    result.push({ role: message.role, content: message.content });
  }
  if (result.length === 0) {
    throw new FlowRuntimeError("LLM_MESSAGES_INVALID", "chat completion requires at least one Message");
  }
  return result;
}

function resolveApiKey(apiKey: string | (() => string)): string {
  const resolved = typeof apiKey === "function" ? apiKey() : apiKey;
  if (resolved.length === 0) {
    throw new FlowRuntimeError("LLM_API_KEY_MISSING", "chat adapter API key is empty");
  }
  return resolved;
}

function readAssistantContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) throw invalidResponse();
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw invalidResponse();
  }
  return first.message.content;
}

function safeResponseDetail(value: unknown, secret: string): string {
  try {
    return redact(JSON.stringify(value), secret).slice(0, 4096);
  } catch {
    return "[unserializable response]";
  }
}

function redact(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join("[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): FlowRuntimeError {
  return new FlowRuntimeError(
    "LLM_RESPONSE_INVALID",
    "chat response does not contain choices[0].message.content",
  );
}
