import type {
  AgentAdapter,
  AgentRunRequest,
  AgentRunResult,
  TraceEvent,
  TraceSink,
} from "./adapters.js";
import { FlowRuntimeError } from "./errors.js";

export type MockAgentHandler = (
  request: AgentRunRequest,
) => string | AgentRunResult | Promise<string | AgentRunResult>;

export class MockAgentAdapter implements AgentAdapter {
  readonly calls: AgentRunRequest[] = [];
  private readonly handlers = new Map<string, MockAgentHandler>();

  on(agent: string, handler: MockAgentHandler): this {
    this.handlers.set(agent, handler);
    return this;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.signal.aborted) throw request.signal.reason;
    this.calls.push(cloneRequest(request));
    const handler = this.handlers.get(request.agent.name);
    if (handler === undefined) {
      throw new FlowRuntimeError("MOCK_HANDLER_MISSING", `no mock handler for '${request.agent.name}'`);
    }
    const result = await handler(request);
    return typeof result === "string" ? { output: result } : structuredClone(result);
  }
}

export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];

  emit(event: TraceEvent): void {
    this.events.push(structuredClone(event));
  }
}

function cloneRequest(request: AgentRunRequest): AgentRunRequest {
  return {
    ...request,
    messages: structuredClone(request.messages),
    signal: request.signal,
  };
}
