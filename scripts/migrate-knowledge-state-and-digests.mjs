import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { recomputeFactTrust } from "../src/graph-model.mjs";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const result = { apply: false, compact: false, help: false, databasePath: null, backupRoot: null, reuseBackupRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") result.apply = true;
    else if (value === "--compact") result.compact = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--database") result.databasePath = path.resolve(argv[++index]);
    else if (value === "--backup-root") result.backupRoot = path.resolve(argv[++index]);
    else if (value === "--reuse-backup") result.reuseBackupRoot = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function scalar(database, sql, ...parameters) {
  return Number(database.prepare(sql).get(...parameters)?.value ?? 0);
}

function inspect(database, databasePath) {
  const bytes = fs.statSync(databasePath).size;
  const annotationColumns = new Set(database.prepare("PRAGMA table_info(graph_episode_annotations)").all().map((row) => row.name));
  const reviewSql = annotationColumns.has("review_status")
    ? `SELECT review_status || ':' || COALESCE(review_outcome, '-') AS state, COUNT(*) AS count
       FROM graph_episode_annotations GROUP BY review_status, review_outcome ORDER BY state`
    : `SELECT COALESCE(json_extract(metadata_json,'$.graphReview.status'),'pending') AS state, COUNT(*) AS count
       FROM graph_episode_annotations GROUP BY state ORDER BY state`;
  return {
    bytes,
    digest: {
      currentRows: scalar(database, "SELECT COUNT(*) AS value FROM evidence WHERE kind='codex_thread_digest'"),
      archivedRows: scalar(database, "SELECT COUNT(*) AS value FROM evidence WHERE kind='codex_thread_digest_archive'"),
      threads: scalar(database, "SELECT COUNT(DISTINCT thread_id) AS value FROM evidence WHERE kind='codex_thread_digest'"),
      generations: scalar(database, "SELECT COUNT(*) AS value FROM (SELECT thread_id, json_extract(metadata_json,'$.digestHash') FROM evidence WHERE kind='codex_thread_digest' GROUP BY thread_id, json_extract(metadata_json,'$.digestHash'))"),
    },
    facts: Object.fromEntries(database.prepare(`
      SELECT epistemic_status, COUNT(*) AS count FROM graph_facts
      GROUP BY epistemic_status ORDER BY epistemic_status
    `).all().map((row) => [row.epistemic_status, Number(row.count)])),
    review: Object.fromEntries(database.prepare(reviewSql).all().map((row) => [row.state, Number(row.count)])),
    assessmentStances: Object.fromEntries(database.prepare(`
      SELECT stance, COUNT(*) AS count FROM graph_evidence_assessments GROUP BY stance ORDER BY stance
    `).all().map((row) => [row.stance, Number(row.count)])),
  };
}

function inspectReadOnly(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return inspect(database, databasePath);
  } finally {
    database.close();
  }
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (true) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
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
  return { target, bytes: fs.statSync(target).size, sha256: hashFile(target), quickCheck };
}

function migrateMentionAssessments(database) {
  const rows = database.prepare(`
    SELECT assessment.fact_id, assessment.evidence_id, fact.subject_entity_id, fact.object_entity_id
    FROM graph_evidence_assessments assessment
    JOIN graph_facts fact ON fact.id=assessment.fact_id
    WHERE assessment.stance NOT IN ('supports','contradicts')
  `).all();
  const link = database.prepare(`
    INSERT OR IGNORE INTO graph_entity_evidence(entity_id, evidence_id, relation, observed_at)
    SELECT ?, ?, 'mentioned_by', COALESCE(occurred_at, collected_at, datetime('now'))
    FROM evidence WHERE id=?
  `);
  const removeAssessment = database.prepare("DELETE FROM graph_evidence_assessments WHERE fact_id=? AND evidence_id=? AND stance NOT IN ('supports','contradicts')");
  const removeLegacy = database.prepare(`
    DELETE FROM graph_fact_evidence WHERE fact_id=? AND evidence_id=?
      AND NOT EXISTS (
        SELECT 1 FROM graph_evidence_assessments
        WHERE fact_id=? AND evidence_id=? AND stance IN ('supports','contradicts')
      )
  `);
  for (const row of rows) {
    link.run(row.subject_entity_id, row.evidence_id, row.evidence_id);
    if (row.object_entity_id) link.run(row.object_entity_id, row.evidence_id, row.evidence_id);
    removeAssessment.run(row.fact_id, row.evidence_id);
    removeLegacy.run(row.fact_id, row.evidence_id, row.fact_id, row.evidence_id);
  }
  return rows.length;
}

function upgradeStructuredProfileAssessments(database) {
  return Number(database.prepare(`
    UPDATE graph_evidence_assessments
    SET level=2, basis='artifact', directness='direct', method='document_record',
      metadata_json=json_set(
        CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
        '$.evidenceNormalization', 'structured_profile_document',
        '$.normalizedAt', datetime('now')
      )
    WHERE stance='supports' AND level<2
      AND evidence_id IN (
        SELECT id FROM evidence
        WHERE kind='manual_knowledge' AND json_extract(metadata_json,'$.structuredProfile')=1
      )
  `).run().changes);
}

