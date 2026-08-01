import type { AgentAdapter, AgentInvokeRequest } from "./adapters.js";
import { FlowRuntimeError } from "./errors.js";
import type { JsonValue } from "./ir.js";
import { isJsonValue, isRecord } from "./value.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatOutputParser =
  | "text"
  | "json"
  | ((content: string, response: JsonValue) => JsonValue | Promise<JsonValue>);

export interface ChatOperationBinding {
  model: string;
  messages: (
    input: JsonValue,
    request: AgentInvokeRequest,
  ) => ChatMessage[] | Promise<ChatMessage[]>;
  output?: ChatOutputParser;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, JsonValue>;
}

export interface OpenAICompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string | (() => string);
  operations: Record<string, ChatOperationBinding>;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class OpenAICompatibleAgentAdapter implements AgentAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string | (() => string);
  private readonly operations: Readonly<Record<string, ChatOperationBinding>>;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenAICompatibleAdapterOptions) {
    if (options.baseUrl.trim().length === 0) {
      throw new TypeError("baseUrl must be non-empty");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.operations = options.operations;
    this.headers = options.headers ?? {};
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (this.fetchImplementation === undefined) {
      throw new TypeError("a Fetch API implementation is required");
    }
  }

  async invoke(request: AgentInvokeRequest): Promise<JsonValue> {
    const binding = this.operations[`${request.agent}.${request.operation}`];
    if (binding === undefined) {
      throw new FlowRuntimeError(
        "AGENT_OPERATION_UNBOUND",
        `no chat binding for '${request.agent}.${request.operation}'`,
      );
    }
    const messages = await binding.messages(request.input, request);
    validateMessages(messages);
    const output = binding.output ?? "text";
    const body: Record<string, JsonValue> = {
      ...(binding.extraBody ?? {}),
      model: binding.model,
      messages: messages as unknown as JsonValue,
      stream: false,
      ...(binding.temperature === undefined ? {} : { temperature: binding.temperature }),
      ...(binding.maxTokens === undefined ? {} : { max_tokens: binding.maxTokens }),
      ...(output === "json" ? { response_format: { type: "json_object" } } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...this.headers,
          "content-type": "application/json",
          authorization: `Bearer ${resolveApiKey(this.apiKey)}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw request.signal.reason;
      }
      if (error instanceof FlowRuntimeError) {
        throw error;
      }
      throw new FlowRuntimeError("LLM_TRANSPORT_ERROR", "chat completion request failed", {
        cause: error,
      });
    }

    const responseText = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new FlowRuntimeError("LLM_RESPONSE_NOT_JSON", "chat endpoint returned invalid JSON", {
        details: { status: response.status, body: responseText.slice(0, 4096) },
        cause: error,
      });
    }
    if (!isJsonValue(payload)) {
      throw new FlowRuntimeError("LLM_RESPONSE_NOT_JSON", "chat endpoint returned a non-JSON value");
    }
    if (!response.ok) {
      throw new FlowRuntimeError(
        "LLM_HTTP_ERROR",
        `chat endpoint returned HTTP ${response.status}`,
        { details: { status: response.status, body: payload } },
      );
    }
    const content = readAssistantContent(payload);
    const parsed = await parseOutput(output, content, payload);
    if (!isJsonValue(parsed)) {
      throw new FlowRuntimeError("LLM_OUTPUT_NOT_JSON", "chat output parser returned a non-JSON value");
    }
    return parsed;
  }
}

function validateMessages(messages: ChatMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new FlowRuntimeError("LLM_MESSAGES_INVALID", "chat binding must produce messages");
  }
  for (const message of messages) {
    if (
      !isRecord(message) ||
      !new Set(["system", "user", "assistant"]).has(message.role as string) ||
      typeof message.content !== "string"
    ) {
      throw new FlowRuntimeError(
        "LLM_MESSAGES_INVALID",
        "chat messages require a supported role and string content",
      );
    }
  }
}

function resolveApiKey(apiKey: string | (() => string)): string {
  const resolved = typeof apiKey === "function" ? apiKey() : apiKey;
  if (resolved.length === 0) {
    throw new FlowRuntimeError("LLM_API_KEY_MISSING", "chat adapter API key is empty");
  }
  return resolved;
}

function readAssistantContent(payload: JsonValue): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw invalidResponse();
  }
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw invalidResponse();
  }
  return first.message.content;
}

async function parseOutput(
  parser: ChatOutputParser,
  content: string,
  response: JsonValue,
): Promise<JsonValue> {
  if (parser === "text") {
    return content;
  }
  if (parser === "json") {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isJsonValue(parsed)) {
        throw new TypeError("parsed content is not JSON");
      }
      return parsed;
    } catch (error) {
      throw new FlowRuntimeError("LLM_CONTENT_NOT_JSON", "assistant content is not valid JSON", {
        details: { content: content.slice(0, 4096) },
        cause: error,
      });
    }
  }
  return parser(content, response);
}

function invalidResponse(): FlowRuntimeError {
  return new FlowRuntimeError(
    "LLM_RESPONSE_INVALID",
    "chat response does not contain choices[0].message.content",
  );
}
