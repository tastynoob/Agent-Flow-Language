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
  type AgentMessage,
  type ExecutionToolContext,
  type PromptTemplate,
  type Session,
  type SessionTreeEntry,
  type Skill,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import {
  BubblewrapExecutionEnv,
  type BubblewrapExecutionEnvOptions,
} from "./bubblewrap-execution-env.js";
import {
  createAgentToolActionDisplay,
  redactAgentToolText,
  type AgentToolExecutionBoundary,
} from "./agent-tool-policy.js";
import {
  contentText,
  Type,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
  type TSchema,
  type TextContent,
  type Usage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentControlToolDescriptor,
  AgentExecutionEvent,
  AgentExecutionHost,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutorBackend,
  AgentExecutorCapabilities,
  AgentSessionImportRequest,
  AgentTransactionResult,
  BackendSessionRef,
} from "./agent-executor.js";
import { AgentExecutorError } from "./agent-executor.js";
import type { AgentStandardToolName, SymbolRef } from "./ir.js";
import {
  AFL_MESSAGE_ROLE_SCHEMA,
  type AgentMemoryContract,
  type BackendSessionRecord,
  type BackendSessionState,
  type Message,
} from "./memory.js";
import { workspaceKey, type AgentWorkspaceSet } from "./workspace.js";

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
  readonly thinkingReplay?: "include" | "exclude";
  readonly streamOptions?: AgentHarnessStreamOptions;
  readonly resources?: AgentHarnessResources;
  readonly toolBoundaries?: Readonly<Record<string, AgentToolExecutionBoundary>>;
  readonly sandboxEnforcement?: boolean;
  readonly createExecutionContext?: (
    workspace: AgentWorkspaceSet,
  ) => PiExecutionContext<TContext> | Promise<PiExecutionContext<TContext>>;
}

export interface PiExecutionContext<TContext extends object | undefined = undefined> {
  readonly tools?: readonly AgentHarnessTool<TContext>[];
  readonly toolContext?: AgentHarnessToolContextSource<TContext>;
  readonly activeToolNames?: readonly string[];
  readonly resources?: AgentHarnessResources;
  readonly contextPrompt?: string;
  readonly toolBoundaries?: Readonly<Record<string, AgentToolExecutionBoundary>>;
  readonly toolWorkspace?: string;
  readonly normalizeToolAction?: (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  readonly elevation?: PiElevationContext<TContext>;
  readonly dispose?: () => void | Promise<void>;
}

export interface PiElevationContext<TContext extends object | undefined = undefined> {
  readonly tools: readonly AgentHarnessTool<TContext>[];
  readonly toolContext: AgentHarnessToolContextSource<TContext>;
  readonly toolWorkspace: string;
  readonly normalizeToolAction?: (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
}

export interface PiAgentExecutorOptions {
  readonly models?: Models;
  readonly agents?: Readonly<Record<string, PiAgentBinding<any>>>;
  readonly defaultBinding?: PiAgentBinding<any>;
}

export interface PiCodingAgentBindingOptions {
  readonly model: Model<Api> | PiModelRef;
  readonly systemPrompt?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly thinkingReplay?: "include" | "exclude";
  readonly streamOptions?: AgentHarnessStreamOptions;
  readonly activeToolNames?: readonly string[];
  readonly elevation?: boolean;
  readonly sandbox?: false | PiBubblewrapSandboxOptions;
}

export interface PiBubblewrapSandboxOptions extends Omit<BubblewrapExecutionEnvOptions, "workspace"> {
  readonly backend: "bubblewrap";
}

type AnyHarness = AgentHarness<any, Skill, PromptTemplate, AgentHarnessTool<any>>;

interface PiSessionRecord {
  readonly session: Session;
  readonly harness: AnyHarness;
  readonly agentName: string;
  readonly systemPrompt: string | undefined;
  readonly binding: PiAgentBinding<any>;
  readonly executionContext: PiExecutionContext<any>;
  readonly workspaceKey: string;
  readonly workspace: AgentWorkspaceSet;
  readonly hostRouter: PiHostRouter;
  sourceEntryCount: number;
  readonly durableRecords: BackendSessionRecord[];
}

interface PiHostRouter {
  readonly pendingSandboxActions: Map<string, PendingSandboxAction>;
  readonly elevationCandidates: ElevationCandidate[];
  activation?: {
    readonly host: AgentExecutionHost;
    readonly request: AgentExecutionRequest;
  };
}

interface PendingSandboxAction {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface ElevationCandidate extends PendingSandboxAction {
  readonly source: "policy-block" | "sandbox-error";
}

const PI_BACKEND_NAME = "pi";
const PI_SESSION_FORMAT = "pi.session/v0";
const AFL_TRANSACTION_TOOL_NAME = "afl_transaction_request";
const AFL_TRANSACTION_CANONICAL_NAME = "afl.transaction.request";
const AFL_ELEVATION_TOOL_NAME = "afl_elevated_tool";
const AFL_ELEVATION_CANONICAL_NAME = "afl.elevation.execute";

interface PiSessionPayload {
  readonly version: 0;
  readonly records: readonly BackendSessionRecord[];
}

export function createPiCodingAgentBinding(options: PiCodingAgentBindingOptions): PiAgentBinding<ExecutionToolContext> {
  const sandbox = options.sandbox ?? false;
  return {
    model: options.model,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(options.thinkingReplay === undefined ? {} : { thinkingReplay: options.thinkingReplay }),
    ...(options.streamOptions === undefined ? {} : { streamOptions: options.streamOptions }),
    sandboxEnforcement: sandbox !== false,
    createExecutionContext: async (workspace) => {
      if (sandbox === false) {
        const env = new NodeExecutionEnv({ cwd: workspace.primary.root });
        return {
          tools: codingTools(),
          toolContext: { env },
          contextPrompt: workspaceContextPrompt(workspace),
          toolWorkspace: workspace.primary.root,
          toolBoundaries: codingToolBoundaries("host"),
          normalizeToolAction: createCodingToolActionNormalizer(env),
        };
      }
      if (sandbox.backend !== "bubblewrap") {
        throw new AgentExecutorError(
          "AGENT_SANDBOX_UNAVAILABLE",
          `Unsupported Pi coding sandbox '${String(sandbox.backend)}'`,
        );
      }
      const env = await BubblewrapExecutionEnv.create({ ...sandbox, workspace });
      const hostEnv = new NodeExecutionEnv({ cwd: workspace.primary.root });
      const elevationAvailable = options.elevation !== false;
      return {
        tools: codingTools(),
        toolContext: { env },
        contextPrompt: sandboxWorkspaceContextPrompt(workspace, elevationAvailable),
        toolWorkspace: env.cwd,
        toolBoundaries: codingToolBoundaries("sandbox"),
        normalizeToolAction: createCodingToolActionNormalizer(env),
        ...(elevationAvailable
          ? {
              elevation: {
                tools: codingTools(),
                toolContext: { env: hostEnv },
                toolWorkspace: workspace.primary.root,
                normalizeToolAction: createCodingToolActionNormalizer(hostEnv),
              },
            }
          : {}),
        dispose: () => env.cleanup(),
      };
    },
  };
}

export class PiAgentExecutorBackend implements AgentExecutorBackend {
  readonly name = PI_BACKEND_NAME;
  readonly sessionFormat = PI_SESSION_FORMAT;
  readonly capabilities: AgentExecutorCapabilities;
  readonly memory: AgentMemoryContract = Object.freeze({
    capabilities: Object.freeze({
      roleSchemas: [AFL_MESSAGE_ROLE_SCHEMA],
      importRoles: ["user", "assistant"] as const,
    }),
    validateImport: (_agent: SymbolRef, roleSchema: string, messages: readonly Message[]) => {
      if (roleSchema !== AFL_MESSAGE_ROLE_SCHEMA) {
        throw new AgentExecutorError(
          "AGENT_MEMORY_ROLE_UNSUPPORTED",
          `Pi cannot import Memory role schema '${roleSchema}'`,
        );
      }
      const unsupported = messages.find((message) => message.role !== "user" && message.role !== "assistant");
      if (unsupported !== undefined) {
        throw new AgentExecutorError(
          "AGENT_MEMORY_ROLE_UNSUPPORTED",
          `Pi cannot import AFL Memory role '${unsupported.role}'`,
        );
      }
    },
  });

