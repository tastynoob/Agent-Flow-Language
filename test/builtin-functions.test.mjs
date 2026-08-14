import assert from "node:assert/strict";
import test from "node:test";

import {
  AflValidationError,
  AflVm,
  frag,
  parseAfl,
  validateModule,
} from "../dist/src/index.js";

const JSON_FLOW = `
main(raw):
    entry:
        parsed = compute @afl.parse.json, raw
        ret parsed
`;

const LABEL_FLOW = `
main(raw):
    entry:
        status = compute @afl.parse.label, raw, ["status", "statues"], ["finish", "continue"]
        ret status
`;

test("compute @afl.parse.json extracts the last complete model JSON value without a binding", async () => {
  const vm = AflVm.fromSource(JSON_FLOW, {});
  const result = await vm.run("main", [frag(`Analysis used {not-json} first.
\`\`\`json
{"action":"continue","details":{"text":"a } and ] inside a string"}}
\`\`\`
The corrected result follows:
["finish", {"round": 2}]
Trailing explanation.`)]);

  assert.deepEqual(result.output, ["finish", { round: 2 }]);
});

test("compute @afl.parse.json accepts exact scalars and fenced scalars", async () => {
  const vm = AflVm.fromSource(JSON_FLOW, {});
  assert.equal((await vm.run("main", ["42"])).output, 42);
  assert.equal((await vm.run("main", [frag("```json\n\"done\"\n```")])).output, "done");
});

test("compute @afl.parse.json reports a stable failure when no complete value exists", async () => {
  const vm = AflVm.fromSource(JSON_FLOW, {});
  await assert.rejects(
    vm.run("main", [frag("analysis only: {\"unfinished\": true")]),
    { code: "BUILTIN_PARSE_JSON_NOT_FOUND" },
  );
});

test("compute @afl.parse.label tolerates prose and Markdown while the last label wins", async () => {
  const vm = AflVm.fromSource(LABEL_FLOW, {});
  const result = await vm.run("main", [frag(`I am still checking the implementation.
- **STATUS**: continue

Final answer:
> \`statues\` : "FINISH"`)]);

  assert.equal(result.output, "finish");
});

test("compute @afl.parse.label rejects an absent or disallowed final value", async () => {
  const vm = AflVm.fromSource(LABEL_FLOW, {});
  await assert.rejects(vm.run("main", [frag("No control label here.")]), {
    code: "BUILTIN_PARSE_LABEL_NOT_FOUND",
  });
  await assert.rejects(vm.run("main", [frag("status: finish\nstatus: blocked")]), {
    code: "BUILTIN_PARSE_LABEL_VALUE_INVALID",
  });
});

test("compute @afl.parse.label preserves non-wrapper punctuation in the value", async () => {
  const vm = AflVm.fromSource(`
main(raw):
    entry:
        status = compute @afl.parse.label, raw, "status"
        ret status
`, {});

  assert.equal((await vm.run("main", [frag("status: in__progress")])).output, "in__progress");
  assert.equal((await vm.run("main", [frag("**status**: **finish**")])).output, "finish");
});

test("AFL built-ins are statically typed as compute values", () => {
  const result = validateModule(parseAfl(`
main(raw):
    entry:
        parsed = compute @afl.parse.json, raw
        action = oper parsed.action
        status = compute @afl.parse.label, action, "status"
        ret status
`));

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
});

test("validator rejects unknown built-ins, invalid arity, and invalid literal arguments", () => {
  const cases = [
    ["value = compute @afl.parse.unknown, raw", "BUILTIN_FUNCTION_UNKNOWN"],
    ["value = compute @example.parse, raw", "BUILTIN_FUNCTION_UNKNOWN"],
    ["value = compute @afl.parse.json, raw, raw", "BUILTIN_FUNCTION_ARITY"],
    ["value = compute @afl.parse.json, 42", "BUILTIN_FUNCTION_ARGUMENT_INVALID"],
    ["value = compute @afl.parse.label, raw, \"status\", \"finish\"", "BUILTIN_FUNCTION_ARGUMENT_INVALID"],
  ];
  for (const [instruction, code] of cases) {
    const result = validateModule(parseAfl(`
main(raw):
    entry:
        ${instruction}
        ret value
`));
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === code), true);
    assert.throws(() => AflVm.fromSource(`
main(raw):
    entry:
        ${instruction}
        ret value
`, {}), AflValidationError);
  }

  const handleInList = validateModule(parseAfl(`
main():
    entry:
        memory = agent @agent.worker
        value = compute @afl.parse.label, "status: finish", [memory], ["finish"]
        ret value
`));
  assert.equal(handleInList.ok, false);
  assert.equal(handleInList.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);

  const fragAllowlist = validateModule(parseAfl(`
main():
    entry:
        allowed = prompt "finish"
        value = compute @afl.parse.label, "status: finish", "status", allowed
        ret value
`));
  assert.equal(fragAllowlist.ok, false);
  assert.equal(fragAllowlist.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);
});

test("compute built-ins bypass capability policy and cannot be overridden", async () => {
  let invoked = false;
  let authorized = false;
  const vm = AflVm.fromSource(JSON_FLOW, {
    capabilities: {
      invoke() {
        invoked = true;
        return "binding-result";
      },
    },
    policy: {
      authorizeCapability() {
        authorized = true;
        return false;
      },
    },
  });

  assert.deepEqual((await vm.run("main", [frag('{"ok":true}')])).output, { ok: true });
  assert.equal(invoked, false);
  assert.equal(authorized, false);
});

test("external invoke remains a policy-controlled Frag capability", async () => {
  const source = `
main():
    entry:
        value = invoke @example.read
        ret value
`;
  const vm = AflVm.fromSource(source, {
    capabilities: { invoke: () => "external" },
  });

  assert.deepEqual((await vm.run()).output, frag("external"));

  const invalidBranch = validateModule(parseAfl(`
main():
    entry:
        value = invoke @example.read
        branch value, yes, no
    yes:
        ret "yes"
    no:
        ret "no"
`));
  assert.equal(invalidBranch.ok, false);
  assert.equal(invalidBranch.diagnostics.some((item) => item.code === "VALUE_KIND_INVALID"), true);
});

test("invoke cannot change result kind by targeting the AFL built-in namespace", () => {
  const result = validateModule(parseAfl(`
main(raw):
    entry:
        value = invoke @afl.parse.json, raw
        ret value
`));

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some((item) => item.code === "BUILTIN_FUNCTION_CONTEXT_INVALID"), true);
});
