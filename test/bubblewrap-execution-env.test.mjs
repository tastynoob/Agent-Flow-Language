import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BubblewrapExecutionEnv } from "../dist/src/index.js";

const bwrap = "/usr/bin/bwrap";

test("bubblewrap ExecutionEnv enforces workspace mounts and hides AFL state", async (t) => {
  if (!await available(bwrap)) return t.skip("bubblewrap is unavailable");
  const root = await mkdtemp(join(tmpdir(), "afl-bwrap-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const readonly = join(root, "readonly");
  const outside = join(root, "outside.txt");
  await mkdir(join(primary, ".afl"), { recursive: true });
  await mkdir(readonly, { recursive: true });
  await writeFile(join(primary, ".afl", "memory.json"), "private-memory");
  await writeFile(join(readonly, "guide.txt"), "read-only context");
  await writeFile(outside, "outside");

  const env = await BubblewrapExecutionEnv.create({
    executable: bwrap,
    network: "host",
    workspace: workspace(primary, readonly),
  });
  t.after(() => env.cleanup());

  assert.deepEqual(await env.writeFile("result.txt", "sandbox output"), { ok: true, value: undefined });
  assert.equal(await readFile(join(primary, "result.txt"), "utf8"), "sandbox output");
  assert.deepEqual(await env.readTextFile("/readonly/0/guide.txt"), {
    ok: true,
    value: "read-only context",
  });
  const denied = await env.writeFile("/readonly/0/change.txt", "blocked");
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "permission_denied");
  assert.deepEqual(await env.exists("/workspace/.afl/memory.json"), { ok: true, value: false });
  assert.deepEqual(await env.exists(outside), { ok: true, value: false });

  const shell = await env.exec("printf '%s|%s' \"$PWD\" \"$HOME\"");
  assert.equal(shell.ok, true);
  assert.equal(shell.value.stdout, "/workspace|/home/afl");
});

test("bubblewrap ExecutionEnv compiles and runs qsort code with GCC", async (t) => {
  if (!await available(bwrap)) return t.skip("bubblewrap is unavailable");
  const root = await mkdtemp(join(tmpdir(), "afl-bwrap-gcc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await BubblewrapExecutionEnv.create({
    executable: bwrap,
    network: "host",
    workspace: workspace(root),
  });
  t.after(() => env.cleanup());
  const source = `
#include <stdio.h>
#include <stdlib.h>

static int compare_int(const void *left, const void *right) {
    int a = *(const int *)left;
    int b = *(const int *)right;
    return (a > b) - (a < b);
}

int main(void) {
    int values[] = {7, -1, 4, 4, 0, 9};
    qsort(values, 6, sizeof(values[0]), compare_int);
    for (size_t i = 0; i < 6; ++i) printf("%s%d", i == 0 ? "" : " ", values[i]);
    return 0;
}
`;
  assert.equal((await env.writeFile("qsort.c", source)).ok, true);
  const compiled = await env.exec("gcc -std=c11 -Wall -Wextra -Werror qsort.c -o qsort && ./qsort");
  assert.equal(compiled.ok, true);
  assert.equal(compiled.value.exitCode, 0);
  assert.equal(compiled.value.stdout, "-1 0 4 4 7 9");
});

test("bubblewrap network-none profile never falls back to host networking", async (t) => {
  if (!await available(bwrap)) return t.skip("bubblewrap is unavailable");
  const root = await mkdtemp(join(tmpdir(), "afl-bwrap-net-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let env;
  try {
    env = await BubblewrapExecutionEnv.create({
      executable: bwrap,
      network: "none",
      workspace: workspace(root),
    });
  } catch (error) {
    assert.equal(error.code, "AGENT_SANDBOX_INIT_FAILED");
    return t.skip("outer environment forbids a network namespace");
  }
  t.after(() => env.cleanup());
  const links = await env.exec("cat /proc/net/dev");
  assert.equal(links.ok, true);
  assert.doesNotMatch(links.value.stdout, /eth[0-9]/u);
});

function workspace(primary, readonly) {
  return {
    primary: { root: primary, resourceId: `file:${primary}` },
    readOnly: readonly === undefined
      ? []
      : [{ root: readonly, resourceId: `file:${readonly}` }],
    origin: "explicit",
  };
}

async function available(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