  private readonly models: Models;
  private readonly agents: Readonly<Record<string, PiAgentBinding<any>>>;
  private readonly defaultBinding: PiAgentBinding<any> | undefined;
  private readonly sessions = new Map<string, PiSessionRecord>();
  private readonly sessionRepo = new InMemorySessionRepo();
  private toolRequestSequence = 0;

  constructor(options: PiAgentExecutorOptions) {
    this.models = options.models ?? builtinModels();
    this.agents = options.agents ?? {};
    this.defaultBinding = options.defaultBinding;
    const knownBindings = [
      ...Object.values(this.agents),
      ...(this.defaultBinding === undefined ? [] : [this.defaultBinding]),
    ];
    this.capabilities = Object.freeze({
      nativeSession: true,
      checkpoint: true,
      fork: true,
      workspaceContext: true,
      readOnlyWorkspaceContext: true,
      structuredOutput: false,
      interrupt: true,
      dynamicControlTools: true,
      standardTools: true,
      interactiveApproval: true,
      sandboxEnforcement: knownBindings.length > 0 &&
        knownBindings.every((binding) => binding.sandboxEnforcement === true),
    });
  }

  async execute(request: AgentExecutionRequest, host: AgentExecutionHost): Promise<AgentExecutionResult> {
    throwIfAborted(request.signal);
    await this.memory.validateImport(request.agent, AFL_MESSAGE_ROLE_SCHEMA, request.memory);
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
    const requestWorkspaceKey = workspaceKey(request.workspace);
    const existing = request.session === undefined
      ? undefined
      : this.requireSession(
          request.session,
          request.agent.name,
          effectiveSystemPrompt,
          requestWorkspaceKey,
          binding,
        );
    const created = existing === undefined;
    const record = existing ?? await this.createSession(
      request.agent.name,
      effectiveSystemPrompt,
      binding,
      request.workspace,
    );
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
      const unsubscribe = this.bindEvents(record, host);
      let restoreStandardTools: (() => Promise<void>) | undefined;
      let restoreControlTools: (() => Promise<void>) | undefined;
      let removeAuthorization: (() => void) | undefined;
      let result: AgentExecutionResult;
      const abort = () => {
        void record.harness.abort().catch(() => {});
      };
      try {
        record.hostRouter.pendingSandboxActions.clear();
        record.hostRouter.elevationCandidates.splice(0);
        record.hostRouter.activation = { host, request };
        restoreStandardTools = await this.configureStandardTools(record, request);
        restoreControlTools = await this.configureControlTools(record, request, host);
        removeAuthorization = this.bindAuthorization(record, request, host);
        request.signal.addEventListener("abort", abort, { once: true });
        result = request.signal.aborted
          ? await this.cancelledResult(record)
          : await this.toResult(record, await record.harness.prompt(prompt.content));
      } finally {
        delete record.hostRouter.activation;
        request.signal.removeEventListener("abort", abort);
        removeAuthorization?.();
        await restoreControlTools?.();
        await restoreStandardTools?.();
        unsubscribe();
      }
      if (result.stopReason !== "completed") {
        await record.session.moveTo(preExecutionLeaf);
        if (created) await this.deleteSession(record);
        return {
          output: result.output,
          stopReason: result.stopReason,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        };
      }
      const metadata = await record.session.getMetadata();
      const checkpoint = await record.session.getLeafId();
      return {
        ...result,
        session: {
          backend: this.name,
          id: metadata.id,
          ...(checkpoint === null ? {} : { checkpoint }),
        },
      };
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
    let executionContext: PiExecutionContext<any> | undefined;
    try {
      executionContext = await this.resolveExecutionContext(source.binding, source.workspace);
      const entries = await forkedSession.getEntries();
      const record = this.buildSessionRecord(
        forkedSession,
        source.agentName,
        source.systemPrompt,
        source.binding,
        executionContext,
        source.workspaceKey,
        source.workspace,
        entries.length,
        sessionEntriesToRecords(entries),
      );
      const forkedMetadata = await forkedSession.getMetadata();
      this.sessions.set(forkedMetadata.id, record);
      const checkpoint = await forkedSession.getLeafId();
      return {
        backend: this.name,
        id: forkedMetadata.id,
        ...(checkpoint === null ? {} : { checkpoint }),
      };
    } catch (error) {
      await disposeExecutionContext(executionContext);
      await this.deleteRawSession(forkedSession).catch(() => {});
      throw error;
    }
  }

