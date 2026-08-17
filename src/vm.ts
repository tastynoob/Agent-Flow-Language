import { isAbsolute, resolve } from "node:path";

import type {
  AgentRunRequest,
  PromptArgument,
  VmArgument,
  VmBindings,
  TraceEvent,
  TraceEventType,
} from "./adapters.js";
import {
  AgentAdapterExecutorBackend,
  type AgentControlActivation,
  type AgentControlToolRequest,
  type AgentControlToolResult,
  AgentExecutorError,
  type AgentExecutionHost,
  type AgentExecutionRequest,
  type AgentExecutionStopReason,
  type AgentExecutorBackend,
  type AgentElevationRequest,
  type AgentToolAuthorization,
  type AgentTransactionRequest,
  type AgentTransactionResult,
  type BackendSessionRef,
} from "./agent-executor.js";
import { AgentApprovalError, type AgentApprovalQueueEvent } from "./approval-queue.js";
import {
  AgentToolPolicyEngine,
  agentToolActionDigest,
  createAgentToolActionDisplay,
  redactAgentToolText,
  snapshotAgentToolAction,
  type AgentToolAction,
} from "./agent-tool-policy.js";
import {
  linkedController,
  ResourceLocks,
  Semaphore,
  throwIfAborted,
  WorkspaceLocks,
} from "./concurrency.js";
import { buildInstructionDependencies, instructionDestination } from "./dependencies.js";
import { computeAflBuiltinFunction, type AflBuiltinArgument } from "./builtin-functions.js";
import {
  asAgent,
  asCompute,
  asFrag,
  asMemory,
  asTaskGroup,
  evaluateOper,
  evaluateValue,
  formatCompute,
} from "./evaluator.js";
import { AflParseError, AflValidationError, AflVmError, normalizeVmError, type AflDiagnostic } from "./errors.js";
import {
  freedomControlTools,
  parseFreedomLimits,
  type FreedomLimits,
} from "./freedom.js";
import {
  frag,
  isComputeValue,
  isFrag,
  symbol,
  type AflBlock,
  type AflInstruction,
  type AflModule,
  type AflNode,
  type ComputeValue,
  type FlowCallExpr,
  type FlowTarget,
  type AgentControlInstruction,
  type AgentControlMode,
  type AgentStandardToolName,
  type Frag,
  type SourceSpan,
  type SymbolExpr,
  type SymbolRef,
  type ValueExpr,
} from "./ir.js";
import { parseAfl } from "./parser.js";
import {
  RunMemoryPersistence,
  type AgentAttemptEnd,
  type MemoryPersistenceAttempt,
} from "./memory-store.js";
import {
  AFL_MESSAGE_ROLE_SCHEMA,
  canonicalModuleDigest,
  type AgentInterruptionContext,
  type Message,
  type PersistedMemoryContinuation,
} from "./memory.js";
import {
  isAgentHandle,
  isMemoryHandle,
  isSymbolRef,
  type AgentOrigin,
  type AgentHandle,
  type MemoryCheckpoint,
  type MemoryHandle,
  type VmValue,
  type TaskGroupHandle,
} from "./vm-values.js";
import { assertValidModule, validateModule } from "./validation.js";
import {
  defaultAgentWorkspacePath,
  resolveAgentWorkspace,
  resolveExecutionRoot,
  type AgentWorkspaceSet,
  workspacePathOverlap,
  workspaceKey,
} from "./workspace.js";

export interface VmRunOptions {
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly executionRoot?: string;
}

export interface VmRunResult {
  readonly runId: string;
  readonly output: VmValue;
}

interface MutableFrame {
  readonly module: AflModule;
  readonly node: AflNode;
  readonly values: Map<string, VmValue>;
  readonly taskGroups: Set<TaskGroupHandle>;
}

interface VmRunContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly maxSteps: number;
  readonly external: Semaphore;
  readonly locks: ResourceLocks;
  readonly workspaceLocks: WorkspaceLocks;
  readonly executionRoot: string;
  readonly rootModuleDigest: string;
  readonly persistence: RunMemoryPersistence;
  readonly counters: {
    steps: number;
    trace: number;
    handles: number;
  };
}

interface ActivationContext {
  readonly path: string;
  readonly moduleDigest: string;
  readonly blockVisits: Map<string, number>;
  readonly freedomDepth: number;
  readonly forbiddenWriterWorkspace?: AgentWorkspaceSet;
  readonly freedomRouteTracker?: FreedomRouteTracker;
}

interface FreedomRuntime {
  readonly activation: AgentControlActivation;
  execute(request: AgentControlToolRequest): Promise<AgentControlToolResult>;
}

interface FreedomScope {
  readonly instruction: AgentControlInstruction;
  readonly planner: AgentHandle;
  readonly origin: AgentOrigin;
  readonly context: VmRunContext;
  readonly location: Required<TraceLocation>;
  readonly signal: AbortSignal;
  readonly constraint: Readonly<Record<string, ComputeValue>>;
  readonly limits: FreedomLimits;
  readonly freedomDepth: number;
  readonly nodes: ReadonlyMap<string, AflNode>;
  readonly agents: readonly SymbolRef[];
  readonly refs: Map<string, VmArgument>;
  readonly routes: QueuedFreedomRoute[];
  nextRouteOrder: number;
  readonly counts: {
    control: number;
    route: number;
    completedNode: number;
    completedIr: number;
    validation: number;
    execution: number;
    result: number;
  };
}

interface QueuedFreedomRoute {
  readonly order: number;
  readonly requestId: string;
  readonly target: FlowTarget;
  readonly args: readonly VmArgument[];
}

interface TaskGroupWork {
  readonly span: SourceSpan;
  execute(signal: AbortSignal, index: number): Promise<VmValue>;
}

interface FreedomRouteTracker {
  readonly scope: FreedomScope;
  readonly generatedNodes: ReadonlySet<string>;
}

interface GeneratedIrValidation {
  readonly valid: boolean;
  readonly digest?: string;
  readonly module?: AflModule;
  readonly overlay?: AflModule;
  readonly diagnostics: readonly AflDiagnostic[];
}

interface TraceLocation {
  readonly node?: string;
  readonly block?: string;
  readonly instruction?: number;
}

let runSequence = 0;

export class AflVm {
  readonly module: AflModule;
  readonly bindings: VmBindings;
  private readonly agentExecutor: AgentExecutorBackend | undefined;
  private readonly agentToolPolicy: AgentToolPolicyEngine | undefined;

  constructor(module: AflModule, bindings: VmBindings) {
    this.module = assertValidModule(module);
    this.bindings = bindings;
    validateVmPolicy(bindings, module.nodes[0]?.span ?? { line: 1, column: 1, endColumn: 1 });
    this.agentExecutor = bindings.agentExecutor ?? (
      bindings.agents === undefined ? undefined : new AgentAdapterExecutorBackend(bindings.agents)
    );
    const preTool = bindings.agentSecurity?.preTool;
    this.agentToolPolicy = preTool === undefined || preTool === false
      ? undefined
      : new AgentToolPolicyEngine(preTool);
  }

  static fromSource(source: string, bindings: VmBindings, sourceName?: string): AflVm {
    return new AflVm(parseAfl(source, sourceName), bindings);
  }

