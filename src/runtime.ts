import type {
  AgentInvokeRequest,
  RuntimeBindings,
  TraceEvent,
  TraceEventType,
} from "./adapters.js";
import { FlowRuntimeError, normalizeRuntimeError } from "./errors.js";
import { evaluateExpr, type EvaluationFrame } from "./expression.js";
import type {
  AflProgram,
  FlowDefinition,
  FlowNode,
  FreedomPlan,
  JsonValue,
  SlotTarget,
} from "./ir.js";
import {
  assertValidProgram,
  validateFreedomPlan,
  type ValidationIssue,
} from "./validation.js";
import { cloneJson, isJsonValue, isRecord, validateDataValue } from "./value.js";

export interface RunOptions {
  runId?: string;
  signal?: AbortSignal;
  maxSteps?: number;
}

export interface RunResult {
  runId: string;
  output: JsonValue;
}

interface MutableFrame extends EvaluationFrame {
  flowId: string;
  definition: FlowDefinition;
  input: JsonValue;
  state: Record<string, JsonValue | undefined>;
  locals: Record<string, JsonValue | undefined>;
}

interface RunContext {
  runId: string;
  signal: AbortSignal;
  maxSteps: number;
  counters: {
    steps: number;
    traceSequence: number;
    revisionSequence: number;
    closed: boolean;
  };
}

type NodeResult = { type: "normal" } | { type: "return"; value: JsonValue };

const NORMAL: NodeResult = { type: "normal" };

let runSequence = 0;

export class AflRuntime {
  readonly program: AflProgram;
  readonly bindings: RuntimeBindings;

  constructor(program: unknown, bindings: RuntimeBindings) {
    this.program = assertValidProgram(program);
    this.bindings = bindings;
  }

  async run(input: JsonValue, options: RunOptions = {}): Promise<RunResult> {
    const linked = linkedController(options.signal);
    const context: RunContext = {
      runId: options.runId ?? createRunId(),
      signal: linked.controller.signal,
      maxSteps: options.maxSteps ?? 100_000,
      counters: {
        steps: 0,
        traceSequence: 0,
        revisionSequence: 0,
        closed: false,
      },
    };
    if (!Number.isInteger(context.maxSteps) || context.maxSteps <= 0) {
      linked.dispose();
      throw new FlowRuntimeError("RUN_OPTIONS_INVALID", "maxSteps must be a positive integer");
    }

    try {
      await this.trace(context, "run.started");
      const output = await this.executeFlow(this.program.entry, input, context);
      await this.trace(context, "run.completed");
      return { runId: context.runId, output };
    } catch (error) {
      const runtimeError = normalizeRuntimeError(error);
      await this.trace(context, "run.failed", { error: runtimeError });
      throw runtimeError;
    } finally {
      context.counters.closed = true;
      linked.dispose();
    }
  }

  private async executeFlow(
    flowId: string,
    input: JsonValue,
    context: RunContext,
    definition = this.program.flows[flowId],
  ): Promise<JsonValue> {
    if (definition === undefined) {
      throw new FlowRuntimeError("FLOW_UNKNOWN", `flow '${flowId}' is not declared`);
    }
    this.assertSchema(input, definition.input, `input for flow '${flowId}'`);
    const frame: MutableFrame = {
      flowId,
      definition,
      input: cloneJson(input),
      state: initializeSlots(definition.state),
      locals: initializeSlots(definition.locals),
    };
    await this.trace(context, "flow.started", { flowId });
    try {
      const result = await this.executeNode(definition.body, frame, context);
      const output = result.type === "return" ? result.value : null;
      this.assertSchema(output, definition.output, `output from flow '${flowId}'`);
      await this.trace(context, "flow.completed", { flowId });
      return cloneJson(output);
    } catch (error) {
      const runtimeError = normalizeRuntimeError(error);
      await this.trace(context, "flow.failed", { flowId, error: runtimeError });
      throw runtimeError;
    }
  }