  async exportSession(session: BackendSessionRef, signal: AbortSignal): Promise<BackendSessionState> {
    throwIfAborted(signal);
    const record = this.requireSession(session);
    const activeLeafId = await record.session.getLeafId();
    const leafId = session.checkpoint ?? activeLeafId;
    if (leafId !== null && await record.session.getEntry(leafId) === undefined) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi checkpoint '${leafId}' does not exist`);
    }
    if (leafId !== activeLeafId) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi cannot export a stale session checkpoint");
    }
    const payload = jsonRoundTrip({
      version: 0,
      records: record.durableRecords,
    }) as PiSessionPayload;
    return { backend: this.name, format: PI_SESSION_FORMAT, payload };
  }

  async importSession(request: AgentSessionImportRequest): Promise<BackendSessionRef> {
    throwIfAborted(request.signal);
    if (request.state.backend !== this.name || request.state.format !== PI_SESSION_FORMAT) {
      throw new AgentExecutorError(
        "AGENT_SESSION_INVALID",
        `Pi cannot import session state '${request.state.backend}/${request.state.format}'`,
      );
    }
    const payload = parsePiSessionPayload(request.state.payload);
    const binding = this.resolveBinding(request.agent.name);
    const effectiveSystemPrompt = request.systemPrompt ?? binding.systemPrompt;
    const session = await this.sessionRepo.create();
    let executionContext: PiExecutionContext<any> | undefined;
    try {
      const model = this.resolveModel(binding.model);
      await importSessionRecords(session, payload.records, model);
      executionContext = await this.resolveExecutionContext(binding, request.workspace);
      const sourceEntryCount = (await session.getEntries()).length;
      const record = this.buildSessionRecord(
        session,
        request.agent.name,
        effectiveSystemPrompt,
        binding,
        executionContext,
        workspaceKey(request.workspace),
        request.workspace,
        sourceEntryCount,
        payload.records,
      );
      const metadata = await session.getMetadata();
      const checkpoint = await session.getLeafId();
      this.sessions.set(metadata.id, record);
      return {
        backend: this.name,
        id: metadata.id,
        ...(checkpoint === null ? {} : { checkpoint }),
      };
    } catch (error) {
      await disposeExecutionContext(executionContext);
      await this.deleteRawSession(session).catch(() => {});
      if (error instanceof AgentExecutorError) throw error;
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session continuation is invalid", { cause: error });
    }
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
    workspace: AgentWorkspaceSet,
  ): Promise<PiSessionRecord> {
    const session = await this.sessionRepo.create();
    let executionContext: PiExecutionContext<any> | undefined;
    try {
      executionContext = await this.resolveExecutionContext(binding, workspace);
      const record = this.buildSessionRecord(
        session,
        agentName,
        systemPrompt,
        binding,
        executionContext,
        workspaceKey(workspace),
        workspace,
      );
      const metadata = await session.getMetadata();
      this.sessions.set(metadata.id, record);
      return record;
    } catch (error) {
      await disposeExecutionContext(executionContext);
      await this.deleteRawSession(session).catch(() => {});
      throw error;
    }
  }

  private buildSessionRecord(
    session: Session,
    agentName: string,
    systemPrompt: string | undefined,
    binding: PiAgentBinding<any>,
    executionContext: PiExecutionContext<any>,
    sessionWorkspaceKey: string,
    workspace: AgentWorkspaceSet,
    sourceEntryCount = 0,
    durableRecords: readonly BackendSessionRecord[] = [],
  ): PiSessionRecord {
    const harnessSystemPrompt = joinPrompts(systemPrompt, executionContext.contextPrompt);
    const hostRouter: PiHostRouter = {
      pendingSandboxActions: new Map(),
      elevationCandidates: [],
    };
    const configuredTools = executionContext.tools ?? binding.tools ?? [];
    const reservedNames = new Set([
      AFL_TRANSACTION_TOOL_NAME,
      AFL_TRANSACTION_CANONICAL_NAME,
      AFL_ELEVATION_TOOL_NAME,
      AFL_ELEVATION_CANONICAL_NAME,
    ]);
    const reserved = configuredTools.find((tool) => reservedNames.has(tool.name));
    if (reserved !== undefined) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent binding cannot register reserved AFL built-in tool '${reserved.name}'`,
      );
    }
    const normalToolContext = executionContext.toolContext ?? binding.toolContext;
    if (executionContext.elevation !== undefined && normalToolContext === undefined) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        "Pi elevation requires a normal sandbox tool context",
      );
    }
    const builtInTools = [
      createTransactionRequestTool(hostRouter),
      ...(executionContext.elevation === undefined
        ? []
        : [createElevationTool(hostRouter, {
            tools: configuredTools,
            toolContext: normalToolContext!,
            toolWorkspace: executionContext.toolWorkspace ?? workspace.primary.root,
            ...(executionContext.normalizeToolAction === undefined
              ? {}
              : { normalizeToolAction: executionContext.normalizeToolAction }),
          }, executionContext.elevation)]),
    ];
    const tools = [...configuredTools, ...builtInTools];
    const configuredActiveNames = executionContext.activeToolNames ?? binding.activeToolNames;
    const activeToolNames = configuredActiveNames === undefined
      ? undefined
      : [...new Set([...configuredActiveNames, ...builtInTools.map((tool) => tool.name)])];
    const harness = new AgentHarness<any, Skill, PromptTemplate, AgentHarnessTool<any>>({
      session,
      models: this.models,
      model: this.resolveModel(binding.model),
      ...(harnessSystemPrompt === undefined ? {} : { systemPrompt: harnessSystemPrompt }),
      tools,
      ...((executionContext.toolContext ?? binding.toolContext) === undefined
        ? {}
        : { toolContext: executionContext.toolContext ?? binding.toolContext }),
      ...(activeToolNames === undefined ? {} : { activeToolNames }),
      ...(binding.thinkingLevel === undefined ? {} : { thinkingLevel: binding.thinkingLevel }),
      ...(binding.streamOptions === undefined ? {} : { streamOptions: binding.streamOptions }),
      ...((executionContext.resources ?? binding.resources) === undefined
        ? {}
        : { resources: executionContext.resources ?? binding.resources }),
    });
    if ((binding.thinkingReplay ?? "include") === "exclude") {
      harness.on("context", (event) => ({ messages: withoutHistoricalThinking(event.messages) }));
    }
    return {
      session,
      harness,
      agentName,
      systemPrompt,
      binding,
      executionContext,
      workspaceKey: sessionWorkspaceKey,
      workspace,
      hostRouter,
      sourceEntryCount,
      durableRecords: structuredClone([...durableRecords]),
    };
  }

  private async resolveExecutionContext(
    binding: PiAgentBinding<any>,
    workspace: AgentWorkspaceSet,
  ): Promise<PiExecutionContext<any>> {
    const resolved = await binding.createExecutionContext?.(workspace) ?? {};
    return resolved.contextPrompt === undefined
      ? { ...resolved, contextPrompt: workspaceContextPrompt(workspace) }
      : resolved;
  }

  private async configureControlTools(
    record: PiSessionRecord,
    request: AgentExecutionRequest,
    host: AgentExecutionHost,
  ): Promise<(() => Promise<void>) | undefined> {
    if (request.control === undefined) return undefined;
    const baselineTools = record.harness.getTools();
    const baselineActiveNames = record.harness.getActiveTools().map((tool) => tool.name);
    const aliases = controlToolAliases(request.control.tools);
    const reserved = baselineTools.find((tool) =>
      (tool.name.startsWith("afl.") &&
        tool.name !== AFL_TRANSACTION_CANONICAL_NAME &&
        tool.name !== AFL_ELEVATION_CANONICAL_NAME) ||
      aliases.has(tool.name));
    if (reserved !== undefined) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent binding cannot register reserved AFL control tool '${reserved.name}'`,
      );
    }
    const controlTools = request.control.tools.map((descriptor): AgentHarnessTool<any> => ({
      name: piControlToolName(descriptor.name),
      label: descriptor.label,
      description: `${descriptor.description} Canonical AFL name: ${descriptor.name}.`,
      parameters: descriptor.inputSchema as TSchema,
      executionMode: "parallel",
      execute: async (toolCallId, params, signal) => {
        const result = await host.executeControlTool({
          id: toolCallId,
          name: descriptor.name,
          input: params as Readonly<Record<string, unknown>>,
          signal: signal ?? request.signal,
        });
        return {
          content: [{ type: "text", text: result.content }],
          details: result.details ?? {},
        };
      },
    }));
    await record.harness.setTools(
      [...baselineTools, ...controlTools],
      [
        AFL_TRANSACTION_TOOL_NAME,
        ...(record.executionContext.elevation === undefined ? [] : [AFL_ELEVATION_TOOL_NAME]),
        ...controlTools.map((tool) => tool.name),
      ],
    );
    return async () => {
      await record.harness.setTools(baselineTools, baselineActiveNames);
    };
  }

  private async configureStandardTools(
    record: PiSessionRecord,
    request: AgentExecutionRequest,
  ): Promise<(() => Promise<void>) | undefined> {
    if (request.tools === undefined) return undefined;
    const baselineActiveNames = record.harness.getActiveTools().map((tool) => tool.name);
    const availableNames = new Set(record.harness.getTools().map((tool) => tool.name));
    const requestedNames = request.tools.map(piStandardToolName);
    const missing = requestedNames.find((name) => !availableNames.has(name));
    if (missing !== undefined) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Pi binding for '${request.agent.name}' does not provide AFL standard tool '${aflStandardToolName(missing)}'`,
      );
    }
    await record.harness.setActiveTools([
      AFL_TRANSACTION_TOOL_NAME,
      ...(record.executionContext.elevation === undefined || requestedNames.length === 0
        ? []
        : [AFL_ELEVATION_TOOL_NAME]),
      ...requestedNames,
    ]);
    return () => record.harness.setActiveTools(baselineActiveNames);
  }

  private requireSession(
    reference: BackendSessionRef,
    agentName?: string,
    systemPrompt?: string,
    sessionWorkspaceKey?: string,
    binding?: PiAgentBinding<any>,
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
    if (sessionWorkspaceKey !== undefined && record.workspaceKey !== sessionWorkspaceKey) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session uses a different Workspace context");
    }
    if (binding !== undefined && record.binding !== binding) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session uses a different Agent binding");
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
        record.durableRecords.push(canonicalAppendRecord(message));
        record.sourceEntryCount += 1;
        continue;
      }
      if (message.role === "assistant") {
        await record.harness.appendMessage(importedAssistantMessage(model, message.content, timestamp));
        record.durableRecords.push(canonicalAppendRecord(message));
        record.sourceEntryCount += 1;
        continue;
      }
      throw new AgentExecutorError(
        "AGENT_MEMORY_ROLE_UNSUPPORTED",
        `Pi cannot import AFL Memory role '${message.role}'`,
      );
    }
  }

  private bindEvents(record: PiSessionRecord, host: AgentExecutionHost): () => void {
    return record.harness.subscribe(async (event) => {
      if (event.type === "tool_execution_end") {
        const pending = record.hostRouter.pendingSandboxActions.get(event.toolCallId);
        record.hostRouter.pendingSandboxActions.delete(event.toolCallId);
        if (pending !== undefined && event.isError) {
          record.hostRouter.elevationCandidates.push({ ...pending, source: "sandbox-error" });
        }
      }
      if (isSessionDurabilityEvent(event)) {
        const entries = await record.session.getEntries({ afterEntrySeq: record.sourceEntryCount });
        if (entries.length > 0) {
          const records = sessionEntriesToRecords(entries);
          if (records.length > 0) {
            await host.persistContinuation({
              backend: this.name,
              format: PI_SESSION_FORMAT,
              baseRecordCount: record.durableRecords.length,
              records,
            });
            record.durableRecords.push(...structuredClone(records));
          }
          record.sourceEntryCount += entries.length;
        }
      }
      const mapped = mapEvent(event);
      if (mapped !== undefined) await host.emit(mapped);
    });
  }

  private bindAuthorization(
    record: PiSessionRecord,
    request: AgentExecutionRequest,
    host: AgentExecutionHost,
  ): () => void {
    const controlNames = new Set(request.control?.tools.map((tool) => piControlToolName(tool.name)) ?? []);
    controlNames.add(AFL_TRANSACTION_TOOL_NAME);
    if (record.executionContext.elevation !== undefined) controlNames.add(AFL_ELEVATION_TOOL_NAME);
    return record.harness.on("tool_call", async (event) => {
      this.toolRequestSequence += 1;
      if (controlNames.has(event.toolName)) {
        await host.emit({ type: "tool.started", id: event.toolCallId, name: event.toolName });
        return undefined;
      }
      const executionBoundary = record.executionContext.toolBoundaries?.[event.toolName] ??
        record.binding.toolBoundaries?.[event.toolName] ??
        "host";
      const input = event.input as Readonly<Record<string, unknown>>;
      const effectiveInput = await record.executionContext.normalizeToolAction?.(
        event.toolName,
        input,
        request.signal,
      ) ?? input;
      const authorization = await host.authorizeTool({
        requestId: `${request.runId}:pi-tool:${this.toolRequestSequence}`,
        runId: request.runId,
        node: request.node,
        block: request.block,
        agent: request.agent,
        backend: this.name,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        executionBoundary,
        workspace: request.workspace,
        input,
        effectiveInput,
        display: createAgentToolActionDisplay(
          event.toolName,
          effectiveInput,
          record.executionContext.toolWorkspace ?? request.workspace.primary.root,
        ),
        signal: request.signal,
      });
      if (authorization.status === "denied") {
        if (authorization.elevatable && executionBoundary === "sandbox") {
          record.hostRouter.elevationCandidates.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: structuredClone(input),
            source: "policy-block",
          });
        }
        const elevationHint = authorization.elevatable && record.executionContext.elevation !== undefined
          ? " Try a safer alternative first; if its cost is unacceptable, retry the same tool and arguments with afl_elevated_tool."
          : "";
        return { block: true, reason: `[${authorization.code}] ${authorization.reason}${elevationHint}` };
      }
      if (executionBoundary === "sandbox") {
        record.hostRouter.pendingSandboxActions.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: structuredClone(input),
        });
      }
      await host.emit({ type: "tool.started", id: event.toolCallId, name: event.toolName });
      return undefined;
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
    await disposeExecutionContext(record.executionContext);
    await this.sessionRepo.delete(metadata);
  }

  private async deleteRawSession(session: Session): Promise<void> {
    await this.sessionRepo.delete(await session.getMetadata());
  }
}