  async run(
    entry = "main",
    args: readonly VmArgument[] = [],
    options: VmRunOptions = {},
  ): Promise<VmRunResult> {
    const linked = linkedController(options.signal);
    const maxSteps = options.maxSteps ?? 100_000;
    const maxConcurrency = this.bindings.policy?.maxConcurrency ?? 32;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      linked.dispose();
      throw new AflVmError("RUN_OPTIONS_INVALID", "maxSteps must be a positive integer");
    }
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      linked.dispose();
      throw new AflVmError("VM_POLICY_INVALID", "maxConcurrency must be a positive integer");
    }
    const runId = options.runId ?? createRunId();
    const rootModuleDigest = canonicalModuleDigest(this.module);
    let persistence: RunMemoryPersistence | undefined;
    let executionRoot: string;
    try {
      executionRoot = await resolveExecutionRoot(options.executionRoot ?? process.cwd(), linked.controller.signal);
      persistence = await RunMemoryPersistence.open(
        this.bindings.memoryPersistence,
        executionRoot,
        runId,
        rootModuleDigest,
        linked.controller.signal,
      );
    } catch (error) {
      linked.dispose();
      throw normalizeVmError(error);
    }
    const context: VmRunContext = {
      runId,
      signal: linked.controller.signal,
      maxSteps,
      external: new Semaphore(maxConcurrency),
      locks: new ResourceLocks(),
      workspaceLocks: new WorkspaceLocks(),
      executionRoot,
      rootModuleDigest,
      persistence,
      counters: { steps: 0, trace: 0, handles: 0 },
    };
    try {
      await this.trace(context, "run.started", {}, { entry });
      const output = await this.executeNode(this.module, entry, [...args], context, context.signal, "root");
      await persistence.close();
      await this.trace(context, "run.completed", {}, { entry });
      return { runId: context.runId, output };
    } catch (error) {
      let vmError = normalizeVmError(error);
      const interruption = interruptionContext(vmError);
      if (interruption === undefined) {
        await this.trace(context, "run.failed", {}, undefined, vmError);
      } else {
        linked.controller.abort(vmError);
        let shutdownError: unknown;
        try {
          await persistence.recordRunInterruption(
            { code: vmError.code, message: vmError.message },
            interruption,
          );
        } catch (persistenceError) {
          shutdownError = persistenceError;
        }
        try {
          await persistence.close();
        } catch (persistenceError) {
          shutdownError ??= persistenceError;
        }
        if (shutdownError !== undefined) {
          vmError = withInterruptionShutdownError(vmError, shutdownError);
        }
        await this.trace(context, "run.interrupted", {}, {
          entry,
          interruption: interruptionDetails(interruption),
        }, vmError).catch(() => {});
      }
      throw vmError;
    } finally {
      await persistence.close().catch(() => {});
      linked.controller.abort(new AflVmError("RUN_CLOSED", "AFL run has closed"));
      linked.dispose();
    }
  }

  private async executeNode(
    module: AflModule,
    nodeName: string,
    args: readonly VmValue[],
    context: VmRunContext,
    invocationSignal: AbortSignal = context.signal,
    activationPath = "root",
    forbiddenWriterWorkspace?: AgentWorkspaceSet,
    freedomDepth = 0,
    freedomRouteTracker?: FreedomRouteTracker,
  ): Promise<VmValue> {
    throwIfAborted(invocationSignal);
    this.takeStep(context, `node '${nodeName}'`, invocationSignal);
    const node = module.nodes.find((candidate) => candidate.name === nodeName);
    if (node === undefined) {
      throw new AflVmError("FLOW_UNKNOWN", `node '${nodeName}' is not declared`);
    }
    if (args.length !== node.parameters.length) {
      throw new AflVmError(
        "CALL_ARITY",
        `node '${nodeName}' expects ${node.parameters.length} arguments, received ${args.length}`,
        { span: node.span },
      );
    }
    const frame: MutableFrame = {
      module,
      node,
      values: new Map(node.parameters.map((parameter, index) => [parameter, cloneVmValue(args[index]!)])),
      taskGroups: new Set(),
    };
    const activation: ActivationContext = {
      path: activationPath,
      moduleDigest: canonicalModuleDigest(module),
      blockVisits: new Map(),
      freedomDepth,
      ...(forbiddenWriterWorkspace === undefined ? {} : { forbiddenWriterWorkspace }),
      ...(freedomRouteTracker === undefined ? {} : { freedomRouteTracker }),
    };
    await this.trace(context, "node.started", { node: node.name });
    try {
      const blocks = new Map(node.blocks.map((block) => [block.name, block]));
      let blockName = "entry";
      for (;;) {
        const block = blocks.get(blockName);
        if (block === undefined) {
          throw new AflVmError("BLOCK_UNKNOWN", `block '${blockName}' is not declared`, { span: node.span });
        }
        this.takeStep(context, `block '${node.name}.${block.name}'`, invocationSignal);
        const blockVisit = activation.blockVisits.get(block.name) ?? 0;
        activation.blockVisits.set(block.name, blockVisit + 1);
        await this.executeBlock(frame, block, context, activation, blockVisit, invocationSignal);
        const terminator = block.terminator;
        if (terminator.op === "ret") {
          this.assertNoOutstandingGroups(frame, terminator.span);
          const output = terminator.value === undefined ? frag("") : evaluateValue(terminator.value, frame);
          await this.trace(context, "node.completed", { node: node.name });
          return output;
        }
        if (terminator.op === "fail") {
          const value = evaluateValue(terminator.error, frame);
          throw new AflVmError("FLOW_FAILED", failureMessage(value), { span: terminator.span });
        }
        if (terminator.op === "jump") {
          blockName = terminator.target;
          continue;
        }
        if (terminator.op === "match") {
          const selector = asCompute(
            evaluateValue(terminator.selector, frame),
            terminator.span,
            "match selector",
          );
          if (!isMatchScalar(selector)) {
            throw new AflVmError(
              "MATCH_SELECTOR_NOT_SCALAR",
              "match selector must be null, boolean, number, or string",
              { span: terminator.span },
            );
          }
          blockName = terminator.cases.find((entry) => entry.value === selector)?.target
            ?? terminator.defaultTarget;
          continue;
        }
        const condition = asCompute(evaluateValue(terminator.condition, frame), terminator.span, "branch condition");
        if (typeof condition !== "boolean") {
          throw new AflVmError("BRANCH_CONDITION_NOT_BOOLEAN", "branch condition must be boolean", {
            span: terminator.span,
          });
        }
        blockName = condition ? terminator.trueTarget : terminator.falseTarget;
      }
    } catch (error) {
      for (const group of frame.taskGroups) group.controller.abort(error);
      if (frame.taskGroups.size > 0) {
        await Promise.allSettled([...frame.taskGroups].flatMap((group) => group.tasks));
      }
      const vmError = normalizeVmError(error, node.span);
      await this.trace(context, "node.failed", { node: node.name }, undefined, vmError);
      throw vmError;
    }
  }

  private async executeBlock(
    frame: MutableFrame,
    block: AflBlock,
    context: VmRunContext,
    activation: ActivationContext,
    blockVisit: number,
    invocationSignal: AbortSignal,
  ): Promise<void> {
    await this.trace(context, "block.started", { node: frame.node.name, block: block.name });
    const linked = linkedController(invocationSignal);
    try {
      const dependencies = buildInstructionDependencies(block);
      this.addRuntimeResourceDependencies(block, frame, dependencies);
      const dependents = new Map<number, number[]>();
      const remaining = dependencies.map((items) => items.size);
      dependencies.forEach((items, consumer) => {
        for (const producer of items) {
          const consumers = dependents.get(producer) ?? [];
          consumers.push(consumer);
          dependents.set(producer, consumers);
        }
      });
      await new Promise<void>((resolve, reject) => {
        let active = 0;
        let completed = 0;
        let failure: AflVmError | undefined;
        const started = new Set<number>();

        const settle = (): void => {
          if (failure !== undefined && active === 0) reject(failure);
          else if (completed === block.instructions.length) resolve();
        };
        const launchReady = (): void => {
          if (failure !== undefined) return;
          for (let index = 0; index < block.instructions.length; index += 1) {
            if (started.has(index) || remaining[index] !== 0) continue;
            started.add(index);
            active += 1;
            const instruction = block.instructions[index]!;
            void this.executeInstruction(
              frame,
              block,
              instruction,
              index,
              context,
              activation,
              blockVisit,
              linked.controller.signal,
            )
              .then((value) => {
                const destination = instructionDestination(instruction);
                if (destination !== undefined && value !== undefined) frame.values.set(destination, value);
                completed += 1;
                active -= 1;
                for (const consumer of dependents.get(index) ?? []) remaining[consumer]! -= 1;
                launchReady();
                settle();
              })
              .catch((error: unknown) => {
                if (failure === undefined) {
                  failure = normalizeVmError(error, instruction.span);
                  linked.controller.abort(failure);
                }
                active -= 1;
                settle();
              });
          }
          if (active === 0 && completed < block.instructions.length && failure === undefined) {
            failure = new AflVmError("DEPENDENCY_DEADLOCK", `block '${block.name}' cannot make progress`, {
              span: block.span,
            });
            settle();
          }
        };
        launchReady();
        settle();
      });
      await this.trace(context, "block.completed", { node: frame.node.name, block: block.name });
    } finally {
      linked.dispose();
    }
  }

  private async executeInstruction(
    frame: MutableFrame,
    block: AflBlock,
    instruction: AflInstruction,
    index: number,
    context: VmRunContext,
    activation: ActivationContext,
    blockVisit: number,
    signal: AbortSignal,
  ): Promise<VmValue | undefined> {
    throwIfAborted(signal);
    this.takeStep(context, `instruction '${instruction.op}'`, signal);
    const location = { node: frame.node.name, block: block.name, instruction: index };
    await this.trace(context, "instruction.started", location, { op: instruction.op });
    try {
      const value = await this.executeInstructionInner(
        frame,
        instruction,
        context,
        activation,
        blockVisit,
        location,
        signal,
      );
      await this.trace(context, "instruction.completed", location, { op: instruction.op });
      return value;
    } catch (error) {
      const vmError = normalizeVmError(error, instruction.span);
      await this.trace(context, "instruction.failed", location, { op: instruction.op }, vmError);
      throw vmError;
    }
  }

  private async executeInstructionInner(
    frame: MutableFrame,
    instruction: AflInstruction,
    context: VmRunContext,
    activation: ActivationContext,
    blockVisit: number,
    location: Required<TraceLocation>,
    signal: AbortSignal,
  ): Promise<VmValue | undefined> {
    switch (instruction.op) {
      case "agent": {
        const allocationSlot = this.memorySlot(
          frame,
          instruction,
          activation,
          blockVisit,
          location,
          "working",
        );
        const workspaceValue = instruction.workspace === undefined
          ? undefined
          : evaluateValue(instruction.workspace, frame);
        const workspace = await resolveAgentWorkspace(
          workspaceValue,
          context.executionRoot,
          defaultAgentWorkspacePath(context.executionRoot, context.runId, allocationSlot),
          signal,
          instruction.workspace?.span,
        );
        const memory = instruction.memory === undefined
          ? this.createMemory(
              context,
              allocationSlot,
              activation.moduleDigest,
            )
          : asMemory(evaluateValue(instruction.memory, frame), instruction.memory.span);
        return context.locks.use([{ key: memory.id, mode: "write" }], signal, () => {
          if (memory.owner !== undefined) {
            throw new AflVmError("MEMORY_ALREADY_BOUND", "Memory is already bound to an Agent", {
              span: instruction.span,
            });
          }
          const agent = this.createAgent(
            context,
            { kind: "symbol", name: instruction.agent.name },
            memory,
            workspace,
            this.agentOrigin(frame, activation, location),
            instruction.tools,
          );
          memory.owner = agent.id;
          return agent;
        });
      }
      case "agent.system_prompt": {
        const agent = asAgent(evaluateValue(instruction.agent, frame), instruction.agent.span);
        const prompt = await this.renderPrompt(instruction.prompt, [], frame, signal);
        const retiredSession = await context.locks.use([
          { key: agent.id, mode: "write" },
          { key: agent.memory.id, mode: "write" },
        ], signal, () => {
          const session = agent.session;
          agent.systemPrompt = prompt.content;
          delete agent.session;
          delete agent.sessionMemoryRevision;
          const state = agent.memory.checkpoint?.state;
          if (state === undefined) {
            delete agent.memory.checkpoint;
          } else {
            agent.memory.checkpoint = {
              state: structuredClone(state),
              memoryRevision: agent.memory.checkpoint!.memoryRevision,
              agent: structuredClone(agent.agent),
              workspaceKey: workspaceKey(agent.workspace),
              systemPrompt: prompt.content,
            };
          }
          return session;
        });
        if (retiredSession !== undefined && this.agentExecutor?.close !== undefined) {
          const cleanupSignal = new AbortController().signal;
          await this.agentExecutor.close(retiredSession, cleanupSignal).catch(() => {});
        }
        return undefined;
      }
      case "agent.do": {
        const agent = asAgent(evaluateValue(instruction.agent, frame), instruction.agent.span);
        const input = asFrag(evaluateValue(instruction.input, frame), instruction.input.span, "Agent input");
        return this.runAgent(
          agent,
          instruction.role ?? "user",
          input,
          instruction.schema,
          context,
          location,
          signal,
          undefined,
          activation.forbiddenWriterWorkspace,
        );
      }
      case "prompt":
        return this.renderPrompt(instruction.source, instruction.args, frame, signal);
      case "input": {
        if (this.bindings.input === undefined) {
          throw new AflVmError("INPUT_ADAPTER_MISSING", "input requires an Input binding", {
            span: instruction.span,
          });
        }
        const prompt = await this.renderPrompt(instruction.prompt, [], frame, signal);
        const content = await this.bindings.input.read({
          runId: context.runId,
          node: location.node,
          block: location.block,
          prompt: prompt.content,
          ...(instruction.schema === undefined ? {} : { schema: toSymbol(instruction.schema) }),
          signal,
        });
        if (typeof content !== "string") {
          throw new AflVmError("INPUT_RESULT_INVALID", "Input binding returned a non-string value", {
            span: instruction.span,
          });
        }
        await this.validateSchema(content, instruction.schema, signal);
        return frag(content);
      }
      case "oper":
        return evaluateOper(instruction.expression, frame);
      case "compute": {
        const args = instruction.args.map((argument) =>
          this.toBuiltinArgument(evaluateValue(argument, frame), argument.span));
        return computeAflBuiltinFunction(instruction.function.name, args, instruction.span);
      }
      case "script": {
        if (this.bindings.scripts === undefined) {
          throw new AflVmError("SCRIPT_ADAPTER_MISSING", `${instruction.language} requires a Script binding`, {
            span: instruction.span,
          });
        }
        const args = instruction.args.map((argument) => asCompute(
          evaluateValue(argument, frame),
          argument.span,
          "script argument",
        ));
        const result = await context.external.use(signal, () => Promise.resolve(this.bindings.scripts!.execute({
          language: instruction.language,
          source: instruction.source,
          args,
          signal,
        })));
        if (!isComputeValue(result)) {
          throw new AflVmError("SCRIPT_RESULT_INVALID", "Script binding returned a non-compute value", {
            span: instruction.span,
          });
        }
        return structuredClone(result);
      }
      case "call": {
        const args = instruction.args.map((argument) => evaluateValue(argument, frame));
        this.reserveGeneratedFreedomRoute(frame.node.name, instruction.target, activation);
        return normalizeFlowResult(
          await this.invokeFlow(
            frame.module,
            instruction.target,
            args,
            context,
            signal,
            this.childActivationPath(activation, location, blockVisit, "call"),
            activation.forbiddenWriterWorkspace,
            activation.freedomDepth,
            activation.freedomRouteTracker,
          ),
          instruction.span,
        );
      }
      case "dispatch": {
        const calls = instruction.calls.map((call) => ({
          target: call.target,
          args: call.args.map((argument) => evaluateValue(argument, frame)),
          span: call.span,
        }));
        return this.startDispatch(frame, calls, context, activation, blockVisit, location, signal);
      }
      case "repeat": {
        const count = asCompute(evaluateValue(instruction.count, frame), instruction.count.span, "repeat count");
        if (!Number.isInteger(count) || typeof count !== "number" || count < 0) {
          throw new AflVmError("DISPATCH_COUNT_INVALID", "repeat count must be a non-negative integer", {
            span: instruction.count.span,
          });
        }
        const args = instruction.args.map((argument) => evaluateValue(argument, frame));
        const calls = Array.from({ length: count }, () => ({
          target: instruction.target,
          args: args.map(cloneVmValue),
          span: instruction.span,
        }));
        return this.startDispatch(frame, calls, context, activation, blockVisit, location, signal);
      }
      case "sync": {
        const group = asTaskGroup(evaluateValue(instruction.taskGroup, frame), instruction.taskGroup.span);
        if (group.consumed) {
          throw new AflVmError("TASK_GROUP_ALREADY_SYNCED", "TaskGroup has already been synced", {
            span: instruction.span,
          });
        }
        group.consumed = true;
        frame.taskGroups.delete(group);
        const settled = await Promise.allSettled(group.tasks);
        group.dispose();
        const failure = selectTaskGroupFailure(settled);
        if (failure !== undefined) throw failure.reason;
        const values = settled.map((item) => (item as PromiseFulfilledResult<Frag>).value);
        const content = instruction.formatter === undefined
          ? JSON.stringify(values.map((value) => value.content))
          : await this.requireFormatter().format({
              formatter: toSymbol(instruction.formatter),
              values,
              signal,
            });
        if (typeof content !== "string") {
          throw new AflVmError("FORMATTER_RESULT_INVALID", "Formatter binding returned a non-string value", {
            span: instruction.span,
          });
        }
        await this.trace(context, "dispatch.completed", location, { taskGroup: group.id, count: values.length });
        return frag(content);
      }
      case "fork": {
        const source = asAgent(evaluateValue(instruction.sourceAgent, frame), instruction.sourceAgent.span);
        await this.trace(context, "fork.started", location, { source: source.id });
        const snapshot = await context.locks.use(
          [{ key: source.id, mode: "read" }, { key: source.memory.id, mode: "read" }],
          signal,
          () => {
            context.persistence.capture(
              source.memory.slot,
              source.memory.moduleDigest,
              source.memory.messages,
              source.memory.revision,
              persistedContinuation(source.memory.checkpoint),
              source.memory.base,
            );
            return {
              messages: cloneMessages(source.memory.messages),
              checkpoint: cloneMemoryCheckpoint(source.memory.checkpoint),
              base: { slot: source.memory.slot, revision: source.memory.revision },
              systemPrompt: source.systemPrompt,
              agent: source.agent,
              workspace: source.workspace,
              tools: source.tools,
            };
          },
        );
        const memory = this.createMemory(
          context,
          this.memorySlot(frame, instruction, activation, blockVisit, location, "fork"),
          activation.moduleDigest,
          snapshot.messages,
          snapshot.checkpoint,
          snapshot.base,
        );
        const branch = this.createAgent(
          context,
          snapshot.agent,
          memory,
          snapshot.workspace,
          this.agentOrigin(frame, activation, location),
          snapshot.tools,
        );
        memory.owner = branch.id;
        if (snapshot.systemPrompt !== undefined) branch.systemPrompt = snapshot.systemPrompt;
        const input = asFrag(evaluateValue(instruction.action.input, frame), instruction.action.input.span, "fork input");
        await this.runAgent(
          branch,
          instruction.action.role ?? "user",
          input,
          instruction.action.schema,
          context,
          location,
          signal,
          undefined,
          activation.forbiddenWriterWorkspace,
        );
        await this.trace(context, "fork.completed", location, { source: source.id, branch: branch.id });
        return branch;
      }
      case "invoke": {
        if (this.bindings.capabilities === undefined) {
          throw new AflVmError("CAPABILITY_ADAPTER_MISSING", "invoke requires a Capability binding", {
            span: instruction.span,
          });
        }
        const args = instruction.args.map((argument) =>
          this.toPromptArgument(evaluateValue(argument, frame), argument.span));
        const request = {
          runId: context.runId,
          node: location.node,
          block: location.block,
          executionRoot: context.executionRoot,
          capability: toSymbol(instruction.capability),
          args,
          signal,
        };
        const approved = await this.bindings.policy?.authorizeCapability?.(request);
        if (approved === false) {
          throw new AflVmError("CAPABILITY_DENIED", `capability '${request.capability.name}' was denied`, {
            span: instruction.span,
          });
        }
        const result = await context.external.use(signal, () => Promise.resolve(
          this.bindings.capabilities!.invoke(request),
        ));
        if (typeof result === "string") return frag(result);
        if (isFrag(result)) return result;
        throw new AflVmError("CAPABILITY_RESULT_INVALID", "Capability binding returned an invalid value", {
          span: instruction.span,
        });
      }
      case "memory.append": {
        const memory = asMemory(evaluateValue(instruction.memory, frame), instruction.memory.span);
        const value = asFrag(evaluateValue(instruction.frag, frame), instruction.frag.span, "memory.append value");
        await context.locks.use([{ key: memory.id, mode: "write" }], signal, async () => {
          appendMemoryMessage(memory, { role: instruction.role, content: value.content });
          if (context.persistence.isMaterialized(memory.slot)) {
            await this.persistMemory(context, memory, signal);
          }
        });
        return undefined;
      }
      case "memory.copy": {
        const memory = asMemory(evaluateValue(instruction.memory, frame), instruction.memory.span);
        const snapshot = await context.locks.use(
          [{ key: memory.id, mode: "read" }],
          signal,
          () => {
            context.persistence.capture(
              memory.slot,
              memory.moduleDigest,
              memory.messages,
              memory.revision,
              persistedContinuation(memory.checkpoint),
              memory.base,
            );
            return {
              messages: cloneMessages(memory.messages),
              checkpoint: cloneMemoryCheckpoint(memory.checkpoint),
              base: { slot: memory.slot, revision: memory.revision },
            };
          },
        );
        const copy = this.createMemory(
          context,
          this.memorySlot(frame, instruction, activation, blockVisit, location, "copy"),
          activation.moduleDigest,
          snapshot.messages,
          snapshot.checkpoint,
          snapshot.base,
        );
        return copy;
      }
      case "agent.with_memory": {
        const source = asAgent(evaluateValue(instruction.agent, frame), instruction.agent.span);
        const memory = asMemory(evaluateValue(instruction.memory, frame), instruction.memory.span);
        return context.locks.use(
          [{ key: source.id, mode: "read" }, { key: memory.id, mode: "write" }],
          signal,
          () => {
            if (memory.owner !== undefined) {
              throw new AflVmError("MEMORY_ALREADY_BOUND", "Memory is already bound to an Agent", {
                span: instruction.span,
              });
            }
            const agent = this.createAgent(
              context,
              source.agent,
              memory,
              source.workspace,
              this.agentOrigin(frame, activation, location),
              source.tools,
            );
            if (source.systemPrompt !== undefined) agent.systemPrompt = source.systemPrompt;
            memory.owner = agent.id;
            return agent;
          },
        );
      }
      case "agent.route":
      case "agent.flow":
        return this.executeFreedom(frame, instruction, context, activation, blockVisit, location, signal);
    }
  }

  private async runAgent(
    agent: AgentHandle,
    role: string,
    input: Frag,
    schema: SymbolExpr | undefined,
    context: VmRunContext,
    location: Required<TraceLocation>,
    signal: AbortSignal,
    control?: FreedomRuntime,
    forbiddenWriterWorkspace?: AgentWorkspaceSet,
  ): Promise<Frag> {
    const executor = this.agentExecutor;
    if (executor === undefined) {
      throw new AflVmError(
        "AGENT_ADAPTER_MISSING",
        `Agent '${agent.agent.name}' requires an Agent binding`,
      );
    }
    const workspaceConflict = forbiddenWriterWorkspace === undefined
      ? undefined
      : freedomWorkspaceConflict(agent.workspace, forbiddenWriterWorkspace);
    if (workspaceConflict !== undefined) {
      throw new AflVmError(
        "FREEDOM_WORKSPACE_OVERLAP",
        `Agent Workspace '${workspaceConflict.child}' conflicts with Freedom writer Workspace '${workspaceConflict.writer}'`,
      );
    }
    if (control !== undefined && !executor.capabilities.dynamicControlTools) {
      throw new AflVmError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent executor '${executor.name}' does not support activation-scoped AFL control tools`,
      );
    }
    if (agent.tools !== undefined && !executor.capabilities.standardTools) {
      throw new AflVmError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent executor '${executor.name}' does not support AFL standard tool selection`,
      );
    }
    return context.locks.use(
      [{ key: agent.id, mode: "write" }, { key: agent.memory.id, mode: "write" }],
      signal,
      () => context.workspaceLocks.use(
        [
          { path: agent.workspace.primary.root, mode: "write" },
          ...agent.workspace.readOnly.map((item) => ({ path: item.root, mode: "read" as const })),
        ],
        signal,
        async () => {
          let externalLease: SuspendableSemaphoreLease | undefined;
          let returnedSession: BackendSessionRef | undefined;
          let persistenceAttempt: MemoryPersistenceAttempt | undefined;
          let executorRunning = false;
          try {
            this.validateWorkspaceCapabilities(agent.workspace, executor);
            this.validateContinuationBackend(agent, executor);
            appendMemoryMessage(agent.memory, { role, content: input.content });
            await this.validateExecutorMemory(executor, agent, signal);
            await this.restoreAgentSession(agent, executor, context, signal);
            const policyRequest: AgentRunRequest = {
              runId: context.runId,
              node: location.node,
              block: location.block,
              agent: agent.agent,
              ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
              workspace: agent.workspace,
              ...(agent.tools === undefined ? {} : { tools: agent.tools }),
              messages: cloneMessages(agent.memory.messages),
              ...(schema === undefined ? {} : { schema: toSymbol(schema) }),
              ...(control === undefined ? {} : { control: control.activation }),
              signal,
            };
            const approved = await this.bindings.policy?.authorizeAgent?.(policyRequest);
            if (approved === false) {
              throw new AflVmError("AGENT_DENIED", `Agent '${agent.agent.name}' was denied`);
            }
            const request: AgentExecutionRequest = {
              runId: context.runId,
              node: location.node,
              block: location.block,
              agent: agent.agent,
              ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
              memory: cloneMessages(agent.memory.messages),
              memoryRevision: agent.memory.revision,
              workspace: agent.workspace,
              ...(agent.tools === undefined ? {} : { tools: agent.tools }),
              ...(agent.session === undefined ? {} : { session: agent.session }),
              ...(agent.sessionMemoryRevision === undefined
                ? {}
                : { sessionMemoryRevision: agent.sessionMemoryRevision }),
              ...(schema === undefined ? {} : { schema: toSymbol(schema) }),
              ...(control === undefined ? {} : { control: control.activation }),
              signal,
            };
            const continuation = persistedContinuation(agent.memory.checkpoint);
            persistenceAttempt = await context.persistence.beginAgentAttempt({
              slot: agent.memory.slot,
              moduleDigest: agent.memory.moduleDigest,
              messages: agent.memory.messages,
              revision: agent.memory.revision,
              ...(continuation === undefined ? {} : { continuation }),
              agent: agent.agent.name,
              executor: executor.name,
              ...(executor.sessionFormat === undefined ? {} : { format: executor.sessionFormat }),
              location: `${location.node}:${location.block}:${location.instruction}`,
            }, signal);
            externalLease = await SuspendableSemaphoreLease.open(context.external, signal);
            const host = this.createAgentHost(
              context,
              location,
              persistenceAttempt,
              externalLease,
              request,
              executor.name,
              control,
            );
            await this.trace(context, "agent.started", location, {
              agent: agent.id,
              security: {
                preToolPolicy: this.agentToolPolicy !== undefined,
                humanRequestQueue: this.bindings.agentSecurity?.approvalQueue !== undefined &&
                  this.bindings.agentSecurity.approvalQueue !== false,
                sandboxEnforcement: executor.capabilities.sandboxEnforcement,
              },
            });
            executorRunning = true;
            const result = await executor.execute(request, host);
            executorRunning = false;
            await externalLease.close();
            externalLease = undefined;
            returnedSession = result.session;
            if (typeof result.output !== "string") {
              throw new AflVmError("AGENT_OUTPUT_INVALID", "Agent executor output must be a string");
            }
            this.requireCompleted(result.stopReason);
            await this.validateSchema(result.output, schema, signal);
            appendMemoryMessage(agent.memory, { role: "assistant", content: result.output });
            await this.updateAgentSession(agent, executor, result.session, context, signal);
            await this.persistMemory(context, agent.memory, signal, persistenceAttempt);
            persistenceAttempt = undefined;
            await this.trace(context, "agent.completed", location, { agent: agent.id });
            return frag(result.output);
          } catch (error) {
            let vmError = error instanceof AgentExecutorError
              ? new AflVmError(error.code, error.message, { cause: error })
              : normalizeVmError(error);
            const status = agentAttemptStatus(error, vmError, executorRunning, signal);
            if (status === "cancelled" && vmError.code !== "AGENT_CANCELLED") {
              vmError = new AflVmError("AGENT_CANCELLED", "Agent execution was cancelled", {
                cause: vmError,
              });
            }
            const interruption = status === "interrupted"
              ? createInterruptionContext(
                  agent,
                  executor.name,
                  location,
                  context.persistence.currentRevision(agent.memory.slot),
                )
              : undefined;
            if (interruption !== undefined) vmError = withInterruptionContext(vmError, interruption);
            if (persistenceAttempt !== undefined) {
              const outcome: AgentAttemptEnd = {
                status,
                error: { code: vmError.code, message: vmError.message },
                ...(interruption === undefined ? {} : { interruption }),
              };
              await context.persistence.abortAgentAttempt(persistenceAttempt, outcome).catch(() => {});
            }
            await this.invalidateAgentSession(agent, executor, returnedSession);
            const failureTrace = this.trace(
              context,
              interruption === undefined ? "agent.failed" : "agent.interrupted",
              location,
              {
                agent: agent.id,
                ...(interruption === undefined ? {} : {
                  interruption: interruptionDetails(interruption),
                }),
              },
              vmError,
            );
            if (interruption === undefined) await failureTrace;
            else await failureTrace.catch(() => {});
            throw vmError;
          } finally {
            await externalLease?.close();
          }
        },
      ),
    );
  }

  private validateWorkspaceCapabilities(
    workspace: AgentWorkspaceSet,
    executor: AgentExecutorBackend,
  ): void {
    if (workspace.origin === "explicit" && !executor.capabilities.workspaceContext) {
      throw new AflVmError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent executor '${executor.name}' does not support explicit Workspace context`,
      );
    }
    if (workspace.readOnly.length > 0 && !executor.capabilities.readOnlyWorkspaceContext) {
      throw new AflVmError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent executor '${executor.name}' does not support read-only Workspace context`,
      );
    }
  }

  private async validateExecutorMemory(
    executor: AgentExecutorBackend,
    agent: AgentHandle,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (!executor.memory.capabilities.roleSchemas.includes(AFL_MESSAGE_ROLE_SCHEMA)) {
      throw new AflVmError(
        "AGENT_MEMORY_ROLE_UNSUPPORTED",
        `Agent executor '${executor.name}' does not support '${AFL_MESSAGE_ROLE_SCHEMA}'`,
      );
    }
    await executor.memory.validateImport(
      agent.agent,
      AFL_MESSAGE_ROLE_SCHEMA,
      cloneMessages(agent.memory.messages),
    );
  }

  private validateContinuationBackend(agent: AgentHandle, executor: AgentExecutorBackend): void {
    const backend = agent.memory.checkpoint?.state?.backend;
    if (backend !== undefined && backend !== executor.name) {
      throw new AflVmError(
        "AGENT_SESSION_INVALID",
        `Memory continuation belongs to executor '${backend}', not '${executor.name}'`,
      );
    }
  }

  private async invalidateAgentSession(
    agent: AgentHandle,
    executor: AgentExecutorBackend,
    returnedSession?: BackendSessionRef,
  ): Promise<void> {
    const session = returnedSession ?? agent.session;
    delete agent.session;
    delete agent.sessionMemoryRevision;
    delete agent.memory.checkpoint;
    if (session === undefined || executor.close === undefined) return;
    const cleanupSignal = new AbortController().signal;
    await executor.close(session, cleanupSignal).catch(() => {});
  }

  private async restoreAgentSession(
    agent: AgentHandle,
    executor: AgentExecutorBackend,
    context: VmRunContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (agent.session !== undefined) return;
    const checkpoint = agent.memory.checkpoint;
    if (checkpoint === undefined) return;
    if (checkpoint.memoryRevision > agent.memory.revision) {
      throw new AflVmError("AGENT_MEMORY_REVISION_INVALID", "Executor continuation is ahead of AFL Memory");
    }

    const canForkLive = checkpoint.session !== undefined &&
      checkpoint.session.backend === executor.name &&
      checkpoint.agent?.name === agent.agent.name &&
      checkpoint.systemPrompt === agent.systemPrompt &&
      checkpoint.workspaceKey === workspaceKey(agent.workspace) &&
      executor.fork !== undefined;
    const restored = canForkLive
      ? await context.external.use(signal, () => executor.fork!(checkpoint.session!, signal))
      : await this.importAgentSession(agent, checkpoint, executor, context, signal);
    if (restored === undefined) return;
    if (restored.backend !== executor.name) {
      throw new AflVmError(
        "AGENT_SESSION_INVALID",
        `Agent executor '${executor.name}' restored session backend '${restored.backend}'`,
      );
    }
    agent.session = restored;
    agent.sessionMemoryRevision = checkpoint.memoryRevision;
  }

  private async importAgentSession(
    agent: AgentHandle,
    checkpoint: MemoryCheckpoint,
    executor: AgentExecutorBackend,
    context: VmRunContext,
    signal: AbortSignal,
  ): Promise<BackendSessionRef | undefined> {
    const state = checkpoint.state;
    if (state === undefined) return undefined;
    if (state.backend !== executor.name) {
      throw new AflVmError(
        "AGENT_SESSION_INVALID",
        `Memory continuation belongs to executor '${state.backend}', not '${executor.name}'`,
      );
    }
    if (executor.importSession === undefined) {
      throw new AflVmError(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `Agent executor '${executor.name}' cannot restore persisted session continuations`,
      );
    }
    return context.external.use(signal, () => executor.importSession!({
      state: structuredClone(state),
      agent: structuredClone(agent.agent),
      ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
      workspace: structuredClone(agent.workspace),
      signal,
    }));
  }

  private async updateAgentSession(
    agent: AgentHandle,
    executor: AgentExecutorBackend,
    session: BackendSessionRef | undefined,
    context: VmRunContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (session === undefined) {
      delete agent.session;
      delete agent.sessionMemoryRevision;
      delete agent.memory.checkpoint;
      return;
    }
    if (session.backend !== executor.name) {
      throw new AflVmError(
        "AGENT_SESSION_INVALID",
        `Agent executor '${executor.name}' returned session backend '${session.backend}'`,
      );
    }
    const checkpoint = executor.checkpoint === undefined
      ? session
      : await context.external.use(signal, () => executor.checkpoint!(session, signal));
    if (checkpoint.backend !== executor.name) {
      throw new AflVmError(
        "AGENT_SESSION_INVALID",
        `Agent executor '${executor.name}' returned checkpoint backend '${checkpoint.backend}'`,
      );
    }
    const state = executor.exportSession === undefined
      ? undefined
      : await context.external.use(signal, () => executor.exportSession!(checkpoint, signal));
    if (state !== undefined && state.backend !== executor.name) {
      throw new AflVmError(
        "AGENT_SESSION_INVALID",
        `Agent executor '${executor.name}' exported session state for backend '${state.backend}'`,
      );
    }
    agent.session = checkpoint;
    agent.sessionMemoryRevision = agent.memory.revision;
    if (executor.checkpoint === undefined && state === undefined) {
      delete agent.memory.checkpoint;
      return;
    }
    agent.memory.checkpoint = {
      ...(executor.checkpoint === undefined ? {} : { session: checkpoint }),
      ...(state === undefined ? {} : { state: structuredClone(state) }),
      memoryRevision: agent.memory.revision,
      agent: structuredClone(agent.agent),
      workspaceKey: workspaceKey(agent.workspace),
      ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
    };
  }

  private createAgentHost(
    context: VmRunContext,
    location: Required<TraceLocation>,
    persistenceAttempt: MemoryPersistenceAttempt,
    externalLease: SuspendableSemaphoreLease,
    executionRequest: AgentExecutionRequest,
    backend: string,
    control?: FreedomRuntime,
  ): AgentExecutionHost {
    const emit = async (event: Parameters<AgentExecutionHost["emit"]>[0]) => {
      await this.trace(context, "agent.event", location, structuredClone(event) as ComputeValue);
      await this.bindings.agentHost?.emit?.(event);
    };
    return {
      emit,
      persistContinuation: (delta) => context.persistence.appendContinuation(
        persistenceAttempt,
        delta,
        new AbortController().signal,
      ),
      authorizeTool: async (action) => this.authorizeAgentTool(
        action,
        executionRequest,
        backend,
        emit,
      ),
      requestElevation: async (request) => this.requestAgentElevation(
        request,
        executionRequest,
        backend,
        emit,
        (operation) => externalLease.suspend(operation),
      ),
      requestTransaction: async (request) => externalLease.suspend(() => this.requestAgentTransaction(
        request,
        executionRequest,
        backend,
        emit,
      )),
      requestInput: async (request) => {
        if (this.bindings.agentHost?.requestInput === undefined) {
          throw new AgentExecutorError(
            "AGENT_CAPABILITY_UNSUPPORTED",
            "Agent executor requested interactive input, but no Agent host is configured",
          );
        }
        return this.bindings.agentHost.requestInput(request);
      },
      executeControlTool: async (request) => {
        if (control === undefined) {
          throw new AgentExecutorError(
            "AGENT_CAPABILITY_UNSUPPORTED",
            `AFL control tool '${request.name}' is not available in this Agent activation`,
          );
        }
        return externalLease.suspend(async () => {
          await this.trace(context, "freedom.tool", location, { tool: request.name });
          return control.execute(request);
        });
      },
    };
  }

  private async authorizeAgentTool(
    action: AgentToolAction,
    executionRequest: AgentExecutionRequest,
    backend: string,
    emit: AgentExecutionHost["emit"],
    elevation?: {
      readonly reason: string;
      readonly wait: <T>(operation: () => Promise<T>) => Promise<T>;
    },
  ): Promise<AgentToolAuthorization> {
    let bound: AgentToolAction;
    try {
      bound = snapshotAgentToolAction({
        ...action,
        runId: executionRequest.runId,
        node: executionRequest.node,
        block: executionRequest.block,
        agent: executionRequest.agent,
        backend,
        workspace: executionRequest.workspace,
        signal: action.signal,
      });
    } catch {
      const requestId = typeof action.requestId === "string" ? action.requestId : "invalid-tool-request";
      const id = typeof action.toolCallId === "string" ? action.toolCallId : "invalid-tool-call";
      const name = typeof action.toolName === "string" ? action.toolName : "invalid-tool";
      await emit({
        type: "tool.policy",
        id,
        name,
        verdict: "deny",
        covered: true,
        code: "AGENT_TOOL_POLICY_FAILED",
        reason: "Tool action could not be normalized for policy evaluation",
      });
      return {
        status: "denied",
        requestId,
        code: "AGENT_TOOL_POLICY_FAILED",
        reason: "Tool action could not be normalized for policy evaluation",
      };
    }
    const evaluation = this.agentToolPolicy === undefined
      ? { verdict: "allow" as const, covered: false, results: [] }
      : await this.agentToolPolicy.evaluate(bound);
    const publicReason = evaluation.verdict === "deny" || evaluation.verdict === "block"
      ? redactAgentToolText(evaluation.reason)
      : undefined;
    await emit({
      type: "tool.policy",
      id: bound.toolCallId,
      name: bound.toolName,
      verdict: evaluation.verdict,
      covered: evaluation.covered,
      ...(evaluation.verdict === "deny" || evaluation.verdict === "block"
        ? { policy: evaluation.policy, code: evaluation.code, reason: publicReason! }
        : {}),
    });
    if (evaluation.verdict === "deny") {
      return {
        status: "denied",
        requestId: bound.requestId,
        code: evaluation.code,
        reason: publicReason!,
      };
    }
    if (evaluation.verdict === "block" && elevation === undefined) {
      return {
        status: "denied",
        requestId: bound.requestId,
        code: evaluation.code,
        reason: publicReason!,
        elevatable: true,
      };
    }
    if (elevation === undefined) {
      return { status: "allowed", requestId: bound.requestId };
    }
    const queue = this.bindings.agentSecurity?.approvalQueue;
    if (queue === undefined || queue === false) {
      return {
        status: "denied",
        requestId: bound.requestId,
        code: "AGENT_ELEVATION_UNAVAILABLE",
        reason: "Elevated tool execution requires approval, but no approval queue is configured",
      };
    }
    try {
      const digest = agentToolActionDigest(bound);
      const decision = await elevation.wait(() => queue.enqueue({
          kind: "tool-elevation",
          subject: {
            runId: bound.runId,
            node: bound.node,
            block: bound.block,
            agent: bound.agent.name,
            backend: bound.backend,
            toolCallId: bound.toolCallId,
            toolName: bound.toolName,
            executionBoundary: bound.executionBoundary,
            workspace: bound.display.details?.workspace ?? bound.workspace.primary.root,
            display: bound.display,
          },
          reasons: [
            ...(evaluation.verdict === "block" ? evaluation.blocks.map((blocked) => ({
              policy: blocked.policy,
              reason: redactAgentToolText(blocked.reason),
            })) : []),
            {
              policy: "agent-elevation",
              reason: redactAgentToolText(elevation.reason),
            },
          ],
          actionDigest: digest,
        }, bound.signal, async (event) => emit(elevationEvent(bound, event))));
      return decision === "approved"
        ? { status: "allowed", requestId: bound.requestId }
        : {
            status: "denied",
            requestId: bound.requestId,
            code: "AGENT_ELEVATION_DENIED",
            reason: "Elevated tool execution was denied by the approver",
          };
    } catch (error) {
      const code = error instanceof AgentApprovalError ? error.code : "AGENT_APPROVAL_UNAVAILABLE";
      return {
        status: "denied",
        requestId: bound.requestId,
        code,
        reason: error instanceof AgentApprovalError ? error.message : "Tool approval failed",
      };
    }
  }

  private async requestAgentElevation(
    request: AgentElevationRequest,
    executionRequest: AgentExecutionRequest,
    backend: string,
    emit: AgentExecutionHost["emit"],
    wait: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<AgentToolAuthorization> {
    if (typeof request.toolName !== "string" || request.toolName.trim().length === 0) {
      throw new AgentExecutorError("AGENT_EXECUTION_FAILED", "Agent elevation toolName must be non-empty");
    }
    if (request.executionBoundary !== "sandbox" && request.executionBoundary !== "host") {
      throw new AgentExecutorError(
        "AGENT_EXECUTION_FAILED",
        "Agent elevation executionBoundary must be 'sandbox' or 'host'",
      );
    }
    const reason = requireNonEmptyTransactionText(request.reason, "elevation reason");
    return this.authorizeAgentTool({
      requestId: `${executionRequest.runId}:elevation:${request.id}`,
      runId: executionRequest.runId,
      node: executionRequest.node,
      block: executionRequest.block,
      agent: executionRequest.agent,
      backend,
      toolCallId: request.id,
      toolName: request.toolName,
      executionBoundary: request.executionBoundary,
      workspace: executionRequest.workspace,
      input: request.input,
      effectiveInput: request.effectiveInput,
      display: request.display,
      signal: request.signal,
    }, executionRequest, backend, emit, { reason, wait });
  }

  private async requestAgentTransaction(
    request: AgentTransactionRequest,
    executionRequest: AgentExecutionRequest,
    backend: string,
    emit: AgentExecutionHost["emit"],
  ): Promise<AgentTransactionResult> {
    const title = requireNonEmptyTransactionText(request.title, "title");
    const requestedAction = requireNonEmptyTransactionText(request.request, "request");
    const reason = requireNonEmptyTransactionText(request.reason, "reason");
    const resumeWhen = request.resumeWhen === undefined
      ? undefined
      : requireNonEmptyTransactionText(request.resumeWhen, "resumeWhen");
    const input = {
      title,
      request: requestedAction,
      reason,
      ...(resumeWhen === undefined ? {} : { resumeWhen }),
    };
    const display = createAgentToolActionDisplay(
      "AFL transaction request",
      input,
      executionRequest.workspace.primary.root,
    );
    const action = snapshotAgentToolAction({
      requestId: `${executionRequest.runId}:transaction:${request.id}`,
      runId: executionRequest.runId,
      node: executionRequest.node,
      block: executionRequest.block,
      agent: executionRequest.agent,
      backend,
      toolCallId: request.id,
      toolName: "afl.transaction.request",
      executionBoundary: "host-control",
      workspace: executionRequest.workspace,
      input,
      effectiveInput: input,
      display: {
        ...display,
        title: redactAgentToolText(title),
        summary: redactAgentToolText(requestedAction),
        details: {
          reason: redactAgentToolText(reason),
          ...(resumeWhen === undefined ? {} : { resumeWhen: redactAgentToolText(resumeWhen) }),
          workspace: executionRequest.workspace.primary.root,
        },
      },
      signal: request.signal,
    });
    const queue = this.bindings.agentSecurity?.approvalQueue;
    if (queue === undefined || queue === false) {
      await emit({
        type: "transaction.state",
        id: request.id,
        title: action.display.title,
        state: "unavailable",
      });
      return {
        status: "unavailable",
        code: "AGENT_APPROVAL_UNAVAILABLE",
        message: "No human request queue is configured",
      };
    }
    try {
      const decision = await queue.enqueue({
        kind: "transaction",
        subject: {
          runId: action.runId,
          node: action.node,
          block: action.block,
          agent: action.agent.name,
          backend: action.backend,
          toolCallId: action.toolCallId,
          toolName: action.toolName,
          executionBoundary: action.executionBoundary,
          workspace: action.workspace.primary.root,
          display: action.display,
        },
        reasons: [{ policy: "agent-request", reason: redactAgentToolText(reason) }],
        actionDigest: agentToolActionDigest(action),
      }, request.signal, async (event) => emit(transactionEvent(action.display.title, event)));
      return decision === "approved"
        ? { status: "completed" }
        : { status: "denied", message: "The user declined the requested action" };
    } catch (error) {
      if (request.signal.aborted) throw error;
      const code = error instanceof AgentApprovalError ? error.code : "AGENT_APPROVAL_UNAVAILABLE";
      await emit({
        type: "transaction.state",
        id: request.id,
        title: action.display.title,
        state: "unavailable",
      });
      return {
        status: "unavailable",
        code,
        message: error instanceof AgentApprovalError ? error.message : "Human request queue failed",
      };
    }
  }

  private requireCompleted(reason: AgentExecutionStopReason): void {
    if (reason === "completed") return;
    const code = reason === "blocked"
      ? "AGENT_BLOCKED"
      : reason === "budget_exhausted"
      ? "AGENT_BUDGET_EXHAUSTED"
      : "AGENT_CANCELLED";
    throw new AflVmError(code, `Agent execution ended with '${reason}'`);
  }

  private async renderPrompt(
    source: ValueExpr,
    args: readonly ValueExpr[],
    frame: MutableFrame,
    signal: AbortSignal,
  ): Promise<Frag> {
    const sourceValue = evaluateValue(source, frame);
    const values = args.map((argument) => this.toPromptArgument(evaluateValue(argument, frame), argument.span));
    if (isSymbolRef(sourceValue)) {
      if (this.bindings.prompts === undefined) {
        throw new AflVmError("PROMPT_ADAPTER_MISSING", `prompt '${sourceValue.name}' requires a Prompt binding`, {
          span: source.span,
        });
      }
      throwIfAborted(signal);
      const rendered = await this.bindings.prompts.render({ prompt: sourceValue, args: values, signal });
      if (typeof rendered !== "string") {
        throw new AflVmError("PROMPT_RESULT_INVALID", "Prompt binding returned a non-string value", {
          span: source.span,
        });
      }
      return frag(rendered);
    }
    const base = isFrag(sourceValue)
      ? sourceValue.content
      : isComputeValue(sourceValue)
        ? formatCompute(sourceValue)
        : undefined;
    if (base === undefined) {
      throw new AflVmError("PROMPT_SOURCE_INVALID", "prompt source cannot be a VM handle", {
        span: source.span,
      });
    }
    return frag([base, ...values.map(formatPromptArgument)].join("\n\n"));
  }

  private async invokeFlow(
    module: AflModule,
    target: FlowTarget,
    args: readonly VmValue[],
    context: VmRunContext,
    signal: AbortSignal,
    activationPath: string,
    forbiddenWriterWorkspace?: AgentWorkspaceSet,
    freedomDepth = 0,
    freedomRouteTracker?: FreedomRouteTracker,
  ): Promise<VmValue> {
    throwIfAborted(signal);
    if (target.kind === "local") {
      return this.executeNode(
        module,
        target.name,
        args,
        context,
        signal,
        activationPath,
        forbiddenWriterWorkspace,
        freedomDepth,
        freedomRouteTracker,
      );
    }
    if (this.bindings.flows === undefined) {
      throw new AflVmError("FLOW_ADAPTER_MISSING", `external flow '${target.name}' requires a Flow binding`, {
        span: target.span,
      });
    }
    const portable = args.map((value) => this.toVmArgument(value, target.span));
    return this.bindings.flows.invoke({ flow: symbol(target.name), args: portable, signal });
  }

  private async startDispatch(
    frame: MutableFrame,
    calls: readonly { readonly target: FlowTarget; readonly args: readonly VmValue[]; readonly span: SourceSpan }[],
    context: VmRunContext,
    activation: ActivationContext,
    blockVisit: number,
    location: Required<TraceLocation>,
    parentSignal: AbortSignal,
  ): Promise<TaskGroupHandle> {
    this.reserveGeneratedFreedomRoutes(frame.node.name, calls.map((call) => call.target), activation);
    return this.startTaskGroup(
      frame,
      calls.map((call): TaskGroupWork => ({
        span: call.span,
        execute: (signal, index) => this.invokeFlow(
          frame.module,
          call.target,
          call.args,
          context,
          signal,
          `${this.childActivationPath(activation, location, blockVisit, "dispatch")}:${index}`,
          activation.forbiddenWriterWorkspace,
          activation.freedomDepth,
          activation.freedomRouteTracker,
        ),
      })),
      context,
      location,
      parentSignal,
    );
  }

  private async startTaskGroup(
    frame: MutableFrame,
    work: readonly TaskGroupWork[],
    context: VmRunContext,
    location: Required<TraceLocation>,
    parentSignal: AbortSignal,
  ): Promise<TaskGroupHandle> {
    const maxWorkers = this.bindings.policy?.maxDispatchWorkers ?? 16;
    const maxTasks = this.bindings.policy?.maxDispatchTasks ?? 10_000;
    if (!Number.isInteger(maxWorkers) || maxWorkers <= 0) {
      throw new AflVmError("VM_POLICY_INVALID", "maxDispatchWorkers must be a positive integer");
    }
    if (!Number.isInteger(maxTasks) || maxTasks < 0) {
      throw new AflVmError("VM_POLICY_INVALID", "maxDispatchTasks must be a non-negative integer");
    }
    if (work.length > maxTasks) {
      throw new AflVmError(
        "DISPATCH_TASK_LIMIT_EXCEEDED",
        `dispatch requested ${work.length} tasks, exceeding maxDispatchTasks=${maxTasks}`,
      );
    }
    const linked = linkedController(parentSignal);
    const workerLimit = new Semaphore(maxWorkers);
    const id = this.nextHandle(context, "task-group");
    const tasks = work.map((item, index) => {
      const task = workerLimit.use(linked.controller.signal, async () => normalizeFlowResult(
        await item.execute(linked.controller.signal, index),
        item.span,
      ));
      void task.catch((error: unknown) => {
        linked.controller.abort(error);
      });
      return task;
    });
    const group: TaskGroupHandle = {
      kind: "taskGroup",
      id,
      tasks,
      controller: linked.controller,
      dispose: linked.dispose,
      consumed: false,
    };
    frame.taskGroups.add(group);
    await this.trace(context, "dispatch.started", location, { taskGroup: id, count: tasks.length });
    return group;
  }

  private addRuntimeResourceDependencies(
    block: AflBlock,
    frame: MutableFrame,
    dependencies: Array<Set<number>>,
  ): void {
    const lastWriter = new Map<string, number>();
    const readers = new Map<string, Set<number>>();
    block.instructions.forEach((instruction, index) => {
      for (const access of this.vmResourceAccesses(instruction, frame)) {
        const writer = lastWriter.get(access.key);
        if (writer !== undefined) dependencies[index]!.add(writer);
        if (access.mode === "write") {
          for (const reader of readers.get(access.key) ?? []) dependencies[index]!.add(reader);
          lastWriter.set(access.key, index);
          readers.set(access.key, new Set());
        } else {
          const current = readers.get(access.key) ?? new Set<number>();
          current.add(index);
          readers.set(access.key, current);
        }
      }
    });
  }

  private vmResourceAccesses(
    instruction: AflInstruction,
    frame: MutableFrame,
  ): Array<{ key: string; mode: "read" | "write" }> {
    const agent = (expression: ValueExpr, mode: "read" | "write") => {
      if (expression.kind !== "name" || !frame.values.has(expression.name)) return [];
      const handle = evaluateValue(expression, frame);
      if (!isAgentHandle(handle)) return [];
      return [
        { key: handle.id, mode },
        { key: handle.memory.id, mode },
      ];
    };
    const memory = (expression: ValueExpr, mode: "read" | "write") => {
      if (expression.kind !== "name" || !frame.values.has(expression.name)) return [];
      const handle = evaluateValue(expression, frame);
      return isMemoryHandle(handle) ? [{ key: handle.id, mode }] : [];
    };
    switch (instruction.op) {
      case "agent":
        return instruction.memory === undefined ? [] : memory(instruction.memory, "write");
      case "agent.system_prompt":
      case "agent.do":
        return agent(instruction.agent, "write");
      case "sync": {
        if (!frame.values.has(instruction.taskGroup.name)) return [];
        const group = evaluateValue(instruction.taskGroup, frame);
        return isTaskGroupLike(group) ? [{ key: group.id, mode: "write" }] : [];
      }
      case "fork":
        return agent(instruction.sourceAgent, "read");
      case "memory.append":
        return memory(instruction.memory, "write");
      case "memory.copy":
        return memory(instruction.memory, "read");
      case "agent.with_memory":
        return [
          ...agent(instruction.agent, "read"),
          ...memory(instruction.memory, "write"),
        ];
      case "agent.route":
      case "agent.flow":
        return agent(instruction.agent, "write");
      default:
        return [];
    }
  }

  private async executeFreedom(
    frame: MutableFrame,
    instruction: AgentControlInstruction,
    context: VmRunContext,
    activation: ActivationContext,
    blockVisit: number,
    location: Required<TraceLocation>,
    signal: AbortSignal,
  ): Promise<Frag | TaskGroupHandle> {
    const mode = freedomInstructionMode(instruction);
    const planner = asAgent(evaluateValue(instruction.agent, frame), instruction.agent.span);
    const prompt = asFrag(evaluateValue(instruction.prompt, frame), instruction.prompt.span, "freedom prompt");
    const constraint: Record<string, ComputeValue> = {};
    if (instruction.minRoutes !== undefined) {
      constraint.min_routes = asCompute(
        evaluateValue(instruction.minRoutes, frame),
        instruction.minRoutes.span,
        "min_routes",
      );
    }
    if (instruction.maxRoutes !== undefined) {
      constraint.max_routes = asCompute(
        evaluateValue(instruction.maxRoutes, frame),
        instruction.maxRoutes.span,
        "max_routes",
      );
    }
    const limits = parseFreedomLimits(
      constraint,
      instruction.span,
      this.bindings.policy?.freedomLimits,
    );
    const freedomDepth = activation.freedomDepth + 1;
    if (freedomDepth > limits.maxActivationDepth) {
      throw new AflVmError(
        "FREEDOM_ACTIVATION_DEPTH_EXCEEDED",
        `Freedom exceeded max_activation_depth=${limits.maxActivationDepth}`,
        { span: instruction.span },
      );
    }
    const nodes = new Map<string, AflNode>();
    for (const candidate of instruction.nodes) {
      const node = planner.origin.module.nodes.find((item) => item.name === candidate.name);
      if (node === undefined) {
        throw new AflVmError(
          "FREEDOM_NODE_UNKNOWN",
          `Freedom Node '${candidate.name}' is unavailable at planner origin`,
          { span: candidate.span },
        );
      }
      nodes.set(candidate.name, node);
    }
    const agents = instruction.op === "agent.flow" ? instruction.agents.map(toSymbol) : [];
    const refs = new Map<string, VmArgument>();
    for (const [name, expression] of Object.entries(instruction.params.entries)) {
      const value = evaluateValue(expression, frame);
      if (isVmHandle(value) || isSymbolRef(value)) {
        throw new AflVmError(
          "FREEDOM_PARAM_INVALID",
          `Freedom controlled param '${name}' must be Frag or compute data`,
          { span: expression.span },
        );
      }
      refs.set(`param:${name}`, this.toVmArgument(value, expression.span));
    }
    const policyRequest = {
      mode,
      module: planner.origin.module,
      runId: context.runId,
      node: location.node,
      block: location.block,
      planner: planner.agent,
      nodes: [...nodes.keys()],
      agents,
      constraint,
    } as const;
    if (await this.bindings.policy?.authorizeFreedom?.(policyRequest) === false) {
      throw new AflVmError("FREEDOM_DENIED", "Freedom activation was denied by policy", {
        span: instruction.span,
      });
    }
    const linked = linkedController(signal);
    const timeout = setTimeout(() => {
      linked.controller.abort(new AflVmError(
        "FREEDOM_TIMEOUT",
        `Freedom activation exceeded timeout_ms=${limits.timeoutMs}`,
        { span: instruction.span },
      ));
    }, limits.timeoutMs);
    const scope: FreedomScope = {
      instruction,
      planner,
      origin: planner.origin,
      context,
      location,
      signal: linked.controller.signal,
      constraint,
      limits,
      freedomDepth,
      nodes,
      agents,
      refs,
      routes: [],
      nextRouteOrder: 0,
      counts: {
        control: 0,
        route: 0,
        completedNode: 0,
        completedIr: 0,
        validation: 0,
        execution: 0,
        result: 0,
      },
    };
    try {
      await this.trace(context, "freedom.started", location, {
        mode,
        nodes: [...nodes.keys()],
      });
      const output = await this.runAgent(
        planner,
        "user",
        prompt,
        undefined,
        context,
        location,
        linked.controller.signal,
        this.createFreedomRuntime(scope),
      );
      if (scope.counts.route < scope.limits.minRoutes) {
        throw new AflVmError(
          "FREEDOM_ROUTE_MIN_NOT_REACHED",
          `Freedom selected ${scope.counts.route} routes, below min_routes=${scope.limits.minRoutes}`,
          { span: instruction.span },
        );
      }
      const details = {
        mode,
        controlCalls: scope.counts.control,
        routes: scope.counts.route,
        completedNodes: scope.counts.completedNode,
        completedIr: scope.counts.completedIr,
      } as const;
      if (instruction.op === "agent.route") {
        const group = await this.startFreedomRouteGroup(
          frame,
          scope,
          context,
          blockVisit,
          location,
          signal,
        );
        await this.trace(context, "freedom.completed", location, details);
        return group;
      }
      await this.trace(context, "freedom.completed", location, details);
      return scope.counts.completedNode + scope.counts.completedIr === 0 ? frag("") : output;
    } finally {
      clearTimeout(timeout);
      linked.dispose();
    }
  }

  private startFreedomRouteGroup(
    frame: MutableFrame,
    scope: FreedomScope,
    context: VmRunContext,
    blockVisit: number,
    location: Required<TraceLocation>,
    signal: AbortSignal,
  ): Promise<TaskGroupHandle> {
    const routes = [...scope.routes].sort((left, right) => left.order - right.order);
    return this.startTaskGroup(
      frame,
      routes.map((route): TaskGroupWork => ({
        span: route.target.span,
        execute: (taskSignal, index) => this.executeNode(
          scope.origin.module,
          route.target.name,
          route.args,
          context,
          taskSignal,
          `${scope.origin.activationPath}/freedom-route:${blockVisit}:${index}:${encodeURIComponent(route.requestId)}`,
          scope.planner.workspace,
          scope.freedomDepth,
        ),
      })),
      context,
      location,
      signal,
    );
  }

  private createFreedomRuntime(scope: FreedomScope): FreedomRuntime {
    return {
      activation: {
        tools: freedomControlTools(freedomInstructionMode(scope.instruction)),
      },
      execute: (request) => this.executeFreedomTool(scope, request),
    };
  }

  private reserveFreedomRoutes(scope: FreedomScope, count: number): void {
    if (count === 0) return;
    this.assertFreedomRouteCapacity(scope, count);
    scope.counts.route += count;
  }

  private assertFreedomRouteCapacity(scope: FreedomScope, count: number): void {
    const next = scope.counts.route + count;
    if (next > scope.limits.maxRoutes) {
      throw new AflVmError(
        "FREEDOM_ROUTE_MAX_EXCEEDED",
        `Freedom routing would reach ${next} routes, exceeding max_routes=${scope.limits.maxRoutes}`,
      );
    }
  }

  private reserveFreedomRoute(scope: FreedomScope): void {
    this.reserveFreedomRoutes(scope, 1);
  }

  private reserveGeneratedFreedomRoute(
    caller: string,
    target: FlowTarget,
    activation: ActivationContext,
  ): void {
    this.reserveGeneratedFreedomRoutes(caller, [target], activation);
  }

  private reserveGeneratedFreedomRoutes(
    caller: string,
    targets: readonly FlowTarget[],
    activation: ActivationContext,
  ): void {
    const tracker = activation.freedomRouteTracker;
    if (tracker === undefined || !tracker.generatedNodes.has(caller)) return;
    const count = targets.filter((target) =>
      target.kind === "local" && tracker.scope.nodes.has(target.name)).length;
    this.reserveFreedomRoutes(tracker.scope, count);
  }

  private async executeFreedomTool(
    scope: FreedomScope,
    request: AgentControlToolRequest,
  ): Promise<AgentControlToolResult> {
    throwIfAborted(scope.signal);
    throwIfAborted(request.signal);
    scope.counts.control += 1;
    try {
      if (scope.counts.control > scope.limits.maxControlCalls) {
        throw new AflVmError(
          "FREEDOM_CONTROL_LIMIT_EXCEEDED",
          `Freedom exceeded max_control_calls=${scope.limits.maxControlCalls}`,
        );
      }
      const mode = freedomInstructionMode(scope.instruction);
      if (!freedomControlTools(mode).some((tool) => tool.name === request.name)) {
        throw new AflVmError(
          "FREEDOM_TOOL_UNAVAILABLE",
          `AFL control tool '${request.name}' is unavailable in ${mode} mode`,
        );
      }
      switch (request.name) {
        case "afl.environment.get":
          return this.freedomEnvironment(scope, request.input);
        case "afl.route.add":
          return await this.queueFreedomRoute(scope, request);
        case "afl.node.execute":
          return await this.executeFreedomNode(scope, request);
        case "afl.ir.validate":
          return this.validateFreedomIrTool(scope, request.input);
        case "afl.ir.execute":
          return await this.executeFreedomIrTool(scope, request);
        default:
          throw new AflVmError("FREEDOM_TOOL_UNAVAILABLE", `Unknown AFL control tool '${request.name}'`);
      }
    } catch (error) {
      throwIfAborted(scope.signal);
      throwIfAborted(request.signal);
      const vmError = normalizeVmError(error);
      return controlResult({
        ok: false,
        error: {
          code: vmError.code,
          message: vmError.message,
          ...(vmError.span === undefined ? {} : {
            span: {
              line: vmError.span.line,
              column: vmError.span.column,
              endColumn: vmError.span.endColumn,
            },
          }),
        },
      });
    }
  }

  private async queueFreedomRoute(
    scope: FreedomScope,
    request: AgentControlToolRequest,
  ): Promise<AgentControlToolResult> {
    assertObjectInput(request.input, ["node", "args"]);
    const target = requiredString(request.input, "node");
    const node = scope.nodes.get(target);
    if (node === undefined) {
      throw new AflVmError("FREEDOM_NODE_DENIED", `Node '${target}' is not in this Freedom allowlist`);
    }
    const args = resolveControlArguments(request.input.args, scope.refs);
    if (args.length !== node.parameters.length) {
      throw new AflVmError(
        "CALL_ARITY",
        `Node '${target}' expects ${node.parameters.length} arguments, received ${args.length}`,
      );
    }
    this.assertFreedomRouteCapacity(scope, 1);
    const order = scope.nextRouteOrder;
    scope.nextRouteOrder += 1;
    if (await this.bindings.policy?.authorizeFreedomNode?.({
      ...this.freedomPolicyRequest(scope),
      target,
      args: args.map((argument) => clonePortable(argument)),
    }) === false) {
      throw new AflVmError("FREEDOM_NODE_DENIED", `Node '${target}' was denied by policy`);
    }
    throwIfAborted(scope.signal);
    throwIfAborted(request.signal);
    this.reserveFreedomRoute(scope);
    scope.routes.push({
      order,
      requestId: request.id,
      target: { kind: "local", name: target, span: node.span },
      args: args.map((argument) => clonePortable(argument)),
    });
    return controlResult({
      ok: true,
      route: `route:${order + 1}`,
      node: target,
    });
  }

  private freedomEnvironment(
    scope: FreedomScope,
    input: Readonly<Record<string, unknown>>,
  ): AgentControlToolResult {
    assertObjectInput(input, ["include"]);
    const allowedSections = ["agents", "nodes", "parameters", "constraints"] as const;
    let include: readonly (typeof allowedSections)[number][] = allowedSections;
    if (input.include !== undefined) {
      if (!Array.isArray(input.include) ||
          !input.include.every((item) => typeof item === "string" && allowedSections.includes(item as never))) {
        throw new AflVmError("FREEDOM_TOOL_INPUT_INVALID", "include contains an unknown environment section");
      }
      include = [...new Set(input.include)] as (typeof allowedSections)[number][];
    }
    const selected = new Set(include);
    const environment: Record<string, ComputeValue> = {
      mode: freedomInstructionMode(scope.instruction),
    };
    if (selected.has("nodes")) {
      environment.nodes = [...scope.nodes.values()].map((node) => ({
        name: node.name,
        description: node.documentation?.description ?? "",
        parameters: node.parameters.map((name) => ({
          name,
          description: node.documentation?.parameters[name] ?? "",
        })),
        returns: node.documentation?.returns ?? "",
        callable: true,
      }));
    }
    if (selected.has("agents")) {
      environment.agents = scope.agents.map((agent) => agent.name);
    }
    if (selected.has("parameters")) {
      environment.parameters = [...scope.refs].map(([ref, value]) => ({
        ref,
        name: ref.startsWith("param:") ? ref.slice("param:".length) : ref,
        kind: portableControlKind(value),
        value: portableControlValue(value),
      }));
    }
    if (selected.has("constraints")) {
      environment.constraints = {
        requested: structuredClone(scope.constraint),
        effective: freedomLimitsValue(scope.limits),
      };
    }
    return controlResult({ ok: true, environment });
  }

  private async executeFreedomNode(
    scope: FreedomScope,
    request: AgentControlToolRequest,
  ): Promise<AgentControlToolResult> {
    assertObjectInput(request.input, ["node", "args"]);
    const target = requiredString(request.input, "node");
    const node = scope.nodes.get(target);
    if (node === undefined) {
      throw new AflVmError("FREEDOM_NODE_DENIED", `Node '${target}' is not in this Freedom allowlist`);
    }
    const args = resolveControlArguments(request.input.args, scope.refs);
    if (args.length !== node.parameters.length) {
      throw new AflVmError(
        "CALL_ARITY",
        `Node '${target}' expects ${node.parameters.length} arguments, received ${args.length}`,
      );
    }
    this.assertFreedomRouteCapacity(scope, 1);
    if (await this.bindings.policy?.authorizeFreedomNode?.({
      ...this.freedomPolicyRequest(scope),
      target,
      args: args.map((argument) => clonePortable(argument)),
    }) === false) {
      throw new AflVmError("FREEDOM_NODE_DENIED", `Node '${target}' was denied by policy`);
    }
    this.reserveFreedomRoute(scope);
    const output = await this.executeNode(
      scope.origin.module,
      target,
      args,
      scope.context,
      scope.signal,
      `${scope.origin.activationPath}/freedom-node:${encodeURIComponent(request.id)}`,
      scope.planner.workspace,
      scope.freedomDepth,
    );
    const result = portableFlowResult(output, node.span);
    const ref = this.registerFreedomResult(scope, result);
    scope.counts.completedNode += 1;
    return controlResult({ ok: true, ref, value: portableControlValue(result) });
  }

  private validateFreedomIrTool(
    scope: FreedomScope,
    input: Readonly<Record<string, unknown>>,
  ): AgentControlToolResult {
    assertObjectInput(input, ["source", "entry", "args"]);
    scope.counts.validation += 1;
    if (scope.counts.validation > scope.limits.maxIrValidations) {
      throw new AflVmError(
        "FREEDOM_IR_VALIDATION_LIMIT_EXCEEDED",
        `Freedom exceeded max_ir_validations=${scope.limits.maxIrValidations}`,
      );
    }
    const source = requiredString(input, "source");
    const entry = requiredString(input, "entry");
    const args = resolveControlArguments(input.args, scope.refs);
    const result = this.validateGeneratedIr(scope, source, entry, args);
    return controlResult({
      ok: result.valid,
      ...(result.digest === undefined ? {} : { digest: result.digest }),
      diagnostics: diagnosticValues(result.diagnostics),
    });
  }

  private async executeFreedomIrTool(
    scope: FreedomScope,
    request: AgentControlToolRequest,
  ): Promise<AgentControlToolResult> {
    assertObjectInput(request.input, ["source", "entry", "args", "expectedDigest"]);
    scope.counts.execution += 1;
    if (scope.counts.execution > scope.limits.maxIrExecutions) {
      throw new AflVmError(
        "FREEDOM_IR_EXECUTION_LIMIT_EXCEEDED",
        `Freedom exceeded max_ir_executions=${scope.limits.maxIrExecutions}`,
      );
    }
    const source = requiredString(request.input, "source");
    const entry = requiredString(request.input, "entry");
    const args = resolveControlArguments(request.input.args, scope.refs);
    const expectedDigest = optionalString(request.input, "expectedDigest");
    const result = this.validateGeneratedIr(scope, source, entry, args);
    if (!result.valid || result.digest === undefined || result.overlay === undefined) {
      return controlResult({ ok: false, diagnostics: diagnosticValues(result.diagnostics) });
    }
    if (expectedDigest !== undefined && expectedDigest !== result.digest) {
      return controlResult({
        ok: false,
        digest: result.digest,
        error: {
          code: "FREEDOM_IR_DIGEST_MISMATCH",
          message: "Generated IR changed after validation",
        },
      });
    }
    if (await this.bindings.policy?.authorizeFreedomIr?.({
      ...this.freedomPolicyRequest(scope),
      source,
      entry,
      digest: result.digest,
    }) === false) {
      throw new AflVmError("FREEDOM_IR_DENIED", "Generated IR execution was denied by policy");
    }
    const output = await this.executeNode(
      result.overlay!,
      entry,
      args,
      scope.context,
      scope.signal,
      `${scope.origin.activationPath}/freedom-ir:${encodeURIComponent(request.id)}`,
      scope.planner.workspace,
      scope.freedomDepth,
      {
        scope,
        generatedNodes: new Set(result.module!.nodes.map((node) => node.name)),
      },
    );
    const portable = portableFlowResult(output, scope.instruction.span);
    const ref = this.registerFreedomResult(scope, portable);
    scope.counts.completedIr += 1;
    return controlResult({
      ok: true,
      digest: result.digest,
      ref,
      value: portableControlValue(portable),
      diagnostics: diagnosticValues(result.diagnostics),
    });
  }

  private validateGeneratedIr(
    scope: FreedomScope,
    source: string,
    entry: string,
    args: readonly VmArgument[],
  ): GeneratedIrValidation {
    const diagnostics: AflDiagnostic[] = [];
    let fragment: AflModule;
    if (new TextEncoder().encode(source).byteLength > scope.limits.maxGeneratedBytes) {
      diagnostics.push(generatedDiagnostic(
        "FREEDOM_IR_BYTE_LIMIT_EXCEEDED",
        `Generated IR exceeds max_generated_bytes=${scope.limits.maxGeneratedBytes}`,
      ));
      return { valid: false, diagnostics };
    }
    try {
      fragment = parseAfl(source, "<freedom-generated>");
    } catch (error) {
      if (error instanceof AflParseError || error instanceof AflValidationError) {
        return { valid: false, diagnostics: error.diagnostics };
      }
      const vmError = normalizeVmError(error);
      return { valid: false, diagnostics: [generatedDiagnostic(vmError.code, vmError.message)] };
    }
    if (fragment.nodes.length > scope.limits.maxGeneratedNodes) {
      diagnostics.push(generatedDiagnostic(
        "FREEDOM_IR_NODE_LIMIT_EXCEEDED",
        `Generated IR exceeds max_generated_nodes=${scope.limits.maxGeneratedNodes}`,
      ));
    }
    const originNames = new Set(scope.origin.module.nodes.map((node) => node.name));
    const fragmentNames = new Set(fragment.nodes.map((node) => node.name));
    for (const node of fragment.nodes) {
      if (originNames.has(node.name)) {
        diagnostics.push(generatedDiagnostic(
          "FREEDOM_IR_NODE_COLLISION",
          `Generated Node '${node.name}' collides with a writer-origin Node`,
          node.span,
        ));
      }
      this.validateGeneratedNodeScope(scope, node, fragmentNames, originNames, diagnostics);
    }
    const entryNode = fragment.nodes.find((node) => node.name === entry);
    if (entryNode === undefined) {
      diagnostics.push(generatedDiagnostic(
        "FREEDOM_IR_ENTRY_UNKNOWN",
        `Generated entry Node '${entry}' is not declared by this fragment`,
      ));
    } else if (entryNode.parameters.length !== args.length) {
      diagnostics.push(generatedDiagnostic(
        "CALL_ARITY",
        `Generated entry Node '${entry}' expects ${entryNode.parameters.length} arguments, received ${args.length}`,
        entryNode.span,
      ));
    }

    const validationOverlay: AflModule = {
      sourceName: "<freedom-generated>",
      nodes: [
        ...scope.origin.module.nodes.map(validationNodeStub),
        ...fragment.nodes,
      ],
    };
    const validation = validateModule(validationOverlay);
    diagnostics.push(...validation.diagnostics.filter((diagnostic) => diagnostic.span.line !== 0));
    this.validateGeneratedWorkspaceOverlap(scope, fragment, diagnostics);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
    if (errors.length > 0) return { valid: false, diagnostics };
    const overlay: AflModule = {
      sourceName: "<freedom-overlay>",
      nodes: [...scope.origin.module.nodes, ...fragment.nodes],
    };
    return {
      valid: true,
      digest: canonicalModuleDigest(fragment),
      module: fragment,
      overlay,
      diagnostics,
    };
  }

  private validateGeneratedNodeScope(
    scope: FreedomScope,
    node: AflNode,
    fragmentNames: ReadonlySet<string>,
    originNames: ReadonlySet<string>,
    diagnostics: AflDiagnostic[],
  ): void {
    const allowedAgents = new Set(scope.agents.map((agent) => agent.name));
    const validateTarget = (target: FlowTarget, span: SourceSpan): void => {
      if (target.kind === "external") {
        diagnostics.push(generatedDiagnostic(
          "FREEDOM_IR_EXTERNAL_FLOW_DENIED",
          `Generated IR cannot call external Flow '${target.name}' in v0`,
          span,
        ));
      } else if (originNames.has(target.name) && !scope.nodes.has(target.name)) {
        diagnostics.push(generatedDiagnostic(
          "FREEDOM_IR_NODE_DENIED",
          `Writer-origin Node '${target.name}' is not in this Freedom allowlist`,
          span,
        ));
      } else if (!originNames.has(target.name) && !fragmentNames.has(target.name)) {
        diagnostics.push(generatedDiagnostic("FLOW_UNKNOWN", `Flow '${target.name}' is not declared`, span));
      }
    };
    for (const block of node.blocks) {
      for (const instruction of block.instructions) {
        switch (instruction.op) {
          case "agent":
            if (!allowedAgents.has(instruction.agent.name)) {
              diagnostics.push(generatedDiagnostic(
                "FREEDOM_IR_AGENT_DENIED",
                `Agent '${instruction.agent.name}' is not in this Freedom allowlist`,
                instruction.span,
              ));
            }
            break;
          case "call":
            validateTarget(instruction.target, instruction.span);
            break;
          case "dispatch":
            for (const call of instruction.calls) validateTarget(call.target, call.span);
            break;
          case "repeat":
            validateTarget(instruction.target, instruction.span);
            break;
          case "input":
          case "script":
          case "invoke":
          case "agent.route":
          case "agent.flow":
            diagnostics.push(generatedDiagnostic(
              "FREEDOM_IR_INSTRUCTION_DENIED",
              `Generated IR cannot use '${instruction.op}' in v0`,
              instruction.span,
            ));
            break;
          case "prompt":
            if (instruction.source.kind === "symbol") {
              diagnostics.push(generatedDiagnostic(
                "FREEDOM_IR_SYMBOL_DENIED",
                "Generated IR cannot use an external Prompt symbol in v0",
                instruction.source.span,
              ));
            }
            break;
          case "agent.system_prompt":
            if (instruction.prompt.kind === "symbol") {
              diagnostics.push(generatedDiagnostic(
                "FREEDOM_IR_SYMBOL_DENIED",
                "Generated IR cannot use an external system Prompt symbol in v0",
                instruction.prompt.span,
              ));
            }
            break;
          case "agent.do":
            if (instruction.schema !== undefined) {
              diagnostics.push(generatedDiagnostic(
                "FREEDOM_IR_SYMBOL_DENIED",
                "Generated IR cannot use an external Schema symbol in v0",
                instruction.schema.span,
              ));
            }
            break;
          case "fork":
            if (instruction.action.schema !== undefined) {
              diagnostics.push(generatedDiagnostic(
                "FREEDOM_IR_SYMBOL_DENIED",
                "Generated IR cannot use an external Schema symbol in v0",
                instruction.action.schema.span,
              ));
            }
            break;
          case "sync":
            if (instruction.formatter !== undefined) {
              diagnostics.push(generatedDiagnostic(
                "FREEDOM_IR_SYMBOL_DENIED",
                "Generated IR cannot use an external Formatter symbol in v0",
                instruction.formatter.span,
              ));
            }
            break;
          default:
            break;
        }
      }
    }
  }

  private validateGeneratedWorkspaceOverlap(
    scope: FreedomScope,
    fragment: AflModule,
    diagnostics: AflDiagnostic[],
  ): void {
    for (const node of fragment.nodes) {
      for (const block of node.blocks) {
        for (const instruction of block.instructions) {
          if (instruction.op !== "agent") continue;
          const workspace = literalWorkspacePaths(instruction.workspace);
          if (workspace === undefined) continue;
          const childPrimary = resolveWorkspaceLiteral(scope.context.executionRoot, workspace.primary);
          const writerPaths = [
            scope.planner.workspace.primary.root,
            ...scope.planner.workspace.readOnly.map((item) => item.root),
          ];
          const primaryConflict = writerPaths.find((path) => workspacePathOverlap(path, childPrimary));
          const readOnlyConflict = workspace.readOnly
            .map((path) => resolveWorkspaceLiteral(scope.context.executionRoot, path))
            .find((path) => workspacePathOverlap(path, scope.planner.workspace.primary.root));
          if (primaryConflict === undefined && readOnlyConflict === undefined) continue;
          diagnostics.push(generatedDiagnostic(
            "FREEDOM_WORKSPACE_OVERLAP",
            `Generated Agent Workspace '${primaryConflict === undefined ? readOnlyConflict : childPrimary}' conflicts with the writer Workspace`,
            instruction.workspace!.span,
            "warning",
          ));
        }
      }
    }
  }

  private freedomPolicyRequest(scope: FreedomScope) {
    return {
      mode: freedomInstructionMode(scope.instruction),
      module: scope.origin.module,
      runId: scope.context.runId,
      node: scope.location.node,
      block: scope.location.block,
      planner: scope.planner.agent,
      nodes: [...scope.nodes.keys()],
      agents: scope.agents,
      constraint: scope.constraint,
    } as const;
  }

  private registerFreedomResult(scope: FreedomScope, result: VmArgument): string {
    scope.counts.result += 1;
    const ref = `result:${scope.counts.result}`;
    scope.refs.set(ref, clonePortable(result));
    return ref;
  }

  private toPromptArgument(value: VmValue, span: SourceSpan): PromptArgument {
    if (isFrag(value) || isComputeValue(value) || isSymbolRef(value)) return clonePortable(value);
    throw new AflVmError("PROMPT_ARGUMENT_INVALID", "prompt argument cannot be a VM handle", { span });
  }

  private toBuiltinArgument(value: VmValue, span: SourceSpan): AflBuiltinArgument {
    if (isFrag(value) || isComputeValue(value)) return clonePortable(value);
    throw new AflVmError("COMPUTE_ARGUMENT_INVALID", "compute argument cannot be a VM handle or symbol", { span });
  }

  private toVmArgument(value: VmValue, span: SourceSpan): VmArgument {
    if (isFrag(value) || isComputeValue(value) || isSymbolRef(value)) return clonePortable(value);
    throw new AflVmError("FLOW_ARGUMENT_INVALID", "external flow argument cannot be a VM handle", { span });
  }

  private createMemory(
    context: VmRunContext,
    slot: string,
    moduleDigest: string,
    messages: readonly Message[] = [],
    checkpoint?: MemoryCheckpoint,
    requestedBase?: { readonly slot: string; readonly revision: number },
  ): MemoryHandle {
    const claimed = context.persistence.claim(slot, moduleDigest, messages, requestedBase);
    const clonedCheckpoint = claimed.continuation === undefined
      ? claimed.restored ? undefined : cloneMemoryCheckpoint(checkpoint)
      : continuationCheckpoint(claimed.continuation);
    return {
      kind: "memory",
      id: this.nextHandle(context, "memory"),
      messages: claimed.messages,
      revision: claimed.revision,
      slot,
      moduleDigest,
      ...(claimed.base === undefined ? {} : { base: structuredClone(claimed.base) }),
      ...(clonedCheckpoint === undefined ? {} : { checkpoint: clonedCheckpoint }),
    };
  }

  private createAgent(
    context: VmRunContext,
    agent: SymbolRef,
    memory: MemoryHandle,
    workspace: AgentWorkspaceSet,
    origin: AgentOrigin,
    tools?: readonly AgentStandardToolName[],
  ): AgentHandle {
    return {
      kind: "agent",
      id: this.nextHandle(context, "agent"),
      agent,
      memory,
      workspace,
      origin,
      ...(tools === undefined ? {} : { tools: Object.freeze([...tools]) }),
    };
  }

  private agentOrigin(
    frame: MutableFrame,
    activation: ActivationContext,
    location: Required<TraceLocation>,
  ): AgentOrigin {
    return Object.freeze({
      module: frame.module,
      moduleDigest: activation.moduleDigest,
      activationPath: activation.path,
      node: location.node,
      block: location.block,
      instruction: location.instruction,
    });
  }

  private async persistMemory(
    context: VmRunContext,
    memory: MemoryHandle,
    signal: AbortSignal,
    attempt?: MemoryPersistenceAttempt,
  ): Promise<void> {
    await context.persistence.save(
      memory.slot,
      memory.moduleDigest,
      memory.messages,
      memory.revision,
      persistedContinuation(memory.checkpoint),
      signal,
      attempt,
    );
  }

  private memorySlot(
    frame: MutableFrame,
    instruction: AflInstruction,
    activation: ActivationContext,
    blockVisit: number,
    location: Required<TraceLocation>,
    allocation: "working" | "copy" | "fork",
  ): string {
    const destination = instructionDestination(instruction) ?? "_";
    return [
      `module:${activation.moduleDigest}`,
      `entry:${encodeURIComponent(frame.node.name)}`,
      `activation:${activation.path}`,
      `block:${encodeURIComponent(location.block)}@${blockVisit}`,
      `instruction:${location.instruction}:${instruction.op}:${encodeURIComponent(destination)}`,
      `allocation:${allocation}`,
    ].join("/");
  }

  private childActivationPath(
    activation: ActivationContext,
    location: Required<TraceLocation>,
    blockVisit: number,
    kind: "call" | "dispatch",
  ): string {
    return [
      activation.path,
      `${kind}:${encodeURIComponent(location.node)}.${encodeURIComponent(location.block)}@${blockVisit}.${location.instruction}`,
    ].join("/");
  }

  private nextHandle(context: VmRunContext, prefix: string): string {
    context.counters.handles += 1;
    return `${context.runId}:${prefix}:${context.counters.handles}`;
  }

  private takeStep(context: VmRunContext, label: string, signal: AbortSignal = context.signal): void {
    throwIfAborted(signal);
    context.counters.steps += 1;
    if (context.counters.steps > context.maxSteps) {
      throw new AflVmError(
        "RUN_STEP_BUDGET_EXCEEDED",
        `run exceeded ${context.maxSteps} steps while entering ${label}`,
      );
    }
  }

  private assertNoOutstandingGroups(frame: MutableFrame, span: SourceSpan): void {
    if (frame.taskGroups.size > 0) {
      throw new AflVmError("TASK_GROUP_UNCONSUMED", "node cannot return before syncing every TaskGroup", {
        span,
      });
    }
  }

  private requireFormatter() {
    if (this.bindings.formatters === undefined) {
      throw new AflVmError("FORMATTER_ADAPTER_MISSING", "explicit formatter requires a Formatter binding");
    }
    return this.bindings.formatters;
  }

  private async validateSchema(
    content: string,
    schema: SymbolExpr | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (schema === undefined) return;
    if (this.bindings.schemas === undefined) {
      throw new AflVmError("SCHEMA_ADAPTER_MISSING", `schema '${schema.name}' requires a Schema binding`, {
        span: schema.span,
      });
    }
    await this.bindings.schemas.validate({ schema: toSymbol(schema), content, signal });
  }

  private async trace(
    context: VmRunContext,
    type: TraceEventType,
    location: TraceLocation = {},
    details?: ComputeValue,
    error?: AflVmError,
  ): Promise<void> {
    if (this.bindings.trace === undefined) return;
    context.counters.trace += 1;
    const event: TraceEvent = {
      sequence: context.counters.trace,
      timestamp: new Date().toISOString(),
      runId: context.runId,
      type,
      ...(location.node === undefined ? {} : { node: location.node }),
      ...(location.block === undefined ? {} : { block: location.block }),
      ...(location.instruction === undefined ? {} : { instruction: location.instruction }),
      ...(details === undefined ? {} : { details }),
      ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }),
    };
    await this.bindings.trace.emit(event);
  }
}