  private async executeNode(
    node: FlowNode,
    frame: MutableFrame,
    context: RunContext,
  ): Promise<NodeResult> {
    throwIfCancelled(context.signal);
    context.counters.steps += 1;
    if (context.counters.steps > context.maxSteps) {
      throw new FlowRuntimeError(
        "RUN_STEP_BUDGET_EXCEEDED",
        `run exceeded ${context.maxSteps} node executions`,
        { nodeId: node.id },
      );
    }
    await this.trace(context, "node.started", { flowId: frame.flowId, nodeId: node.id });
    try {
      const result = await this.executeNodeInner(node, frame, context);
      await this.trace(context, "node.completed", {
        flowId: frame.flowId,
        nodeId: node.id,
      });
      return result;
    } catch (error) {
      const runtimeError = normalizeRuntimeError(error, node.id);
      await this.trace(context, "node.failed", {
        flowId: frame.flowId,
        nodeId: node.id,
        error: runtimeError,
      });
      throw runtimeError;
    }
  }

  private async executeNodeInner(
    node: FlowNode,
    frame: MutableFrame,
    context: RunContext,
  ): Promise<NodeResult> {
    switch (node.kind) {
      case "noop":
        return NORMAL;
      case "sequence":
        for (const step of node.steps) {
          const result = await this.executeNode(step, frame, context);
          if (result.type === "return") {
            return result;
          }
        }
        return NORMAL;
      case "assign":
        this.writeTarget(frame, node.target, evaluateExpr(node.value, frame));
        return NORMAL;
      case "invoke": {
        const output = await this.invokeAgent(
          frame,
          node.id,
          node.agent,
          node.operation,
          evaluateExpr(node.input, frame),
          context,
        );
        if (node.assign !== undefined) {
          this.writeTarget(frame, node.assign, output);
        }
        return NORMAL;
      }
      case "callFlow": {
        const output = await this.executeFlow(
          node.flow,
          evaluateExpr(node.input, frame),
          context,
        );
        if (node.assign !== undefined) {
          this.writeTarget(frame, node.assign, output);
        }
        return NORMAL;
      }
      case "branch":
        for (const branchCase of node.cases) {
          if (expectCondition(evaluateExpr(branchCase.when, frame), node.id)) {
            return this.executeNode(branchCase.then, frame, context);
          }
        }
        return node.default === undefined
          ? NORMAL
          : this.executeNode(node.default, frame, context);
      case "loop":
        for (let iteration = 0; iteration < node.maxIterations; iteration += 1) {
          if (!expectCondition(evaluateExpr(node.condition, frame), node.id)) {
            return NORMAL;
          }
          const result = await this.executeNode(node.body, frame, context);
          if (result.type === "return") {
            return result;
          }
        }
        if (expectCondition(evaluateExpr(node.condition, frame), node.id)) {
          throw new FlowRuntimeError(
            "LOOP_LIMIT_EXCEEDED",
            `loop reached maxIterations=${node.maxIterations}`,
          );
        }
        return NORMAL;
      case "forEach": {
        const items = evaluateExpr(node.items, frame);
        if (!Array.isArray(items)) {
          throw new FlowRuntimeError("FOREACH_ITEMS_NOT_ARRAY", "forEach items must evaluate to an array");
        }
        const results = await this.executeForEach(node, items, frame, context);
        if (node.assign !== undefined) {
          this.writeTarget(frame, node.assign, results);
        }
        return NORMAL;
      }
      case "parallel": {
        const output = await this.executeParallel(node, frame, context);
        if (node.assign !== undefined) {
          this.writeTarget(frame, node.assign, output);
        }
        return NORMAL;
      }
      case "retry":
        return this.executeRetry(node, frame, context);
      case "timeout":
        return this.executeTimeout(node, frame, context);
      case "try":
        return this.executeTry(node, frame, context);
      case "delay": {
        const duration = evaluateExpr(node.durationMs, frame);
        if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
          throw new FlowRuntimeError(
            "DELAY_DURATION_INVALID",
            "delay durationMs must evaluate to a non-negative finite number",
          );
        }
        await cancellableDelay(duration, context.signal);
        return NORMAL;
      }
      case "emit": {
        if (this.bindings.events === undefined) {
          throw new FlowRuntimeError("EVENT_ADAPTER_MISSING", "emit requires an event adapter");
        }
        const payload = evaluateExpr(node.payload, frame);
        await this.bindings.events.emit({
          runId: context.runId,
          flowId: frame.flowId,
          nodeId: node.id,
          event: node.event,
          payload,
          signal: context.signal,
        });
        await this.trace(context, "event.emitted", {
          flowId: frame.flowId,
          nodeId: node.id,
          details: { event: node.event },
        });
        return NORMAL;
      }
      case "awaitEvent": {
        if (this.bindings.events === undefined) {
          throw new FlowRuntimeError("EVENT_ADAPTER_MISSING", "awaitEvent requires an event adapter");
        }
        const wait = async (signal: AbortSignal): Promise<JsonValue> =>
          this.bindings.events!.wait({
            runId: context.runId,
            flowId: frame.flowId,
            nodeId: node.id,
            event: node.event,
            signal,
          });
        const payload = node.timeoutMs === undefined
          ? await wait(context.signal)
          : await promiseWithTimeout(wait, node.timeoutMs, context.signal, node.id);
        if (!isJsonValue(payload)) {
          throw new FlowRuntimeError("EVENT_PAYLOAD_NOT_JSON", "event adapter returned a non-JSON payload");
        }
        if (node.assign !== undefined) {
          this.writeTarget(frame, node.assign, payload);
        }
        await this.trace(context, "event.received", {
          flowId: frame.flowId,
          nodeId: node.id,
          details: { event: node.event },
        });
        return NORMAL;
      }
      case "checkpoint": {
        if (this.bindings.checkpoints === undefined) {
          throw new FlowRuntimeError(
            "CHECKPOINT_ADAPTER_MISSING",
            "checkpoint requires a checkpoint adapter",
          );
        }
        await this.bindings.checkpoints.save({
          runId: context.runId,
          flowId: frame.flowId,
          nodeId: node.id,
          ...(node.label === undefined ? {} : { label: node.label }),
          input: cloneJson(frame.input),
          state: initializedValues(frame.state),
          traceSequence: context.counters.traceSequence,
          signal: context.signal,
        });
        await this.trace(context, "checkpoint.created", {
          flowId: frame.flowId,
          nodeId: node.id,
          ...(node.label === undefined ? {} : { details: { label: node.label } }),
        });
        return NORMAL;
      }
      case "freedom": {
        const rawPlan = await this.invokeAgent(
          frame,
          node.id,
          node.planner,
          node.operation,
          evaluateExpr(node.context, frame),
          context,
        );
        const result = validateFreedomPlan(
          this.program,
          frame.flowId,
          rawPlan,
          node.constraints,
        );
        const planHash = hashJson(rawPlan);
        await this.trace(context, "freedom.plan.created", {
          flowId: frame.flowId,
          nodeId: node.id,
          details: { planHash },
        });
        if (!result.ok) {
          await this.trace(context, "freedom.plan.rejected", {
            flowId: frame.flowId,
            nodeId: node.id,
            details: { planHash, issues: issuesAsJson(result.issues) },
          });
          throw new FlowRuntimeError(
            "FREEDOM_PLAN_INVALID",
            "freedom planner returned invalid or disallowed IR",
            { details: { planHash, issues: issuesAsJson(result.issues) } },
          );
        }
        const approved = await this.bindings.policy?.approveFreedom?.({
          program: this.program,
          runId: context.runId,
          flowId: frame.flowId,
          nodeId: node.id,
          plan: result.value,
          planHash,
        });
        if (approved === false) {
          await this.trace(context, "freedom.plan.rejected", {
            flowId: frame.flowId,
            nodeId: node.id,
            details: { planHash, reason: "policy" },
          });
          throw new FlowRuntimeError("FREEDOM_PLAN_DENIED", "freedom plan was denied by policy");
        }
        await this.trace(context, "freedom.plan.accepted", {
          flowId: frame.flowId,
          nodeId: node.id,
          details: { planHash, kind: result.value.kind },
        });
        const output = await this.executeFreedomPlan(result.value, frame, context, node.id);
        if (node.assign !== undefined) {
          this.writeTarget(frame, node.assign, output);
        }
        return NORMAL;
      }
      case "return":
        return { type: "return", value: evaluateExpr(node.value, frame) };
      case "fail": {
        const error = evaluateExpr(node.error, frame);
        if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
          throw new FlowRuntimeError(error.code, error.message, {
            ...(isJsonValue(error.details) ? { details: error.details } : {}),
          });
        }
        throw new FlowRuntimeError("FLOW_FAILED", "flow entered a fail node", { details: error });
      }
    }
  }

  private async invokeAgent(
    frame: MutableFrame,
    nodeId: string,
    agentId: string,
    operationId: string,
    input: JsonValue,
    context: RunContext,
  ): Promise<JsonValue> {
    const declaration = this.program.agents?.[agentId];
    const operationDeclaration = declaration?.operations[operationId];
    if (declaration === undefined || operationDeclaration === undefined) {
      throw new FlowRuntimeError(
        "AGENT_BINDING_INVALID",
        `agent operation '${agentId}.${operationId}' is not declared`,
      );
    }
    this.assertSchema(input, operationDeclaration.input, `input for '${agentId}.${operationId}'`);
    const request: AgentInvokeRequest = {
      runId: context.runId,
      flowId: frame.flowId,
      nodeId,
      agent: agentId,
      operation: operationId,
      declaration,
      operationDeclaration,
      input: cloneJson(input),
      signal: context.signal,
    };
    const authorized = await this.bindings.policy?.authorizeAgent?.(request);
    if (authorized === false) {
      throw new FlowRuntimeError(
        "AGENT_CALL_DENIED",
        `agent call '${agentId}.${operationId}' was denied by policy`,
      );
    }
    await this.trace(context, "agent.started", {
      flowId: frame.flowId,
      nodeId,
      details: { agent: agentId, operation: operationId },
    });
    try {
      const output = await this.bindings.agents.invoke(request);
      throwIfCancelled(context.signal);
      if (!isJsonValue(output)) {
        throw new FlowRuntimeError(
          "AGENT_OUTPUT_NOT_JSON",
          `agent '${agentId}.${operationId}' returned a non-JSON value`,
        );
      }
      this.assertSchema(output, operationDeclaration.output, `output from '${agentId}.${operationId}'`);
      await this.trace(context, "agent.completed", {
        flowId: frame.flowId,
        nodeId,
        details: { agent: agentId, operation: operationId },
      });
      return cloneJson(output);
    } catch (error) {
      const runtimeError = normalizeRuntimeError(error, nodeId);
      await this.trace(context, "agent.failed", {
        flowId: frame.flowId,
        nodeId,
        details: { agent: agentId, operation: operationId },
        error: runtimeError,
      });
      throw runtimeError;
    }
  }

  private async executeForEach(
    node: Extract<FlowNode, { kind: "forEach" }>,
    items: JsonValue[],
    frame: MutableFrame,
    context: RunContext,
  ): Promise<JsonValue[]> {
    if (items.length === 0) {
      return [];
    }
    const concurrency = Math.min(node.maxConcurrency ?? 1, items.length);
    const results: JsonValue[] = new Array(items.length);
    const linked = linkedController(context.signal);
    const childContext = { ...context, signal: linked.controller.signal };
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        const childFrame = cloneFrame(frame);
        this.writeTarget(childFrame, { scope: "local", name: node.item }, items[index] as JsonValue);
        if (node.index !== undefined) {
          this.writeTarget(childFrame, { scope: "local", name: node.index }, index);
        }
        const result = await this.executeNode(node.body, childFrame, childContext);
        results[index] = result.type === "return" ? result.value : null;
      }
    };
    const workers = Array.from({ length: concurrency }, () => worker());
    try {
      await Promise.all(workers);
      return results;
    } catch (error) {
      linked.controller.abort(error);
      await Promise.allSettled(workers);
      throw error;
    } finally {
      linked.dispose();
    }
  }

  private async executeParallel(
    node: Extract<FlowNode, { kind: "parallel" }>,
    frame: MutableFrame,
    context: RunContext,
  ): Promise<JsonValue> {
    const linked = linkedController(context.signal);
    const childContext = { ...context, signal: linked.controller.signal };
    const tasks = node.branches.map(async (branch) => {
      const childFrame = cloneFrame(frame);
      const result = await this.executeNode(branch.body, childFrame, childContext);
      return {
        branch: branch.id,
        value: result.type === "return" ? result.value : null,
      };
    });
    try {
      if (node.mode === "all") {
        const completed = await Promise.all(tasks);
        return Object.fromEntries(completed.map((item) => [item.branch, item.value]));
      }
      if (node.mode === "allSettled") {
        const settled = await Promise.allSettled(tasks);
        return Object.fromEntries(
          settled.map((item, index) => {
            const branch = node.branches[index]!.id;
            return item.status === "fulfilled"
              ? [branch, { status: "fulfilled", value: item.value.value }]
              : [
                  branch,
                  {
                    status: "rejected",
                    error: normalizeRuntimeError(item.reason).serialize(),
                  },
                ];
          }),
        ) as JsonValue;
      }
      try {
        const winner = await Promise.any(tasks);
        linked.controller.abort(
          new FlowRuntimeError("CANCELLED", `parallel race won by '${winner.branch}'`),
        );
        await Promise.allSettled(tasks);
        return { branch: winner.branch, value: winner.value };
      } catch (error) {
        if (error instanceof AggregateError) {
          const first = error.errors[0];
          throw normalizeRuntimeError(first ?? error);
        }
        throw error;
      }
    } catch (error) {
      linked.controller.abort(error);
      await Promise.allSettled(tasks);
      throw error;
    } finally {
      linked.dispose();
    }
  }

  private async executeRetry(
    node: Extract<FlowNode, { kind: "retry" }>,
    frame: MutableFrame,
    context: RunContext,
  ): Promise<NodeResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= node.maxAttempts; attempt += 1) {
      throwIfCancelled(context.signal);
      const attemptFrame = cloneFrame(frame);
      try {
        const result = await this.executeNode(node.body, attemptFrame, context);
        commitFrame(frame, attemptFrame);
        return result;
      } catch (error) {
        const runtimeError = normalizeRuntimeError(error);
        if (runtimeError.code === "CANCELLED") {
          throw runtimeError;
        }
        lastError = runtimeError;
        if (attempt < node.maxAttempts) {
          await cancellableDelay(retryDelay(node, attempt), context.signal);
        }
      }
    }
    throw normalizeRuntimeError(lastError);
  }

  private async executeTimeout(
    node: Extract<FlowNode, { kind: "timeout" }>,
    frame: MutableFrame,
    context: RunContext,
  ): Promise<NodeResult> {
    const childFrame = cloneFrame(frame);
    const result = await promiseWithTimeout(
      async (signal) => {
        const childContext = { ...context, signal };
        const childResult = await this.executeNode(node.body, childFrame, childContext);
        return childResult;
      },
      node.timeoutMs,
      context.signal,
      node.id,
    );
    commitFrame(frame, childFrame);
    return result;
  }

  private async executeTry(
    node: Extract<FlowNode, { kind: "try" }>,
    frame: MutableFrame,
    context: RunContext,
  ): Promise<NodeResult> {
    let result: NodeResult = NORMAL;
    let pendingError: unknown;
    try {
      result = await this.executeNode(node.body, frame, context);
    } catch (error) {
      const runtimeError = normalizeRuntimeError(error);
      if (runtimeError.code === "CANCELLED" || node.catch === undefined) {
        pendingError = runtimeError;
      } else {
        try {
          this.writeTarget(
            frame,
            { scope: "local", name: node.catch.error },
            runtimeError.serialize() as unknown as JsonValue,
          );
          result = await this.executeNode(node.catch.body, frame, context);
        } catch (catchError) {
          pendingError = catchError;
        }
      }
    }

    if (node.finally !== undefined) {
      try {
        const finalResult = await this.executeNode(node.finally, frame, context);
        if (finalResult.type === "return") {
          result = finalResult;
          pendingError = undefined;
        }
      } catch (finalError) {
        pendingError = finalError;
      }
    }
    if (pendingError !== undefined) {
      throw pendingError;
    }
    return result;
  }

  private async executeFreedomPlan(
    plan: FreedomPlan,
    frame: MutableFrame,
    context: RunContext,
    nodeId: string,
  ): Promise<JsonValue> {
    if (plan.kind === "continuation") {
      const result = await this.executeNode(plan.body, frame, context);
      return result.type === "return" ? result.value : null;
    }
    context.counters.revisionSequence += 1;
    const revisionId = `${frame.flowId}#revision-${context.counters.revisionSequence}`;
    await this.trace(context, "revision.created", {
      flowId: frame.flowId,
      nodeId,
      details: { revisionId },
    });
    return this.executeFlow(revisionId, plan.input, context, plan.flow);
  }

  private writeTarget(frame: MutableFrame, target: SlotTarget, value: JsonValue): void {
    const declaration = target.scope === "state"
      ? frame.definition.state?.[target.name]
      : frame.definition.locals?.[target.name];
    if (declaration === undefined) {
      throw new FlowRuntimeError(
        "TARGET_UNKNOWN",
        `${target.scope} slot '${target.name}' is not declared`,
      );
    }
    this.assertSchema(value, declaration.schema, `${target.scope} slot '${target.name}'`);
    const slots = target.scope === "state" ? frame.state : frame.locals;
    slots[target.name] = cloneJson(value);
  }

  private assertSchema(value: unknown, schema: FlowDefinition["input"], label: string): void {
    const issues = validateDataValue(value, schema, this.program.schemas);
    if (issues.length > 0) {
      throw new FlowRuntimeError("SCHEMA_VALUE_INVALID", `${label} does not match its schema`, {
        details: { issues: issuesAsJson(issues) },
      });
    }
  }

  private async trace(
    context: RunContext,
    type: TraceEventType,
    options: {
      flowId?: string;
      nodeId?: string;
      details?: JsonValue;
      error?: FlowRuntimeError;
    } = {},
  ): Promise<void> {
    if (context.counters.closed) {
      return;
    }
    context.counters.traceSequence += 1;
    const event: TraceEvent = {
      sequence: context.counters.traceSequence,
      timestamp: new Date().toISOString(),
      runId: context.runId,
      type,
      ...(options.flowId === undefined ? {} : { flowId: options.flowId }),
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.error === undefined ? {} : { error: options.error.serialize() }),
    };
    await this.bindings.trace?.emit(event);
  }
}

