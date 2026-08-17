import assert from "node:assert/strict";
import test from "node:test";

import {
  AFL_ELEVATION_TOOL_NAME,
  AFL_FORMAT_OUTPUT_TOOL_NAME,
  AFL_TRANSACTION_TOOL,
  AGENT_STANDARD_TOOLS,
  AGENT_TOOL_PROFILES,
  agentElevationTool,
  agentFormatOutputTool,
  agentStandardTool,
  freedomControlTools,
} from "../dist/src/index.js";

test("AFL defines stable contracts for executor-provided standard tools", () => {
  assert.deepEqual(Object.keys(AGENT_STANDARD_TOOLS), [
    "read",
    "list",
    "search",
    "write",
    "edit",
    "shell",
  ]);
  for (const [name, descriptor] of Object.entries(AGENT_STANDARD_TOOLS)) {
    assert.equal(descriptor.name, name);
    assert.equal(descriptor.provider, "executor");
    assert.equal(descriptor.authorization, "required");
    assert.equal(typeof descriptor.description, "string");
    assert.equal("inputSchema" in descriptor, false);
  }
  assert.deepEqual(AGENT_TOOL_PROFILES.readonly, ["read", "list", "search"]);
  assert.match(agentStandardTool("shell").description, /shell command/u);
  assert.match(agentStandardTool("edit").description, /targeted changes/u);
});

test("AFL built-in control tools use the same descriptor interface", () => {
  assert.equal(AFL_TRANSACTION_TOOL.name, "afl.transaction.request");
  assert.equal(AFL_TRANSACTION_TOOL.provider, "vm");
  assert.equal(AFL_TRANSACTION_TOOL.executionMode, "sequential");

  const formatted = agentFormatOutputTool({
    kind: "object",
    fields: { status: "Completion state", details: "Result details" },
  });
  assert.equal(formatted.name, AFL_FORMAT_OUTPUT_TOOL_NAME);
  assert.deepEqual(formatted.inputSchema.properties.value.required, ["status", "details"]);
  assert.equal(formatted.inputSchema.properties.value.additionalProperties, false);

  const elevation = agentElevationTool(["read", "bash"]);
  assert.equal(elevation.name, AFL_ELEVATION_TOOL_NAME);
  assert.equal(elevation.provider, "executor");
  assert.deepEqual(elevation.inputSchema.properties.tool.enum, ["read", "bash"]);

  for (const descriptor of freedomControlTools("flow")) {
    assert.equal(descriptor.provider, "vm");
    assert.equal(descriptor.executionMode, "parallel");
  }
});
