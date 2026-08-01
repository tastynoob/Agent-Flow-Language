import assert from "node:assert/strict";
import test from "node:test";

import {
  expression as e,
  node as n,
  schema as s,
  validateProgram,
} from "../dist/src/index.js";

test("validator accepts a typed minimal program", () => {
  const program = {
    irVersion: "0.1",
    name: "minimal",
    entry: "main",
    flows: {
      main: {
        input: s.string(),
        output: s.string(),
        body: n.return("return-input", e.input()),
      },
    },
  };

  assert.deepEqual(validateProgram(program), { ok: true, value: program, issues: [] });
});

test("validator reports stable linkage and node-id diagnostics", () => {
  const sharedNode = n.invoke("duplicate", "missing", "work", e.literal(null));
  const program = {
    irVersion: "0.1",
    name: "invalid",
    entry: "main",
    flows: {
      main: {
        input: s.null(),
        output: s.null(),
        body: n.sequence("root", [sharedNode, { ...sharedNode }]),
      },
    },
  };

  const result = validateProgram(program);
  assert.equal(result.ok, false);
  const codes = new Set(result.issues.map((item) => item.code));
  assert.equal(codes.has("AGENT_UNKNOWN"), true);
  assert.equal(codes.has("NODE_ID_DUPLICATE"), true);
  assert.equal(result.issues.every((item) => item.path.startsWith("$")), true);
});

test("AFL rejects provider-specific or skill-specific node kinds", () => {
  const result = validateProgram({
    irVersion: "0.1",
    name: "not-a-workflow-node",
    entry: "main",
    flows: {
      main: {
        input: s.null(),
        output: s.null(),
        body: { id: "browse", kind: "fetch", url: "https://example.com" },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((item) => item.code === "NODE_KIND_INVALID"), true);
});

test("schema references must exist and remain acyclic", () => {
  const result = validateProgram({
    irVersion: "0.1",
    name: "schema-cycle",
    entry: "main",
    schemas: {
      A: s.ref("B"),
      B: s.ref("A"),
    },
    flows: {
      main: {
        input: s.ref("A"),
        output: s.null(),
        body: n.return("done", e.literal(null)),
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((item) => item.code === "SCHEMA_REF_CYCLE"), true);
});