function initializeSlots(
  declarations: FlowDefinition["state"] | FlowDefinition["locals"],
): Record<string, JsonValue | undefined> {
  return Object.fromEntries(
    Object.entries(declarations ?? {}).map(([name, declaration]) => [
      name,
      declaration.initial === undefined ? undefined : cloneJson(declaration.initial),
    ]),
  );
}

function initializedValues(
  slots: Readonly<Record<string, JsonValue | undefined>>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(slots)
      .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
      .map(([name, value]) => [name, cloneJson(value)]),
  );
}

function cloneFrame(frame: MutableFrame): MutableFrame {
  return {
    flowId: frame.flowId,
    definition: frame.definition,
    input: cloneJson(frame.input),
    state: cloneSlots(frame.state),
    locals: cloneSlots(frame.locals),
  };
}

function cloneSlots(
  slots: Readonly<Record<string, JsonValue | undefined>>,
): Record<string, JsonValue | undefined> {
  return Object.fromEntries(
    Object.entries(slots).map(([name, value]) => [
      name,
      value === undefined ? undefined : cloneJson(value),
    ]),
  );
}

function commitFrame(target: MutableFrame, source: MutableFrame): void {
  target.state = cloneSlots(source.state);
  target.locals = cloneSlots(source.locals);
}

