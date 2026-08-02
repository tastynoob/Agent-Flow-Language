#!/usr/bin/env node

import { runVmCommand } from "./vm-command.mjs";

process.exitCode = await runVmCommand(process.argv.slice(2));
