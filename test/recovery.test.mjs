import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AflVm,
  AFL_MESSAGE_ROLE_SCHEMA,
  FileMemoryStateStore,
  FileRecoveryStateStore,
  MockAgentAdapter,
  RunRecoveryPersistence,
  frag,
  recoveryValueDigest,
} from "../dist/src/index.js";

const SINGLE_AGENT_FLOW = `
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "turn"
        ret result
`;

test("file recovery store enforces one kernel-backed writer", async (t) => {
  const root = await temporaryRoot(t);
  const directory = join(root, ".afl", "recovery");
  const firstStore = FileRecoveryStateStore.create(directory);
  const secondStore = FileRecoveryStateStore.create(directory);
  const signal = new AbortController().signal;
  const first = await firstStore.acquireRun("exclusive-writer", "start", signal);
  try {
    await assert.rejects(
      secondStore.acquireRun("exclusive-writer", "resume", signal),
      { code: "RECOVERY_RUN_ACTIVE" },
    );
  } finally {
    await first.release();
  }
  const second = await secondStore.acquireRun("exclusive-writer", "resume", signal);
  await second.release();
});

test("explicit resume continues an interrupted Agent operation without duplicating input", async (t) => {
  const root = await temporaryRoot(t);
  let firstCalls = 0;
  const interrupted = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      firstCalls += 1;
      throw new Error("provider unavailable");
    }),
  });

  await assert.rejects(
    interrupted.run("main", [], { runId: "resume-agent", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.equal(firstCalls, 1);

  await assert.rejects(
    interrupted.run("main", [], { runId: "resume-agent", executionRoot: root }),
    { code: "RECOVERY_RUN_REQUIRES_RESUME" },
  );

  let resumedMessages;
  let resumedCalls = 0;
  const resumed = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents: new MockAgentAdapter().on("@agent.worker", (request) => {
      resumedCalls += 1;
      resumedMessages = request.messages.map((message) => ({ ...message }));
      return "recovered";
    }),
  });
  const result = await resumed.run("main", [], {
    runId: "resume-agent",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "recovered");
  assert.equal(resumedCalls, 1);
  assert.deepEqual(resumedMessages, [{ role: "user", content: "turn" }]);

  const state = await memoryState(root, "resume-agent");
  assert.deepEqual(Object.values(state.memories)[0].messages, [
    { role: "user", content: "turn" },
    { role: "assistant", content: "recovered" },
  ]);

  const replayOnly = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      throw new Error("completed recovery must not execute the Agent");
    }),
  });
  const replayed = await replayOnly.run("main", [], {
    runId: "resume-agent",
    executionRoot: root,
    resume: true,
  });
  assert.deepEqual(replayed.output, result.output);

  const records = await recoveryRecords(root, "resume-agent");
  assert.deepEqual(records.map((record) => record.type), [
    "run.begin",
    "operation.prepared",
    "operation.interrupted",
    "run.interrupted",
    "run.resume",
    "operation.completed",
    "run.completed",
  ]);
});

test("pure control-flow safe points do not produce preventive checkpoint writes", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
main(left):
    entry:
        branch left, selected, fallback
    selected:
        count = oper 2 + 3
        value = oper [path: "left", count: count]
        ret value
    fallback:
        value = oper [path: "right", count: 0]
        ret value
`, {});
  const result = await vm.run("main", [true], {
    runId: "pure-safe-points",
    executionRoot: root,
  });
  assert.deepEqual(result.output, { path: "left", count: 5 });
  const records = await recoveryRecords(root, "pure-safe-points");
  assert.deepEqual(records.map((record) => record.type), ["run.begin", "run.completed"]);
});

test("file recovery store rejects a journal replaced by a symbolic link", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
main():
    entry:
        ret "done"
`, {});
  await vm.run("main", [], { runId: "linked-recovery", executionRoot: root });
  const directory = join(root, ".afl", "recovery");
  const [runDirectory] = (await readdir(directory)).filter((name) => name.startsWith("run-"));
  const journal = join(directory, runDirectory, "recovery.jsons");
  const target = join(root, "recovery-target.jsons");
  await rename(journal, target);
  await symlink(target, journal);

  await assert.rejects(
    FileRecoveryStateStore.create(directory).loadRun("linked-recovery", new AbortController().signal),
    { code: "RECOVERY_STATE_INVALID" },
  );
});

