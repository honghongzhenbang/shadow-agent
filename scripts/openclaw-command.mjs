import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argumentFile = process.argv[2];
const outputFile = process.argv[3];
if (!argumentFile) {
  console.error("Usage: node scripts/openclaw-command.mjs <arguments-json-file>");
  process.exit(2);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const openClawEntry = resolve(
  projectRoot,
  "tools/openclaw-runtime/node_modules/openclaw/openclaw.mjs",
);
const raw = readFileSync(argumentFile, "utf8").replace(/^\uFEFF/, "");
const args = JSON.parse(raw);

if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new TypeError("OpenClaw arguments file must contain an array of strings.");
}

const result = spawnSync(process.execPath, [openClawEntry, ...args], {
  cwd: projectRoot,
  env: process.env,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
  windowsHide: true,
});

if (result.error) {
  throw result.error;
}

if (result.stdout) {
  if (outputFile) writeFileSync(outputFile, result.stdout, "utf8");
  else process.stdout.write(result.stdout);
}

process.exit(result.status ?? 1);
