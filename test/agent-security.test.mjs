import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AflVm,
  AgentApprovalError,
  AgentToolPolicyEngine,
  FifoAgentApprovalQueue,
  MemoryTraceSink,
  agentToolActionDigest,
  createCCSafetyNetPolicy,
  createStdioAgentApprovalPresenter,
  symbol,
} from "../dist/src/index.js";

test("tool policy deny wins over block and later policies are evaluated", async () => {
  const order = [];
  const engine = new AgentToolPolicyEngine({
    policies: [
      {
        name: "soft-block",
        evaluate() {
          order.push("soft-block");
          return { verdict: "block", code: "REVIEW", reason: "try another approach" };
        },
      },
      {
        name: "hard-block",
        evaluate() {
          order.push("hard-block");
          return { verdict: "deny", code: "DANGEROUS", reason: "blocked" };
        },
      },
      {
        name: "unreached",
        evaluate() {
          order.push("unreached");
          return { verdict: "allow" };
        },
      },
    ],
  });

  const result = await engine.evaluate(action());
  assert.equal(result.verdict, "deny");
  assert.equal(result.code, "DANGEROUS");
  assert.deepEqual(order, ["soft-block", "hard-block"]);
});

test("tool policy distinguishes uncovered calls and fails closed on errors", async () => {
  const strict = new AgentToolPolicyEngine({
    requireCoverage: true,
    policies: [{ name: "shell-only", evaluate: () => ({ verdict: "abstain" }) }],
  });
  assert.deepEqual(
    pick(await strict.evaluate(action())),
    { verdict: "deny", covered: false, code: "AGENT_TOOL_POLICY_UNCOVERED" },
  );

  const failed = new AgentToolPolicyEngine({
    policies: [{ name: "broken", evaluate: () => { throw new Error("secret details"); } }],
  });
  assert.deepEqual(
    pick(await failed.evaluate(action())),
    { verdict: "deny", covered: true, code: "AGENT_TOOL_POLICY_FAILED" },
  );
  assert.deepEqual(
    pick(await failed.evaluate(action({ effectiveInput: { value: 1n } }))),
    { verdict: "deny", covered: true, code: "AGENT_TOOL_POLICY_FAILED" },
  );
});

test("tool policy block is returned to the model without an approval side effect", async () => {
  const engine = new AgentToolPolicyEngine({
    policies: [{
      name: "review-shell",
      evaluate: (value) => value.toolName === "bash"
        ? { verdict: "block", code: "SHELL_REVIEW", reason: "use a safer operation" }
        : { verdict: "abstain" },
    }],
  });
  assert.deepEqual(pick(await engine.evaluate(action({ toolName: "bash" }))), {
    verdict: "block",
    covered: true,
    code: "SHELL_REVIEW",
  });
  assert.deepEqual(
    pick(await engine.evaluate(action({ toolName: "read" }))),
    { verdict: "allow", covered: false },
  );
});

test("tool action digest is canonical and changes with effective input", () => {
  const left = action({
    capability: "shell",
    effectiveInput: { command: "pwd", options: { b: 2, a: 1 } },
  });
  const right = action({
    capability: "shell",
    effectiveInput: { options: { a: 1, b: 2 }, command: "pwd" },
  });
  assert.equal(agentToolActionDigest(left), agentToolActionDigest(right));
  assert.notEqual(
    agentToolActionDigest(left),
    agentToolActionDigest(action({ capability: "shell", effectiveInput: { command: "rm -rf ." } })),
  );
  assert.notEqual(
    agentToolActionDigest(left),
    agentToolActionDigest(action({ capability: "custom-shell" })),
  );
});

test("cc-safety-net policy allows ordinary shell and soft-blocks destructive semantics", async () => {
  const policy = createCCSafetyNetPolicy();
  assert.deepEqual(await policy.evaluate(action({
    toolName: "read",
    effectiveInput: { path: "README.md" },
  })), { verdict: "abstain" });
  assert.deepEqual(await policy.evaluate(action({
    effectiveInput: { command: "printf safe" },
  })), { verdict: "allow" });
  const git = await policy.evaluate(action({
    effectiveInput: { command: "git reset --hard" },
  }));
  assert.equal(git.verdict, "block");
  assert.equal(git.code, "CC_SAFETY_NET_BLOCKED");
  assert.match(git.reason, /BLOCKED by CC Safety Net/u);
  const nested = await policy.evaluate(action({
    effectiveInput: { command: "bash -c 'rm -rf /'" },
  }));
  assert.equal(nested.verdict, "block");
  assert.equal(nested.code, "CC_SAFETY_NET_BLOCKED");
  assert.deepEqual(await policy.evaluate(action({ effectiveInput: { command: 42 } })), {
    verdict: "deny",
    code: "CC_SAFETY_NET_INPUT_INVALID",
    reason: "CC Safety Net requires 'bash' to provide a non-empty command",
  });
  const portable = await policy.evaluate(action({
    capability: "shell",
    toolName: "executor_native_shell",
    effectiveInput: { command: "git reset --hard" },
  }));
  assert.equal(portable.verdict, "block");
  assert.equal(portable.code, "CC_SAFETY_NET_BLOCKED");
});

