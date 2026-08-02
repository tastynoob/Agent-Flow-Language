import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