function validateVmPolicy(bindings: VmBindings, span: SourceSpan): void {
  const policy = bindings.policy;
  if (policy === undefined) return;
  if (policy.maxConcurrency !== undefined && (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency <= 0)) {
    throw new AflVmError("VM_POLICY_INVALID", "maxConcurrency must be a positive integer");
  }
  if (policy.maxDispatchWorkers !== undefined &&
      (!Number.isInteger(policy.maxDispatchWorkers) || policy.maxDispatchWorkers <= 0)) {
    throw new AflVmError("VM_POLICY_INVALID", "maxDispatchWorkers must be a positive integer");
  }
  if (policy.maxDispatchTasks !== undefined &&
      (!Number.isInteger(policy.maxDispatchTasks) || policy.maxDispatchTasks < 0)) {
    throw new AflVmError("VM_POLICY_INVALID", "maxDispatchTasks must be a non-negative integer");
  }
  parseFreedomLimits({}, span, policy.freedomLimits);
}

function isMatchScalar(value: ComputeValue): value is null | boolean | number | string {
  return value === null || ["boolean", "number", "string"].includes(typeof value);
}

class SuspendableSemaphoreLease {
  private release: (() => void) | undefined;
  private suspended = 0;
  private closed = false;
  private transition: Promise<void> = Promise.resolve();

