import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AflVm,
  FileMemoryStateStore,
  MemoryTraceSink,
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
  await assert.rejects(access(join(root, ".afl", "memory")), { code: "ENOENT" });
  await access(join(root, ".afl", "tmpworkspace", "lazy-memory"));
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
      dynamicControlTools: false,
      interactiveApproval: false,
      sandboxEnforcement: false,
    },
    memory: {
      capabilities: { roleSchemas: ["afl.message-role/v0"], importRoles: ["user", "assistant"] },
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

test("memory.copy remains lazy when neither source nor copy enters agent.do", async (t) => {
  const root = await temporaryRoot(t);
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        copied = worker.memory.copy
        ret "done"
`, {});

  await vm.run("main", [], { runId: "empty-copy", executionRoot: root });
  await assert.rejects(access(join(root, ".afl", "memory")), { code: "ENOENT" });
  await access(join(root, ".afl", "tmpworkspace", "empty-copy"));
});

test("memory.copy journals a base reference instead of duplicating source messages", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => "done");
  const vm = AflVm.fromSource(`
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "turn"
        copied = worker.memory.copy
        reviewer = agent @agent.worker
        branch = reviewer.with_memory copied
        reviewed = branch.do "review"
        ret reviewed
`, { agents });

  await vm.run("main", [], { runId: "copy-reference", executionRoot: root });
  const journals = await readRawJournals(root);
  assert.equal(journals.length, 2);
  const copied = journals.find((journal) => journal.header.base !== undefined);
  const source = journals.find((journal) => journal.header.base === undefined);
  assert.ok(copied);
  assert.ok(source);
  assert.equal(source.filename, "worker.jsons");
  assert.equal(copied.filename, "copied.jsons");
  assert.equal(copied.header.base.file, source.filename);
  assert.equal(copied.header.base.revision, 2);
  assert.equal(JSON.stringify(copied.records).includes('"turn"'), false);
  assert.equal(source.records.filter((record) => record.type === "user" || record.type === "assistant").length, 2);
});

test("using a nested lazy copy materializes its base chain without duplicating history", async (t) => {
  const root = await temporaryRoot(t);
  let observed;
  const agents = new MockAgentAdapter().on("@agent.worker", (request) => {
    observed = request.messages.map((message) => message.content);
    return "done";
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        source = agent @agent.worker
        source.memory.append user, "seed"
        first = source.memory.copy
        second = first.copy
        reviewer = agent @agent.worker
        branch = reviewer.with_memory second
        result = branch.do "turn"
        ret result
`, { agents });

  await vm.run("main", [], { runId: "nested-copy", executionRoot: root });
  assert.deepEqual(observed, ["seed", "turn"]);
  const journals = await readRawJournals(root);
  assert.equal(journals.length, 3);
  const source = journals.find((journal) => journal.header.base === undefined);
  const first = journals.find((journal) => journal.header.base?.file === source?.filename);
  const second = journals.find((journal) => journal.header.base?.file === first?.filename);
  assert.ok(source);
  assert.ok(first);
  assert.ok(second);
  assert.equal(source.records.filter((record) => record.type === "append").length, 1);
  assert.equal(first.records.length, 0);
  assert.equal(JSON.stringify(second.records).includes('"seed"'), false);
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
        value = prompt [${field}: "old"]
        ret value
`, "old.afl");
    const newModule = parseAfl(`
main():
    entry:
        value = prompt [${field}: "new"]
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
    undefined,
    signal,
  );
  await firstSaveEntered;
  const second = persistence.save(
    "second",
    digest,
    [{ role: "user", content: "second" }],
    1,
    undefined,
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

test("invalid data in the middle of a Memory stream is rejected", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => "done");
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents });
  await vm.run("main", [], { runId: "corrupt-state", executionRoot: root });
  const directory = join(root, ".afl", "memory");
  const [runDirectory] = await readdir(directory);
  const [filename] = (await readdir(join(directory, runDirectory))).filter((name) => name !== "program.jsons");
  const path = join(directory, runDirectory, filename);
  const records = parsePrettyJsonStream(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify(records[0], null, 2)}\n\nnot-json\n\n${JSON.stringify(records[1], null, 2)}\n`);

  await assert.rejects(
    vm.run("main", [], { runId: "corrupt-state", executionRoot: root }),
    { code: "MEMORY_STATE_INVALID" },
  );
});

test("a partial final object is truncated while complete records remain recoverable", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => "done");
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents });
  await vm.run("main", [], { runId: "initial-crash", executionRoot: root });
  const directory = join(root, ".afl", "memory");
  const [runDirectory] = await readdir(directory);
  const [filename] = (await readdir(join(directory, runDirectory))).filter((name) => name !== "program.jsons");
  const path = join(directory, runDirectory, filename);
  const complete = parsePrettyJsonStream(await readFile(path, "utf8"))
    .filter((record) => record.type !== "do.end")
    .map((record) => `${JSON.stringify(record, null, 2)}\n\n`)
    .join("");
  await writeFile(path, `${complete}{\n  "type": "assistant",\n  "text": [\n`);

  const result = await vm.run("main", [], { runId: "initial-crash", executionRoot: root });
  assert.equal(result.output.content, "done");
  const state = await readOnlyState(root);
  assert.equal(Object.values(state.memories)[0].revision, 4);
});

test("an executor interruption preserves recovery context in Memory and Trace", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => {
    throw new Error("model unavailable");
  });
  const trace = new MemoryTraceSink();
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents, trace });

  let interruption;
  await assert.rejects(
    vm.run("main", [], { runId: "error-tail", executionRoot: root }),
    (error) => {
      assert.equal(error.code, "ADAPTER_ERROR");
      interruption = error.details.interruption;
      return true;
    },
  );
  assert.equal(interruption.agent, "@agent.worker");
  assert.equal(interruption.executor, "agent-adapter");
  assert.equal(interruption.activation, "root");
  assert.equal(interruption.location, "main:entry:1");
  assert.equal(interruption.memoryRevision, 1);
  assert.equal(
    interruption.workspace.startsWith(`${await realpath(join(root, ".afl", "tmpworkspace", "error-tail"))}/`),
    true,
  );
  assert.deepEqual(interruption.readOnlyWorkspaces, []);

  const [journal] = await readRawJournals(root);
  const tail = journal.records.at(-1);
  assert.equal(tail.type, "do.end");
  assert.equal(tail.status, "interrupted");
  assert.equal(tail.error_code, "ADAPTER_ERROR");
  assert.equal(tail.error_message, "model unavailable");
  assert.equal(tail.memory_slot, interruption.memorySlot);
  assert.equal(tail.memory_revision, 1);
  assert.equal("error" in tail, false);

  const program = await readProgramRecords(root);
  assert.equal(program.at(-1).type, "program.interrupted");
  assert.equal(program.at(-1).error_code, "ADAPTER_ERROR");
  assert.equal(program.at(-1).memory_slot, interruption.memorySlot);
  assert.equal((await readOnlyState(root)).memories[interruption.memorySlot].revision, 1);
  assert.deepEqual(
    trace.events.filter((event) => event.type === "agent.interrupted" || event.type === "run.interrupted")
      .map((event) => event.type),
    ["agent.interrupted", "run.interrupted"],
  );
  assert.equal(trace.events.some((event) => event.type === "run.failed"), false);
});

test("post-execution validation failures remain ordinary errors", async (t) => {
  const root = await temporaryRoot(t);
  const agents = new MockAgentAdapter().on("@agent.worker", () => ({ output: 42 }));
  const trace = new MemoryTraceSink();
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, { agents, trace });

  await assert.rejects(
    vm.run("main", [], { runId: "invalid-output", executionRoot: root }),
    { code: "AGENT_OUTPUT_INVALID" },
  );
  const [journal] = await readRawJournals(root);
  assert.equal(journal.records.at(-1).status, "error");
  assert.deepEqual((await readProgramRecords(root)).map((record) => record.type), ["program.begin"]);
  assert.equal(trace.events.some((event) => event.type === "run.failed"), true);
  assert.equal(trace.events.some((event) => event.type === "run.interrupted"), false);
});

test("an interruption keeps its root error when the recovery marker cannot be saved", async (t) => {
  const root = await temporaryRoot(t);
  const store = {
    async loadRun() {
      return undefined;
    },
    async saveRun() {},
    async beginMemoryDo() {},
    async endMemoryDo() {
      throw new Error("disk unavailable");
    },
  };
  const agents = new MockAgentAdapter().on("@agent.worker", () => {
    throw new Error("provider unavailable");
  });
  const vm = AflVm.fromSource(SINGLE_AGENT_FLOW, {
    agents,
    memoryPersistence: { store },
  });

  await assert.rejects(
    vm.run("main", [], { runId: "interruption-save-failure", executionRoot: root }),
    (error) => {
      assert.equal(error.code, "ADAPTER_ERROR");
      assert.equal(error.message, "provider unavailable");
      assert.equal(error.details.interruption.agent, "@agent.worker");
      assert.equal(error.details.interruptionPersistenceError.code, "MEMORY_STATE_SAVE_FAILED");
      return true;
    },
  );
});

test("dispatch waits for cancelled siblings and reports the interruption root cause", async (t) => {
  const root = await temporaryRoot(t);
  let markWaitingStarted;
  const waitingStarted = new Promise((resolve) => {
    markWaitingStarted = resolve;
  });
  let waitingSettled = false;
  const agents = new MockAgentAdapter().on("@agent.worker", async (request) => {
    const task = request.messages.at(-1).content;
    if (task === "fail") {
      await waitingStarted;
      throw new Error("provider unavailable");
    }
    markWaitingStarted();
    try {
      await new Promise((_, reject) => {
        const cancel = () => reject(request.signal.reason);
        if (request.signal.aborted) cancel();
        else request.signal.addEventListener("abort", cancel, { once: true });
      });
    } finally {
      waitingSettled = true;
    }
    return "unreachable";
  });
  const trace = new MemoryTraceSink();
  const vm = AflVm.fromSource(`
worker(task):
    entry:
        runner = agent @agent.worker
        result = runner.do task
        ret result

main():
    entry:
        jobs = dispatch [worker("wait"), worker("fail")]
        results = sync jobs
        ret results
`, { agents, trace });

  await assert.rejects(
    vm.run("main", [], { runId: "parallel-interruption", executionRoot: root }),
    (error) => error.code === "ADAPTER_ERROR" && error.details.interruption !== undefined,
  );
  assert.equal(waitingSettled, true);
  const statuses = (await readRawJournals(root))
    .map((journal) => journal.records.at(-1).status)
    .sort();
  assert.deepEqual(statuses, ["cancelled", "interrupted"]);
  assert.equal((await readProgramRecords(root)).at(-1).type, "program.interrupted");
  assert.equal(trace.events.filter((event) => event.type === "run.interrupted").length, 1);
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
        left = agent @agent.left, [workspace: "workers/"]
        right = agent @agent.right, [workspace: "workers/child/"]
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
        left = agent @agent.left, [workspace: ["left/", "docs/"]]
        right = agent @agent.right, [workspace: ["right/", "docs/"]]
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
        reviewer = agent @agent.reviewer, [workspace: [main_workspace, "docs/"]]
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
        worker = agent @agent.worker, [workspace: ["work/", "work/docs/"]]
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
        worker = agent @agent.worker, [workspace: "work/"]
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
  const runDirectories = await readdir(directory);
  assert.equal(runDirectories.length, 1);
  const [program] = parsePrettyJsonStream(
    await readFile(join(directory, runDirectories[0], "program.jsons"), "utf8"),
  );
  return FileMemoryStateStore.create(directory).loadRun(
    program.run_id,
    new AbortController().signal,
  );
}

async function readRawJournals(root) {
  const directory = join(root, ".afl", "memory");
  const [runDirectory] = await readdir(directory);
  const runPath = join(directory, runDirectory);
  const filenames = (await readdir(runPath)).filter((name) => name !== "program.jsons");
  return Promise.all(filenames.map(async (filename) => {
    const values = parsePrettyJsonStream(await readFile(join(runPath, filename), "utf8"));
    return { filename, header: values[0], records: values.slice(1) };
  }));
}

async function readProgramRecords(root) {
  const directory = join(root, ".afl", "memory");
  const [runDirectory] = await readdir(directory);
  return parsePrettyJsonStream(await readFile(join(directory, runDirectory, "program.jsons"), "utf8"));
}

function parsePrettyJsonStream(text) {
  return text.trim().split(/\n\s*\n(?=\{)/u).map((value) => JSON.parse(value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