function compactDigestHistory(store) {
  const threads = store.db.prepare(`
    SELECT thread_id, id, json_extract(metadata_json,'$.digestHash') AS digest_hash
    FROM evidence current
    WHERE kind='codex_thread_digest' AND thread_id IS NOT NULL
      AND rowid=(
        SELECT rowid FROM evidence latest
        WHERE latest.kind='codex_thread_digest' AND latest.thread_id=current.thread_id
        ORDER BY latest.collected_at DESC, latest.rowid DESC LIMIT 1
      )
    ORDER BY thread_id
  `).all();
  const result = { threads: threads.length, archived: 0, deleted: 0 };
  for (const thread of threads) {
    const finalized = store.finalizeThreadDigestGeneration(thread.thread_id, thread.digest_hash ?? "", thread.id);
    result.archived += finalized.archived;
    result.deleted += finalized.deleted;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage: node scripts/migrate-knowledge-state-and-digests.mjs [options]\n\n`);
  process.stdout.write(`  --apply                 Apply the migration; otherwise run a read-only audit\n`);
  process.stdout.write(`  --compact               VACUUM the database after a successful migration\n`);
  process.stdout.write(`  --database <path>       Override the configured SQLite database\n`);
  process.stdout.write(`  --backup-root <path>    Write the verified backup and report here\n`);
  process.stdout.write(`  --reuse-backup <path>   Reuse a previously verified migration backup\n`);
  process.exit(0);
}
const config = loadConfig();
const databasePath = args.databasePath ?? config.paths.database;

if (!args.apply) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", databasePath, current: inspect(database, databasePath) }, null, 2)}\n`);
  } finally {
    database.close();
  }
  process.exit(0);
}

const backupRoot = args.reuseBackupRoot ?? args.backupRoot
  ?? path.resolve(config.projectRoot, "..", "shadow-agent-backups", `knowledge-state-digest-${stamp()}`);
let backupManifest;
if (args.reuseBackupRoot) {
  const priorReportPath = path.join(args.reuseBackupRoot, "migration-report.json");
  if (!fs.existsSync(priorReportPath)) throw new Error(`Reusable migration report not found: ${priorReportPath}`);
  const priorReport = JSON.parse(fs.readFileSync(priorReportPath, "utf8"));
  backupManifest = priorReport.backupManifest;
  if (!backupManifest?.target || !fs.existsSync(backupManifest.target) || backupManifest.quickCheck !== "ok") {
    throw new Error("Reusable backup is missing or was not verified");
  }
} else {
  backupManifest = await backupDatabase(databasePath, backupRoot);
}
const store = openDatabase(databasePath);
let report;
try {
  const baseline = inspectReadOnly(backupManifest.target);
  const before = inspect(store.db, databasePath);
  const digest = compactDigestHistory(store);
  const migratedMentions = migrateMentionAssessments(store.db);
  const normalizedStructuredProfileAssessments = upgradeStructuredProfileAssessments(store.db);
  const facts = store.db.prepare("SELECT id FROM graph_facts WHERE status='active' ORDER BY id").all();
  const trustChanges = {};
  for (const row of facts) {
    const previous = store.db.prepare("SELECT epistemic_status FROM graph_facts WHERE id=?").get(row.id).epistemic_status;
    const next = recomputeFactTrust(store.db, row.id);
    if (previous !== next) trustChanges[`${previous}->${next}`] = (trustChanges[`${previous}->${next}`] ?? 0) + 1;
  }
  if (args.compact) store.db.exec("VACUUM");
  const quickCheck = store.db.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
  if (quickCheck !== "ok") throw new Error(`Post-migration quick_check failed: ${quickCheck}`);
  const after = inspect(store.db, databasePath);
  report = {
    mode: "apply",
    databasePath,
    backupRoot,
    backupManifest,
    digest,
    migratedMentions,
    normalizedStructuredProfileAssessments,
    trustChanges,
    compacted: args.compact,
    quickCheck,
    baseline,
    before,
    after,
    cumulative: {
      searchableDigestRowsRetired: Math.max(0, baseline.digest.currentRows - after.digest.currentRows),
      digestGenerationsRetired: Math.max(0, baseline.digest.generations - after.digest.generations),
      bytesReclaimed: Math.max(0, baseline.bytes - after.bytes),
    },
  };
} finally {
  store.close();
}
const renderedReport = `${JSON.stringify(report, null, 2)}\n`;
fs.writeFileSync(path.join(backupRoot, `migration-report-${stamp()}.json`), renderedReport, "utf8");
fs.writeFileSync(path.join(backupRoot, "migration-report.json"), renderedReport, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
