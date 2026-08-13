#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AflParseError,
  AflVm,
  AflValidationError,
  AflVmError,
  MemoryTraceSink,
  buildAflVisualGraph,
  layoutAflVisualGraph,
  parseAfl,
  renderAflVisualGraphHtml,
  validateModule,
} from "../dist/src/index.js";

const [command, file, ...args] = process.argv.slice(2);

if (!new Set(["validate", "run", "visualize"]).has(command) || file === undefined) {
  usage();
  process.exitCode = 2;
} else {
  try {
    const filename = resolve(file);
    const source = await readFile(filename, "utf8");
    const module = parseAfl(source, filename);
    if (command === "validate") {
      const result = validateModule(module);
      if (result.ok) {
        process.stdout.write(`${JSON.stringify({
          valid: true,
          nodes: result.value.nodes.map((node) => node.name),
          ...(result.diagnostics.length === 0 ? {} : { diagnostics: result.diagnostics }),
        }, null, result.diagnostics.length === 0 ? 0 : 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify({ valid: false, diagnostics: result.diagnostics }, null, 2)}\n`);
        process.exitCode = 1;
      }
    } else if (command === "visualize") {
      const options = parseVisualizeOptions(args);
      const validation = validateModule(module);
      if (!validation.ok) throw new AflValidationError(validation.diagnostics);
      const graph = buildAflVisualGraph(module, source, {
        ...(options.entry === undefined ? {} : { entry: options.entry }),
        ...(options.maxDepth === undefined ? {} : { maxCallDepth: options.maxDepth }),
        expandFreedomCandidates: options.expandDynamic,
      });
      const output = options.output ?? defaultVisualizationOutput(filename);
      const layouts = await layoutAflVisualGraph(graph);
      await writeFile(output, await renderAflVisualGraphHtml(graph, { layouts }));
      process.stdout.write(`${JSON.stringify({
        visualized: true,
        entry: graph.entry,
        output,
        ir: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          scopes: graph.scopes.length,
        },
        display: {
          main: { nodes: layouts.main.nodes.length, paths: layouts.main.edges.length },
          expanded: { nodes: layouts.expanded.nodes.length, paths: layouts.expanded.edges.length },
        },
        statistics: graph.statistics,
      }, null, 2)}\n`);
    } else {
      const options = parseRunOptions(args);
      const bindings = options.adapter === undefined ? missingAgentBindings() : await loadBindings(options.adapter);
      const trace = options.trace === undefined ? undefined : new MemoryTraceSink();
      const vm = new AflVm(module, {
        ...bindings,
        ...(trace === undefined ? {} : { trace }),
      });
      const vmArgs = options.argsFile === undefined
        ? JSON.parse(options.args ?? "[]")
        : JSON.parse(await readFile(resolve(options.argsFile), "utf8"));
      if (!Array.isArray(vmArgs)) throw new Error("--args must decode to a JSON array");
      const result = await vm.run(options.entry ?? "main", vmArgs, {
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        executionRoot: process.cwd(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (trace !== undefined && options.trace !== undefined) {
        await writeFile(resolve(options.trace), `${JSON.stringify(trace.events, null, 2)}\n`);
      }
    }
  } catch (error) {
    if (error instanceof AflVmError) {
      process.stderr.write(`${JSON.stringify(error.serialize(), null, 2)}\n`);
    } else if (error instanceof AflParseError || error instanceof AflValidationError) {
      process.stderr.write(`${JSON.stringify({ message: error.message, diagnostics: error.diagnostics }, null, 2)}\n`);
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
    if (!["--entry", "--args", "--args-file", "--adapter", "--trace", "--run-id"].includes(option)) {
      throw new Error(`unknown run option '${option}'`);
    }
    if (value === undefined) throw new Error(`option '${option}' requires a value`);
    const key = {
      "--entry": "entry",
      "--args": "args",
      "--args-file": "argsFile",
      "--adapter": "adapter",
      "--trace": "trace",
      "--run-id": "runId",
    }[option];
    options[key] = value;
    index += 1;
  }
  if (options.args !== undefined && options.argsFile !== undefined) {
    throw new Error("--args and --args-file are mutually exclusive");
  }
  return options;
}

function parseVisualizeOptions(args) {
  const options = { expandDynamic: true };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--hide-dynamic") {
      options.expandDynamic = false;
      continue;
    }
    if (!["--entry", "--output", "--max-depth"].includes(option)) {
      throw new Error(`unknown visualize option '${option}'`);
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`option '${option}' requires a value`);
    if (option === "--entry") options.entry = value;
    if (option === "--output") options.output = resolve(value);
    if (option === "--max-depth") {
      const depth = Number(value);
      if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("--max-depth must be a non-negative integer");
      options.maxDepth = depth;
    }
    index += 1;
  }
  return options;
}

function defaultVisualizationOutput(filename) {
  const extension = extname(filename);
  const stem = basename(filename, extension);
  return join(dirname(filename), `${stem}.graph.html`);
}

async function loadBindings(modulePath) {
  const loaded = await import(pathToFileURL(resolve(modulePath)).href);
  const bindings = loaded.default ?? loaded.bindings;
  if (bindings === undefined || typeof bindings !== "object") {
    throw new Error("adapter module must export default VmBindings or a named 'bindings'");
  }
  if (bindings.agents !== undefined && typeof bindings.agents.run !== "function") {
    throw new Error("VmBindings.agents must implement run(request)");
  }
  if (bindings.agentExecutor !== undefined && typeof bindings.agentExecutor.execute !== "function") {
    throw new Error("VmBindings.agentExecutor must implement execute(request, host)");
  }
  return bindings;
}

function missingAgentBindings() {
  return {
    agents: {
      async run(request) {
        throw new AflVmError(
          "AGENT_ADAPTER_MISSING",
          `no adapter configured for '${request.agent.name}'`,
        );
      },
    },
  };
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  afl validate <program.afl>",
      "  afl visualize <program.afl> [--entry <node>] [--output <graph.html>]",
      "      [--max-depth <n>] [--hide-dynamic]",
      "  afl run <program.afl> [--entry <node>] [--args <json-array> | --args-file <file>]",
      "      [--adapter <module.mjs>] [--trace <trace.json>] [--run-id <id>]",
      "",
    ].join("\n"),
  );
}
