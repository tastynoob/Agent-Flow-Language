import type {
  AgentRunRequest,
  FreedomPlan,
  PromptArgument,
  VmArgument,
  VmBindings,
  TraceEvent,
  TraceEventType,
} from "./adapters.js";
import { linkedController, ResourceLocks, Semaphore, throwIfAborted } from "./concurrency.js";
import { buildInstructionDependencies, instructionDestination } from "./dependencies.js";
import {
  asAgent,
  asCompute,
  asFrag,
  asMemory,
  asSymbol,
  asTaskGroup,
  evaluateOper,
  evaluateValue,
  formatCompute,
} from "./evaluator.js";
import { AflVmError, normalizeVmError } from "./errors.js";
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
  type Frag,
  type SourceSpan,
  type SymbolExpr,
  type SymbolRef,
  type ValueExpr,
} from "./ir.js";
import { parseAfl } from "./parser.js";
import {
  isAgentHandle,
  isMemoryHandle,
  isSymbolRef,
  type AgentHandle,
  type MemoryHandle,
  type VmValue,
  type TaskGroupHandle,
} from "./vm-values.js";
import { assertValidModule } from "./validation.js";

export interface VmRunOptions {
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
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
  readonly counters: {
    steps: number;
    trace: number;
    handles: number;
  };
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

