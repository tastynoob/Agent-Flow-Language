import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AflRuntime,
  MockAgentAdapter,
  validateProgram,
} from "../dist/src/index.js";

function generatePythonProgram() {
  const generated = spawnSync("python3", ["python/examples/parallel_flow.py"], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: "python/src" },
    encoding: "utf8",
  });
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

test("Python frontend output validates and executes in the TypeScript runtime", async () => {
  const program = generatePythonProgram();

  const validation = validateProgram(program);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  const runtime = new AflRuntime(program, { agents: new MockAgentAdapter() });
  const result = await runtime.run([1, 2, 3, 4]);

  assert.deepEqual(result.output, [2, 4, 6, 8]);
});
