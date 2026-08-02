import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (npmCli === undefined) {
  throw new Error("run package verification through 'npm run test:package'");
}

const temporary = await mkdtemp(join(tmpdir(), "afl-vm-package-"));
const cache = join(temporary, "cache");
const install = join(temporary, "install");

try {
  await run(process.execPath, [npmCli, "pack", "--pack-destination", temporary], root, cache);
  const filename = (await readdir(temporary)).find((entry) => entry.endsWith(".tgz"));
  if (filename === undefined) throw new Error("npm pack did not create a tarball");

  await run(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      install,
      join(temporary, filename),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    root,
    cache,
  );

  const executable = process.platform === "win32"
    ? join(install, "node_modules", ".bin", "afl-vm.cmd")
    : join(install, "node_modules", ".bin", "afl-vm");
  await access(executable);
  const commandModule = join(
    install,
    "node_modules",
    "@afl-lang",
    "core",
    "bin",
    "vm-command.mjs",
  );
  const { runVmCommand } = await import(pathToFileURL(commandModule).href);
  let output = "";
  let errorOutput = "";
  const exitCode = await runVmCommand(
    [
      join(root, "test", "fixtures", "noop-bindings.mjs"),
      join(root, "test", "fixtures", "minimal.afl"),
    ],
    {
      stdout: { write: (chunk) => { output += chunk; } },
      stderr: { write: (chunk) => { errorOutput += chunk; } },
    },
  );
  if (exitCode !== 0) throw new Error(`installed afl-vm failed: ${errorOutput}`);
  const result = JSON.parse(output);
  if (result.output?.kind !== "frag" || result.output.content !== "afl-vm-ok") {
    throw new Error(`installed afl-vm returned an unexpected result: ${output}`);
  }
  process.stdout.write(`installed ${basename(filename)}: afl-vm-ok\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function run(command, args, cwd, cacheDirectory) {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cacheDirectory },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveOutput(stdout);
        return;
      }
      rejectOutput(new Error(
        [
          `command failed: ${command} ${args.join(" ")}`,
          error.message,
          stdout,
          stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      ));
    });
  });
}