test("concurrent transitions for one recovery operation are serialized before append", async (t) => {
  const root = await temporaryRoot(t);
  const directory = join(root, ".afl", "recovery");
  const signal = new AbortController().signal;
  const persistence = await RunRecoveryPersistence.open(
    { directory },
    {
      mode: "start",
      runId: "serialized-operation",
      rootModuleDigest: `sha256:${"0".repeat(64)}`,
      entry: "main",
      args: [],
      executionRoot: root,
    },
    signal,
  );
  const descriptor = {
    id: "operation:test",
    kind: "test.operation",
    inputDigest: recoveryValueDigest({ input: "same" }),
    activation: "root",
    node: "main",
    block: "entry",
    instruction: 0,
    blockVisit: 0,
  };
  await Promise.all([
    persistence.prepareOperation(descriptor, signal),
    persistence.prepareOperation(descriptor, signal),
  ]);
  const [first, second] = await Promise.allSettled([
    persistence.completeOperation(descriptor.id, descriptor.inputDigest, "first", signal),
    persistence.completeOperation(descriptor.id, descriptor.inputDigest, "conflict", signal),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "RECOVERY_STATE_INVALID");
  await persistence.markCompleted("done", signal);
  await persistence.close();

  const records = await FileRecoveryStateStore.create(directory)
    .loadRun("serialized-operation", signal);
  assert.equal(records.filter((record) => record.type === "operation.prepared").length, 1);
  assert.equal(records.filter((record) => record.type === "operation.completed").length, 1);
});

test("a partial recovery-journal tail is truncated without losing complete records", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
main():
    entry:
        ret "done"
`, {});
  await vm.run("main", [], { runId: "partial-recovery-tail", executionRoot: root });
  const directory = join(root, ".afl", "recovery");
  const [runDirectory] = (await readdir(directory)).filter((name) => name.startsWith("run-"));
  const journal = join(directory, runDirectory, "recovery.jsons");
  await appendFile(journal, '{\n  "type": "operation.prepared",\n');

  const records = await FileRecoveryStateStore.create(directory)
    .loadRun("partial-recovery-tail", new AbortController().signal);
  assert.deepEqual(records.map((record) => record.type), ["run.begin", "run.completed"]);
  assert.equal((await readFile(journal, "utf8")).includes('"operation.prepared"'), false);
});

test("a recovery append failure prevents already queued records from reaching the store", async (t) => {
  const root = await temporaryRoot(t);
  let rejectFirstAppend;
  let markFirstAppendEntered;
  const firstAppendEntered = new Promise((resolve) => {
    markFirstAppendEntered = resolve;
  });
  const firstAppend = new Promise((_, reject) => {
    rejectFirstAppend = reject;
  });
  let appends = 0;
  const records = [];
  const store = {
    namespace: "test:terminal-recovery-save",
    async loadRun() {
      return undefined;
    },
    async createRun(descriptor) {
      records.push({ type: "run.begin", descriptor });
    },
    async appendRun(_runId, next) {
      appends += 1;
      if (appends === 1) {
        markFirstAppendEntered();
        await firstAppend;
      }
      records.push(...next);
    },
  };
  const signal = new AbortController().signal;
  const persistence = await RunRecoveryPersistence.open(
    { store },
    {
      mode: "start",
      runId: "terminal-recovery-save",
      rootModuleDigest: `sha256:${"1".repeat(64)}`,
      entry: "main",
      args: [],
      executionRoot: root,
    },
    signal,
  );
  const descriptor = (id) => ({
    id,
    kind: "test.operation",
    inputDigest: recoveryValueDigest({ id }),
    activation: "root",
    node: "main",
    block: "entry",
    instruction: id === "first" ? 0 : 1,
    blockVisit: 0,
  });
  const first = persistence.prepareOperation(descriptor("first"), signal);
  await firstAppendEntered;
  const second = persistence.prepareOperation(descriptor("second"), signal);
  rejectFirstAppend(new Error("store unavailable"));
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[0].reason.code, "RECOVERY_STATE_SAVE_FAILED");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.code, "RECOVERY_STATE_SAVE_FAILED");
  assert.equal(appends, 1);
  assert.deepEqual(records.map((record) => record.type), ["run.begin"]);
  await assert.rejects(persistence.close(), { code: "RECOVERY_STATE_SAVE_FAILED" });
});

test("a completed runId is immutable and cannot inherit Memory into a new execution", async (t) => {
  const root = await temporaryRoot(t);
  let initialCalls = 0;
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      initialCalls += 1;
      return "first-run";
    }),
  });
  const completedRun = await initial.run("main", [], {
    runId: "completed-run-id",
    executionRoot: root,
  });
  assert.equal(completedRun.output.content, "first-run");
  assert.equal(initialCalls, 1);

  let repeatedCalls = 0;
  const repeated = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      repeatedCalls += 1;
      return "must-not-run";
    }),
  });
  await assert.rejects(
    repeated.run("main", [], {
      runId: "completed-run-id",
      executionRoot: root,
    }),
    { code: "RECOVERY_RUN_COMPLETED" },
  );
  assert.equal(repeatedCalls, 0);

  const replayed = await repeated.run("main", [], {
    runId: "completed-run-id",
    executionRoot: root,
    resume: true,
  });
  assert.deepEqual(replayed.output, completedRun.output);
  assert.equal(repeatedCalls, 0);
  assert.equal((await recoveryRecords(root, "completed-run-id")).filter((record) =>
    record.type === "run.begin").length, 1);
});

test("resume replays completed Agent operations and executes only the interrupted operation", async (t) => {
  const root = await temporaryRoot(t);
  const flow = `
main():
    entry:
        worker = agent @agent.worker
        first = worker.do "first"
        second = worker.do "second"
        ret second
`;
  let initialCalls = 0;
  const initial = AflVm.fromSource(flow, {
    agents: new MockAgentAdapter().on("@agent.worker", (request) => {
      initialCalls += 1;
      if (request.messages.at(-1).content === "second") throw new Error("stream ended");
      return "first-result";
    }),
  });
  await assert.rejects(
    initial.run("main", [], { runId: "replay-completed", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.equal(initialCalls, 2);

  let resumedCalls = 0;
  let resumedMessages;
  const resumed = AflVm.fromSource(flow, {
    agents: new MockAgentAdapter().on("@agent.worker", (request) => {
      resumedCalls += 1;
      resumedMessages = request.messages.map((message) => ({ ...message }));
      return "second-result";
    }),
  });
  const result = await resumed.run("main", [], {
    runId: "replay-completed",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "second-result");
  assert.equal(resumedCalls, 1);
  assert.deepEqual(resumedMessages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "first-result" },
    { role: "user", content: "second" },
  ]);
});

test("pure branch control is replayed before the interrupted Agent operation", async (t) => {
  const root = await temporaryRoot(t);
  const flow = `
main(use_left):
    entry:
        branch use_left, left, right
    left:
        worker = agent @agent.worker
        result = worker.do "left"
        ret result
    right:
        ret "right"
`;
  const initial = AflVm.fromSource(flow, {
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      throw new Error("provider unavailable");
    }),
  });
  await assert.rejects(
    initial.run("main", [true], { runId: "branch-replay", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );

  let calls = 0;
  const resumed = AflVm.fromSource(flow, {
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      calls += 1;
      return "left-result";
    }),
  });
  const result = await resumed.run("main", [true], {
    runId: "branch-replay",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "left-result");
  assert.equal(calls, 1);

  await assert.rejects(
    resumed.run("main", [false], {
      runId: "branch-replay",
      executionRoot: root,
      resume: true,
    }),
    { code: "RECOVERY_RUN_INCOMPATIBLE" },
  );
});

test("resume rejects a changed binding recovery identity", async (t) => {
  const root = await temporaryRoot(t);
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    recoveryIdentity: "test-bindings/v1",
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      throw new Error("provider unavailable");
    }),
  });
  await assert.rejects(
    initial.run("main", [], { runId: "binding-identity", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );

  let calls = 0;
  const changed = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    recoveryIdentity: "test-bindings/v2",
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      calls += 1;
      return "wrong";
    }),
  });
  await assert.rejects(
    changed.run("main", [], { runId: "binding-identity", executionRoot: root, resume: true }),
    { code: "RECOVERY_RUN_INCOMPATIBLE" },
  );
  assert.equal(calls, 0);
});

test("resume rejects a changed Agent executor identity without relying on a manual binding fingerprint", async (t) => {
  const root = await temporaryRoot(t);
  const initialBackend = {
    ...controlBackend(async () => {
      throw new Error("provider unavailable");
    }),
    recoveryIdentity: "executor-config/v1",
  };
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, { agentExecutor: initialBackend });
  await assert.rejects(
    initial.run("main", [], { runId: "executor-identity", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );

  let calls = 0;
  const changedBackend = {
    ...controlBackend(async () => {
      calls += 1;
      return completed("wrong");
    }),
    recoveryIdentity: "executor-config/v2",
  };
  const changed = AflVm.fromSource(SINGLE_AGENT_FLOW, { agentExecutor: changedBackend });
  await assert.rejects(
    changed.run("main", [], { runId: "executor-identity", executionRoot: root, resume: true }),
    { code: "RECOVERY_RUN_INCOMPATIBLE" },
  );
  assert.equal(calls, 0);
});

test("Memory append is recovered while user-managed invoke is replayed", async (t) => {
  const root = await temporaryRoot(t);
  const flow = `
main():
    entry:
        prefix = invoke @example.prefix
        worker = agent @agent.worker
        worker.memory.append system, "seed"
        result = worker.do prefix
        ret result
`;
  let initialCapabilityCalls = 0;
  const initial = AflVm.fromSource(flow, {
    capabilities: {
      invoke() {
        initialCapabilityCalls += 1;
        return "turn";
      },
    },
    agents: new MockAgentAdapter().on("@agent.worker", () => {
      throw new Error("provider unavailable");
    }),
  });
  await assert.rejects(
    initial.run("main", [], { runId: "effect-replay", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.equal(initialCapabilityCalls, 1);

  let resumedCapabilityCalls = 0;
  let resumedMessages;
  const resumed = AflVm.fromSource(flow, {
    capabilities: {
      invoke() {
        resumedCapabilityCalls += 1;
        return "turn";
      },
    },
    agents: new MockAgentAdapter().on("@agent.worker", (request) => {
      resumedMessages = request.messages.map((message) => ({ ...message }));
      return "done";
    }),
  });
  const result = await resumed.run("main", [], {
    runId: "effect-replay",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "done");
  assert.equal(resumedCapabilityCalls, 1);
  assert.deepEqual(resumedMessages, [
    { role: "system", content: "seed" },
    { role: "user", content: "turn" },
  ]);
});

test("a transient user-managed invoke failure is retried on resume", async (t) => {
  const root = await temporaryRoot(t);
  const source = `
main():
    entry:
        result = invoke @example.effect
        ret result
`;
  let initialCalls = 0;
  const initial = AflVm.fromSource(source, {
    capabilities: {
      invoke() {
        initialCalls += 1;
        throw new Error("temporary transport failure");
      },
    },
  });
  await assert.rejects(
    initial.run("main", [], { runId: "adapter-interruption", executionRoot: root }),
    { code: "ADAPTER_ERROR" },
  );
  assert.equal(initialCalls, 1);
  assert.equal((await recoveryRecords(root, "adapter-interruption")).at(-1).type, "run.interrupted");

  let resumedCalls = 0;
  const resumed = AflVm.fromSource(source, {
    capabilities: {
      invoke() {
        resumedCalls += 1;
        return "recovered";
      },
    },
  });
  const result = await resumed.run("main", [], {
    runId: "adapter-interruption",
    executionRoot: root,
    resume: true,
  });
  assert.equal(resumedCalls, 1);
  assert.equal(result.output.content, "recovered");
});

test("a deterministic AFL failure remains terminal", async (t) => {
  const root = await temporaryRoot(t);
  const source = `
main():
    entry:
        fail "invalid design"
`;
  const vm = AflVm.fromSource(source, {});
  await assert.rejects(
    vm.run("main", [], { runId: "deterministic-failure", executionRoot: root }),
    { code: "FLOW_FAILED" },
  );
  assert.equal((await recoveryRecords(root, "deterministic-failure")).at(-1).type, "run.failed");
  await assert.rejects(
    vm.run("main", [], {
      runId: "deterministic-failure",
      executionRoot: root,
      resume: true,
    }),
    { code: "RECOVERY_RUN_NOT_RESUMABLE" },
  );
});

test("Agent tool authorization does not create a VM recovery operation", async (t) => {
  const root = await temporaryRoot(t);
  let effects = 0;
  const backend = toolBackend(async (request, host) => {
    const authorization = await authorizeTestTool(request, host);
    assert.equal(authorization.status, "allowed");
    effects += 1;
    return completed("model-finished-without-durable-tool-result");
  });
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, { agentExecutor: backend });
  const result = await initial.run("main", [], { runId: "agent-tool-boundary", executionRoot: root });
  assert.equal(result.output.content, "model-finished-without-durable-tool-result");
  assert.equal(effects, 1);
  const records = await recoveryRecords(root, "agent-tool-boundary");
  assert.equal(records.some((record) =>
    record.type === "operation.prepared" && record.operation.kind === "agent.tool"), false);
});

test("an interrupted Agent resumes without VM-level tool-effect ambiguity", async (t) => {
  const root = await temporaryRoot(t);
  let effects = 0;
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agentExecutor: toolBackend(async (request, host) => {
      const authorization = await authorizeTestTool(request, host);
      assert.equal(authorization.status, "allowed");
      effects += 1;
      throw new Error("provider disconnected before the tool result became durable");
    }),
  });
  await assert.rejects(
    initial.run("main", [], { runId: "nested-effect-before-output", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.equal(effects, 1);

  let resumedCalls = 0;
  const resumed = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agentExecutor: toolBackend(async (request, host) => {
      resumedCalls += 1;
      assert.equal(request.recovery?.mode, "resume");
      const authorization = await authorizeTestTool(request, host, "reconciliation-check");
      assert.equal(authorization.status, "allowed");
      return completed("model-reconciled");
    }),
  });
  const result = await resumed.run("main", [], {
    runId: "nested-effect-before-output",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "model-reconciled");
  assert.equal(resumedCalls, 1);
  assert.equal(effects, 1);
});

test("a completed transaction result is replayed without presenting the request twice", async (t) => {
  const root = await temporaryRoot(t);
  let presentations = 0;
  let first = true;
  const queue = {
    async enqueue() {
      presentations += 1;
      return "approved";
    },
  };
  const backend = {
    ...controlBackend(async (request, host) => {
      const result = await host.requestTransaction({
        id: "install-verilator",
        title: "Install Verilator",
        request: "Install the missing simulator",
        reason: "The verification environment is incomplete",
        signal: request.signal,
      });
      if (first) {
        first = false;
        assert.equal(result.status, "completed");
        throw new Error("provider disconnected after transaction result");
      }
      return completed(`transaction:${result.status}`);
    }),
    capabilities: {
      ...controlBackend(async () => completed("unused")).capabilities,
      interactiveApproval: true,
    },
  };
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agentExecutor: backend,
    agentSecurity: { approvalQueue: queue },
  });
  await assert.rejects(
    initial.run("main", [], { runId: "transaction-recovery", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );

  const resumed = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agentExecutor: backend,
    agentSecurity: { approvalQueue: queue },
  });
  const result = await resumed.run("main", [], {
    runId: "transaction-recovery",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "transaction:completed");
  assert.equal(presentations, 1);
  const records = await recoveryRecords(root, "transaction-recovery");
  assert.equal(records.some((record) =>
    record.type === "operation.prepared" && record.operation.kind === "agent.transaction"), true);
  assert.equal(records.some((record) =>
    record.type === "operation.completed" && record.id.startsWith("agent.transaction:")), true);
});

test("a completed interactive input result is replayed without reading the host twice", async (t) => {
  const root = await temporaryRoot(t);
  let reads = 0;
  let first = true;
  const backend = controlBackend(async (request, host) => {
    const value = await host.requestInput({
      id: "user-answer",
      runId: request.runId,
      node: request.node,
      block: request.block,
      agent: request.agent,
      prompt: "Which simulator should be used?",
      signal: request.signal,
    });
    if (first) {
      first = false;
      assert.equal(value, "verilator");
      throw new Error("provider disconnected after input result");
    }
    return completed(`input:${value}`);
  });
  const bindings = {
    agentExecutor: backend,
    agentHost: {
      async requestInput() {
        reads += 1;
        return "verilator";
      },
    },
  };
  const initial = AflVm.fromSource(SINGLE_AGENT_FLOW, bindings);
  await assert.rejects(
    initial.run("main", [], { runId: "input-recovery", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  const resumed = AflVm.fromSource(SINGLE_AGENT_FLOW, bindings);
  const result = await resumed.run("main", [], {
    runId: "input-recovery",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "input:verilator");
  assert.equal(reads, 1);
  const records = await recoveryRecords(root, "input-recovery");
  assert.equal(records.some((record) =>
    record.type === "operation.completed" && record.id.startsWith("agent.input:")), true);
});

test("an out-of-order Freedom control delivery observes cancellation instead of hanging", async (t) => {
  const root = await temporaryRoot(t);
  const abort = new AbortController();
  const flow = `
child():
    entry:
        ret "child"

main():
    entry:
        planner = agent @agent.planner
        summary = planner.flow "plan", [nodes: [child], max_routes: 1]
        ret summary
`;
  const backend = controlBackend(async (request, host) => {
    if (request.control === undefined) return completed("child");
    const first = host.executeControlTool({
      id: "first",
      name: "afl.environment.get",
      input: { include: ["nodes"] },
      signal: request.signal,
    });
    const second = host.executeControlTool({
      id: "second",
      name: "afl.environment.get",
      input: { include: ["nodes"] },
      signal: request.signal,
    });
    await Promise.all([first, second]);
    queueMicrotask(() => abort.abort(new Error("cancelled while waiting for ordered delivery")));
    await host.completeControlTool({ id: "second", name: "afl.environment.get", ok: true });
    await host.completeControlTool({ id: "first", name: "afl.environment.get", ok: true });
    return completed("unreachable");
  });
  const vm = AflVm.fromSource(flow, { agentExecutor: backend });
  const run = vm.run("main", [], {
    runId: "freedom-delivery-cancel",
    executionRoot: root,
    signal: abort.signal,
  });
  await assert.rejects(
    Promise.race([
      run,
      delay(1_000).then(() => { throw new Error("ordered Freedom delivery hung"); }),
    ]),
    { code: "AGENT_CANCELLED" },
  );
});

test("dispatch recovery reuses completed children and resumes only interrupted children", async (t) => {
  const root = await temporaryRoot(t);
  const flow = `
worker(task):
    entry:
        runner = agent @agent.worker
        result = runner.do task
        ret result

main():
    entry:
        jobs = dispatch [worker("done"), worker("retry"), @flow.external("external")]
        results = sync jobs
        ret results
`;
  const initialCalls = [];
  let initialExternalCalls = 0;
  const initial = AflVm.fromSource(flow, {
    agents: new MockAgentAdapter().on("@agent.worker", async (request) => {
      const task = request.messages.at(-1).content;
      initialCalls.push(task);
      if (task === "retry") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new Error("provider unavailable");
      }
      return "done-result";
    }),
    flows: {
      invoke() {
        initialExternalCalls += 1;
        return frag("external-result");
      },
    },
  });
  await assert.rejects(
    initial.run("main", [], { runId: "dispatch-recovery", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.deepEqual(initialCalls.sort(), ["done", "retry"]);
  assert.equal(initialExternalCalls, 1);

  const resumedCalls = [];
  let resumedExternalCalls = 0;
  const resumed = AflVm.fromSource(flow, {
    agents: new MockAgentAdapter().on("@agent.worker", (request) => {
      const task = request.messages.at(-1).content;
      resumedCalls.push(task);
      return `${task}-result`;
    }),
    flows: {
      invoke() {
        resumedExternalCalls += 1;
        return frag("external-result");
      },
    },
  });
  const result = await resumed.run("main", [], {
    runId: "dispatch-recovery",
    executionRoot: root,
    resume: true,
  });
  assert.deepEqual(resumedCalls, ["retry"]);
  assert.equal(resumedExternalCalls, 1);
  assert.deepEqual(JSON.parse(result.output.content), ["done-result", "retry-result", "external-result"]);
});

test("Freedom route recovery restores the planner route manifest without rerunning the planner", async (t) => {
  const root = await temporaryRoot(t);
  const flow = `
department(task):
    entry:
        worker = agent @agent.department
        result = worker.do task
        ret result

main():
    entry:
        planner = agent @agent.planner
        jobs = planner.route "choose", [nodes: [department], params: [task: "job"], min_routes: 1, max_routes: 1]
        reports = sync jobs
        ret reports
`;
  let plannerCalls = 0;
  let childCalls = 0;
  const initial = AflVm.fromSource(flow, {
    agentExecutor: controlBackend(async (request, host) => {
      if (request.control !== undefined) {
        plannerCalls += 1;
        const routed = await host.executeControlTool({
          id: "department",
          name: "afl.route.add",
          input: { node: "department", args: [{ ref: "param:task" }] },
          signal: request.signal,
        });
        assert.equal(JSON.parse(routed.content).ok, true);
        await host.completeControlTool({ id: "department", name: "afl.route.add", ok: true });
        return completed("planned");
      }
      childCalls += 1;
      throw new Error("provider unavailable");
    }),
  });
  await assert.rejects(
    initial.run("main", [], { runId: "freedom-route-recovery", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.equal(plannerCalls, 1);
  assert.equal(childCalls, 1);

  let resumedPlannerCalls = 0;
  let resumedChildCalls = 0;
  const resumed = AflVm.fromSource(flow, {
    agentExecutor: controlBackend(async (request) => {
      if (request.control !== undefined) {
        resumedPlannerCalls += 1;
        throw new Error("completed planner must be replayed");
      }
      resumedChildCalls += 1;
      return completed(`department:${request.memory.at(-1).content}`);
    }),
  });
  const result = await resumed.run("main", [], {
    runId: "freedom-route-recovery",
    executionRoot: root,
    resume: true,
  });
  assert.equal(resumedPlannerCalls, 0);
  assert.equal(resumedChildCalls, 1);
  assert.deepEqual(JSON.parse(result.output.content), ["department:job"]);
});

test("Freedom flow recovery restores completed control results before continuing the planner", async (t) => {
  const root = await temporaryRoot(t);
  const flow = `
department(task):
    entry:
        worker = agent @agent.department
        result = worker.do task
        ret result

main():
    entry:
        writer = agent @agent.writer
        summary = writer.flow "execute", [nodes: [department], params: [task: "job"], min_routes: 1, max_routes: 1]
        ret summary
`;
  let childCalls = 0;
  const initial = AflVm.fromSource(flow, {
    agentExecutor: controlBackend(async (request, host) => {
      if (request.control === undefined) {
        childCalls += 1;
        return completed(`department:${request.memory.at(-1).content}`);
      }
      const executed = await host.executeControlTool({
        id: "department",
        name: "afl.node.execute",
        input: { node: "department", args: [{ ref: "param:task" }] },
        signal: request.signal,
      });
      assert.equal(JSON.parse(executed.content).ok, true);
      throw new Error("planner stream ended after tool result");
    }),
  });
  await assert.rejects(
    initial.run("main", [], { runId: "freedom-flow-recovery", executionRoot: root }),
    (error) => error.details?.interruption !== undefined,
  );
  assert.equal(childCalls, 1);

  let resumedPlannerCalls = 0;
  let resumedChildCalls = 0;
  const resumed = AflVm.fromSource(flow, {
    agentExecutor: controlBackend(async (request, host) => {
      if (request.control === undefined) {
        resumedChildCalls += 1;
        throw new Error("completed control Node must not execute again");
      }
      resumedPlannerCalls += 1;
      assert.equal(request.recovery?.mode, "resume");
      const replayed = await host.executeControlTool({
        id: "department-reissued",
        name: "afl.node.execute",
        input: { node: "department", args: [{ ref: "param:task" }] },
        signal: request.signal,
      });
      assert.deepEqual(JSON.parse(replayed.content), {
        ok: true,
        ref: "result:1",
        value: { type: "frag", content: "department:job", output: "reasoning" },
      });
      await host.completeControlTool({ id: "department-reissued", name: "afl.node.execute", ok: true });
      return completed("flow-summary");
    }),
  });
  const result = await resumed.run("main", [], {
    runId: "freedom-flow-recovery",
    executionRoot: root,
    resume: true,
  });
  assert.equal(result.output.content, "flow-summary");
  assert.equal(resumedPlannerCalls, 1);
  assert.equal(resumedChildCalls, 0);
});

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "afl-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function memoryState(root, runId) {
  const state = await FileMemoryStateStore.create(join(root, ".afl", "memory"))
    .loadRun(runId, new AbortController().signal);
  assert.ok(state);
  return state;
}

async function recoveryRecords(root, runId) {
  const records = await FileRecoveryStateStore.create(join(root, ".afl", "recovery"))
    .loadRun(runId, new AbortController().signal);
  assert.ok(records);
  return records;
}

function controlBackend(execute) {
  return {
    name: "recovery-control-test",
    capabilities: {
      nativeSession: false,
      checkpoint: false,
      fork: false,
      workspaceContext: true,
      readOnlyWorkspaceContext: true,
      structuredOutput: false,
      interrupt: true,
      dynamicControlTools: true,
      standardTools: false,
      toolAuthorization: false,
      interactiveApproval: false,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: [AFL_MESSAGE_ROLE_SCHEMA], importRoles: ["user", "assistant"] },
      validateImport() {},
    },
    execute,
  };
}

function toolBackend(execute) {
  const backend = controlBackend(execute);
  return {
    ...backend,
    recoveryIdentity: "tool-test/v0",
    capabilities: { ...backend.capabilities, toolAuthorization: true },
  };
}

function authorizeTestTool(request, host, toolCallId = "test-call") {
  return host.authorizeTool({
    requestId: `${request.operationId}:tool:test-call`,
    runId: request.runId,
    node: request.node,
    block: request.block,
    agent: request.agent,
    backend: "recovery-control-test",
    toolCallId,
    toolName: "write",
    executionBoundary: "host",
    workspace: request.workspace,
    input: { path: "result.txt", content: "done" },
    effectiveInput: { path: "result.txt", content: "done" },
    display: { title: "write", summary: "result.txt" },
    signal: request.signal,
  });
}

function completed(output) {
  return { output, stopReason: "completed" };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
