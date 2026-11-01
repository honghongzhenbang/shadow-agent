import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "./paths.mjs";
import { ensureDirectory, nowIso, redactSecrets } from "./utils.mjs";

const logDirectory = ensureDirectory(path.join(PROJECT_ROOT, "logs"));

export function log(level, message, details = undefined) {
  const entry = {
    timestamp: nowIso(),
    level,
    message,
    ...(details === undefined ? {} : { details }),
  };
  const line = redactSecrets(JSON.stringify(entry));
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(path.join(logDirectory, "shadow-agent.ndjson"), `${line}\n`, "utf8");
}

export const logger = {
  info: (message, details) => log("info", message, details),
  warn: (message, details) => log("warn", message, details),
  error: (message, details) => log("error", message, details),
};