function createTransactionRequestTool(hostRouter: PiHostRouter): AgentHarnessTool<any> {
  return {
    name: AFL_TRANSACTION_TOOL_NAME,
    label: "Request user action",
    description: [
      "Ask the user to perform an external prerequisite action, then pause until they confirm completion.",
      "Use this when work cannot continue without something only the user or host can provide, such as installing a missing tool.",
      "This tool does not grant permissions or perform the action. After it returns completed, verify the resume condition yourself.",
      `Canonical AFL name: ${AFL_TRANSACTION_CANONICAL_NAME}.`,
    ].join(" "),
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: "Short human-readable request title" }),
      request: Type.String({ minLength: 1, description: "The exact action the user needs to perform" }),
      reason: Type.String({ minLength: 1, description: "Why the agent cannot continue without this action" }),
      resume_when: Type.Optional(Type.String({
        minLength: 1,
        description: "An observable condition the agent will verify after the user confirms completion",
      })),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const input = params as {
        readonly title: string;
        readonly request: string;
        readonly reason: string;
        readonly resume_when?: string;
      };
      const activation = hostRouter.activation;
      if (activation === undefined) {
        throw new AgentExecutorError(
          "AGENT_CAPABILITY_UNSUPPORTED",
          "AFL transaction requests are only available during an active Agent execution",
        );
      }
      const result = await activation.host.requestTransaction({
        id: toolCallId,
        title: input.title,
        request: input.request,
        reason: input.reason,
        ...(input.resume_when === undefined ? {} : { resumeWhen: input.resume_when }),
        signal: signal ?? activation.request.signal,
      });
      return transactionToolResult(result);
    },
  };
}

function transactionToolResult(result: AgentTransactionResult): {
  content: TextContent[];
  details: AgentTransactionResult;
} {
  const text = result.status === "completed"
    ? "The user marked the requested action as completed. Verify the resume condition before continuing."
    : result.status === "denied"
    ? `The user declined the requested action: ${result.message}`
    : `The transaction request could not be presented [${result.code}]: ${result.message}`;
  return { content: [{ type: "text", text }], details: result };
}

