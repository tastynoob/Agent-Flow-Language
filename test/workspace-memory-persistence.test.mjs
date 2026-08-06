import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AflVm,
  MockAgentAdapter,
  RunMemoryPersistence,
  canonicalModuleDigest,
  parseAfl,
} from "../dist/src/index.js";

const SINGLE_AGENT_FLOW = `
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "turn"
        ret result
`;

test("a repeated runId restores canonical Memory and starts the flow entry again", async (t) => {
  const root = await temporaryRoot(t);
  const firstAgents = new MockAgentAdapter().on("@agent.worker", () => "first-output");
  const first = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents: firstAgents });
  await first.run("main", [], { runId: "restore-run", executionRoot: root });

  let restoredMessages;
  const secondAgents = new MockAgentAdapter().on("@agent.worker", (request) => {
    restoredMessages = request.messages.map((message) => ({ ...message }));
    return "second-output";
  });
  const second = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents: secondAgents });
  const result = await second.run("main", [], { runId: "restore-run", executionRoot: root });

  assert.equal(result.output.content, "second-output");
  assert.deepEqual(restoredMessages, [
    { role: "user", content: "turn" },
    { role: "assistant", content: "first-output" },
    { role: "user", content: "turn" },
  ]);

  const state = await readOnlyState(root);
  assert.equal(state.format, "afl.memory-run");
  assert.match(state.rootModuleDigest, /^sha256:[a-f0-9]{64}$/u);
  const slots = Object.values(state.memories);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].revision, 4);
  assert.equal(slots[0].messages.at(-1).content, "second-output");
});

test("default persistence remains lazy until the first durable Memory allocation", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        ret "done"
`, {});
  await vm.run("main", [], { runId: "lazy-memory", executionRoot: root });
  await assert.rejects(access(join(root, ".afl")), { code: "ENOENT" });
});

test("Memory persistence binding can replace the directory or store", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => "done");
  const directoryVm = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents,
    memoryPersistence: { directory: "state/memory" },
  });
  await directoryVm.run("main", [], { runId: "directory-binding", executionRoot: root });
  assert.equal((await readdir(join(root, "state", "memory"))).length, 1);

  let savedState;
  const store = {
    async loadRun() {
      return undefined;
    },
    async saveRun(state) {
      savedState = structuredClone(state);
    },
  };
  const storeVm = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents,
    memoryPersistence: { store },
  });
  await storeVm.run("main", [], { runId: "store-binding", executionRoot: root });
  assert.equal(savedState.runId, "store-binding");
  assert.equal(Object.values(savedState.memories)[0].revision, 2);

  const invalid = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents,
    memoryPersistence: { directory: "state", store },
  });
  await assert.rejects(
    invalid.run("main", [], { runId: "invalid-binding", executionRoot: root }),
    { code: "MEMORY_BINDING_INVALID" },
  );
});

test("input is durable before execution and output-save failure invalidates the returned session", async (t) => {
  const root = await temporaryRoot(t);
  let saves = 0;
  let executions = 0;
  let closes = 0;
  const store = {
    async loadRun() {
      return undefined;
    },
    async saveRun() {
      saves += 1;
      if (saves === 2) throw new Error("disk unavailable");
    },
  };
  const backend = {
    name: "transaction-test",
    capabilities: {
      nativeSession: true,
      checkpoint: false,
      fork: false,
      workspaceContext: false,
      readOnlyWorkspaceContext: false,
      structuredOutput: false,
      interrupt: true,
      toolCallInterception: false,
      interactiveApproval: false,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: ["afl.message-role/v1"], importRoles: ["user", "assistant"] },
      validateImport() {},
    },
    async execute() {
      executions += 1;
      assert.equal(saves, 1);
      return {
        output: "done",
        stopReason: "completed",
        session: { backend: "transaction-test", id: "advanced-session" },
      };
    },
    async close(session) {
      assert.equal(session.id, "advanced-session");
      closes += 1;
    },
  };
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agentExecutor: backend,
    memoryPersistence: { store },
  });

  await assert.rejects(
    vm.run("main", [], { runId: "failed-output-save", executionRoot: root }),
    { code: "MEMORY_STATE_SAVE_FAILED" },
  );
  assert.equal(executions, 1);
  assert.equal(saves, 2);
  assert.equal(closes, 1);
});

test("memory.copy durably allocates an empty slot while implicit empty Memory stays lazy", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        copied = memory.copy worker.memory
        ret "done"
`, {});

  await vm.run("main", [], { runId: "empty-copy", executionRoot: root });
  const state = await readOnlyState(root);
  const entries = Object.entries(state.memories);
  assert.equal(entries.length, 1);
  assert.match(entries[0][0], /allocation:copy$/u);
  assert.deepEqual(entries[0][1].messages, []);
  assert.equal(entries[0][1].revision, 0);
});

