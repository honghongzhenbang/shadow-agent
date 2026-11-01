import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";
import {
  inspectCodexStateTitles,
  inspectShadowStoredTitles,
  repairCodexStateTitles,
  repairShadowDigestTitles,
} from "../src/codex-title-maintenance.mjs";

const apply = process.argv.includes("--apply");
const compact = process.argv.includes("--compact");
const config = loadConfig();
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupRoot = path.join(config.projectRoot, "runtime", "backups", "codex-title-repair", timestamp);

function sqliteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function backupStateDatabase(databasePath) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout=10000");
  try {
    database.exec(`VACUUM INTO ${sqliteLiteral(backupPath)}`);
  } finally {
    database.close();
  }
  return backupPath;
}

function compactShadowDatabase(databasePath) {
  const compactPath = `${databasePath}.title-repair.compact`;
  const oldPath = `${databasePath}.title-repair.old`;
  fs.rmSync(compactPath, { force: true });
  fs.rmSync(oldPath, { force: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec(`VACUUM INTO ${sqliteLiteral(compactPath)}`);
  } finally {
    database.close();
  }
  const compactDatabase = new DatabaseSync(compactPath, { readOnly: true });
  try {
    const check = compactDatabase.prepare("PRAGMA quick_check").get();
    if (check.quick_check !== "ok") throw new Error(`Compacted Shadow database failed quick_check: ${check.quick_check}`);
  } finally {
    compactDatabase.close();
  }
  fs.renameSync(databasePath, oldPath);
  fs.renameSync(compactPath, databasePath);
  fs.rmSync(oldPath, { force: true });
}

const stateInspection = inspectCodexStateTitles(config);
const shadowInspection = inspectShadowStoredTitles(config.paths.database, {
  canonicalCandidates: stateInspection.candidates,
  maxThreadTitleChars: config.codex.titleMaintenance.maxThreadTitleChars,
  maxDigestTitleChars: config.codex.titleMaintenance.maxDigestTitleChars,
});
const preview = stateInspection.candidates.slice(0, 20).map((row) => ({
  id: row.id,
  oldTitleChars: row.oldTitleChars,
  newTitle: row.newTitle,
}));

if (!apply) {
  console.log(JSON.stringify({ apply, compact, stateInspection: {
    databasePath: stateInspection.databasePath,
    candidates: stateInspection.candidates.length,
    reclaimedTitleChars: stateInspection.candidates.reduce((sum, row) => sum + row.oldTitleChars - Array.from(row.newTitle).length, 0),
  }, shadowInspection: {
    databasePath: shadowInspection.databasePath,
    candidates: shadowInspection.candidates.length,
    threads: shadowInspection.threads,
    digestRows: shadowInspection.digestRows,
    titleChars: shadowInspection.titleChars,
    maxDigestTitleChars: shadowInspection.maxDigestTitleChars,
  }, preview }, null, 2));
  process.exit(0);
}

const lockPath = path.join(config.projectRoot, "runtime", "context-service.lock.json");
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  try {
    process.kill(lock.pid, 0);
    throw new Error(`Stop Shadow Agent before applying title repair (PID ${lock.pid}).`);
  } catch (error) {
    if (error.message.startsWith("Stop Shadow Agent")) throw error;
  }
}

const stateBackupPath = backupStateDatabase(stateInspection.databasePath);
const stateResult = repairCodexStateTitles(config, { apply: true, inspection: stateInspection });
const shadowResult = repairShadowDigestTitles(config.paths.database, shadowInspection.candidates, {
  apply: true,
  inspection: shadowInspection,
  maxDigestTitleChars: config.codex.titleMaintenance.maxDigestTitleChars,
});
if (compact) compactShadowDatabase(config.paths.database);

const manifest = {
  appliedAt: new Date().toISOString(),
  stateBackupPath,
  compactedShadowDatabase: compact,
  stateResult: {
    databasePath: stateResult.databasePath,
    changed: stateResult.changed,
    reclaimedTitleChars: stateResult.reclaimedTitleChars,
  },
  shadowResult,
  changes: stateInspection.candidates.map((row) => ({
    id: row.id,
    oldTitleChars: row.oldTitleChars,
    oldTitleSha256: crypto.createHash("sha256").update(row.oldTitle).digest("hex"),
    newTitle: row.newTitle,
  })),
};
fs.mkdirSync(backupRoot, { recursive: true });
fs.writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
