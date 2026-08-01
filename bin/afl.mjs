#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AflRuntime,
  FlowRuntimeError,
  MemoryTraceSink,
  validateProgram,
} from "../dist/src/index.js";

const [command, file, ...args] = process.argv.slice(2);

if ((command !== "validate" && command !== "run") || file === undefined) {
  usage();
  process.exitCode = 2;
} else {
  try {
    const program = JSON.parse(await readFile(resolve(file), "utf8"));
    if (command === "validate") {
      const result = validateProgram(program);
      if (result.ok) {
        process.stdout.write(`${JSON.stringify({ valid: true, name: result.value.name })}\n`);
      } else {
        process.stdout.write(`${JSON.stringify({ valid: false, issues: result.issues }, null, 2)}\n`);
        process.exitCode = 1;
      }
    } else {
      const options = parseRunOptions(args);
      const bindings = options.adapter === undefined
        ? {
            agents: {
              async invoke(request) {
                throw new FlowRuntimeError(
                  "AGENT_ADAPTER_MISSING",
                  `no adapter configured for '${request.agent}.${request.operation}'`,
                );
              },
            },
          }
        : await loadBindings(options.adapter);
      const trace = options.trace === undefined ? undefined : new MemoryTraceSink();
      const runtime = new AflRuntime(program, {
        ...bindings,
        ...(trace === undefined ? {} : { trace }),
      });
      const input = options.inputFile === undefined
        ? JSON.parse(options.input ?? "null")
        : JSON.parse(await readFile(resolve(options.inputFile), "utf8"));
      const result = await runtime.run(input, {
        ...(options.runId === undefined ? {} : { runId: options.runId }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (trace !== undefined && options.trace !== undefined) {
        await writeFile(resolve(options.trace), `${JSON.stringify(trace.events, null, 2)}\n`);
      }
    }
  } catch (error) {
    if (error instanceof FlowRuntimeError) {
      process.stderr.write(`${JSON.stringify(error.serialize(), null, 2)}\n`);
    } else if (error instanceof Error && "issues" in error) {
      process.stderr.write(
        `${JSON.stringify({ message: error.message, issues: error.issues }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

function parseRunOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!["--input", "--input-file", "--adapter", "--trace", "--run-id"].includes(option)) {
      throw new Error(`unknown run option '${option}'`);
    }
    if (value === undefined) {
      throw new Error(`option '${option}' requires a value`);
    }
    const key = {
      "--input": "input",
      "--input-file": "inputFile",
      "--adapter": "adapter",
      "--trace": "trace",
      "--run-id": "runId",
    }[option];
    options[key] = value;
    index += 1;
  }
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new Error("--input and --input-file are mutually exclusive");
  }
  return options;
}

async function loadBindings(modulePath) {
  const loaded = await import(pathToFileURL(resolve(modulePath)).href);
  const bindings = loaded.default ?? loaded.bindings;
  if (bindings === undefined || typeof bindings !== "object" || bindings.agents === undefined) {
    throw new Error("adapter module must export default RuntimeBindings or a named 'bindings'");
  }
  return bindings;
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  afl validate <program.aflir>",
      "  afl run <program.aflir> [--input <json> | --input-file <file>]",
      "      [--adapter <module.mjs>] [--trace <trace.json>] [--run-id <id>]",
      "",
    ].join("\n"),
  );
}