  private constructor(
    private readonly semaphore: Semaphore,
    private readonly signal: AbortSignal,
    release: () => void,
  ) {
    this.release = release;
  }

  static async open(semaphore: Semaphore, signal: AbortSignal): Promise<SuspendableSemaphoreLease> {
    return new SuspendableSemaphoreLease(semaphore, signal, await semaphore.acquire(signal));
  }

  async suspend<T>(operation: () => Promise<T>): Promise<T> {
    await this.enqueue(() => {
      if (this.closed) throw new AflVmError("RUN_CLOSED", "Agent execution lease has closed");
      this.suspended += 1;
      if (this.suspended === 1) {
        this.release?.();
        this.release = undefined;
      }
    });
    try {
      return await operation();
    } finally {
      await this.enqueue(async () => {
        this.suspended -= 1;
        if (this.suspended < 0) {
          throw new AflVmError("VM_INTERNAL", "Agent execution lease suspension underflow");
        }
        if (this.suspended === 0 && !this.closed) {
          this.release = await this.semaphore.acquire(this.signal);
        }
      });
    }
  }

  async close(): Promise<void> {
    await this.enqueue(() => {
      this.closed = true;
      this.release?.();
      this.release = undefined;
    });
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const current = this.transition.then(operation, operation);
    this.transition = current.then(() => {}, () => {});
    return current;
  }
}

