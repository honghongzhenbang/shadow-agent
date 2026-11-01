import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";
import { ensureCanonicalSourceStorage, SOURCE_STORAGE_VERSION } from "../src/source-records.mjs";
import { ensureDirectory, nowIso } from "../src/utils.mjs";

function scalar(database, sql, ...params) {
  return Number(database.prepare(sql).get(...params)?.value ?? 0);
}

function safeTimestamp(value = nowIso()) {
  return value.replaceAll(":", "-").replaceAll(".", "-");
}

function inspect(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const views = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map((row) => row.name));
  return {
    storageVersion: Number(database.prepare("SELECT value FROM settings WHERE key='source:storage:version'").get()?.value ?? 0),
    evidence: scalar(database, "SELECT COUNT(*) AS value FROM evidence"),
    observations: tables.has("source_observations") ? scalar(database, "SELECT COUNT(*) AS value FROM source_observations") : 0,
    collaboration: tables.has("collaboration_events") ? scalar(database, "SELECT COUNT(*) AS value FROM collaboration_events") : 0,
    execution: tables.has("execution_events") ? scalar(database, "SELECT COUNT(*) AS value FROM execution_events") : 0,
    legacyViews: [
      "source_observation_projection",
      "collaboration_event_projection",
      "execution_event_projection",
    ].filter((name) => views.has(name)),
  };
}

const apply = process.argv.includes("--apply");
const config = loadConfig();
const databasePath = path.resolve(config.paths.database);
if (!fs.existsSync(databasePath)) throw new Error(`Shadow database does not exist: ${databasePath}`);
let database = new DatabaseSync(databasePath);
const before = inspect(database);

if (!apply) {
  database.close();
  process.stdout.write(`${JSON.stringify({ apply: false, databasePath, targetVersion: SOURCE_STORAGE_VERSION, before }, null, 2)}\n`);
  process.exit(0);
}

database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
database.close();

const stamp = safeTimestamp();
const backupDirectory = path.join(path.dirname(databasePath), "backups", "canonical-source-storage", stamp);
ensureDirectory(backupDirectory);
const backupPath = path.join(backupDirectory, path.basename(databasePath));
fs.copyFileSync(databasePath, backupPath, fs.constants.COPYFILE_EXCL);

database = new DatabaseSync(databasePath);
database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
const migrated = ensureCanonicalSourceStorage(database);
const after = inspect(database);
const orphanObservations = scalar(database, `
  SELECT COUNT(*) AS value FROM source_observations o
  LEFT JOIN evidence e ON e.id=o.evidence_id WHERE e.id IS NULL
`);
const missingDomainRows = scalar(database, `
  SELECT COUNT(*) AS value FROM source_observations o
  LEFT JOIN collaboration_events c ON c.evidence_id=o.evidence_id
  LEFT JOIN execution_events x ON x.evidence_id=o.evidence_id
  WHERE (o.source_family='collaboration' AND c.evidence_id IS NULL)
     OR (o.source_family='execution' AND x.evidence_id IS NULL)
`);
database.exec("PRAGMA optimize");
database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
database.close();

if (after.storageVersion !== SOURCE_STORAGE_VERSION || after.legacyViews.length || orphanObservations || missingDomainRows) {
  throw new Error(`Canonical source cutover verification failed: ${JSON.stringify({ after, orphanObservations, missingDomainRows })}`);
}

const report = {
  apply: true,
  migrated,
  databasePath,
  backupPath,
  targetVersion: SOURCE_STORAGE_VERSION,
  before,
  after,
  orphanObservations,
  missingDomainRows,
  completedAt: nowIso(),
};
const reportPath = path.join(backupDirectory, "cutover-report.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