function createElevationTool(
  hostRouter: PiHostRouter,
  sandbox: PiElevationContext<any>,
  host: PiElevationContext<any>,
): AgentHarnessTool<any> {
  if (host.tools.length === 0) {
    throw new AgentExecutorError(
      "AGENT_CAPABILITY_UNSUPPORTED",
      "Pi elevation context must provide at least one target tool",
    );
  }
  const sandboxTargets = new Map(sandbox.tools.map((tool) => [tool.name, tool]));
  const hostTargets = new Map<string, AgentHarnessTool<any>>();
  for (const tool of host.tools) {
    if (hostTargets.has(tool.name) || tool.name.startsWith("afl.") || tool.name.startsWith("afl_")) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Invalid or duplicate elevated Pi tool '${tool.name}'`,
      );
    }
    if (!sandboxTargets.has(tool.name)) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Elevated Pi tool '${tool.name}' has no matching sandbox tool`,
      );
    }
    hostTargets.set(tool.name, tool);
  }
  const toolNames = host.tools.map((tool) => tool.name);
  const parameters = Type.Object({
    tool: Type.String({
      minLength: 1,
      enum: toolNames,
      description: `Tool to retry. Must be one of: ${toolNames.join(", ")}`,
    }),
    arguments: Type.Object({}, {
      additionalProperties: true,
      description: "Exact arguments from the previously blocked or sandbox-failed tool call",
    }),
    reason: Type.String({
      minLength: 1,
      description: "Why safer alternatives are too costly or why the sandbox boundary prevents completion",
    }),
  });
  return {
    name: AFL_ELEVATION_TOOL_NAME,
    label: "Request elevated tool execution",
    description: [
      "Retry one previously blocked tool action after mandatory one-shot human approval.",
      "Use it only after the same tool and arguments were soft-blocked by policy or failed during sandbox execution, and safer alternatives are impractical.",
      "A policy-blocked action remains inside the sandbox; only an action that actually failed in the sandbox may use the host executor.",
      "Hard policy denials cannot be elevated. Use afl_transaction_request when the user must perform an external action.",
      "For host retries, relative paths and command working directories resolve to the primary host workspace; do not use /workspace as a host path.",
      `Available elevated tools: ${host.tools.map((tool) => tool.name).join(", ")}.`,
      `Canonical AFL name: ${AFL_ELEVATION_CANONICAL_NAME}.`,
    ].join(" "),
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const input = params as {
        readonly tool: string;
        readonly arguments: Readonly<Record<string, unknown>>;
        readonly reason: string;
      };
      const activation = hostRouter.activation;
      if (activation === undefined) {
        throw new AgentExecutorError(
          "AGENT_CAPABILITY_UNSUPPORTED",
          "AFL elevated tool execution is only available during an active Agent execution",
        );
      }
      const hostTarget = hostTargets.get(input.tool);
      const sandboxTarget = sandboxTargets.get(input.tool);
      if (hostTarget === undefined || sandboxTarget === undefined) {
        throw new AgentExecutorError(
          "AGENT_CAPABILITY_UNSUPPORTED",
          `Elevated Pi tool '${input.tool}' is not available`,
        );
      }
      if (!Value.Check(hostTarget.parameters, input.arguments)) {
        throw new AgentExecutorError(
          "AGENT_EXECUTION_FAILED",
          `Invalid arguments for elevated Pi tool '${hostTarget.name}'`,
        );
      }
      let failedIndex = -1;
      for (let index = hostRouter.elevationCandidates.length - 1; index >= 0; index -= 1) {
        const action = hostRouter.elevationCandidates[index]!;
        if (action.toolName === hostTarget.name && isDeepStrictEqual(action.input, input.arguments)) {
          failedIndex = index;
          break;
        }
      }
      if (failedIndex < 0) {
        throw new AgentExecutorError(
          "AGENT_CAPABILITY_UNSUPPORTED",
          `Elevated Pi tool '${hostTarget.name}' must retry the same arguments from a soft policy block or failed sandbox execution in the current Agent call`,
        );
      }
      const candidate = hostRouter.elevationCandidates[failedIndex]!;
      const targetContext = candidate.source === "policy-block" ? sandbox : host;
      const target = candidate.source === "policy-block" ? sandboxTarget : hostTarget;
      const requestSignal = signal ?? activation.request.signal;
      const effectiveInput = await targetContext.normalizeToolAction?.(
        target.name,
        input.arguments,
        requestSignal,
      ) ?? input.arguments;
      const baseDisplay = createAgentToolActionDisplay(
        target.name,
        effectiveInput,
        targetContext.toolWorkspace,
      );
      const elevatedCallId = `${toolCallId}:elevated`;
      const authorization = await activation.host.requestElevation({
        id: elevatedCallId,
        toolName: target.name,
        input: input.arguments,
        effectiveInput,
        executionBoundary: candidate.source === "policy-block" ? "sandbox" : "host",
        reason: input.reason,
        display: {
          ...baseDisplay,
          title: `Elevated ${target.label ?? target.name}`,
          details: {
            ...baseDisplay.details,
            reason: redactAgentToolText(input.reason),
          },
        },
        signal: requestSignal,
      });
      if (authorization.status === "denied") {
        throw new Error(`Elevated execution denied [${authorization.code}]: ${authorization.reason}`);
      }
      await activation.host.emit({ type: "tool.started", id: elevatedCallId, name: target.name });
      try {
        const context = typeof targetContext.toolContext === "function"
          ? await targetContext.toolContext()
          : targetContext.toolContext;
        const result = await target.execute(
          elevatedCallId,
          input.arguments,
          requestSignal,
          onUpdate,
          context,
        );
        hostRouter.elevationCandidates.splice(failedIndex, 1);
        await activation.host.emit({ type: "tool.completed", id: elevatedCallId, name: target.name, ok: true });
        return {
          content: result.content,
          details: { status: "executed", tool: target.name, source: candidate.source },
        };
      } catch (error) {
        await activation.host.emit({ type: "tool.completed", id: elevatedCallId, name: target.name, ok: false });
        throw error;
      }
    },
  };
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

function withoutHistoricalThinking(messages: readonly AgentMessage[]): AgentMessage[] {
  let currentTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      currentTurnStart = index;
      break;
    }
  }
  return messages.map((message, index) => index < currentTurnStart && message.role === "assistant"
    ? { ...message, content: message.content.filter((block) => block.type !== "thinking") }
    : message);
}

function sessionEntriesToRecords(entries: readonly SessionTreeEntry[]): BackendSessionRecord[] {
  const records = entries.flatMap(sessionEntryToRecords);
  return jsonRoundTrip(records) as BackendSessionRecord[];
}

