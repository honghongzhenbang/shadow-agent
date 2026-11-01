#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  doctorKimiExecutor,
  loadKimiExecutorConfig,
  queueKimiTurn,
  runQueuedKimiTurn,
  stopKimiTurn,
  taskStatus,
} from "../src/execution-providers/kimi-code.mjs";

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return `Usage:
  node scripts/kimi-code-executor.mjs doctor [--config PATH]
  node scripts/kimi-code-executor.mjs start --task ID --workspace PATH --prompt-file PATH [--timeout-seconds N] [--config PATH]
  node scripts/kimi-code-executor.mjs resume --task ID --workspace PATH --prompt-file PATH [--timeout-seconds N] [--config PATH]
  node scripts/kimi-code-executor.mjs status --task ID [--config PATH]
  node scripts/kimi-code-executor.mjs wait --task ID [--wait-seconds N] [--config PATH]
  node scripts/kimi-code-executor.mjs stop --task ID [--config PATH]`;
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (!command || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = loadKimiExecutorConfig(options.config);
  if (command === "doctor") return print(doctorKimiExecutor(config));
  if (command === "status") return print(taskStatus(config, options.task));
  if (command === "stop") return print(stopKimiTurn(config, options.task));
  if (command === "_run") return print(await runQueuedKimiTurn(config, options.task));
  if (command === "start" || command === "resume") {
    return print(queueKimiTurn(config, {
      task: options.task,
      workspace: options.workspace,
      promptFile: options["prompt-file"],
      timeoutSeconds: options["timeout-seconds"] ? Number(options["timeout-seconds"]) : undefined,
      resume: command === "resume",
      runnerPath: fileURLToPath(import.meta.url),
    }));
  }
  if (command === "wait") {
    const deadline = Date.now() + Number(options["wait-seconds"] ?? 60) * 1000;
    while (Date.now() < deadline) {
      const status = taskStatus(config, options.task);
      if (!["starting", "running", "stopping"].includes(status.status)) return print(status);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    print(taskStatus(config, options.task));
    process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
