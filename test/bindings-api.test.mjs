import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AflVm, defineBindings, pi } from "../dist/src/index.js";

test("defineBindings composes Pi, capability functions, and trusted TypeScript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afl-friendly-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      assert.deepEqual(context.tools.map((tool) => tool.name), ["afl_transaction_request"]);
      return fauxAssistantMessage("agent-ok");
    },
  ]);
  let seenContext;
  const bindings = defineBindings({
    agents: pi({ model: faux.getModel(), models }),
    capabilities: {
      "@demo.describe": (context, value) => {
        seenContext = context;
        return { value, source: context.node };
      },
    },
    scripts: "typescript",
  });
  const vm = AflVm.fromSource(`
main():
    entry:
        value = typescript "return args[0] + 1", 40
        description = invoke @demo.describe, value
        worker = agent @agent.worker, [tools: "none"]
        result = worker.do description
        ret result
`, bindings);

  const result = await vm.run("main", [], { executionRoot: root, runId: "friendly-bindings" });
  assert.equal(result.output.content, "agent-ok");
  assert.deepEqual(
    { runId: seenContext.runId, node: seenContext.node, block: seenContext.block },
    { runId: "friendly-bindings", node: "main", block: "entry" },
  );
  assert.equal(seenContext.executionRoot, root);
});

test("pi accepts provider/model shorthand", () => {
  const backend = pi({ model: "deepseek/deepseek-v4-pro", sandbox: "bubblewrap", thinking: "high" });
  assert.equal(backend.name, "pi");
  assert.equal(backend.capabilities.standardTools, true);
  assert.equal(backend.capabilities.toolAuthorization, true);
  assert.equal(backend.capabilities.sandboxEnforcement, true);
});

test("defineBindings rejects duplicate Agent executor declarations", () => {
  const executor = pi({ model: "deepseek/deepseek-v4-pro" });
  assert.throws(
    () => defineBindings({ agents: executor, agentExecutor: executor }),
    /both an Agent executor/u,
  );
});