function sessionEntryToRecords(entry: SessionTreeEntry): BackendSessionRecord[] {
  switch (entry.type) {
    case "message":
      return [agentMessageToRecord(entry.message)];
    case "thinking_level_change":
      return [{ type: "session.thinking", level: entry.thinkingLevel }];
    case "model_change":
      return [{ type: "session.model", provider: entry.provider, model: entry.modelId }];
    case "active_tools_change":
      return [{ type: "session.tools", names: [...entry.activeToolNames] }];
    case "compaction":
      return [{
        type: "session.compaction",
        summary: encodeText(entry.summary),
        tokens_before: entry.tokensBefore,
        ...(entry.retainedTail === undefined
          ? {}
          : { retained_tail: entry.retainedTail.map(agentMessageToRecord) }),
        ...(entry.details === undefined ? {} : { details: entry.details }),
        ...(entry.fromHook === undefined ? {} : { from_hook: entry.fromHook }),
      }];
    case "branch_summary":
      return [{
        type: "session.branch_summary",
        summary: encodeText(entry.summary),
        ...(entry.details === undefined ? {} : { details: entry.details }),
        ...(entry.fromHook === undefined ? {} : { from_hook: entry.fromHook }),
      }];
    case "custom":
      return [{
        type: "session.custom",
        custom_type: entry.customType,
        ...(entry.data === undefined ? {} : { data: entry.data }),
      }];
    case "custom_message":
      return [{
        type: "session.custom_message",
        custom_type: entry.customType,
        display: entry.display,
        ...encodeSimpleContent(entry.content),
        ...(entry.details === undefined ? {} : { details: entry.details }),
      }];
    case "session_info":
      return entry.name === undefined ? [] : [{ type: "session.name", name: entry.name }];
    case "label":
    case "leaf":
      return [];
  }
}

function agentMessageToRecord(message: AgentMessage): BackendSessionRecord {
  if (message.role === "user") return { type: "user", ...encodeSimpleContent(message.content) };
  if (message.role === "toolResult") {
    return {
      type: "tool.result",
      id: message.toolCallId,
      name: message.toolName,
      status: message.isError ? "error" : "ok",
      ...encodeSimpleContent(message.content),
      ...(message.details === undefined ? {} : { details: message.details }),
      ...(message.addedToolNames === undefined ? {} : { added_tools: [...message.addedToolNames] }),
    };
  }
  if (message.role === "bashExecution") {
    return {
      type: "session.bash",
      command: encodeText(message.command),
      output: encodeText(message.output),
      ...(message.exitCode === undefined ? {} : { exit_code: message.exitCode }),
      cancelled: message.cancelled,
      truncated: message.truncated,
      ...(message.fullOutputPath === undefined ? {} : { full_output_path: message.fullOutputPath }),
      ...(message.excludeFromContext === undefined ? {} : { exclude_from_context: message.excludeFromContext }),
    };
  }
  if (message.role === "custom") {
    return {
      type: "session.custom_message",
      custom_type: message.customType,
      display: message.display,
      ...encodeSimpleContent(message.content),
      ...(message.details === undefined ? {} : { details: message.details }),
    };
  }
  if (message.role === "branchSummary") {
    return { type: "session.branch_summary", summary: encodeText(message.summary) };
  }
  if (message.role === "compactionSummary") {
    return {
      type: "session.compaction",
      summary: encodeText(message.summary),
      tokens_before: message.tokensBefore,
    };
  }
  const final = message.stopReason === "stop";
  const first = message.content[0];
  const simple = message.content.length === 1 && first?.type === "text" && first.textSignature === undefined;
  return {
    type: "assistant",
    ...(simple
      ? { text: encodeText((first as TextContent).text) }
      : { content: message.content.map(encodeAssistantBlock) }),
    ...(final && simple ? {} : { final }),
    ...(message.stopReason === "stop" ? {} : { stop_reason: message.stopReason }),
    ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
  };
}

function canonicalAppendRecord(message: Message): BackendSessionRecord {
  return { type: "session.append", role: message.role, text: encodeText(message.content) };
}

function encodeSimpleContent(
  content: string | readonly (TextContent | ImageContent)[],
): Record<string, unknown> {
  if (typeof content === "string") return { text: encodeText(content) };
  if (content.length === 1 && content[0]?.type === "text" &&
      typeof content[0].text === "string" && content[0].textSignature === undefined) {
    return { text: encodeText(content[0].text) };
  }
  return { content: content.map((block) => encodeSimpleBlock(block)) };
}

function encodeSimpleBlock(block: TextContent | ImageContent): BackendSessionRecord {
  if (block.type === "text") {
    return {
      type: "text",
      text: encodeText(block.text),
      ...(block.textSignature === undefined ? {} : { signature: block.textSignature }),
    };
  }
  return { type: "image", data: block.data, mime_type: block.mimeType };
}

function encodeAssistantBlock(
  block: AssistantMessage["content"][number],
): BackendSessionRecord {
  if (block.type === "text") {
    return {
      type: "text",
      text: encodeText(block.text),
      ...(block.textSignature === undefined ? {} : { signature: block.textSignature }),
    };
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      text: encodeText(block.thinking),
      ...(block.thinkingSignature === undefined ? {} : { signature: block.thinkingSignature }),
      ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
    };
  }
  return {
    type: "tool.call",
    id: block.id,
    name: block.name,
    arguments: structuredClone(block.arguments),
    ...(block.thoughtSignature === undefined ? {} : { signature: block.thoughtSignature }),
  };
}

