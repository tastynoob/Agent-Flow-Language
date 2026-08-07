import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type {
  AgentToolActionDisplay,
  AgentToolExecutionBoundary,
} from "./agent-tool-policy.js";

export interface AgentApprovalSubject {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: string;
  readonly backend: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly executionBoundary: AgentToolExecutionBoundary;
  readonly workspace: string;
  readonly display: AgentToolActionDisplay;
}

export type AgentApprovalRequestKind = "tool-elevation" | "transaction";

export interface AgentApprovalRequestDraft {
  readonly kind: AgentApprovalRequestKind;
  readonly subject: AgentApprovalSubject;
  readonly reasons: readonly { readonly policy: string; readonly reason: string }[];
  readonly actionDigest: string;
}

export interface AgentApprovalRequest extends AgentApprovalRequestDraft {
  readonly queueId: string;
  readonly sequence: number;
  readonly requestedAt: string;
}

export type AgentApprovalDecision = "approved" | "denied";

export type AgentApprovalQueueEvent =
  | { readonly type: "queued"; readonly request: AgentApprovalRequest }
  | { readonly type: "presenting"; readonly request: AgentApprovalRequest }
  | { readonly type: "resolved"; readonly request: AgentApprovalRequest; readonly decision: AgentApprovalDecision }
  | { readonly type: "cancelled"; readonly request: AgentApprovalRequest; readonly code: string };

export interface AgentApprovalPresenter {
  present(request: AgentApprovalRequest, signal: AbortSignal): Promise<AgentApprovalDecision>;
}

export interface StdioAgentApprovalPresenterOptions {
  readonly input?: Readable;
  readonly output?: Writable;
}

export interface StdioAgentApprovalPresenter extends AgentApprovalPresenter {
  close(): void;
}

export function createStdioAgentApprovalPresenter(
  options: StdioAgentApprovalPresenterOptions = {},
): StdioAgentApprovalPresenter {
  const output = options.output ?? process.stdout;
  const lines = createInterface({
    input: options.input ?? process.stdin,
    output,
    terminal: false,
  });
  return {
    async present(request, signal) {
      output.write(formatStdioRequest(request));
      const prompt = request.kind === "transaction"
        ? "Mark this transaction completed? [y/N] "
        : "Approve this elevated tool call? [y/N] ";
      const answer = (await lines.question(prompt, { signal })).trim().toLowerCase();
      return answer === "y" || answer === "yes" || answer === "approved" || answer === "completed"
        ? "approved"
        : "denied";
    },
    close() {
      lines.close();
    },
  };
}

export interface AgentApprovalQueue {
  enqueue(
    request: AgentApprovalRequestDraft,
    signal: AbortSignal,
    observer?: (event: AgentApprovalQueueEvent) => void | Promise<void>,
  ): Promise<AgentApprovalDecision>;
  close(): Promise<void>;
}

export type AgentApprovalErrorCode =
  | "AGENT_APPROVAL_UNAVAILABLE"
  | "AGENT_APPROVAL_QUEUE_FULL"
  | "AGENT_APPROVAL_CANCELLED";

export class AgentApprovalError extends Error {
  readonly code: AgentApprovalErrorCode;

  constructor(code: AgentApprovalErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentApprovalError";
    this.code = code;
  }
}

export interface FifoAgentApprovalQueueOptions {
  readonly presenter: AgentApprovalPresenter;
  readonly maxPending?: number;
}

interface PendingApproval {
  readonly request: AgentApprovalRequest;
  readonly signal: AbortSignal;
  readonly observer: ((event: AgentApprovalQueueEvent) => void | Promise<void>) | undefined;
  readonly controller: AbortController;
  readonly resolve: (decision: AgentApprovalDecision) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  queuedEvent: Promise<void>;
  settled: boolean;
}

export class FifoAgentApprovalQueue implements AgentApprovalQueue {
  private readonly presenter: AgentApprovalPresenter;
  private readonly maxPending: number;
  private readonly pending: PendingApproval[] = [];
  private active: PendingApproval | undefined;
  private activeTask: Promise<void> | undefined;
  private sequence = 0;
  private closed = false;

  constructor(options: FifoAgentApprovalQueueOptions) {
    if (!Number.isInteger(options.maxPending ?? 64) || (options.maxPending ?? 64) <= 0) {
      throw new TypeError("approval queue maxPending must be a positive integer");
    }
    this.presenter = options.presenter;
    this.maxPending = options.maxPending ?? 64;
  }