function normalizeFlowResult(value: VmValue, span: SourceSpan): Frag {
  if (isFrag(value)) return value;
  if (isComputeValue(value)) return frag(formatCompute(value));
  throw new AflVmError("FLOW_RESULT_INVALID", "flow result must be Frag or compute data", { span });
}

function failureMessage(value: VmValue): string {
  if (isFrag(value)) return value.content;
  if (isComputeValue(value)) return formatCompute(value);
  return "flow entered fail with a VM handle";
}

function formatPromptArgument(value: PromptArgument): string {
  if (isFrag(value)) return value.content;
  if (isSymbolRef(value)) return value.name;
  return formatCompute(value);
}

function clonePortable<T extends VmArgument>(value: T): T {
  return structuredClone(value);
}

function cloneVmValue(value: VmValue): VmValue {
  if (isAgentHandle(value) || isMemoryHandle(value) || isTaskGroupLike(value)) return value;
  return clonePortable(value);
}

function isTaskGroupLike(value: VmValue): value is TaskGroupHandle {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "taskGroup";
}

function cloneMessages(messages: readonly { role: string; content: string }[]) {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function appendMemoryMessage(memory: MemoryHandle, message: { role: string; content: string }): void {
  memory.messages.push(message);
  memory.revision += 1;
}

function cloneMemoryCheckpoint(checkpoint: MemoryCheckpoint | undefined): MemoryCheckpoint | undefined {
  return checkpoint === undefined ? undefined : structuredClone(checkpoint);
}

function persistedContinuation(checkpoint: MemoryCheckpoint | undefined): PersistedMemoryContinuation | undefined {
  return checkpoint?.state === undefined
    ? undefined
    : {
        memoryRevision: checkpoint.memoryRevision,
        state: structuredClone(checkpoint.state),
      };
}

function continuationCheckpoint(continuation: PersistedMemoryContinuation): MemoryCheckpoint {
  return {
    memoryRevision: continuation.memoryRevision,
    state: structuredClone(continuation.state),
  };
}

function toSymbol(expression: SymbolExpr): SymbolRef {
  return { kind: "symbol", name: expression.name };
}

function isVmHandle(value: VmValue): value is AgentHandle | MemoryHandle | TaskGroupHandle {
  return isAgentHandle(value) || isMemoryHandle(value) || isTaskGroupLike(value);
}

function portableFlowResult(value: VmValue, span: SourceSpan): VmArgument {
  if (isFrag(value)) return clonePortable(value);
  if (isSymbolRef(value) || isVmHandle(value) || !isComputeValue(value)) {
    throw new AflVmError("FLOW_RESULT_INVALID", "Freedom child result must be Frag or compute data", { span });
  }
  return structuredClone(value);
}

function portableControlValue(value: VmArgument): ComputeValue {
  if (isFrag(value)) return { type: "frag", content: value.content };
  if (isSymbolRef(value)) return { type: "symbol", name: value.name };
  return structuredClone(value);
}

function portableControlKind(value: VmArgument): string {
  if (isFrag(value)) return "frag";
  if (isSymbolRef(value)) return "symbol";
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value === "object" ? "record" : typeof value;
}

function freedomInstructionMode(instruction: AgentControlInstruction): AgentControlMode {
  return instruction.op === "agent.route" ? "route" : "flow";
}

function freedomLimitsValue(limits: FreedomLimits): ComputeValue {
  return {
    min_routes: limits.minRoutes,
    max_routes: limits.maxRoutes,
  };
}

function controlResult(payload: ComputeValue): AgentControlToolResult {
  return {
    content: JSON.stringify(payload, null, 2),
    details: structuredClone(payload),
  };
}

function assertObjectInput(
  input: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AflVmError("FREEDOM_TOOL_INPUT_INVALID", "AFL control tool input must be an object");
  }
  const unknown = Object.keys(input).find((field) => !allowedFields.includes(field));
  if (unknown !== undefined) {
    throw new AflVmError("FREEDOM_TOOL_INPUT_INVALID", `unknown AFL control tool input field '${unknown}'`);
  }
}

