import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { loadConfig } from "../src/config.mjs";
import { materializeContextGraph } from "../src/context-graph.mjs";
import { openDatabase } from "../src/db.mjs";
import { routePendingContextChanges } from "../src/work-sessions.mjs";

function parseArguments(argv) {
  const result = { source: null, target: null, report: null, keepCopy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") result.source = argv[++index];
    else if (argument === "--target") result.target = argv[++index];
    else if (argument === "--report") result.report = argv[++index];
    else if (argument === "--keep-copy") result.keepCopy = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columnExists(database, table, column) {
  return tableExists(database, table)
    && database.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function count(database, table, where = "1=1") {
  if (!tableExists(database, table)) return null;
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get()?.count ?? 0);
}

function setting(database, key) {
  if (!tableExists(database, "settings")) return null;
  return database.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? null;
}

function snapshot(database) {
  const hasSessionKey = columnExists(database, "context_changes", "session_key");
  const hasNotBefore = columnExists(database, "context_changes", "not_before");
  return {
    graphVersion: setting(database, "contextGraph:version"),
    evidence: count(database, "evidence"),
    feishuEvidence: count(database, "evidence", "kind='feishu_message'"),
    graphEntities: count(database, "graph_entities"),
    graphFacts: count(database, "graph_facts"),
    conversationEntities: count(database, "graph_entities", "type='Conversation'"),
    messageEntities: count(database, "graph_entities", "type='Message'"),
    pendingFeishuEnrichment: tableExists(database, "graph_enrichment_queue")
      ? Number(database.prepare(`
          SELECT COUNT(*) AS count FROM graph_enrichment_queue q
          JOIN evidence e ON e.id=q.evidence_id
          WHERE e.kind='feishu_message' AND q.status<>'completed'
        `).get().count)
      : null,
    conversationMessageLinks: tableExists(database, "graph_entity_evidence")
      ? Number(database.prepare(`
          SELECT COUNT(*) AS count FROM graph_entity_evidence link
          JOIN graph_entities entity ON entity.id=link.entity_id
          JOIN evidence e ON e.id=link.evidence_id
          WHERE entity.type='Conversation' AND e.kind='feishu_message'
        `).get().count)
      : null,
    pendingChanges: count(database, "context_changes", "status='pending'"),
    pendingChangesRouted: hasSessionKey && hasNotBefore
      ? count(database, "context_changes", "status='pending' AND session_key IS NOT NULL AND not_before IS NOT NULL")
      : 0,
    workSessions: count(database, "conversation_bindings"),
  };
}

function ensureFreeSpace(sourcePath, targetPath) {
  const size = fs.statSync(sourcePath).size;
  const targetDirectory = path.dirname(targetPath);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const targetStats = fs.statfsSync(targetDirectory);
  const free = Number(targetStats.bavail) * Number(targetStats.bsize);
  const minimum = size + 1024 ** 3;
  if (free < minimum) {
    throw new Error(`Insufficient free space for migration copy: need at least ${minimum}, have ${free}`);
  }
  return { size, free };
}

const args = parseArguments(process.argv.slice(2));
const config = loadConfig();
const sourcePath = path.resolve(args.source ?? config.paths.database);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetPath = path.resolve(args.target ?? path.join(os.tmpdir(), `shadow-agent-v4-migration-${stamp}.sqlite`));
const reportPath = path.resolve(args.report ?? path.join(config.projectRoot, "runtime", "v4-migration-validation.json"));
const capacity = ensureFreeSpace(sourcePath, targetPath);
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.mkdirSync(path.dirname(reportPath), { recursive: true });

let source = null;
let targetStore = null;
try {
  source = new DatabaseSync(sourcePath, { readOnly: true });
  source.exec("PRAGMA query_only=ON");
  const before = snapshot(source);
  process.stderr.write(`Backing up ${sourcePath} to ${targetPath}\n`);
  await backup(source, targetPath);
  source.close();
  source = null;

  const disposable = new DatabaseSync(targetPath);
  disposable.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF");
  disposable.close();

  targetStore = openDatabase(targetPath);
  const migration = materializeContextGraph(targetStore, config, {
    emitChanges: false,
    refreshStructural: false,
    runMaintenance: false,
  });
  const routing = routePendingContextChanges(targetStore, config.attention ?? {});
  const after = snapshot(targetStore.db);
  const quickCheck = targetStore.db.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
  const checks = {
    quickCheck: quickCheck === "ok",
    graphVersion: after.graphVersion === "epistemic-context-v4",
    evidencePreserved: after.evidence === before.evidence,
    feishuEvidencePreserved: after.feishuEvidence === before.feishuEvidence,
    factsPreserved: Number(after.graphFacts ?? 0) >= Number(before.graphFacts ?? 0),
    entitiesPreserved: Number(after.graphEntities ?? 0) >= Number(before.graphEntities ?? 0),
    noPendingFeishuEnrichment: after.pendingFeishuEnrichment === 0,
    noConversationMessageLinks: after.conversationMessageLinks === 0,
    pendingChangesRouted: after.pendingChanges === after.pendingChangesRouted,
  };
  const report = {
    schemaVersion: "shadow-agent-v4-migration-validation-v1",
    generatedAt: new Date().toISOString(),
    sourcePath,
    targetPath: args.keepCopy ? targetPath : "deleted-after-validation",
    sourceBytes: capacity.size,
    freeBytesBefore: capacity.free,
    before,
    after,
    migration,
    routing,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 2;
} finally {
  try { targetStore?.close(); } catch { /* already closed */ }
  try { source?.close(); } catch { /* already closed */ }
  if (!args.keepCopy) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${targetPath}${suffix}`, { force: true });
  }
}