  enqueue(
    draft: AgentApprovalRequestDraft,
    signal: AbortSignal,
    observer?: (event: AgentApprovalQueueEvent) => void | Promise<void>,
  ): Promise<AgentApprovalDecision> {
    if (this.closed) {
      return Promise.reject(new AgentApprovalError(
        "AGENT_APPROVAL_UNAVAILABLE",
        "Agent approval queue is closed",
      ));
    }
    if (signal.aborted) return Promise.reject(cancelled(signal));
    if (this.pending.length + (this.active === undefined ? 0 : 1) >= this.maxPending) {
      return Promise.reject(new AgentApprovalError(
        "AGENT_APPROVAL_QUEUE_FULL",
        `Agent approval queue reached its ${this.maxPending} request limit`,
      ));
    }
    this.sequence += 1;
    const request = snapshotRequest({
      ...draft,
      queueId: `human-${this.sequence}-${randomUUID()}`,
      sequence: this.sequence,
      requestedAt: new Date().toISOString(),
    });
    return new Promise<AgentApprovalDecision>((resolve, reject) => {
      const controller = new AbortController();
      const item: PendingApproval = {
        request,
        signal,
        observer,
        controller,
        resolve,
        reject,
        queuedEvent: Promise.resolve(),
        settled: false,
        onAbort: () => this.cancel(item, cancelled(signal)),
      };
      signal.addEventListener("abort", item.onAbort, { once: true });
      this.pending.push(item);
      item.queuedEvent = emit(item, { type: "queued", request });
      this.drain();
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.activeTask;
      return;
    }
    this.closed = true;
    const error = new AgentApprovalError("AGENT_APPROVAL_UNAVAILABLE", "Agent approval queue was closed");
    for (const item of this.pending.splice(0)) this.cancel(item, error);
    if (this.active !== undefined) this.cancel(this.active, error);
    await this.activeTask;
  }

  private drain(): void {
    if (this.closed || this.active !== undefined) return;
    let item: PendingApproval | undefined;
    while ((item = this.pending.shift()) !== undefined) {
      if (!item.settled && !item.signal.aborted) break;
      if (!item.settled) this.cancel(item, cancelled(item.signal));
      item = undefined;
    }
    if (item === undefined) return;
    this.active = item;
    this.activeTask = this.present(item).finally(() => {
      if (this.active === item) this.active = undefined;
      this.activeTask = undefined;
      this.drain();
    });
  }

  private async present(item: PendingApproval): Promise<void> {
    await item.queuedEvent;
    await emit(item, { type: "presenting", request: item.request });
    if (item.settled) return;
    try {
      const decision = await this.presenter.present(item.request, item.controller.signal);
      if (decision !== "approved" && decision !== "denied") {
        throw new TypeError("approval presenter returned an invalid decision");
      }
      if (item.settled) return;
      item.settled = true;
      item.signal.removeEventListener("abort", item.onAbort);
      await emit(item, { type: "resolved", request: item.request, decision });
      item.resolve(decision);
    } catch (error) {
      if (item.settled) return;
      const failure = item.controller.signal.aborted
        ? new AgentApprovalError("AGENT_APPROVAL_CANCELLED", "Agent approval was cancelled", { cause: error })
        : new AgentApprovalError("AGENT_APPROVAL_UNAVAILABLE", "Agent approval presenter failed", { cause: error });
      this.cancel(item, failure);
    }
  }

  private cancel(item: PendingApproval, error: AgentApprovalError): void {
    if (item.settled) return;
    item.settled = true;
    item.signal.removeEventListener("abort", item.onAbort);
    const index = this.pending.indexOf(item);
    if (index >= 0) this.pending.splice(index, 1);
    item.controller.abort(error);
    void item.queuedEvent.then(() => emit(item, {
      type: "cancelled",
      request: item.request,
      code: error.code,
    }));
    item.reject(error);
  }
}

function snapshotRequest(request: AgentApprovalRequest): AgentApprovalRequest {
  return deepFreeze(structuredClone(request));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function emit(item: PendingApproval, event: AgentApprovalQueueEvent): Promise<void> {
  try {
    await item.observer?.(event);
  } catch {
    // Observability cannot change an approval decision or stall the queue.
  }
}

function cancelled(signal: AbortSignal): AgentApprovalError {
  return new AgentApprovalError("AGENT_APPROVAL_CANCELLED", "Agent approval was cancelled", {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
}

function formatStdioRequest(request: AgentApprovalRequest): string {
  return [
    `\n[AFL human request #${request.sequence}]`,
    `kind: ${request.kind}`,
    `location: ${request.subject.node}:${request.subject.block}`,
    `agent: ${request.subject.agent}`,
    `tool: ${request.subject.toolName} (${request.subject.executionBoundary})`,
    `workspace: ${request.subject.workspace}`,
    `title: ${request.subject.display.title}`,
    `summary: ${request.subject.display.summary}`,
    ...request.reasons.map((reason) => `reason[${reason.policy}]: ${reason.reason}`),
    `request-id: ${request.queueId}`,
    "",
  ].join("\n");
}
