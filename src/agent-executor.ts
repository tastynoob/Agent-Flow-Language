import type { AgentAdapter, AgentRunRequest } from "./adapters.js";
import type { SymbolRef } from "./ir.js";
import {
  AFL_MESSAGE_ROLE_SCHEMA,
  type AgentMemoryContract,
  type BackendSessionJournalDelta,
  type BackendSessionState,
  type Message,
} from "./memory.js";
import type { AgentWorkspaceSet } from "./workspace.js";

export interface AgentExecutorCapabilities {
  readonly nativeSession: boolean;
  readonly checkpoint: boolean;
  readonly fork: boolean;
  readonly workspaceContext: boolean;
  readonly readOnlyWorkspaceContext: boolean;
  readonly structuredOutput: boolean;
  readonly interrupt: boolean;
  readonly toolCallInterception: boolean;
  readonly interactiveApproval: boolean;
  readonly sandboxEnforcement: boolean;
}

export interface BackendSessionRef {
  readonly backend: string;
  readonly id: string;
  readonly checkpoint?: string;
}

export interface AgentSessionImportRequest {
  readonly state: BackendSessionState;
  readonly agent: SymbolRef;
  readonly systemPrompt?: string;
  readonly workspace: AgentWorkspaceSet;
  readonly signal: AbortSignal;
}

export interface AgentExecutionRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly systemPrompt?: string;
  readonly memory: readonly Message[];
  readonly memoryRevision: number;
  readonly workspace: AgentWorkspaceSet;
  readonly session?: BackendSessionRef;
  readonly sessionMemoryRevision?: number;
  readonly schema?: SymbolRef;
  readonly signal: AbortSignal;
}

export type AgentExecutionStopReason =
  | "completed"
  | "blocked"
  | "budget_exhausted"
  | "cancelled";

export interface AgentExecutionResult {
  readonly output: string;
  readonly stopReason: AgentExecutionStopReason;
  readonly session?: BackendSessionRef;
  readonly usage?: Readonly<Record<string, number>>;
}

export type AgentExecutionEvent =
  | { readonly type: "message.delta"; readonly text: string }
  | { readonly type: "tool.started"; readonly id: string; readonly name: string }
  | { readonly type: "tool.updated"; readonly id: string; readonly name: string }
  | { readonly type: "tool.completed"; readonly id: string; readonly name: string; readonly ok: boolean }
  | { readonly type: "usage.updated"; readonly usage: Readonly<Record<string, number>> }
  | { readonly type: "warning"; readonly message: string };

export interface AgentApprovalRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly action: "tool";
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type AgentApprovalDecision = "approved" | "denied";

export interface AgentInputRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly prompt: string;
}

export interface AgentExecutionHost {
  emit(event: AgentExecutionEvent): void | Promise<void>;
  persistContinuation(delta: BackendSessionJournalDelta): void | Promise<void>;
  requestApproval(request: AgentApprovalRequest): Promise<AgentApprovalDecision>;
  requestInput(request: AgentInputRequest): Promise<string>;
}

export interface AgentExecutorBackend {
  readonly name: string;
  readonly sessionFormat?: string;
  readonly capabilities: AgentExecutorCapabilities;
  readonly memory: AgentMemoryContract;

  execute(request: AgentExecutionRequest, host: AgentExecutionHost): Promise<AgentExecutionResult>;
  checkpoint?(session: BackendSessionRef, signal: AbortSignal): Promise<BackendSessionRef>;
  fork?(session: BackendSessionRef, signal: AbortSignal): Promise<BackendSessionRef>;
  exportSession?(session: BackendSessionRef, signal: AbortSignal): Promise<BackendSessionState>;
  importSession?(request: AgentSessionImportRequest): Promise<BackendSessionRef>;
  close?(session: BackendSessionRef, signal: AbortSignal): Promise<void>;
}

export type AgentExecutorErrorCode =
  | "AGENT_EXECUTOR_UNAVAILABLE"
  | "AGENT_BINDING_MISSING"
  | "AGENT_CAPABILITY_UNSUPPORTED"
  | "AGENT_SESSION_INVALID"
  | "AGENT_MEMORY_REVISION_INVALID"
  | "AGENT_MEMORY_ROLE_UNSUPPORTED"
  | "AGENT_APPROVAL_DENIED"
  | "AGENT_EXECUTION_FAILED";

export class AgentExecutorError extends Error {
  readonly code: AgentExecutorErrorCode;

  constructor(code: AgentExecutorErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentExecutorError";
    this.code = code;
  }
}

const STATELESS_CAPABILITIES = {
  nativeSession: false,
  checkpoint: false,
  fork: false,
  structuredOutput: false,
  interrupt: true,
  toolCallInterception: false,
  interactiveApproval: false,
  sandboxEnforcement: false,
} as const;

const PERMISSIVE_MEMORY: AgentMemoryContract = Object.freeze({
  capabilities: Object.freeze({
    roleSchemas: [AFL_MESSAGE_ROLE_SCHEMA],
    importRoles: ["*"] as const,
  }),
  validateImport: () => {},
});

export class AgentAdapterExecutorBackend implements AgentExecutorBackend {
  readonly name = "agent-adapter";
  readonly capabilities: AgentExecutorCapabilities;
  readonly memory: AgentMemoryContract;

  constructor(private readonly adapter: AgentAdapter) {
    this.capabilities = Object.freeze({
      ...STATELESS_CAPABILITIES,
      workspaceContext: adapter.workspaceCapabilities?.workspaceContext ?? false,
      readOnlyWorkspaceContext: adapter.workspaceCapabilities?.readOnlyWorkspaceContext ?? false,
    });
    this.memory = adapter.memory ?? PERMISSIVE_MEMORY;
  }

  async execute(request: AgentExecutionRequest, _host: AgentExecutionHost): Promise<AgentExecutionResult> {
    await this.memory.validateImport(request.agent, AFL_MESSAGE_ROLE_SCHEMA, request.memory);
    const adapterRequest: AgentRunRequest = {
      runId: request.runId,
      node: request.node,
      block: request.block,
      agent: request.agent,
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      workspace: request.workspace,
      messages: request.memory,
      ...(request.schema === undefined ? {} : { schema: request.schema }),
      signal: request.signal,
    };
    const result = await this.adapter.run(adapterRequest);
    return {
      output: result.output,
      stopReason: "completed",
    };
  }
}