async function importSessionRecords(
  session: Session,
  records: readonly BackendSessionRecord[],
  model: Model<Api>,
): Promise<void> {
  let timestamp = Date.now() - records.length;
  for (const record of records) {
    timestamp += 1;
    if (record.type === "append" || record.type === "session.append") {
      const role = requireString(record.role, "append role");
      if (role !== "user" && role !== "assistant") {
        throw new AgentExecutorError("AGENT_MEMORY_ROLE_UNSUPPORTED", `Pi cannot restore AFL Memory role '${role}'`);
      }
      await session.appendMessage(role === "user"
        ? { role, content: decodeText(record.text, "append text"), timestamp }
        : importedAssistantMessage(model, decodeText(record.text, "append text"), timestamp));
      continue;
    }
    if (record.type === "user" || record.type === "assistant" || record.type === "tool.result") {
      await session.appendMessage(recordToAgentMessage(record, model, timestamp));
      continue;
    }
    if (record.type === "session.thinking") {
      await session.appendThinkingLevelChange(requireString(record.level, "thinking level"));
      continue;
    }
    if (record.type === "session.model") {
      await session.appendModelChange(
        requireString(record.provider, "model provider"),
        requireString(record.model, "model id"),
      );
      continue;
    }
    if (record.type === "session.tools") {
      await session.appendActiveToolsChange(requireStringArray(record.names, "active tools"));
      continue;
    }
    if (record.type === "session.compaction") {
      const retainedTail = record.retained_tail === undefined
        ? undefined
        : requireRecordArray(record.retained_tail, "retained tail")
          .map((item, index) => recordToAgentMessage(item, model, timestamp + index));
      await session.appendCompaction(
        decodeText(record.summary, "compaction summary"),
        undefined,
        requireNonNegativeNumber(record.tokens_before, "compaction token count"),
        record.details,
        optionalBoolean(record.from_hook, "compaction from_hook"),
        undefined,
        retainedTail,
      );
      continue;
    }
    if (record.type === "session.branch_summary") {
      const fromHook = optionalBoolean(record.from_hook, "branch summary from_hook");
      await session.moveTo(await session.getLeafId(), {
        summary: decodeText(record.summary, "branch summary"),
        ...(record.details === undefined ? {} : { details: record.details }),
        ...(fromHook === undefined ? {} : { fromHook }),
      });
      continue;
    }
    if (record.type === "session.custom") {
      await session.appendCustomEntry(requireString(record.custom_type, "custom type"), record.data);
      continue;
    }
    if (record.type === "session.custom_message") {
      await session.appendCustomMessageEntry(
        requireString(record.custom_type, "custom message type"),
        decodeSimpleContent(record, "custom message"),
        requireBoolean(record.display, "custom message display"),
        record.details,
      );
      continue;
    }
    if (record.type === "session.name") {
      await session.appendSessionName(requireString(record.name, "session name"));
      continue;
    }
    if (record.type === "session.bash") {
      await session.appendMessage({
        role: "bashExecution",
        command: decodeText(record.command, "bash command"),
        output: decodeText(record.output, "bash output"),
        exitCode: record.exit_code === undefined
          ? undefined
          : requireInteger(record.exit_code, "bash exit code"),
        cancelled: requireBoolean(record.cancelled, "bash cancelled"),
        truncated: requireBoolean(record.truncated, "bash truncated"),
        ...(record.full_output_path === undefined
          ? {}
          : { fullOutputPath: requireString(record.full_output_path, "bash output path") }),
        ...(record.exclude_from_context === undefined
          ? {}
          : { excludeFromContext: requireBoolean(record.exclude_from_context, "bash context exclusion") }),
        timestamp,
      });
      continue;
    }
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Unknown Pi continuation record '${record.type}'`);
  }
}

function recordToAgentMessage(record: BackendSessionRecord, model: Model<Api>, timestamp: number): AgentMessage {
  if (record.type === "user") {
    return { role: "user", content: decodeSimpleContent(record, "user message"), timestamp };
  }
  if (record.type === "tool.result") {
    return {
      role: "toolResult",
      toolCallId: requireString(record.id, "tool result id"),
      toolName: requireString(record.name, "tool result name"),
      content: decodeSimpleContentBlocks(record, "tool result"),
      ...(record.details === undefined ? {} : { details: record.details }),
      ...(record.added_tools === undefined
        ? {}
        : { addedToolNames: requireStringArray(record.added_tools, "added tools") }),
      isError: record.status === "error",
      timestamp,
    };
  }
  if (record.type !== "assistant") {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Record '${record.type}' is not a Pi message`);
  }
  const stopReason = record.stop_reason === undefined
    ? "stop"
    : requireString(record.stop_reason, "assistant stop reason");
  if (!["stop", "length", "toolUse", "error", "aborted"].includes(stopReason)) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi assistant stop reason '${stopReason}' is invalid`);
  }
  return {
    role: "assistant",
    content: decodeAssistantContent(record),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: stopReason as AssistantMessage["stopReason"],
    ...(record.error === undefined ? {} : { errorMessage: requireString(record.error, "assistant error") }),
    timestamp,
  };
}

function decodeAssistantContent(record: BackendSessionRecord): AssistantMessage["content"] {
  if (record.text !== undefined) return [{ type: "text", text: decodeText(record.text, "assistant text") }];
  const blocks = requireRecordArray(record.content, "assistant content");
  return blocks.map((block) => {
    if (block.type === "text") {
      return {
        type: "text" as const,
        text: decodeText(block.text, "assistant text"),
        ...(block.signature === undefined ? {} : { textSignature: requireString(block.signature, "text signature") }),
      };
    }
    if (block.type === "thinking") {
      return {
        type: "thinking" as const,
        thinking: decodeText(block.text, "assistant thinking"),
        ...(block.signature === undefined
          ? {}
          : { thinkingSignature: requireString(block.signature, "thinking signature") }),
        ...(block.redacted === undefined ? {} : { redacted: requireBoolean(block.redacted, "thinking redacted") }),
      };
    }
    if (block.type === "tool.call") {
      if (!isRecord(block.arguments)) {
        throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi tool call arguments are invalid");
      }
      return {
        type: "toolCall" as const,
        id: requireString(block.id, "tool call id"),
        name: requireString(block.name, "tool call name"),
        arguments: structuredClone(block.arguments),
        ...(block.signature === undefined
          ? {}
          : { thoughtSignature: requireString(block.signature, "tool call signature") }),
      };
    }
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Unknown Pi assistant block '${String(block.type)}'`);
  });
}

function decodeSimpleContent(
  record: BackendSessionRecord,
  description: string,
): string | Array<{ type: "text"; text: string; textSignature?: string } | { type: "image"; data: string; mimeType: string }> {
  if (record.text !== undefined) return decodeText(record.text, `${description} text`);
  return decodeSimpleContentBlocks(record, description);
}

function decodeSimpleContentBlocks(
  record: BackendSessionRecord,
  description: string,
): Array<{ type: "text"; text: string; textSignature?: string } | { type: "image"; data: string; mimeType: string }> {
  if (record.text !== undefined) {
    return [{ type: "text", text: decodeText(record.text, `${description} text`) }];
  }
  return requireRecordArray(record.content, `${description} content`).map((block) => {
    if (block.type === "text") {
      return {
        type: "text" as const,
        text: decodeText(block.text, `${description} text`),
        ...(block.signature === undefined ? {} : { textSignature: requireString(block.signature, "text signature") }),
      };
    }
    if (block.type === "image") {
      return {
        type: "image" as const,
        data: requireString(block.data, `${description} image data`),
        mimeType: requireString(block.mime_type, `${description} image MIME type`),
      };
    }
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Unknown ${description} block '${String(block.type)}'`);
  });
}

function encodeText(content: string): string | string[] {
  return content.includes("\n") ? content.split("\n") : content;
}

function decodeText(value: unknown, description: string): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("\n");
  throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
}

function requireRecordArray(value: unknown, description: string): BackendSessionRecord[] {
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && typeof item.type === "string")) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
  }
  return value as BackendSessionRecord[];
}

function requireStringArray(value: unknown, description: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
  }
  return [...value];
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
  }
  return value;
}

function requireBoolean(value: unknown, description: string): boolean {
  if (typeof value !== "boolean") {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
  }
  return value;
}

function optionalBoolean(value: unknown, description: string): boolean | undefined {
  return value === undefined ? undefined : requireBoolean(value, description);
}

function requireNonNegativeNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", `Pi ${description} is invalid`);
  }
  return value;
}

function parsePiSessionPayload(value: unknown): PiSessionPayload {
  if (!isRecord(value) || value.version !== 0 || !Array.isArray(value.records)) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session continuation payload is invalid");
  }
  for (const record of value.records) {
    if (!isRecord(record) || typeof record.type !== "string" || record.type.length === 0 || !isJsonValue(record)) {
      throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session continuation contains invalid entries");
    }
  }
  return {
    version: 0,
    records: structuredClone(value.records) as BackendSessionRecord[],
  };
}

function isSessionDurabilityEvent(event: AgentHarnessEvent): boolean {
  return event.type === "message_end" || event.type === "save_point" ||
    event.type === "session_compact" || event.type === "session_tree";
}

function jsonRoundTrip(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("value is not JSON serializable");
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new AgentExecutorError("AGENT_SESSION_INVALID", "Pi session cannot be serialized", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every((item) => item !== undefined && isJsonValue(item));
}

function mapEvent(event: AgentHarnessEvent): AgentExecutionEvent | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "message.delta", text: event.assistantMessageEvent.delta };
  }
  if (event.type === "tool_execution_start") {
    return { type: "tool.requested", id: event.toolCallId, name: event.toolName };
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

function workspaceContextPrompt(workspace: AgentWorkspaceSet): string {
  const lines = [
    `Primary workspace: ${workspace.primary.root}`,
    "Use the primary workspace as the working directory for file and command operations.",
  ];
  if (workspace.readOnly.length > 0) {
    lines.push(
      "Read-only workspaces (context only; do not modify them):",
      ...workspace.readOnly.map((item) => `- ${item.root}`),
    );
  }
  return lines.join("\n");
}

function sandboxWorkspaceContextPrompt(workspace: AgentWorkspaceSet, elevationAvailable: boolean): string {
  const lines = [
    "Primary workspace: /workspace",
    "Use /workspace as the working directory for file and command operations.",
  ];
  if (elevationAvailable) {
    lines.push(
      "When a tool is soft-blocked by policy, try a safer alternative first. Use afl_elevated_tool with the same tool and arguments only when the alternative cost is unacceptable, and explain why.",
      "When an otherwise safe operation actually fails because the sandbox cannot access a host resource, afl_elevated_tool may retry the same tool and arguments on the host after approval.",
      "For host retries, relative paths use the primary host workspace; do not pass /workspace as a host path.",
      "Hard policy denials must not be retried through elevation. Use afl_transaction_request only when the user must perform an external action.",
    );
  }
  if (workspace.readOnly.length > 0) {
    lines.push(
      "Read-only workspaces (context only; do not modify them):",
      ...workspace.readOnly.map((item, index) => `- ${item.root} -> /readonly/${index}`),
    );
  }
  return lines.join("\n");
}

function codingTools(): AgentHarnessTool<ExecutionToolContext>[] {
  return [
    createReadTool(),
    createListTool(),
    createSearchTool(),
    createBashTool(),
    createEditTool(),
    createWriteTool(),
  ];
}

const LIST_TOOL_SCHEMA = Type.Object({
  path: Type.Optional(Type.String({
    description: "Directory to list, relative to the primary workspace or an absolute sandbox path",
  })),
});

function createListTool(): AgentHarnessTool<ExecutionToolContext, typeof LIST_TOOL_SCHEMA> {
  return {
    name: "list",
    label: "list",
    description: "List the direct children of a directory without modifying it.",
    parameters: LIST_TOOL_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, { env }) {
      const result = await env.listDir(params.path ?? ".", signal);
      if (!result.ok) throw result.error;
      const entries = [...result.value]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.kind === "directory" ? "d" : entry.kind === "symlink" ? "l" : "f"}\t${entry.name}\t${entry.size}`);
      return {
        content: [{ type: "text", text: entries.length === 0 ? "[empty directory]" : entries.join("\n") }],
        details: undefined,
      };
    },
  };
}

