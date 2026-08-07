import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { PiAgentExecutorBackend } from "@afl-lang/core";

if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.length === 0) {
  throw new Error("DEEPSEEK_API_KEY is required");
}

const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

export default {
  agentExecutor: new PiAgentExecutorBackend({
    agents: {
      "@agent.coder": restrictedBinding(),
      "@agent.reviewer": restrictedBinding(),
    },
  }),
  scripts: {
    execute(request) {
      if (request.language !== "typescript") {
        throw new Error(`unsupported script language: ${request.language}`);
      }
      return Function("args", `"use strict";\n${request.source}`)(request.args);
    },
  },
};

function restrictedBinding() {
  return {
    model: { provider: "deepseek", id: model },
    thinkingLevel: "high",
    thinkingReplay: "include",
    streamOptions: { timeoutMs: 180_000, maxRetries: 2 },
    createExecutionContext(workspace) {
      const root = workspace.primary.root;
      return {
        tools: [sourceFileTool(root), gccVerifyTool(root)],
        contextPrompt: [
          `Primary workspace: ${root}`,
          "Only qsort.c may be read or written, through source_file.",
          "Compilation and test execution are available only through gcc_verify.",
          "Use the tools to inspect and verify the implementation; do not claim success without a passing gcc_verify result.",
        ].join("\n"),
      };
    },
  };
}

function sourceFileTool(root) {
  const filename = join(root, "qsort.c");
  return {
    name: "source_file",
    label: "qsort.c",
    description: "Read or replace qsort.c in the primary workspace. No other path is accessible.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      content: Type.Optional(Type.String({ maxLength: 65_536 })),
    }),
    async execute(_toolCallId, params) {
      if (params.operation === "read") {
        let content;
        try {
          content = await readFile(filename, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          content = "(qsort.c does not exist yet)";
        }
        await logTool(root, { tool: "source_file", operation: "read", bytes: content.length });
        return { content: [{ type: "text", text: content }], details: { operation: "read" } };
      }
      if (typeof params.content !== "string" || params.content.length === 0) {
        throw new Error("source_file write requires non-empty content");
      }
      await writeFile(filename, params.content, "utf8");
      await logTool(root, { tool: "source_file", operation: "write", bytes: params.content.length });
      return {
        content: [{ type: "text", text: `wrote ${params.content.length} bytes to qsort.c` }],
        details: { operation: "write", bytes: params.content.length },
      };
    },
  };
}

function gccVerifyTool(root) {
  return {
    name: "gcc_verify",
    label: "GCC verify",
    description: "Compile qsort.c with strict warnings and run its self-tests. The command and filenames are fixed.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const compile = await runCommand(
        "gcc",
        ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-O2", "qsort.c", "-o", "qsort_test"],
        root,
        signal,
      );
      if (!compile.ok) {
        await logTool(root, { tool: "gcc_verify", phase: "compile", ok: false, output: compile.output });
        return {
          content: [{ type: "text", text: `COMPILE_FAILED\n${compile.output}` }],
          details: { phase: "compile", ok: false },
        };
      }
      const run = await runCommand(join(root, "qsort_test"), [], root, signal);
      await logTool(root, { tool: "gcc_verify", phase: "run", ok: run.ok, output: run.output });
      return {
        content: [{ type: "text", text: `${run.ok ? "VERIFY_OK" : "VERIFY_FAILED"}\n${run.output}` }],
        details: { phase: "run", ok: run.ok },
      };
    },
  };
}

function runCommand(command, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1_048_576,
      timeout: 30_000,
      signal,
    }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(signal.reason ?? error);
        return;
      }
      resolve({
        ok: error === null,
        output: [stdout, stderr, error === null ? "" : `exit: ${String(error.code ?? "unknown")}`]
          .filter((item) => item.length > 0)
          .join("\n")
          .slice(0, 16_384),
      });
    });
  });
}

async function logTool(root, event) {
  await appendFile(
    join(root, "tool-calls.jsonl"),
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}
