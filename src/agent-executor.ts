import type { AgentAdapter, AgentRunRequest } from "./adapters.js";
import type { AgentControlToolDescriptor, AgentStandardToolDescriptor } from "./agent-tools.js";
import type { AgentOutputFormat, ComputeValue, SymbolRef } from "./ir.js";
import {
  AFL_MESSAGE_ROLE_SCHEMA,
  type AgentMemoryContract,
  type BackendSessionJournalDelta,
  type BackendSessionState,
  type Message,
} from "./memory.js";
import type { AgentWorkspaceSet } from "./workspace.js";
import type {
  AgentToolAction,
  AgentToolActionDisplay,
  AgentToolExecutionBoundary,
} from "./agent-tool-policy.js";

export interface AgentExecutorCapabilities {
  readonly nativeSession: boolean;
  readonly checkpoint: boolean;
  readonly fork: boolean;
  readonly workspaceContext: boolean;
  readonly readOnlyWorkspaceContext: boolean;
  readonly structuredOutput: boolean;
  readonly interrupt: boolean;
  readonly dynamicControlTools: boolean;
  readonly standardTools: boolean;
  /** Every external-effect tool is authorized through AgentExecutionHost before execution. */
  readonly toolAuthorization: boolean;
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
  readonly tools?: readonly AgentStandardToolDescriptor[];
  readonly session?: BackendSessionRef;
  readonly sessionMemoryRevision?: number;
  readonly format?: AgentOutputFormat;
  readonly control?: AgentControlActivation;
  /** Stable VM operation identity used to resume this Agent activation and its VM-owned control effects. */
  readonly operationId?: string;
  readonly recovery?: AgentExecutionRecovery;
  readonly signal: AbortSignal;
}

export interface AgentExecutionRecovery {
  readonly mode: "resume";
  readonly operationId: string;
}

export interface AgentControlActivation {
  readonly tools: readonly AgentControlToolDescriptor[];
}

export interface AgentControlToolRequest {
  readonly id: string;
  readonly name: `afl.${string}`;
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface AgentControlToolResult {
  readonly content: string;
  readonly details?: ComputeValue;
}

export interface AgentControlToolCompletionRequest {
  readonly id: string;
  readonly name: `afl.${string}`;
  readonly ok: boolean;
}

export interface AgentFormatOutputSubmissionRequest {
  readonly id: string;
  readonly content: string;
  readonly signal: AbortSignal;
}

export type AgentFormatOutputSubmissionResult =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly code: string; readonly message: string };

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
  | { readonly type: "tool.requested"; readonly id: string; readonly name: string }
  | {
      readonly type: "tool.policy";
      readonly id: string;
      readonly name: string;
      readonly verdict: "allow" | "block" | "deny";
      readonly covered: boolean;
      readonly policy?: string;
      readonly code?: string;
      readonly reason?: string;
    }
  | {
      readonly type: "transaction.state";
      readonly id: string;
      readonly title: string;
      readonly state: "queued" | "presenting" | "completed" | "denied" | "cancelled" | "unavailable";
      readonly sequence?: number;
    }
  | {
      readonly type: "elevation.state";
      readonly id: string;
      readonly name: string;
      readonly state: "queued" | "presenting" | "approved" | "denied" | "cancelled" | "unavailable";
      readonly sequence?: number;
    }
  | { readonly type: "tool.started"; readonly id: string; readonly name: string }
  | { readonly type: "tool.updated"; readonly id: string; readonly name: string }
  | { readonly type: "tool.completed"; readonly id: string; readonly name: string; readonly ok: boolean }
  | { readonly type: "usage.updated"; readonly usage: Readonly<Record<string, number>> }
  | { readonly type: "warning"; readonly message: string };

export interface AgentInputRequest {
  /** Stable logical request identity within one Agent activation. */
  readonly id: string;
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentTransactionRequest {
  readonly id: string;
  readonly title: string;
  readonly request: string;
  readonly reason: string;
  readonly resumeWhen?: string;
  readonly signal: AbortSignal;
}

export type AgentTransactionResult =
  | { readonly status: "completed" }
  | { readonly status: "denied"; readonly message: string }
  | { readonly status: "unavailable"; readonly code: string; readonly message: string };

export interface AgentElevationRequest {
  readonly id: string;
  readonly capability?: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly executionBoundary: Exclude<AgentToolExecutionBoundary, "host-control">;
  readonly reason: string;
  readonly display: AgentToolActionDisplay;
  readonly signal: AbortSignal;
}

export interface AgentExecutionHost {
  emit(event: AgentExecutionEvent): void | Promise<void>;
  persistContinuation(delta: BackendSessionJournalDelta): void | Promise<void>;
  authorizeTool(action: AgentToolAction): Promise<AgentToolAuthorization>;
  requestElevation(request: AgentElevationRequest): Promise<AgentToolAuthorization>;
  requestTransaction(request: AgentTransactionRequest): Promise<AgentTransactionResult>;
  requestInput(request: AgentInputRequest): Promise<string>;
  submitFormattedOutput(
    request: AgentFormatOutputSubmissionRequest,
  ): Promise<AgentFormatOutputSubmissionResult>;
  executeControlTool(request: AgentControlToolRequest): Promise<AgentControlToolResult>;
  /** Called after the executor has durably incorporated the control-tool result. */
  completeControlTool(request: AgentControlToolCompletionRequest): void | Promise<void>;
}

export type AgentToolAuthorization =
  | { readonly status: "allowed"; readonly requestId: string }
  | {
      readonly status: "denied";
      readonly requestId: string;
      readonly code: string;
      readonly reason: string;
      readonly elevatable?: boolean;
    };

export interface AgentInteractionHost {
  emit?(event: AgentExecutionEvent): void | Promise<void>;
  requestInput?(request: AgentInputRequest): Promise<string>;
}

export interface AgentExecutorBackend {
  readonly name: string;
  readonly sessionFormat?: string;
  /** Stable non-secret identity for model, tool, and backend semantics used by recovery. */
  readonly recoveryIdentity?: string;
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
  | "AGENT_FORMAT_OUTPUT_MISSING"
  | "AGENT_MEMORY_ROLE_UNSUPPORTED"
  | "AGENT_TOOL_POLICY_DENIED"
  | "AGENT_TOOL_POLICY_FAILED"
  | "AGENT_TOOL_POLICY_UNCOVERED"
  | "AGENT_APPROVAL_UNAVAILABLE"
  | "AGENT_APPROVAL_QUEUE_FULL"
  | "AGENT_APPROVAL_CANCELLED"
  | "AGENT_ELEVATION_DENIED"
  | "AGENT_ELEVATION_UNAVAILABLE"
  | "AGENT_SANDBOX_UNAVAILABLE"
  | "AGENT_SANDBOX_INIT_FAILED"
  | "AGENT_SANDBOX_TERMINATED"
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
  dynamicControlTools: false,
  standardTools: false,
  toolAuthorization: false,
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
    if (request.control !== undefined) {
      throw new AgentExecutorError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        "Agent adapter backend does not support activation-scoped AFL control tools",
      );
    }
    await this.memory.validateImport(request.agent, AFL_MESSAGE_ROLE_SCHEMA, request.memory);
    const adapterRequest: AgentRunRequest = {
      runId: request.runId,
      node: request.node,
      block: request.block,
      agent: request.agent,
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      workspace: request.workspace,
      messages: request.memory,
      ...(request.format === undefined ? {} : { format: request.format }),
      signal: request.signal,
    };
    const result = await this.adapter.run(adapterRequest);
    return {
      output: result.output,
      stopReason: "completed",
    };
  }
}