function requiredString(input: Readonly<Record<string, unknown>>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AflVmError("FREEDOM_TOOL_INPUT_INVALID", `'${field}' must be a non-empty string`);
  }
  return value;
}

function optionalString(input: Readonly<Record<string, unknown>>, field: string): string | undefined {
  if (input[field] === undefined) return undefined;
  return requiredString(input, field);
}

function resolveControlArguments(
  input: unknown,
  refs: ReadonlyMap<string, VmArgument>,
): VmArgument[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new AflVmError("FREEDOM_TOOL_INPUT_INVALID", "'args' must be an array");
  }
  return input.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new AflVmError(
        "FREEDOM_TOOL_INPUT_INVALID",
        `argument ${index} must contain exactly one 'ref' or 'string' field`,
      );
    }
    const candidate = item as Record<string, unknown>;
    const keys = Object.keys(candidate);
    if (keys.length !== 1) {
      throw new AflVmError(
        "FREEDOM_TOOL_INPUT_INVALID",
        `argument ${index} must contain exactly one 'ref' or 'string' field`,
      );
    }
    if (keys[0] === "string" && typeof candidate.string === "string") return candidate.string;
    if (keys[0] !== "ref" || typeof candidate.ref !== "string" || candidate.ref.length === 0) {
      throw new AflVmError(
        "FREEDOM_TOOL_INPUT_INVALID",
        `argument ${index} must contain exactly one 'ref' or 'string' field`,
      );
    }
    const value = refs.get(candidate.ref);
    if (value === undefined) {
      throw new AflVmError("FREEDOM_REF_UNKNOWN", `controlled reference '${candidate.ref}' is unavailable`);
    }
    return clonePortable(value);
  });
}