test("VM rejects unsafe tool executors instead of silently bypassing authorization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-tool-authorization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let executed = false;
  const backend = {
    name: "unsafe-tools",
    capabilities: {
      nativeSession: false,
      checkpoint: false,
      fork: false,
      workspaceContext: true,
      readOnlyWorkspaceContext: true,
      structuredOutput: false,
      interrupt: true,
      dynamicControlTools: false,
      standardTools: true,
      toolAuthorization: false,
      interactiveApproval: false,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: ["afl.message-role/v0"], importRoles: ["*"] },
      validateImport() {},
    },
    async execute() {
      executed = true;
      return { output: "unsafe", stopReason: "completed" };
    },
  };
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, [tools: ["read"]]
        result = worker.do "read"
        ret result
`, { agentExecutor: backend });

  await assert.rejects(
    vm.run("main", [], { executionRoot: root }),
    { code: "AGENT_CAPABILITY_UNSUPPORTED" },
  );

  const policyVm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "read"
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: { policies: [{ name: "allow", evaluate: () => ({ verdict: "allow" }) }] },
    },
  });
  await assert.rejects(
    policyVm.run("main", [], { executionRoot: root }),
    { code: "AGENT_CAPABILITY_UNSUPPORTED" },
  );
  assert.equal(executed, false);
});

test("approval queue presents concurrent requests one at a time in FIFO order", async (t) => {
  const entered = [];
  const releases = [];
  let active = 0;
  let maximum = 0;
  const queue = new FifoAgentApprovalQueue({
    presenter: {
      async present(request) {
        active += 1;
        maximum = Math.max(maximum, active);
        entered.push(request.subject.toolCallId);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
        return request.subject.toolCallId === "two" ? "denied" : "approved";
      },
    },
  });
  t.after(() => queue.close());

  const pending = ["one", "two", "three"].map((id) => queue.enqueue(approval(id), new AbortController().signal));
  await until(() => entered.length === 1);
  releases.shift()();
  await until(() => entered.length === 2);
  releases.shift()();
  await until(() => entered.length === 3);
  releases.shift()();
  assert.deepEqual(await Promise.all(pending), ["approved", "denied", "approved"]);
  assert.deepEqual(entered, ["one", "two", "three"]);
  assert.equal(maximum, 1);
});

test("approval queue removes cancelled requests and enforces its capacity", async (t) => {
  let release;
  const queue = new FifoAgentApprovalQueue({
    maxPending: 2,
    presenter: {
      async present(_request, signal) {
        await new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "approved";
      },
    },
  });
  t.after(() => queue.close());
  const first = queue.enqueue(approval("one"), new AbortController().signal);
  const secondController = new AbortController();
  const second = queue.enqueue(approval("two"), secondController.signal);
  await assert.rejects(
    queue.enqueue(approval("three"), new AbortController().signal),
    (error) => error instanceof AgentApprovalError && error.code === "AGENT_APPROVAL_QUEUE_FULL",
  );
  secondController.abort();
  await assert.rejects(second, { code: "AGENT_APPROVAL_CANCELLED" });
  release();
  assert.equal(await first, "approved");
});

test("stdio approval presenter renders transaction context and accepts completion", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { rendered += chunk; });
  const presenter = createStdioAgentApprovalPresenter({ input, output });
  t.after(() => presenter.close());
  const queue = new FifoAgentApprovalQueue({ presenter });
  t.after(() => queue.close());
  const pending = queue.enqueue({ ...approval("transaction"), kind: "transaction" }, new AbortController().signal);
  await until(() => rendered.includes("Mark this transaction completed?"));
  input.write("completed\n");
  assert.equal(await pending, "approved");
  assert.match(rendered, /kind: transaction/u);
  assert.match(rendered, /location: main:entry/u);
  assert.match(rendered, /request-id: human-/u);
});

test("VM serializes active elevation requests from concurrent Agents without serializing unrelated work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-approval-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const presented = [];
  let activePresenters = 0;
  let maximumPresenters = 0;
  const queue = new FifoAgentApprovalQueue({
    presenter: {
      async present(request) {
        activePresenters += 1;
        maximumPresenters = Math.max(maximumPresenters, activePresenters);
        presented.push(request.subject);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activePresenters -= 1;
        return request.subject.toolCallId.includes("right") ? "denied" : "approved";
      },
    },
  });
  t.after(() => queue.close());
  const trace = new MemoryTraceSink();
  const backend = {
    name: "approval-test",
    capabilities: {
      nativeSession: false,
      checkpoint: false,
      fork: false,
      workspaceContext: true,
      readOnlyWorkspaceContext: true,
      structuredOutput: false,
      interrupt: true,
      dynamicControlTools: false,
      toolAuthorization: true,
      interactiveApproval: true,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: ["afl.message-role/v0"], importRoles: ["*"] },
      validateImport() {},
    },
    async execute(request, host) {
      const name = request.agent.name.includes("left") ? "left" : "right";
      const authorization = await host.requestElevation({
        id: `${name}-tool`,
        capability: "shell",
        toolName: "bash",
        input: { command: "pwd" },
        effectiveInput: { command: "pwd", cwd: request.workspace.primary.root },
        executionBoundary: "host",
        reason: "A host-only resource is required",
        display: { title: "Elevated bash", summary: "pwd" },
        signal: request.signal,
      });
      return {
        output: `${name}:${authorization.status}`,
        stopReason: "completed",
      };
    },
  };
  const vm = AflVm.fromSource(`