  constructor(module: AflModule, bindings: VmBindings) {
    this.module = assertValidModule(module);
    this.bindings = bindings;
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
    const context: VmRunContext = {
      runId: options.runId ?? createRunId(),
      signal: linked.controller.signal,
      maxSteps,
      external: new Semaphore(maxConcurrency),
      locks: new ResourceLocks(),
      counters: { steps: 0, trace: 0, handles: 0 },
    };
    try {
      await this.trace(context, "run.started", {}, { entry });
      const output = await this.executeNode(this.module, entry, [...args], context);
      await this.trace(context, "run.completed", {}, { entry });
      return { runId: context.runId, output };
    } catch (error) {
      const vmError = normalizeVmError(error);
      await this.trace(context, "run.failed", {}, undefined, vmError);
      throw vmError;
    } finally {
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
        await this.executeBlock(frame, block, context, invocationSignal);
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
        if (terminator.condition === undefined) {
          blockName = terminator.trueTarget;
        } else {
          const condition = asCompute(evaluateValue(terminator.condition, frame), terminator.span, "jump condition");
          if (typeof condition !== "boolean") {
            throw new AflVmError("JUMP_CONDITION_NOT_BOOLEAN", "jump condition must be boolean", {
              span: terminator.span,
            });
          }
          blockName = condition ? terminator.trueTarget : terminator.falseTarget!;
        }
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
            void this.executeInstruction(frame, block, instruction, index, context, linked.controller.signal)
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
    signal: AbortSignal,
  ): Promise<VmValue | undefined> {
    throwIfAborted(signal);
    this.takeStep(context, `instruction '${instruction.op}'`, signal);
    const location = { node: frame.node.name, block: block.name, instruction: index };
    await this.trace(context, "instruction.started", location, { op: instruction.op });
    try {
      const value = await this.executeInstructionInner(frame, instruction, context, location, signal);
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
    location: Required<TraceLocation>,
    signal: AbortSignal,
  ): Promise<VmValue | undefined> {
    switch (instruction.op) {
      case "agent": {
        const memory = instruction.memory === undefined
          ? this.createMemory(context)
          : asMemory(evaluateValue(instruction.memory, frame), instruction.memory.span);
        return context.locks.use([{ key: memory.id, mode: "write" }], signal, () => {
          if (memory.owner !== undefined) {
            throw new AflVmError("MEMORY_ALREADY_BOUND", "Memory is already bound to an Agent", {
              span: instruction.span,
            });
          }
          const agent = this.createAgent(context, { kind: "symbol", name: instruction.agent.name }, memory);
          memory.owner = agent.id;
          return agent;
        });
      }
      case "agent.sysprompt": {
        const agent = asAgent(evaluateValue(instruction.agent, frame), instruction.agent.span);
        const prompt = await this.renderPrompt(instruction.prompt, [], frame, signal);
        await context.locks.use([{ key: agent.id, mode: "write" }], signal, () => {
          agent.systemPrompt = prompt.content;
        });
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
        return normalizeFlowResult(
          await this.invokeFlow(frame.module, instruction.target, args, context, signal),
          instruction.span,
        );
      }
      case "dispatch.list": {
        const calls = instruction.calls.map((call) => ({
          target: call.target,
          args: call.args.map((argument) => evaluateValue(argument, frame)),
          span: call.span,
        }));
        return this.startDispatch(frame, calls, context, location, signal);
      }
      case "dispatch.batch": {
        const count = asCompute(evaluateValue(instruction.count, frame), instruction.count.span, "dispatch count");
        if (!Number.isInteger(count) || typeof count !== "number" || count < 0) {
          throw new AflVmError("DISPATCH_COUNT_INVALID", "dispatch count must be a non-negative integer", {
            span: instruction.count.span,
          });
        }
        const task = evaluateValue(instruction.task, frame);
        const calls = Array.from({ length: count }, () => ({
          target: instruction.target,
          args: [cloneVmValue(task)],
          span: instruction.span,
        }));
        return this.startDispatch(frame, calls, context, location, signal);
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
        const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
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
          () => ({
            messages: cloneMessages(source.memory.messages),
            systemPrompt: source.systemPrompt,
            agent: source.agent,
          }),
        );
        const memory = this.createMemory(context, snapshot.messages);
        const branch = this.createAgent(context, snapshot.agent, memory);
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
        const request = {
          capability: toSymbol(instruction.capability),
          args: instruction.args.map((argument) => this.toPromptArgument(evaluateValue(argument, frame), argument.span)),
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
        await context.locks.use([{ key: memory.id, mode: "write" }], signal, () => {
          memory.messages.push({ role: instruction.role, content: value.content });
        });
        return undefined;
      }
      case "memory.copy": {
        const memory = asMemory(evaluateValue(instruction.memory, frame), instruction.memory.span);
        const messages = await context.locks.use(
          [{ key: memory.id, mode: "read" }],
          signal,
          () => cloneMessages(memory.messages),
        );
        return this.createMemory(context, messages);
      }
      case "memory.apply": {
        const source = asAgent(evaluateValue(instruction.sourceAgent, frame), instruction.sourceAgent.span);
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
            const agent = this.createAgent(context, source.agent, memory);
            if (source.systemPrompt !== undefined) agent.systemPrompt = source.systemPrompt;
            memory.owner = agent.id;
            return agent;
          },
        );
      }
      case "freedom.move":
      case "freedom.flow":
        return this.executeFreedom(frame, instruction, context, location, signal);
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
  ): Promise<Frag> {
    const agentAdapter = this.bindings.agents;
    if (agentAdapter === undefined) {
      throw new AflVmError(
        "AGENT_ADAPTER_MISSING",
        `Agent '${agent.agent.name}' requires an Agent binding`,
      );
    }
    return context.locks.use(
      [{ key: agent.id, mode: "write" }, { key: agent.memory.id, mode: "write" }],
      signal,
      async () => {
        agent.memory.messages.push({ role, content: input.content });
        const request: AgentRunRequest = {
          runId: context.runId,
          node: location.node,
          block: location.block,
          agent: agent.agent,
          ...(agent.systemPrompt === undefined ? {} : { systemPrompt: agent.systemPrompt }),
          messages: cloneMessages(agent.memory.messages),
          ...(schema === undefined ? {} : { schema: toSymbol(schema) }),
          signal,
        };
        const approved = await this.bindings.policy?.authorizeAgent?.(request);
        if (approved === false) {
          throw new AflVmError("AGENT_DENIED", `Agent '${agent.agent.name}' was denied`);
        }
        await this.trace(context, "agent.started", location, { agent: agent.id });
        try {
          const result = await context.external.use(signal, () => agentAdapter.run(request));
          if (typeof result.output !== "string") {
            throw new AflVmError("AGENT_OUTPUT_INVALID", "Agent adapter output must be a string");
          }
          await this.validateSchema(result.output, schema, signal);
          for (const message of result.messages ?? []) {
            if (typeof message.role !== "string" || typeof message.content !== "string") {
              throw new AflVmError("AGENT_MESSAGES_INVALID", "Agent adapter returned an invalid Message");
            }
            agent.memory.messages.push({ role: message.role, content: message.content });
          }
          agent.memory.messages.push({ role: "assistant", content: result.output });
          await this.trace(context, "agent.completed", location, { agent: agent.id });
          return frag(result.output);
        } catch (error) {
          const vmError = normalizeVmError(error);
          await this.trace(context, "agent.failed", location, { agent: agent.id }, vmError);
          throw vmError;
        }
      },
    );
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
  ): Promise<VmValue> {
    throwIfAborted(signal);
    if (target.kind === "local") return this.executeNode(module, target.name, args, context, signal);
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
    if (calls.length > maxTasks) {
      throw new AflVmError(
        "DISPATCH_TASK_LIMIT_EXCEEDED",
        `dispatch requested ${calls.length} tasks, exceeding maxDispatchTasks=${maxTasks}`,
      );
    }
    const linked = linkedController(parentSignal);
    const workerLimit = new Semaphore(maxWorkers);
    const id = this.nextHandle(context, "task-group");
    const tasks = calls.map((call) => {
      const task = workerLimit.use(linked.controller.signal, async () => normalizeFlowResult(
        await this.invokeFlow(frame.module, call.target, call.args, context, linked.controller.signal),
        call.span,
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
      case "agent.sysprompt":
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
      case "memory.apply":
        return [
          ...agent(instruction.sourceAgent, "read"),
          ...memory(instruction.memory, "write"),
        ];
      case "freedom.move":
      case "freedom.flow":
        return agent(instruction.planner, "read");
      default:
        return [];
    }
  }

  private async executeFreedom(
    frame: MutableFrame,
    instruction: Extract<AflInstruction, { op: "freedom.move" | "freedom.flow" }>,
    context: VmRunContext,
    location: Required<TraceLocation>,
    signal: AbortSignal,
  ): Promise<Frag> {
    if (this.bindings.freedom === undefined) {
      throw new AflVmError("FREEDOM_ADAPTER_MISSING", `${instruction.op} requires a Freedom binding`, {
        span: instruction.span,
      });
    }
    const planner = asAgent(evaluateValue(instruction.planner, frame), instruction.planner.span);
    const prompt = asFrag(evaluateValue(instruction.prompt, frame), instruction.prompt.span, "freedom prompt");
    const contextValue = asFrag(evaluateValue(instruction.context, frame), instruction.context.span, "freedom context");
    const moves = instruction.moves === undefined ? undefined : this.evaluateMoveCandidates(instruction.moves, frame);
    const plan: unknown = await this.bindings.freedom.plan({
      mode: instruction.mode,
      planner: planner.agent,
      ...(planner.systemPrompt === undefined ? {} : { systemPrompt: planner.systemPrompt }),
      messages: cloneMessages(planner.memory.messages),
      ...(moves === undefined ? {} : { moves }),
      prompt,
      context: contextValue,
      signal,
    });
    validateFreedomPlanShape(plan, instruction.mode, instruction.span);
    await this.trace(context, "freedom.planned", location, { kind: plan.kind });
    const approved = await this.bindings.policy?.approveFreedom?.({
      module: frame.module,
      plan,
      runId: context.runId,
      node: frame.node.name,
      block: location.block,
    });
    if (approved === false) {
      await this.trace(context, "freedom.rejected", location, { kind: plan.kind });
      throw new AflVmError("FREEDOM_DENIED", "freedom plan was denied by policy", {
        span: instruction.span,
      });
    }
    await this.trace(context, "freedom.approved", location, { kind: plan.kind });
    const result = await this.executeFreedomPlan(frame.module, plan, moves, context, signal, instruction.span);
    const output = normalizeFlowResult(result, instruction.span);
    await this.validateSchema(output.content, instruction.schema, signal);
    return output;
  }

  private async executeFreedomPlan(
    module: AflModule,
    plan: FreedomPlan,
    candidates: readonly SymbolRef[] | undefined,
    context: VmRunContext,
    signal: AbortSignal,
    span: SourceSpan,
  ): Promise<VmValue> {
    if (plan.kind === "move") {
      if (candidates === undefined || !candidates.some((candidate) => candidate.name === plan.move.name)) {
        throw new AflVmError("FREEDOM_MOVE_OUT_OF_SCOPE", `move '${plan.move.name}' is not a candidate`, { span });
      }
      if (this.bindings.moves === undefined) {
        throw new AflVmError("MOVE_ADAPTER_MISSING", "freedom move requires a Move binding", { span });
      }
      const result = await this.bindings.moves.execute({
        move: plan.move,
        args: plan.args ?? [],
        signal,
      });
      if (typeof result === "string") return frag(result);
      if (isFrag(result)) return result;
      throw new AflVmError("MOVE_RESULT_INVALID", "Move binding returned an invalid value", { span });
    }
    if (plan.kind === "flow") {
      if (this.bindings.flows === undefined) {
        throw new AflVmError("FLOW_ADAPTER_MISSING", "freedom flow requires a Flow binding", { span });
      }
      return this.bindings.flows.invoke({ flow: plan.flow, args: plan.args ?? [], signal });
    }
    const generated = assertValidModule(parseAfl(plan.source, "<freedom-generated>"));
    return this.executeNode(generated, plan.entry, [...(plan.args ?? [])], context, signal);
  }

  private evaluateMoveCandidates(expression: ValueExpr, frame: MutableFrame): SymbolRef[] {
    if (expression.kind !== "list") {
      throw new AflVmError("FREEDOM_MOVES_INVALID", "freedom.move candidates must be a symbol list", {
        span: expression.span,
      });
    }
    return expression.items.map((item) => asSymbol(evaluateValue(item, frame), item.span));
  }

  private toPromptArgument(value: VmValue, span: SourceSpan): PromptArgument {
    if (isFrag(value) || isComputeValue(value) || isSymbolRef(value)) return clonePortable(value);
    throw new AflVmError("PROMPT_ARGUMENT_INVALID", "prompt argument cannot be a VM handle", { span });
  }

  private toVmArgument(value: VmValue, span: SourceSpan): VmArgument {
    if (isFrag(value) || isComputeValue(value) || isSymbolRef(value)) return clonePortable(value);
    throw new AflVmError("FLOW_ARGUMENT_INVALID", "external flow argument cannot be a VM handle", { span });
  }

  private createMemory(context: VmRunContext, messages: readonly { role: string; content: string }[] = []): MemoryHandle {
    return {
      kind: "memory",
      id: this.nextHandle(context, "memory"),
      messages: cloneMessages(messages),
    };
  }

  private createAgent(context: VmRunContext, agent: SymbolRef, memory: MemoryHandle): AgentHandle {
    return { kind: "agent", id: this.nextHandle(context, "agent"), agent, memory };
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

function toSymbol(expression: SymbolExpr): SymbolRef {
  return { kind: "symbol", name: expression.name };
}

function validateFreedomPlanShape(
  plan: unknown,
  mode: "move" | "flow",
  span: SourceSpan,
): asserts plan is FreedomPlan {
  if (typeof plan !== "object" || plan === null || !("kind" in plan)) {
    throw new AflVmError("FREEDOM_PLAN_INVALID", "Freedom binding returned an invalid plan", { span });
  }
  const candidate = plan as Record<string, unknown>;
  if (candidate.kind !== "move" && candidate.kind !== "flow" && candidate.kind !== "generated") {
    throw new AflVmError("FREEDOM_PLAN_INVALID", "Freedom plan has an unknown kind", { span });
  }
  if (candidate.args !== undefined &&
      (!Array.isArray(candidate.args) || !candidate.args.every(isVmArgument))) {
    throw new AflVmError("FREEDOM_PLAN_INVALID", "Freedom plan args are invalid", { span });
  }
  if (mode === "move" && candidate.kind !== "move") {
    throw new AflVmError("FREEDOM_PLAN_KIND_INVALID", "freedom.move requires a move plan", { span });
  }
  if (mode === "flow" && candidate.kind === "move") {
    throw new AflVmError("FREEDOM_PLAN_KIND_INVALID", "freedom.flow requires a flow plan", { span });
  }
  if (candidate.kind === "move" &&
      (!isSymbolRef(candidate.move) || !candidate.move.name.startsWith("@move."))) {
    throw new AflVmError("FREEDOM_PLAN_INVALID", "move plan requires an @move symbol", { span });
  }
  if (candidate.kind === "flow" &&
      (!isSymbolRef(candidate.flow) || !candidate.flow.name.startsWith("@flow."))) {
    throw new AflVmError("FREEDOM_PLAN_INVALID", "flow plan requires an @flow symbol", { span });
  }
  if (candidate.kind === "generated" &&
      (typeof candidate.source !== "string" || candidate.source.trim().length === 0 ||
       typeof candidate.entry !== "string" || candidate.entry.trim().length === 0)) {
    throw new AflVmError("FREEDOM_PLAN_INVALID", "generated flow requires source and entry", { span });
  }
}

function isVmArgument(value: unknown): value is VmArgument {
  return isFrag(value) || isSymbolRef(value) || isComputeValue(value);
}

function createRunId(): string {
  runSequence += 1;
  return `afl-${Date.now().toString(36)}-${runSequence.toString(36)}`;
}
