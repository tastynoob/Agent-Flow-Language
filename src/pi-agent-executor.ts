import {
  AgentHarness,
  InMemorySessionRepo,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessEvent,
  type AgentHarnessResources,
  type AgentHarnessStreamOptions,
  type AgentHarnessTool,
  type AgentHarnessToolContextSource,
  type ExecutionToolContext,
  type PromptTemplate,
  type Session,
  type Skill,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  contentText,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentExecutionEvent,
  AgentExecutionHost,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutorBackend,
  AgentExecutorCapabilities,
  BackendSessionRef,
} from "./agent-executor.js";
import { AgentExecutorError } from "./agent-executor.js";
import type { Message } from "./adapters.js";

export interface PiModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface PiAgentBinding<TContext extends object | undefined = undefined> {
  readonly model: Model<Api> | PiModelRef;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentHarnessTool<TContext>[];
  readonly toolContext?: AgentHarnessToolContextSource<TContext>;
  readonly activeToolNames?: readonly string[];
  readonly thinkingLevel?: ThinkingLevel;
  readonly streamOptions?: AgentHarnessStreamOptions;
  readonly resources?: AgentHarnessResources;
}

export interface PiAgentExecutorOptions {
  readonly models?: Models;
  readonly agents?: Readonly<Record<string, PiAgentBinding<any>>>;
  readonly defaultBinding?: PiAgentBinding<any>;
  readonly approval?: "never" | "always";
}

export interface PiCodingAgentBindingOptions {
  readonly model: Model<Api> | PiModelRef;
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly streamOptions?: AgentHarnessStreamOptions;
  readonly activeToolNames?: readonly string[];
}

type AnyHarness = AgentHarness<any, Skill, PromptTemplate, AgentHarnessTool<any>>;

interface PiSessionRecord {
  readonly session: Session;
  readonly harness: AnyHarness;
  readonly agentName: string;
  readonly systemPrompt: string | undefined;
  readonly binding: PiAgentBinding<any>;
}

const PI_BACKEND_NAME = "pi";

export function createPiCodingAgentBinding(options: PiCodingAgentBindingOptions): PiAgentBinding<ExecutionToolContext> {
  const env = new NodeExecutionEnv({ cwd: options.cwd });
  return {
    model: options.model,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    tools: [createReadTool(), createBashTool(), createEditTool(), createWriteTool()],
    toolContext: { env },
    ...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(options.streamOptions === undefined ? {} : { streamOptions: options.streamOptions }),
  };
}

export class PiAgentExecutorBackend implements AgentExecutorBackend {
  readonly name = PI_BACKEND_NAME;
  readonly capabilities: AgentExecutorCapabilities;

  private readonly models: Models;
  private readonly agents: Readonly<Record<string, PiAgentBinding<any>>>;
  private readonly defaultBinding: PiAgentBinding<any> | undefined;
  private readonly approval: "never" | "always";
  private readonly sessions = new Map<string, PiSessionRecord>();
  private readonly sessionRepo = new InMemorySessionRepo();

  constructor(options: PiAgentExecutorOptions) {
    this.models = options.models ?? builtinModels();
    this.agents = options.agents ?? {};
    this.defaultBinding = options.defaultBinding;
    this.approval = options.approval ?? "never";
    this.capabilities = Object.freeze({
      nativeSession: true,
      checkpoint: true,
      fork: true,
      memoryExport: false,
      memoryImportRoles: ["user", "assistant"],
      structuredOutput: false,
      interrupt: true,
      toolCallInterception: true,
      interactiveApproval: this.approval === "always",
      sandboxEnforcement: false,
    });
  }