test("the same runId permits one active top-level run per store namespace", async (t) => {
  const root = await temporaryRoot(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const agents = new MockAgentAdapter().on("@agent.worker", async () => {
    enteredResolve();
    await gate;
    return "done";
  });
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents });
  const running = vm.run("main", [], { runId: "active-run", executionRoot: root });
  await entered;

  await assert.rejects(
    vm.run("main", [], { runId: "active-run", executionRoot: root }),
    { code: "MEMORY_RUN_ACTIVE" },
  );
  release();
  await running;
});

test("a runId cannot restore Memory from a different root module", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => "done");
  await AflVm.fromSource(SINGLE_AGENT_FLOW, { agents }).run(
    "main",
    [],
    { runId: "module-change", executionRoot: root },
  );
  const changed = AflVm.fromSource(SINGLE_AGENT_FLOW.replace('"turn"', '"changed"'), { agents });
  await assert.rejects(
    changed.run("main", [], { runId: "module-change", executionRoot: root }),
    { code: "MEMORY_STATE_INVALID" },
  );
});

test("module digests preserve user record data while ignoring IR source metadata", () => {
  for (const field of ["span", "sourceName"]) {
    const oldModule = parseAfl(`
main():
    entry:
        value = prompt {${field}: "old"}
        ret value
`, "old.afl");
    const newModule = parseAfl(`
main():
    entry:
        value = prompt {${field}: "new"}
        ret value
`, "new.afl");
    assert.notEqual(canonicalModuleDigest(oldModule), canonicalModuleDigest(newModule));
  }

  const source = `main():\n    entry:\n        ret "done"\n`;
  assert.equal(
    canonicalModuleDigest(parseAfl(source, "left.afl")),
    canonicalModuleDigest(parseAfl(source, "right.afl")),
  );
});

test("a failed Memory save prevents already-queued snapshots from reaching the store", async () => {
  let rejectFirstSave;
  let markFirstSaveEntered;
  const firstSaveEntered = new Promise((resolve) => {
    markFirstSaveEntered = resolve;
  });
  let saves = 0;
  const store = {
    async loadRun() {
      return undefined;
    },
    async saveRun() {
      saves += 1;
      if (saves === 1) {
        markFirstSaveEntered();
        await new Promise((_, reject) => {
          rejectFirstSave = reject;
        });
      }
    },
  };
  const signal = new AbortController().signal;
  const digest = `sha256:${"0".repeat(64)}`;
  const persistence = await RunMemoryPersistence.open(
    { store },
    process.cwd(),
    "queued-save-failure",
    digest,
    signal,
  );
  persistence.claim("first", digest);
  persistence.claim("second", digest);

  const first = persistence.save(
    "first",
    digest,
    [{ role: "user", content: "first" }],
    1,
    signal,
  );
  await firstSaveEntered;
  const second = persistence.save(
    "second",
    digest,
    [{ role: "user", content: "second" }],
    1,
    signal,
  );
  const outcomes = Promise.allSettled([first, second]);
  rejectFirstSave(new Error("store failed"));

  const [firstOutcome, secondOutcome] = await outcomes;
  assert.equal(firstOutcome.status, "rejected");
  assert.equal(firstOutcome.reason.code, "MEMORY_STATE_SAVE_FAILED");
  assert.equal(secondOutcome.status, "rejected");
  assert.equal(secondOutcome.reason.code, "MEMORY_STATE_SAVE_FAILED");
  assert.equal(saves, 1);
  await assert.rejects(persistence.close(), { code: "MEMORY_STATE_SAVE_FAILED" });
});