function diagnosticValues(diagnostics: readonly AflDiagnostic[]): ComputeValue[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity ?? "error",
    span: {
      line: diagnostic.span.line,
      column: diagnostic.span.column,
      endColumn: diagnostic.span.endColumn,
    },
    ...(diagnostic.sourceName === undefined ? {} : { sourceName: diagnostic.sourceName }),
  }));
}

function generatedDiagnostic(
  code: string,
  message: string,
  span: SourceSpan = { line: 1, column: 1, endColumn: 1 },
  severity?: "warning",
): AflDiagnostic {
  return {
    code,
    message,
    ...(severity === undefined ? {} : { severity }),
    span,
    sourceName: "<freedom-generated>",
  };
}

function validationNodeStub(node: AflNode): AflNode {
  const span = { line: 0, column: 0, endColumn: 0 };
  return {
    name: node.name,
    parameters: [...node.parameters],
    blocks: [{
      name: "entry",
      instructions: [],
      terminator: { op: "ret", span },
      span,
    }],
    span,
  };
}

function literalWorkspacePaths(
  expression: ValueExpr | undefined,
): { readonly primary: string; readonly readOnly: readonly string[] } | undefined {
  if (expression?.kind === "literal" && typeof expression.value === "string") {
    return { primary: expression.value, readOnly: [] };
  }
  if (expression?.kind !== "list") return undefined;
  const paths = expression.items.map((item) =>
    item.kind === "literal" && typeof item.value === "string" ? item.value : undefined);
  if (paths.some((path) => path === undefined)) return undefined;
  return { primary: paths[0]!, readOnly: paths.slice(1) as string[] };
}

