import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { applyKnowledgeGovernance, inspectKnowledgeGovernance } from "../src/knowledge-governance.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function fileHash(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function argumentsFrom(argv) {
  const result = { apply: false, databasePath: null, backupRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--database") result.databasePath = path.resolve(argv[++index]);
    else if (arg === "--backup-root") result.backupRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function actionCounts(actions) {
  return Object.fromEntries(Object.entries(actions).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.length : value,
  ]));
}

async function backupDatabase(sourcePath, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const target = path.join(backupRoot, "shadow-agent.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, target, { rate: 4096 });
  } finally {
    source.close();
  }
  const checked = new DatabaseSync(target, { readOnly: true });
  let quickCheck;
  try {
    quickCheck = checked.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
  } finally {
    checked.close();
  }
  if (quickCheck !== "ok") throw new Error(`Backup quick_check failed: ${quickCheck}`);
  const manifest = {
    schemaVersion: "shadow-agent-knowledge-governance-backup-v1",
    createdAt: new Date().toISOString(),
    source: sourcePath,
    target,
    bytes: fs.statSync(target).size,
    sha256: fileHash(target),
    quickCheck,
  };
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

const args = argumentsFrom(process.argv.slice(2));
const config = loadConfig();
const databasePath = args.databasePath ?? config.paths.database;
if (!args.apply) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", databasePath, plan: inspectKnowledgeGovernance(database) }, null, 2)}\n`);
  } finally {
    database.close();
  }
} else {
  const backupRoot = args.backupRoot
    ?? path.resolve(projectRoot, "..", "shadow-agent-backups", `knowledge-governance-${stamp()}`);
  const backupManifest = await backupDatabase(databasePath, backupRoot);
  const store = openDatabase(databasePath);
  let result;
  try {
    result = applyKnowledgeGovernance(store.db);
    const quickCheck = store.db.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
    if (quickCheck !== "ok") throw new Error(`Post-migration quick_check failed: ${quickCheck}`);
    result.quickCheck = quickCheck;
  } finally {
    store.close();
  }
  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    databasePath,
    backupManifest,
    result: {
      before: result.before,
      actionCounts: actionCounts(result.actions),
      after: result.after,
      quickCheck: result.quickCheck,
    },
  }, null, 2)}\n`);
}