function expectCondition(value: JsonValue, nodeId: string): boolean {
  if (typeof value !== "boolean") {
    throw new FlowRuntimeError(
      "CONDITION_NOT_BOOLEAN",
      "branch and loop conditions must evaluate to boolean",
      { nodeId },
    );
  }
  return value;
}

function retryDelay(
  node: Extract<FlowNode, { kind: "retry" }>,
  failedAttempt: number,
): number {
  if (node.backoff === undefined) {
    return 0;
  }
  const delay = node.backoff.kind === "fixed"
    ? node.backoff.delayMs
    : node.backoff.delayMs * 2 ** (failedAttempt - 1);
  return Math.min(delay, node.backoff.maxDelayMs ?? delay);
}

async function promiseWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal,
  nodeId: string,
): Promise<T> {
  const linked = linkedController(parentSignal);
  const timeoutError = new FlowRuntimeError(
    "TIMEOUT",
    `operation timed out after ${timeoutMs}ms`,
    { nodeId },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      linked.controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(linked.controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    linked.dispose();
  }
}

function cancellableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cancelledError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function linkedController(parent?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener("abort", onAbort, { once: true });
  }
  return {
    controller,
    dispose: () => parent?.removeEventListener("abort", onAbort),
  };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError(signal);
  }
}

function cancelledError(signal: AbortSignal): FlowRuntimeError {
  return signal.reason instanceof FlowRuntimeError
    ? signal.reason
    : new FlowRuntimeError("CANCELLED", "run was cancelled", { cause: signal.reason });
}

function issuesAsJson(issues: ReadonlyArray<ValidationIssue>): JsonValue[] {
  return issues.map((item) => ({
    path: item.path,
    code: item.code,
    message: item.message,
  }));
}

function hashJson(value: JsonValue): string {
  const canonical = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createRunId(): string {
  runSequence += 1;
  return `run-${Date.now().toString(36)}-${runSequence.toString(36)}`;
}