main():
    entry:
        left = agent @agent.left, [workspace: "left/"]
        right = agent @agent.right, [workspace: "right/"]
        left_result = left.do "left"
        right_result = right.do "right"
        result = prompt "joined", left_result, right_result
        ret result
`, {
    agentExecutor: backend,
    agentSecurity: {
      preTool: { policies: [{ name: "allow", evaluate: () => ({ verdict: "allow" }) }] },
      approvalQueue: queue,
    },
    prompts: {
      render(request) {
        return request.args.map((item) => item.content).join("|");
      },
    },
    policy: { maxConcurrency: 1 },
    trace,
  });

  const result = await vm.run("main", [], { executionRoot: root });
  assert.equal(result.output.content.includes("left:allowed"), true);
  assert.equal(result.output.content.includes("right:denied"), true);
  assert.equal(maximumPresenters, 1);
  assert.deepEqual(
    new Set(presented.map((subject) => subject.toolCallId)),
    new Set(["left-tool", "right-tool"]),
  );
  assert.deepEqual(new Set(presented.map((subject) => subject.capability)), new Set(["shell"]));
  const approvalStates = trace.events
    .filter((event) => event.type === "agent.event" && event.details?.type === "elevation.state")
    .map((event) => event.details.state);
  assert.equal(approvalStates.filter((state) => state === "presenting").length, 2);
  assert.equal(approvalStates.includes("approved"), true);
  assert.equal(approvalStates.includes("denied"), true);
});

function action(overrides = {}) {
  return {
    requestId: "request-1",
    runId: "run-1",
    node: "main",
    block: "entry",
    agent: symbol("@agent.worker"),
    backend: "test",
    toolCallId: "tool-1",
    toolName: "bash",
    executionBoundary: "host",
    workspace: {
      primary: { root: "/workspace", resourceId: "file:/workspace" },
      readOnly: [],
      origin: "explicit",
    },
    input: { command: "pwd" },
    effectiveInput: { command: "pwd" },
    display: { title: "bash", summary: "pwd" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function approval(id) {
  return {
    kind: "tool-elevation",
    subject: {
      runId: "run",
      node: "main",
      block: "entry",
      agent: "@agent.worker",
      backend: "test",
      toolCallId: id,
      toolName: "bash",
      executionBoundary: "host",
      workspace: "/workspace",
      display: { title: "bash", summary: id },
    },
    reasons: [{ policy: "approval", reason: "review" }],
    actionDigest: `digest:${id}`,
  };
}

function pick(result) {
  return {
    verdict: result.verdict,
    covered: result.covered,
    ...(result.code === undefined ? {} : { code: result.code }),
  };
}

async function until(predicate) {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 1));
}