  async execute(request: AgentExecutionRequest, host: AgentExecutionHost): Promise<AgentExecutionResult> {
    throwIfAborted(request.signal);
    if (request.schema !== undefined) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        "Pi AgentHarness does not provide native structured output",
      );
    }
    if (request.memoryRevision !== request.memory.length) {
      throw new AgentExecutorError(
        "AGENT_MEMORY_REVISION_INVALID",
        `Memory revision ${request.memoryRevision} does not match ${request.memory.length} messages`,
      );
    }

    const binding = this.resolveBinding(request.agent.name);
    const effectiveSystemPrompt = request.systemPrompt ?? binding.systemPrompt;
    const existing = request.session === undefined
      ? undefined
      : this.requireSession(request.session, request.agent.name, effectiveSystemPrompt);
    const created = existing === undefined;
    const record = existing ?? await this.createSession(request.agent.name, effectiveSystemPrompt, binding);
    const synchronizedRevision = request.session === undefined
      ? 0
      : request.sessionMemoryRevision;
    if (synchronizedRevision === undefined || synchronizedRevision < 0 || synchronizedRevision > request.memoryRevision) {
      if (created) await this.deleteSession(record);
      throw new AgentExecutorError(
        "AGENT_MEMORY_REVISION_INVALID",
        "A native Pi session requires a valid synchronized Memory revision",
      );
    }

    const pending = request.memory.slice(synchronizedRevision);
    const prompt = pending.at(-1);
    if (prompt === undefined || prompt.role !== "user") {
      if (created) await this.deleteSession(record);
      throw new AgentExecutorError(
        "AGENT_MEMORY_ROLE_UNSUPPORTED",
        "Pi execution requires the newest unsynchronized Memory message to have role 'user'",
      );
    }

    const preExecutionLeaf = await record.session.getLeafId();
    try {
      await this.importMessages(record, pending.slice(0, -1));
      const unsubscribe = this.bindEvents(record.harness, host);
      const removeApproval = this.bindApproval(record.harness, request, host);
      const abort = () => {
        void record.harness.abort().catch(() => {});
      };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = request.signal.aborted
          ? await this.cancelledResult(record)
          : await this.toResult(record, await record.harness.prompt(prompt.content));
        if (result.stopReason !== "completed") {
          await record.session.moveTo(preExecutionLeaf);
          if (created) await this.deleteSession(record);
          return {
            output: result.output,
            stopReason: result.stopReason,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          };
        }
        return result;
      } finally {
        request.signal.removeEventListener("abort", abort);
        removeApproval();
        unsubscribe();
      }
    } catch (error) {
      await record.session.moveTo(preExecutionLeaf);
      if (created) await this.deleteSession(record);
      if (error instanceof AgentExecutorError) throw error;
      throw new AgentExecutorError("AGENT_EXECUTION_FAILED", errorMessage(error), { cause: error });
    }
  }

  async checkpoint(session: BackendSessionRef, signal: AbortSignal): Promise<BackendSessionRef> {
    throwIfAborted(signal);
    const record = this.requireSession(session);
    const checkpoint = session.checkpoint ?? await record.session.getLeafId();
    if (checkpoint === null) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi session '${session.id}' has no checkpoint`);
    }
    if (await record.session.getEntry(checkpoint) === undefined) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi checkpoint '${checkpoint}' does not exist`);
    }
    return { backend: this.name, id: session.id, checkpoint };
  }

  async fork(session: BackendSessionRef, signal: AbortSignal): Promise<BackendSessionRef> {
    throwIfAborted(signal);
    const source = this.requireSession(session);
    const metadata = await source.session.getMetadata();
    const forkedSession = await this.sessionRepo.fork(metadata, {
      ...(session.checkpoint === undefined ? {} : { entryId: session.checkpoint, position: "at" }),
    });
    const record = this.buildSessionRecord(
      forkedSession,
      source.agentName,
      source.systemPrompt,
      source.binding,
    );
    const forkedMetadata = await forkedSession.getMetadata();
    this.sessions.set(forkedMetadata.id, record);
    const checkpoint = await forkedSession.getLeafId();
    return {
      backend: this.name,
      id: forkedMetadata.id,
      ...(checkpoint === null ? {} : { checkpoint }),
    };
  }

  async close(session: BackendSessionRef, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const record = this.requireSession(session);
    await record.harness.abort();
    await record.harness.waitForIdle();
    await this.deleteSession(record);
  }

  private resolveBinding(agentName: string): PiAgentBinding<any> {
    const binding = this.agents[agentName] ?? this.defaultBinding;
    if (binding === undefined) {
      throw new AgentExecutorError("AGENT_BINDING_MISSING", `No Pi binding is configured for '${agentName}'`);
    }
    return binding;
  }

  private resolveModel(selection: Model<Api> | PiModelRef): Model<Api> {
    if ("api" in selection) return selection;
    const model = this.models.getModel(selection.provider, selection.id);
    if (model === undefined) {
      throw new AgentExecutorError(
        "AGENT_BINDING_MISSING",
        `Pi model '${selection.provider}/${selection.id}' is not registered`,
      );
    }
    return model;
  }

  private async createSession(
    agentName: string,
    systemPrompt: string | undefined,
    binding: PiAgentBinding<any>,
  ): Promise<PiSessionRecord> {
    const session = await this.sessionRepo.create();
    const record = this.buildSessionRecord(session, agentName, systemPrompt, binding);
    const metadata = await session.getMetadata();
    this.sessions.set(metadata.id, record);
    return record;
  }

  private buildSessionRecord(
    session: Session,
    agentName: string,
    systemPrompt: string | undefined,
    binding: PiAgentBinding<any>,
  ): PiSessionRecord {
    const harness = new AgentHarness<any, Skill, PromptTemplate, AgentHarnessTool<any>>({
      session,
      models: this.models,
      model: this.resolveModel(binding.model),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(binding.tools === undefined ? {} : { tools: [...binding.tools] }),
      ...(binding.toolContext === undefined ? {} : { toolContext: binding.toolContext }),
      ...(binding.activeToolNames === undefined ? {} : { activeToolNames: [...binding.activeToolNames] }),
      ...(binding.thinkingLevel === undefined ? {} : { thinkingLevel: binding.thinkingLevel }),
      ...(binding.streamOptions === undefined ? {} : { streamOptions: binding.streamOptions }),
      ...(binding.resources === undefined ? {} : { resources: binding.resources }),
    });
    return { session, harness, agentName, systemPrompt, binding };
  }

  private requireSession(
    reference: BackendSessionRef,
    agentName?: string,
    systemPrompt?: string,
  ): PiSessionRecord {
    if (reference.backend !== this.name) {
      throw new AgentExecutorError(
        "AGENT_SESSION_INVALID",
        `Session backend '${reference.backend}' cannot be used by '${this.name}'`,
      );
    }
    const record = this.sessions.get(reference.id);
    if (record === undefined) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi session '${reference.id}' was not found`);
    }
    if (agentName !== undefined && record.agentName !== agentName) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session belongs to a different Agent symbol");
    }
    if (agentName !== undefined && record.systemPrompt !== systemPrompt) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session uses a different system prompt");
    }
    return record;
  }

  private async importMessages(record: PiSessionRecord, messages: readonly Message[]): Promise<void> {
    const model = record.harness.getModel();
    let timestamp = Date.now() - messages.length;
    for (const message of messages) {
      timestamp += 1;
      if (message.role === "user") {
        await record.harness.appendMessage({ role: "user", content: message.content, timestamp });
        continue;
      }
      if (message.role === "assistant") {
        await record.harness.appendMessage(importedAssistantMessage(model, message.content, timestamp));
        continue;
      }
      throw new AgentExecutorError(
        "AGENT_MEMORY_ROLE_UNSUPPORTED",
        `Pi cannot import AFL Memory role '${message.role}'`,
      );
    }
  }

  private bindEvents(harness: AnyHarness, host: AgentExecutionHost): () => void {
    return harness.subscribe(async (event) => {
      const mapped = mapEvent(event);
      if (mapped !== undefined) await host.emit(mapped);
    });
  }

  private bindApproval(harness: AnyHarness, request: AgentExecutionRequest, host: AgentExecutionHost): () => void {
    if (this.approval !== "always") return () => {};
    return harness.on("tool_call", async (event) => {
      const decision = await host.requestApproval({
        runId: request.runId,
        node: request.node,
        block: request.block,
        agent: request.agent,
        action: "tool",
        id: event.toolCallId,
        name: event.toolName,
        input: event.input,
      });
      return decision === "approved"
        ? undefined
        : { block: true, reason: "AFL host denied this tool call" };
    });
  }

  private async toResult(record: PiSessionRecord, response: AssistantMessage): Promise<AgentExecutionResult> {
    const metadata = await record.session.getMetadata();
    const checkpoint = await record.session.getLeafId();
    const session = {
      backend: this.name,
      id: metadata.id,
      ...(checkpoint === null ? {} : { checkpoint }),
    };
    if (response.stopReason === "error") {
      throw new AgentExecutorError(
        "AGENT_EXECUTION_FAILED",
        response.errorMessage ?? "Pi model execution failed",
      );
    }
    return {
      output: contentText(response.content),
      stopReason: response.stopReason === "length"
        ? "budget_exhausted"
        : response.stopReason === "aborted"
        ? "cancelled"
        : response.stopReason === "toolUse"
        ? "blocked"
        : "completed",
      session,
      usage: usageRecord(response.usage),
    };
  }

  private async cancelledResult(record: PiSessionRecord): Promise<AgentExecutionResult> {
    const metadata = await record.session.getMetadata();
    return {
      output: "",
      stopReason: "cancelled",
      session: { backend: this.name, id: metadata.id },
    };
  }

  private async deleteSession(record: PiSessionRecord): Promise<void> {
    const metadata = await record.session.getMetadata();
    this.sessions.delete(metadata.id);
    await this.sessionRepo.delete(metadata);
  }
}

function importedAssistantMessage(model: Model<Api>, content: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function mapEvent(event: AgentHarnessEvent): AgentExecutionEvent | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "message.delta", text: event.assistantMessageEvent.delta };
  }
  if (event.type === "tool_execution_start") {
    return { type: "tool.started", id: event.toolCallId, name: event.toolName };
  }
  if (event.type === "tool_execution_update") {
    return { type: "tool.updated", id: event.toolCallId, name: event.toolName };
  }
  if (event.type === "tool_execution_end") {
    return { type: "tool.completed", id: event.toolCallId, name: event.toolName, ok: !event.isError };
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    return { type: "usage.updated", usage: usageRecord(event.message.usage) };
  }
  return undefined;
}

function usageRecord(usage: Usage): Readonly<Record<string, number>> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Agent execution was aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
