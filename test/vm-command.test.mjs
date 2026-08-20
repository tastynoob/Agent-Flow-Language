import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runVmCommand } from "../bin/vm-command.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("afl-vm resolves a bindings package from the caller's working directory", async () => {
  const project = await mkdtemp(join(tmpdir(), "afl-vm-bindings-"));
  const packageRoot = join(project, "node_modules", "afl-test-bindings");
  const previousDirectory = process.cwd();
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "afl-test-bindings", type: "module", main: "./index.mjs" })}\n`,
    );
    await writeFile(join(packageRoot, "index.mjs"), "export default {};\n");
    process.chdir(project);

    const captured = captureIo();
    const exitCode = await runVmCommand([
      "afl-test-bindings",
      join(root, "test", "fixtures", "minimal.afl"),
    ], captured.io);

    assert.equal(exitCode, 0, captured.stderr());
    assert.equal(JSON.parse(captured.stdout()).output.content, "afl-vm-ok");
  } finally {
    process.chdir(previousDirectory);
    await rm(project, { recursive: true, force: true });
  }
});

test("afl-vm requires explicit --resume for an interrupted run", async () => {
  const project = await mkdtemp(join(tmpdir(), "afl-vm-resume-"));
  const previousDirectory = process.cwd();
  try {
    const marker = join(project, "provider-ready");
    const bindings = join(project, "bindings.mjs");
    const flow = join(project, "flow.afl");
    const core = pathToFileURL(join(root, "dist", "src", "index.js")).href;
    await writeFile(bindings, `
import { access } from "node:fs/promises";
import { MockAgentAdapter } from ${JSON.stringify(core)};
const marker = ${JSON.stringify(marker)};
export default {
  agents: new MockAgentAdapter().on("@agent.worker", async () => {
    try {
      await access(marker);
      return "recovered";
    } catch {
      throw new Error("provider unavailable");
    }
  }),
};
`);
    await writeFile(flow, `
main():
    entry:
        worker = agent @agent.worker
        result = worker.do "work"
        ret result
`);
    process.chdir(project);

    const first = captureIo();
    assert.equal(await runVmCommand([
      bindings,
      flow,
      "--run-id",
      "cli-recovery",
    ], first.io), 1);
    assert.match(first.stderr(), /provider unavailable/u);

    const ordinary = captureIo();
    assert.equal(await runVmCommand([
      bindings,
      flow,
      "--run-id",
      "cli-recovery",
    ], ordinary.io), 1);
    assert.match(ordinary.stderr(), /RECOVERY_RUN_REQUIRES_RESUME/u);

    await writeFile(marker, "ready\n");
    const resumed = captureIo();
    assert.equal(await runVmCommand([
      bindings,
      flow,
      "--run-id",
      "cli-recovery",
      "--resume",
    ], resumed.io), 0, resumed.stderr());
    assert.equal(JSON.parse(resumed.stdout()).output.content, "recovered");
  } finally {
    process.chdir(previousDirectory);
    await rm(project, { recursive: true, force: true });
  }
});

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
