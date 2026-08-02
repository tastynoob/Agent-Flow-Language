import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AflParseError,
  AflValidationError,
  AflVm,
  AflVmError,
  MemoryTraceSink,
  parseAfl,
} from "../dist/src/index.js";

export async function runVmCommand(argv, io = process) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout.write(vmUsage());
    return 0;
  }

  const [bindingsSpecifier, flowFile, ...optionArgs] = argv;
  if (bindingsSpecifier === undefined || flowFile === undefined) {
    io.stderr.write(vmUsage());
    return 2;
  }

  try {
    const options = parseVmOptions(optionArgs);
    const loaded = await loadBindingsModule(bindingsSpecifier);
    const bindings = readBindings(loaded);
    const filename = resolve(flowFile);
    const module = parseAfl(await readFile(filename, "utf8"), filename);
    const trace = options.trace === undefined ? undefined : new MemoryTraceSink();
    const vm = new AflVm(module, {
      ...bindings,
      ...(trace === undefined ? {} : { trace }),
    });
    const vmArgs = await readVmArgs(options);
    const result = await vm.run(options.entry ?? "main", vmArgs, {
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (trace !== undefined && options.trace !== undefined) {
      await writeFile(resolve(options.trace), `${JSON.stringify(trace.events, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    writeVmError(error, io.stderr);
    return 1;
  }
}

export function vmUsage() {
  return [
    "Usage:",
    "  afl-vm <bindings-module> <flow.afl>",
    "      [--entry <node>] [--args <json-array> | --args-file <file>]",
    "      [--trace <trace.json>] [--run-id <id>]",
    "",
  ].join("\n");
}

function parseVmOptions(args) {
  const options = {};
  const names = new Map([
    ["--entry", "entry"],
    ["--args", "args"],
    ["--args-file", "argsFile"],
    ["--trace", "trace"],
    ["--run-id", "runId"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const key = names.get(option);
    if (key === undefined) throw new Error(`unknown VM option '${option}'`);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`option '${option}' requires a value`);
    options[key] = value;
    index += 1;
  }
  if (options.args !== undefined && options.argsFile !== undefined) {
    throw new Error("--args and --args-file are mutually exclusive");
  }
  return options;
}

async function readVmArgs(options) {
  const text = options.argsFile === undefined
    ? options.args ?? "[]"
    : await readFile(resolve(options.argsFile), "utf8");
  const args = JSON.parse(text);
  if (!Array.isArray(args)) throw new Error("VM arguments must decode to a JSON array");
  return args;
}

async function loadBindingsModule(specifier) {
  return import(await resolveBindingsSpecifier(specifier));
}

async function resolveBindingsSpecifier(specifier) {
  const filename = resolve(specifier);
  if (isAbsolute(specifier) || specifier.startsWith(".")) {
    return pathToFileURL(filename).href;
  }
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(specifier)) return specifier;
  try {
    await access(filename);
    return pathToFileURL(filename).href;
  } catch {
    try {
      const fromWorkingDirectory = createRequire(pathToFileURL(resolve("package.json")));
      const resolved = fromWorkingDirectory.resolve(specifier);
      return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(resolved)
        ? resolved
        : pathToFileURL(resolved).href;
    } catch {
      return specifier;
    }
  }
}

function readBindings(loaded) {
  const bindings = loaded.bindings ?? loaded.default;
  if (
    bindings === undefined ||
    typeof bindings !== "object"
  ) {
    throw new Error("bindings module must export default VmBindings or a named 'bindings'");
  }
  if (bindings.agents !== undefined && typeof bindings.agents.run !== "function") {
    throw new Error("VmBindings.agents must implement run(request)");
  }
  return bindings;
}

function writeVmError(error, stream) {
  if (error instanceof AflVmError) {
    stream.write(`${JSON.stringify(error.serialize(), null, 2)}\n`);
  } else if (error instanceof AflParseError || error instanceof AflValidationError) {
    stream.write(`${JSON.stringify({ message: error.message, diagnostics: error.diagnostics }, null, 2)}\n`);
  } else {
    stream.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
}