test("corrupt Memory revisions are rejected instead of being reset", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => "done");
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents });
  await vm.run("main", [], { runId: "corrupt-state", executionRoot: root });
  const directory = join(root, ".afl", "memory");
  const [filename] = await readdir(directory);
  const state = JSON.parse(await readFile(join(directory, filename), "utf8"));
  Object.values(state.memories)[0].revision = 99;
  await writeFile(join(directory, filename), JSON.stringify(state));

  await assert.rejects(
    vm.run("main", [], { runId: "corrupt-state", executionRoot: root }),
    { code: "MEMORY_STATE_INVALID" },
  );
});

test("Workspace paths are canonical and hierarchical write conflicts are serialized", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "docs"));
  let active = 0;
  let maximum = 0;
  const seen = [];
  const agents = new MockAgentAdapter();
  const handler = async (request) => {
    seen.push(request.workspace);
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(25);
    active -= 1;
    return "done";
  };
  agents.on("@agent.left", handler).on("@agent.right", handler);

  const overlapping = AflVm.fromSource(`
main():
    entry:
        left = agent @agent.left, "workers/"
        right = agent @agent.right, "workers/child/"
        left_result = left.do "left"
        right_result = right.do "right"
        ret right_result
`, { agents });
  await overlapping.run("main", [], { executionRoot: root });
  assert.equal(maximum, 1);

  active = 0;
  maximum = 0;
  seen.length = 0;
  const siblings = AflVm.fromSource(`
main():
    entry:
        left = agent @agent.left, ["left/", "docs/"]
        right = agent @agent.right, ["right/", "docs/"]
        left_result = left.do "left"
        right_result = right.do "right"
        ret right_result
`, { agents });
  await siblings.run("main", [], { executionRoot: root });
  assert.equal(maximum, 2);
  assert.equal(seen[0].readOnly[0].root, await realpath(join(root, "docs")));
  assert.equal(seen[0].readOnly[0].resourceId, `file:${await realpath(join(root, "docs"))}`);
  assert.equal(seen.every((workspace) => workspace.origin === "explicit"), true);
});

test("generated numbered Workspaces flow through dispatch parameters and run in parallel", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "docs"));
  let active = 0;
  let maximum = 0;
  const primaryRoots = [];
  const agents = new MockAgentAdapter().on("@agent.reviewer", async (request) => {
    primaryRoots.push(request.workspace.primary.root);
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(25);
    active -= 1;
    return request.messages.at(-1).content;
  });
  const vm = AflVm.fromSource(`
review(task, main_workspace):
    entry:
        reviewer = agent @agent.reviewer, [main_workspace, "docs/"]
        result = reviewer.do task
        ret result
main():
    entry:
        workspace_0 = typescript "return args[0]", "workers/0/"
        workspace_1 = typescript "return args[0]", "workers/1/"
        jobs = dispatch [review("left", workspace_0), review("right", workspace_1)]
        result = sync jobs
        ret result
`, {
    agents,
    scripts: { execute: (request) => request.args[0] },
  });

  await vm.run("main", [], { executionRoot: root });
  assert.equal(maximum, 2);
  assert.deepEqual(
    primaryRoots.sort(),
    [await realpath(join(root, "workers", "0")), await realpath(join(root, "workers", "1"))].sort(),
  );
  const state = await readOnlyState(root);
  assert.equal(Object.keys(state.memories).length, 2);
  assert.equal(Object.values(state.memories).every((memory) => memory.revision === 2), true);
});

test("Workspace rejects primary/read-only overlap after canonicalization", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "work", "docs"), { recursive: true });
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, ["work/", "work/docs/"]
        ret "done"
`, {});
  await assert.rejects(
    vm.run("main", [], { executionRoot: root }),
    { code: "AGENT_WORKSPACE_INVALID" },
  );
});

test("an adapter cannot silently ignore an explicit Workspace", async (t) => {
  const root = await temporaryRoot(t);
  let called = false;
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker, "work/"
        result = worker.do "work"
        ret result
`, {
    agents: {
      async run() {
        called = true;
        return { output: "done" };
      },
    },
  });
  await assert.rejects(
    vm.run("main", [], { executionRoot: root }),
    { code: "AGENT_CAPABILITY_UNSUPPORTED" },
  );
  assert.equal(called, false);
});

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "afl-workspace-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function readOnlyState(root) {
  const directory = join(root, ".afl", "memory");
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(join(directory, files[0]), "utf8"));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
