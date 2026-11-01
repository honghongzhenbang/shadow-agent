import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { refreshKnowledgeEntries } from "../src/context-graph.mjs";
import { buildKnowledgeEntry, collectEntryTargets, maintainedEntryRows, initializeKnowledgeEntries } from "../src/knowledge-entries.mjs";
import { sha256, stableJson } from "../src/utils.mjs";

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const databasePath = option("--database");
const apply = args.includes("--apply");
const reportPath = option("--report");
const backupPath = option("--backup");
const checkedTables = ["graph_entities", "graph_aliases", "graph_entity_evidence", "graph_facts",
  "graph_entity_fts_data", "graph_entity_fts_idx", "graph_entity_fts_content", "graph_entity_fts_docsize", "graph_entity_fts_config"];
if (!databasePath || (apply && !backupPath)) {
  throw new Error("Usage: --database <sqlite> [--report <json>] [--apply --backup <new sqlite>]. Stop database writers before applying.");
}
if (backupPath && (fs.existsSync(backupPath) || path.resolve(backupPath) === path.resolve(databasePath))) {
  throw new Error("Backup must be a new, distinct path");
}
if (reportPath && [databasePath, backupPath].filter(Boolean).some(value => path.resolve(value) === path.resolve(reportPath))) {
  throw new Error("Report must not overwrite the database or its backup");
}

function protectedState(db) {
  const scalar = sql => db.prepare(sql).get().n;
  return {
    evidence: scalar("SELECT count(*) AS n FROM evidence"),
    evidenceLinks: scalar("SELECT count(*) AS n FROM evidence_links"),
    reviews: scalar("SELECT count(*) AS n FROM graph_episode_annotations"),
    changes: scalar("SELECT count(*) AS n FROM context_changes"),
    tasks: scalar("SELECT count(*) AS n FROM tasks"),
    semanticFactsHash: sha256(stableJson(db.prepare("SELECT * FROM graph_facts WHERE assertion_mode<>'structural_route' ORDER BY id").all())),
  };
}

function inspect(db) {
  const rows = maintainedEntryRows(db);
  const targets = collectEntryTargets(rows);
  const counts = { repository: 0, document: 0, "document-set": 0 };
  const result = { evidenceInputs: rows.length, targets: targets.length, kinds: counts,
    missingEntries: 0, staleEntries: 0, unresolvedTargets: 0, exactSourceLinks: 0, invalidSourceLinks: 0 };
  const hasIndexes = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('evidence_repository_entry_idx','evidence_document_entry_idx')").get().n === 2;
  if (!hasIndexes) {
    for (const target of targets) counts[target.kind]++;
    return { ...result, missingEntries: null, staleEntries: null, unresolvedTargets: null,
      exactSourceLinks: db.prepare("SELECT count(*) AS n FROM graph_entity_evidence WHERE relation='retrieval_source'").get().n,
      requiresIndexedInspection: true };
  }
  for (const target of targets) {
    const entry = buildKnowledgeEntry(db, target);
    if (!entry) { result.unresolvedTargets++; continue; }
    counts[target.kind]++;
    const current = db.prepare("SELECT id,summary,metadata_json FROM graph_entities WHERE canonical_key=?").get(entry.input.canonicalKey);
    if (!current) result.missingEntries++;
    else {
      const metadata = JSON.parse(current.metadata_json || "{}");
      const actualLinks = db.prepare("SELECT evidence_id FROM graph_entity_evidence WHERE entity_id=? AND relation='retrieval_source' ORDER BY evidence_id").all(current.id).map(row => row.evidence_id);
      const expectedLinks = entry.sources.map(row => row.id).sort();
      if (metadata.knowledgeEntry?.revision !== entry.input.metadata.knowledgeEntry.revision
        || (Number(metadata.presentationPriority ?? 0) <= 10 && current.summary !== entry.input.summary)
        || stableJson(actualLinks) !== stableJson(expectedLinks)) result.staleEntries++;
      result.exactSourceLinks += actualLinks.length;
    }
  }
  result.invalidSourceLinks = db.prepare(`SELECT count(*) AS n FROM graph_entity_evidence link
    LEFT JOIN evidence ON evidence.id=link.evidence_id WHERE link.relation='retrieval_source' AND evidence.id IS NULL`).get().n;
  return result;
}

const startedAt = new Date().toISOString();
const database = new DatabaseSync(path.resolve(databasePath), { readOnly: !apply });
database.exec("PRAGMA busy_timeout=5000");
let report;
try {
  let before = inspect(database);
  const protectedBefore = protectedState(database);
  let updatedEntries = 0;
  let backupCheck;
  if (apply) {
    console.error("Backing up the database before repair.");
    fs.mkdirSync(path.dirname(path.resolve(backupPath)), { recursive: true });
    await backup(database, path.resolve(backupPath));
    const saved = new DatabaseSync(path.resolve(backupPath), { readOnly: true });
    try { backupCheck = saved.prepare("PRAGMA quick_check").get().quick_check; } finally { saved.close(); }
    if (backupCheck !== "ok") throw new Error(`Backup verification failed: ${backupCheck}`);
    console.error("Full backup verified; rebuilding derived entries in one transaction.");
    database.exec("BEGIN IMMEDIATE");
    try {
      initializeKnowledgeEntries(database);
      before = inspect(database);
      const entries = refreshKnowledgeEntries(database);
      updatedEntries = [...entries.values()].filter(entry => entry.item.changed).length;
      if (stableJson(protectedState(database)) !== stableJson(protectedBefore)) throw new Error("Protected records changed");
      const after = inspect(database);
      if (after.missingEntries || after.staleEntries || after.invalidSourceLinks) throw new Error(`Repair verification failed: ${JSON.stringify(after)}`);
      for (const table of checkedTables) {
        const check = database.prepare(`PRAGMA quick_check('${table}')`).get().quick_check;
        if (check !== "ok") throw new Error(`Repaired table ${table} failed integrity check: ${check}`);
      }
      database.exec("COMMIT");
      console.error("Derived entries committed; protected records and touched tables verified.");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  report = { version: 1, startedAt, finishedAt: new Date().toISOString(), mode: apply ? "apply" : "dry-run",
    databasePath: path.resolve(databasePath), backupPath: backupPath ? path.resolve(backupPath) : null,
    backupCheck, before, after: apply ? inspect(database) : null, updatedEntries,
    protectedRecordsUnchanged: stableJson(protectedState(database)) === stableJson(protectedBefore),
    protectedBefore, quickCheck: apply ? "ok" : null, checkedTables: apply ? checkedTables : [],
    integrityScope: "full backup; repaired graph and FTS tables inside the transaction" };
} finally { database.close(); }
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
