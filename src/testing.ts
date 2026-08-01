import type {
  AgentAdapter,
  AgentInvokeRequest,
  CheckpointAdapter,
  CheckpointRequest,
  EventAdapter,
  EventEmitRequest,
  EventWaitRequest,
  TraceEvent,
  TraceSink,
} from "./adapters.js";
import { FlowRuntimeError } from "./errors.js";
import type { JsonValue } from "./ir.js";
import { cloneJson } from "./value.js";

export type MockAgentHandler = (
  input: JsonValue,
  request: AgentInvokeRequest,
) => JsonValue | Promise<JsonValue>;

export class MockAgentAdapter implements AgentAdapter {
  readonly calls: AgentInvokeRequest[] = [];
  private readonly handlers = new Map<string, MockAgentHandler>();

  on(agent: string, operation: string, handler: MockAgentHandler): this {
    this.handlers.set(`${agent}.${operation}`, handler);
    return this;
  }

  async invoke(request: AgentInvokeRequest): Promise<JsonValue> {
    if (request.signal.aborted) {
      throw request.signal.reason;
    }
    this.calls.push({ ...request, input: cloneJson(request.input) });
    const handler = this.handlers.get(`${request.agent}.${request.operation}`);
    if (handler === undefined) {
      throw new FlowRuntimeError(
        "MOCK_HANDLER_MISSING",
        `no mock handler for '${request.agent}.${request.operation}'`,
      );
    }
    return cloneJson(await handler(cloneJson(request.input), request));
  }
}

export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  emit(event: TraceEvent): void {
    this.events.push(structuredClone(event));
  }
}

export class MemoryCheckpointAdapter implements CheckpointAdapter {
  readonly checkpoints: CheckpointRequest[] = [];

  async save(request: CheckpointRequest): Promise<void> {
    this.checkpoints.push({
      ...request,
      input: cloneJson(request.input),
      state: cloneJson(request.state),
    });
  }
}

export class QueueEventAdapter implements EventAdapter {
  readonly emitted: EventEmitRequest[] = [];
  private readonly queued = new Map<string, JsonValue[]>();
  private readonly waiters = new Map<
    string,
    Array<{
      resolve: (value: JsonValue) => void;
      reject: (error: unknown) => void;
      cleanup: () => void;
    }>
  >();

  push(event: string, payload: JsonValue): void {
    const waiter = this.waiters.get(event)?.shift();
    if (waiter !== undefined) {
      waiter.cleanup();
      waiter.resolve(cloneJson(payload));
      return;
    }
    const queue = this.queued.get(event) ?? [];
    queue.push(cloneJson(payload));
    this.queued.set(event, queue);
  }

  async emit(request: EventEmitRequest): Promise<void> {
    this.emitted.push({ ...request, payload: cloneJson(request.payload) });
    this.push(request.event, request.payload);
  }

  async wait(request: EventWaitRequest): Promise<JsonValue> {
    if (request.signal.aborted) {
      throw request.signal.reason;
    }
    const queue = this.queued.get(request.event);
    const queued = queue?.shift();
    if (queued !== undefined) {
      return cloneJson(queued);
    }
    return new Promise<JsonValue>((resolve, reject) => {
      let onAbort: () => void;
      const cleanup = (): void => request.signal.removeEventListener("abort", onAbort);
      const waiter = { resolve, reject, cleanup };
      const waiters = this.waiters.get(request.event) ?? [];
      waiters.push(waiter);
      this.waiters.set(request.event, waiters);
      onAbort = (): void => {
        const current = this.waiters.get(request.event);
        const index = current?.indexOf(waiter) ?? -1;
        if (index >= 0) {
          current!.splice(index, 1);
        }
        cleanup();
        reject(request.signal.reason);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