function resolveWorkspaceLiteral(executionRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(executionRoot, path);
}

function freedomWorkspaceConflict(
  child: AgentWorkspaceSet,
  writer: AgentWorkspaceSet,
): { readonly child: string; readonly writer: string } | undefined {
  for (const writerPath of [writer.primary, ...writer.readOnly]) {
    if (workspacePathOverlap(child.primary.root, writerPath.root)) {
      return { child: child.primary.root, writer: writerPath.root };
    }
  }
  for (const childPath of child.readOnly) {
    if (workspacePathOverlap(childPath.root, writer.primary.root)) {
      return { child: childPath.root, writer: writer.primary.root };
    }
  }
  return undefined;
}

function transactionEvent(
  title: string,
  event: AgentApprovalQueueEvent,
): Parameters<AgentExecutionHost["emit"]>[0] {
  const state = event.type === "resolved"
    ? event.decision === "approved" ? "completed" : "denied"
    : event.type;
  return {
    type: "transaction.state",
    id: event.request.subject.toolCallId,
    title,
    state,
    sequence: event.request.sequence,
  };
}

function elevationEvent(
  action: AgentToolAction,
  event: AgentApprovalQueueEvent,
): Parameters<AgentExecutionHost["emit"]>[0] {
  const state = event.type === "resolved" ? event.decision : event.type;
  return {
    type: "elevation.state",
    id: action.toolCallId,
    name: action.toolName,
    state,
    sequence: event.request.sequence,
  };
}

function requireNonEmptyTransactionText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentExecutorError(
      "AGENT_EXECUTION_FAILED",
      `Agent transaction ${field} must be a non-empty string`,
    );
  }
  return value;
}

const INTERRUPTING_AGENT_ERROR_CODES = new Set([
  "AGENT_EXECUTOR_UNAVAILABLE",
  "AGENT_SANDBOX_INIT_FAILED",
  "AGENT_SANDBOX_TERMINATED",
  "AGENT_EXECUTION_FAILED",
]);

function agentAttemptStatus(
  error: unknown,
  vmError: AflVmError,
  executorRunning: boolean,
  signal: AbortSignal,
): AgentAttemptEnd["status"] {
  if (signal.aborted || vmError.code === "AGENT_CANCELLED") return "cancelled";
  if (!executorRunning) return "error";
  if (INTERRUPTING_AGENT_ERROR_CODES.has(vmError.code)) return "interrupted";
  if (error instanceof AgentExecutorError || error instanceof AflVmError) return "error";
  return "interrupted";
}

function createInterruptionContext(
  agent: AgentHandle,
  executor: string,
  location: Required<TraceLocation>,
  persistedRevision?: number,
): AgentInterruptionContext {
  return {
    agent: agent.agent.name,
    executor,
    activation: agent.origin.activationPath,
    location: `${location.node}:${location.block}:${location.instruction}`,
    memorySlot: agent.memory.slot,
    memoryRevision: persistedRevision ?? agent.memory.revision,
    workspace: agent.workspace.primary.root,
    readOnlyWorkspaces: agent.workspace.readOnly.map((item) => item.root),
  };
}

function withInterruptionContext(
  error: AflVmError,
  interruption: AgentInterruptionContext,
): AflVmError {
  return new AflVmError(error.code, error.message, {
    ...(error.span === undefined ? {} : { span: error.span }),
    details: mergeErrorDetails(error.details, {
      interruption: interruptionDetails(interruption),
    }),
    cause: error,
  });
}

function interruptionContext(error: AflVmError): AgentInterruptionContext | undefined {
  if (!isComputeRecord(error.details)) return undefined;
  const value = error.details.interruption;
  if (!isComputeRecord(value) ||
      typeof value.agent !== "string" ||
      typeof value.executor !== "string" ||
      typeof value.activation !== "string" ||
      typeof value.location !== "string" ||
      typeof value.memorySlot !== "string" ||
      !Number.isInteger(value.memoryRevision) ||
      (value.memoryRevision as number) < 0 ||
      typeof value.workspace !== "string" ||
      !Array.isArray(value.readOnlyWorkspaces) ||
      !value.readOnlyWorkspaces.every((item) => typeof item === "string")) {
    return undefined;
  }
  return {
    agent: value.agent,
    executor: value.executor,
    activation: value.activation,
    location: value.location,
    memorySlot: value.memorySlot,
    memoryRevision: value.memoryRevision as number,
    workspace: value.workspace,
    readOnlyWorkspaces: [...value.readOnlyWorkspaces] as string[],
  };
}

function interruptionDetails(
  interruption: AgentInterruptionContext,
): { readonly [key: string]: ComputeValue } {
  return {
    agent: interruption.agent,
    executor: interruption.executor,
    activation: interruption.activation,
    location: interruption.location,
    memorySlot: interruption.memorySlot,
    memoryRevision: interruption.memoryRevision,
    workspace: interruption.workspace,
    readOnlyWorkspaces: [...interruption.readOnlyWorkspaces],
  };
}

function withInterruptionShutdownError(error: AflVmError, shutdownError: unknown): AflVmError {
  const normalized = normalizeVmError(shutdownError);
  return new AflVmError(error.code, error.message, {
    ...(error.span === undefined ? {} : { span: error.span }),
    details: mergeErrorDetails(error.details, {
      interruptionPersistenceError: {
        code: normalized.code,
        message: normalized.message,
      },
    }),
    cause: error,
  });
}

function mergeErrorDetails(
  details: ComputeValue | undefined,
  additions: { readonly [key: string]: ComputeValue },
): { readonly [key: string]: ComputeValue } {
  if (details === undefined) return additions;
  if (isComputeRecord(details)) return { ...details, ...additions };
  return { originalDetails: details, ...additions };
}

function isComputeRecord(value: ComputeValue | undefined): value is { readonly [key: string]: ComputeValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectTaskGroupFailure(
  settled: readonly PromiseSettledResult<Frag>[],
): PromiseRejectedResult | undefined {
  const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  return failures.find((item) => interruptionContext(normalizeVmError(item.reason)) !== undefined)
    ?? failures.find((item) => normalizeVmError(item.reason).code !== "AGENT_CANCELLED")
    ?? failures[0];
}

function createRunId(): string {
  runSequence += 1;
  return `afl-${Date.now().toString(36)}-${process.pid.toString(36)}-${runSequence.toString(36)}`;
}