const SEARCH_TOOL_SCHEMA = Type.Object({
  query: Type.String({ minLength: 1, description: "Literal text to find" }),
  path: Type.Optional(Type.String({
    description: "File or directory to search, relative to the primary workspace or an absolute sandbox path",
  })),
  case_sensitive: Type.Optional(Type.Boolean({ description: "Whether matching is case-sensitive; defaults to true" })),
  max_results: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 500,
    description: "Maximum matching lines to return; defaults to 100",
  })),
});

function createSearchTool(): AgentHarnessTool<ExecutionToolContext, typeof SEARCH_TOOL_SCHEMA> {
  return {
    name: "search",
    label: "search",
    description: "Recursively search UTF-8 workspace files for literal text without modifying them.",
    parameters: SEARCH_TOOL_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, { env }) {
      const root = await env.absolutePath(params.path ?? ".", signal);
      if (!root.ok) throw root.error;
      const files = await collectSearchFiles(env, root.value, signal);
      const query = params.case_sensitive === false ? params.query.toLocaleLowerCase() : params.query;
      const limit = params.max_results ?? 100;
      const matches: string[] = [];
      for (const file of files) {
        if (matches.length >= limit) break;
        const content = await env.readTextFile(file, signal);
        if (!content.ok || content.value.includes("\0")) continue;
        const lines = content.value.split(/\r?\n/u);
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          const line = lines[index]!;
          const candidate = params.case_sensitive === false ? line.toLocaleLowerCase() : line;
          if (candidate.includes(query)) matches.push(`${file}:${index + 1}:${line.slice(0, 1_000)}`);
        }
      }
      return {
        content: [{ type: "text", text: matches.length === 0 ? "[no matches]" : matches.join("\n") }],
        details: { matches: matches.length, truncated: matches.length >= limit },
      };
    },
  };
}

async function collectSearchFiles(
  env: ExecutionToolContext["env"],
  root: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const info = await env.fileInfo(root, signal);
  if (!info.ok) throw info.error;
  if (info.value.kind === "file") return info.value.size <= 2_000_000 ? [root] : [];
  if (info.value.kind !== "directory") return [];
  const files: string[] = [];
  const directories = [root];
  let visited = 0;
  while (directories.length > 0 && visited < 10_000) {
    const directory = directories.pop()!;
    const listed = await env.listDir(directory, signal);
    if (!listed.ok) {
      if (directory === root) throw listed.error;
      continue;
    }
    for (const entry of listed.value) {
      visited += 1;
      if (visited >= 10_000) break;
      if (entry.kind === "directory") directories.push(entry.path);
      else if (entry.kind === "file" && entry.size <= 2_000_000) files.push(entry.path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function codingToolBoundaries(
  boundary: AgentToolExecutionBoundary,
): Readonly<Record<string, AgentToolExecutionBoundary>> {
  return { read: boundary, list: boundary, search: boundary, bash: boundary, edit: boundary, write: boundary };
}

function createCodingToolActionNormalizer(env: ExecutionToolContext["env"]): (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) => Promise<Readonly<Record<string, unknown>>> {
  return async (toolName, input, signal) => {
    if (toolName === "bash") return { ...input, cwd: env.cwd, env: {}, inheritEnv: true };
    if (toolName !== "read" && toolName !== "list" && toolName !== "search" &&
      toolName !== "edit" && toolName !== "write") return input;
    if (typeof input.path !== "string") return input;
    const resolved = await env.absolutePath(input.path, signal);
    if (!resolved.ok) throw resolved.error;
    return { ...input, path: resolved.value };
  };
}

function piStandardToolName(name: AgentStandardToolName): string {
  return name === "shell" ? "bash" : name;
}

function aflStandardToolName(name: string): string {
  return name === "bash" ? "shell" : name;
}

async function disposeExecutionContext(context: PiExecutionContext<any> | undefined): Promise<void> {
  try {
    await context?.dispose?.();
  } catch {
    // Execution environment cleanup is best-effort during session teardown.
  }
}

function controlToolAliases(tools: readonly AgentControlToolDescriptor[]): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const tool of tools) {
    const alias = piControlToolName(tool.name);
    if (aliases.has(alias)) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `AFL control tools produce duplicate Pi alias '${alias}'`,
      );
    }
    aliases.add(alias);
  }
  return aliases;
}

function piControlToolName(name: string): string {
  const alias = name.replace(/[^a-zA-Z0-9_-]+/gu, "_");
  if (alias.length === 0 || !/^[a-zA-Z0-9_-]+$/u.test(alias)) {
    throw new AgentExecutorError(
      "AGENT_CAPABILITY_UNSUPPORTED",
      `AFL control tool '${name}' cannot be represented by the Pi executor`,
    );
  }
  return alias;
}

function joinPrompts(...prompts: readonly (string | undefined)[]): string | undefined {
  const parts = prompts.filter((value): value is string => value !== undefined && value.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Agent execution was aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
