import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const APPLY = process.argv.includes("--apply");
const COMPACT = process.argv.includes("--compact");
const INCLUDE_SUBAGENTS = process.argv.includes("--include-subagents");
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(process.env.USERPROFILE, ".codex"));
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const AGENT_CWD = path.resolve(PROJECT_ROOT, "runtime", "openclaw-poc", "workspace");
const LEGACY_AGENT_CWD = path.resolve(process.env.USERPROFILE, "Documents", "Codex", "shadow-agent");
const EVALUATION_ROOT = path.resolve(PROJECT_ROOT, "runtime", "evaluations");
const BACKUP_PARENT = path.resolve(PROJECT_ROOT, "..", "shadow-agent-backups");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP_ROOT = path.join(BACKUP_PARENT, `shared-codex-agent-cleanup-${STAMP}`);

const DATABASES = {
  state: path.join(CODEX_HOME, "state_5.sqlite"),
  history: path.join(CODEX_HOME, "thread_history_1.sqlite"),
  logs: path.join(CODEX_HOME, "logs_2.sqlite"),
  catalog: path.join(CODEX_HOME, "sqlite", "codex-dev.db"),
};

function normalizeFsPath(value) {
  if (!value) return "";
  const withoutPrefix = String(value).replace(/^\\\\\?\\/, "");
  return path.resolve(withoutPrefix).replace(/[\\/]+$/, "").toLowerCase();
}

function assertInside(candidate, roots) {
  const resolved = path.resolve(String(candidate).replace(/^\\\\\?\\/, ""));
  const allowed = roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) throw new Error(`Refusing path outside approved roots: ${resolved}`);
  return resolved;
}

function openDatabase(databasePath, readOnly = true) {
  if (!fs.existsSync(databasePath)) throw new Error(`Codex database not found: ${databasePath}`);
  const database = new DatabaseSync(databasePath, { readOnly });
  if (!readOnly) database.exec("PRAGMA busy_timeout=30000");
  return database;
}

function placeholders(values) {
  return values.map(() => "?").join(",");
}

function classifyTarget({ cwd, source, title, hasBackingThread }) {
  const normalizedCwd = normalizeFsPath(cwd);
  const currentAgentCwd = normalizeFsPath(AGENT_CWD);
  const legacyAgentCwd = normalizeFsPath(LEGACY_AGENT_CWD);
  const evaluationRoot = `${normalizeFsPath(EVALUATION_ROOT)}${path.sep}`;
  if (normalizedCwd === currentAgentCwd) return "current_agent_runtime";
  if (normalizedCwd.startsWith(evaluationRoot)) return "isolated_evaluation";
  if (normalizedCwd === legacyAgentCwd && (!hasBackingThread || source === "exec")) return "legacy_shadow_exec";
  if (INCLUDE_SUBAGENTS && String(title ?? "").startsWith("[Subagent Context]")) return "visible_subagent_thread";
  return null;
}

function targetThreads() {
  const database = openDatabase(DATABASES.state);
  const catalog = openDatabase(DATABASES.catalog);
  try {
    const selected = new Map();
    const stateRows = database.prepare(`
      SELECT id, rollout_path, cwd, title, source, tokens_used,
             length(COALESCE(first_user_message,'')) AS first_user_chars,
             created_at_ms, updated_at_ms
      FROM threads
      ORDER BY created_at_ms, id
    `).all();
    const stateById = new Map(stateRows.map((row) => [row.id, row]));
    for (const row of stateRows) {
      const cleanupCategory = classifyTarget({ ...row, hasBackingThread: true });
      if (cleanupCategory) selected.set(row.id, { ...row, cleanupCategory, hasCatalogRow: false });
    }
    for (const row of catalog.prepare(`
      SELECT thread_id AS id, cwd, display_title AS title, source_kind AS catalog_source,
             source_created_at AS created_at_ms, source_updated_at AS updated_at_ms
      FROM local_thread_catalog
      WHERE host_id = 'local'
      ORDER BY source_created_at, thread_id
    `).all()) {
      const backing = stateById.get(row.id);
      const cleanupCategory = classifyTarget({
        cwd: row.cwd,
        source: backing?.source,
        title: row.title,
        hasBackingThread: Boolean(backing),
      });
      if (!cleanupCategory) continue;
      const existing = selected.get(row.id);
      if (existing) {
        existing.hasCatalogRow = true;
      } else {
        selected.set(row.id, {
          ...row,
          rollout_path: null,
          source: row.catalog_source,
          tokens_used: 0,
          first_user_chars: 0,
          cleanupCategory,
          hasCatalogRow: true,
          catalogOnly: true,
        });
      }
    }
    return [...selected.values()].sort((left, right) => Number(left.created_at_ms) - Number(right.created_at_ms));
  } finally {
    catalog.close();
    database.close();
  }
}

function countByIds(database, table, column, ids, extra = "") {
  if (ids.length === 0) return 0;
  return Number(database.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders(ids)}) ${extra}`,
  ).get(...ids)?.count ?? 0);
}

function inspect(threads) {
  const ids = threads.map((row) => row.id);
  const history = openDatabase(DATABASES.history);
  const logs = openDatabase(DATABASES.logs);
  const state = openDatabase(DATABASES.state);
  const catalog = openDatabase(DATABASES.catalog);
  try {
    const allThreadSources = state.prepare("SELECT source FROM threads").all();
    const nativeSubagentThreads = allThreadSources.filter((row) => {
      try {
        return Boolean(JSON.parse(row.source)?.subagent);
      } catch {
        return false;
      }
    }).length;
    const itemStats = ids.length === 0 ? { count: 0, chars: 0 } : history.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(item_json)),0) AS chars
      FROM thread_items WHERE thread_id IN (${placeholders(ids)})
    `).get(...ids);
    const logStats = ids.length === 0 ? { count: 0, bytes: 0 } : logs.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(estimated_bytes),0) AS bytes
      FROM logs WHERE thread_id IN (${placeholders(ids)})
    `).get(...ids);
    return {
      selection: {
        includeSubagents: INCLUDE_SUBAGENTS,
        currentAgentCwd: AGENT_CWD,
        legacyAgentExecCwd: LEGACY_AGENT_CWD,
        evaluationRoot: EVALUATION_ROOT,
        categoryCounts: Object.fromEntries(
          [...new Set(threads.map((row) => row.cleanupCategory))]
            .sort()
            .map((category) => [category, threads.filter((row) => row.cleanupCategory === category).length]),
        ),
      },
      threadCount: ids.length,
      rolloutFiles: threads.filter((row) => fs.existsSync(row.rollout_path)).length,
      rolloutBytes: threads.reduce((sum, row) => sum + (fs.existsSync(row.rollout_path) ? fs.statSync(row.rollout_path).size : 0), 0),
      firstUserMessageChars: threads.reduce((sum, row) => sum + Number(row.first_user_chars ?? 0), 0),
      tokensUsed: threads.reduce((sum, row) => sum + Number(row.tokens_used ?? 0), 0),
      personalHomeBaseline: {
        totalThreads: allThreadSources.length,
        nativeSubagentThreads,
      },
      state: {
        threads: countByIds(state, "threads", "id", ids),
        spawnEdges: ids.length === 0 ? 0 : Number(state.prepare(`
          SELECT COUNT(*) AS count FROM thread_spawn_edges
          WHERE parent_thread_id IN (${placeholders(ids)}) OR child_thread_id IN (${placeholders(ids)})
        `).get(...ids, ...ids)?.count ?? 0),
        artifacts: countByIds(state, "thread_artifacts", "thread_id", ids),
        dynamicTools: countByIds(state, "thread_dynamic_tools", "thread_id", ids),
      },
      catalog: {
        rows: countByIds(catalog, "local_thread_catalog", "thread_id", ids, "AND host_id = 'local'"),
        timelineRows: countByIds(catalog, "thread_timeline_ledger", "thread_id", ids, "AND host_id = 'local'"),
        inboxRows: countByIds(catalog, "inbox_items", "thread_id", ids),
        automationRuns: countByIds(catalog, "automation_runs", "thread_id", ids),
      },
      history: {
        turns: countByIds(history, "thread_turns", "thread_id", ids),
        items: Number(itemStats.count ?? 0),
        itemJsonChars: Number(itemStats.chars ?? 0),
        projectionRows: countByIds(history, "thread_history_projection_state", "thread_id", ids),
        realtimeItems: countByIds(history, "thread_realtime_items", "thread_id", ids),
      },
      logs: {
        rows: Number(logStats.count ?? 0),
        estimatedBytes: Number(logStats.bytes ?? 0),
      },
    };
  } finally {
    history.close();
    logs.close();
    state.close();
    catalog.close();
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

async function hashGunzip(filePath) {
  const hash = createHash("sha256");
  const gunzip = createGunzip();
  gunzip.on("data", (chunk) => hash.update(chunk));
  await pipeline(fs.createReadStream(filePath), gunzip);
  return hash.digest("hex");
}

async function writeRowsGzip(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const gzip = createGzip({ level: 9 });
  const output = fs.createWriteStream(filePath, { flags: "wx" });
  gzip.pipe(output);
  for (const row of rows) {
    if (!gzip.write(`${JSON.stringify(row)}\n`)) {
      await new Promise((resolve) => gzip.once("drain", resolve));
    }
  }
  gzip.end();
  await new Promise((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
    gzip.on("error", reject);
  });
  return { path: filePath, bytes: fs.statSync(filePath).size, sha256: hashFile(filePath) };
}

function selectedRows(database, table, where, parameters) {
  return database.prepare(`SELECT * FROM ${table} WHERE ${where}`).iterate(...parameters);
}

async function archiveDatabaseRows(ids) {
  const archives = [];
  const state = openDatabase(DATABASES.state);
  const history = openDatabase(DATABASES.history);
  const logs = openDatabase(DATABASES.logs);
  const catalog = openDatabase(DATABASES.catalog);
  try {
    const idList = placeholders(ids);
    const specs = [
      [state, "threads", `id IN (${idList})`, ids],
      [state, "thread_spawn_edges", `parent_thread_id IN (${idList}) OR child_thread_id IN (${idList})`, [...ids, ...ids]],
      [state, "thread_artifacts", `thread_id IN (${idList})`, ids],
      [state, "thread_dynamic_tools", `thread_id IN (${idList})`, ids],
      [history, "thread_turns", `thread_id IN (${idList})`, ids],
      [history, "thread_items", `thread_id IN (${idList})`, ids],
      [history, "thread_history_projection_state", `thread_id IN (${idList})`, ids],
      [history, "thread_realtime_items", `thread_id IN (${idList})`, ids],
      [logs, "logs", `thread_id IN (${idList})`, ids],
      [catalog, "local_thread_catalog", `host_id = 'local' AND thread_id IN (${idList})`, ids],
      [catalog, "thread_timeline_ledger", `host_id = 'local' AND thread_id IN (${idList})`, ids],
      [catalog, "inbox_items", `thread_id IN (${idList})`, ids],
      [catalog, "automation_runs", `thread_id IN (${idList})`, ids],
      [catalog, "local_thread_catalog_metadata", "id = 1", []],
    ];
    for (const [database, table, where, parameters] of specs) {
      const target = path.join(BACKUP_ROOT, "database-rows", `${table}.jsonl.gz`);
      archives.push({ table, ...(await writeRowsGzip(target, selectedRows(database, table, where, parameters))) });
    }
  } finally {
    state.close();
    history.close();
    logs.close();
    catalog.close();
  }
  return archives;
}

async function archiveRollouts(threads) {
  const allowedRoots = [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];
  const archived = [];
  const missing = [];
  for (const thread of threads) {
    if (!thread.rollout_path || !fs.existsSync(thread.rollout_path)) {
      missing.push({ threadId: thread.id, originalPath: thread.rollout_path });
      continue;
    }
    const source = assertInside(thread.rollout_path, allowedRoots);
    const target = path.join(BACKUP_ROOT, "rollouts", `${thread.id}.jsonl.gz`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sourceSha256 = hashFile(source);
    await pipeline(fs.createReadStream(source), createGzip({ level: 9 }), fs.createWriteStream(target, { flags: "wx" }));
    const restoredSha256 = await hashGunzip(target);
    if (sourceSha256 !== restoredSha256) throw new Error(`Rollout archive verification failed: ${source}`);
    archived.push({
      threadId: thread.id,
      originalPath: source,
      archivePath: target,
      originalBytes: fs.statSync(source).size,
      archiveBytes: fs.statSync(target).size,
      sourceSha256,
    });
  }
  return { archived, missing };
}

async function archiveSessionIndex(ids) {
  const source = path.join(CODEX_HOME, "session_index.jsonl");
  if (!fs.existsSync(source)) return null;
  const target = path.join(BACKUP_ROOT, "session_index.jsonl.gz");
  await pipeline(fs.createReadStream(source), createGzip({ level: 9 }), fs.createWriteStream(target, { flags: "wx" }));
  return { path: target, bytes: fs.statSync(target).size, sha256: hashFile(target), targetIds: ids.length };
}

function deleteDatabaseRows(ids) {
  const idList = placeholders(ids);
  const results = {};
  const run = (name, databasePath, statements) => {
    const database = openDatabase(databasePath, false);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        results[name] = {};
        for (const [label, sql, parameters] of statements) {
          results[name][label] = Number(database.prepare(sql).run(...parameters).changes ?? 0);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      database.exec("PRAGMA optimize");
      results[name].quickCheck = database.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown";
      if (COMPACT) database.exec("VACUUM");
    } finally {
      database.close();
    }
  };
  run("history", DATABASES.history, [
    ["realtimeItems", `DELETE FROM thread_realtime_items WHERE thread_id IN (${idList})`, ids],
    ["items", `DELETE FROM thread_items WHERE thread_id IN (${idList})`, ids],
    ["turns", `DELETE FROM thread_turns WHERE thread_id IN (${idList})`, ids],
    ["projectionRows", `DELETE FROM thread_history_projection_state WHERE thread_id IN (${idList})`, ids],
  ]);
  run("logs", DATABASES.logs, [
    ["rows", `DELETE FROM logs WHERE thread_id IN (${idList})`, ids],
  ]);
  run("state", DATABASES.state, [
    ["spawnEdges", `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${idList}) OR child_thread_id IN (${idList})`, [...ids, ...ids]],
    ["artifacts", `DELETE FROM thread_artifacts WHERE thread_id IN (${idList})`, ids],
    ["dynamicTools", `DELETE FROM thread_dynamic_tools WHERE thread_id IN (${idList})`, ids],
    ["threads", `DELETE FROM threads WHERE id IN (${idList})`, ids],
  ]);
  run("catalog", DATABASES.catalog, [
    ["timelineRows", `DELETE FROM thread_timeline_ledger WHERE host_id = 'local' AND thread_id IN (${idList})`, ids],
    ["inboxRows", `DELETE FROM inbox_items WHERE thread_id IN (${idList})`, ids],
    ["automationRuns", `DELETE FROM automation_runs WHERE thread_id IN (${idList})`, ids],
    ["rows", `DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id IN (${idList})`, ids],
    ["catalogRevision", "UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1", []],
  ]);
  return results;
}

function rewriteSessionIndex(ids) {
  const source = path.join(CODEX_HOME, "session_index.jsonl");
  if (!fs.existsSync(source)) return { removed: 0 };
  const idSet = new Set(ids);
  const lines = fs.readFileSync(source, "utf8").split(/\r?\n/);
  let removed = 0;
  const kept = lines.filter((line) => {
    if (!line.trim()) return false;
    try {
      if (idSet.has(JSON.parse(line).id)) {
        removed += 1;
        return false;
      }
    } catch {
      // Preserve malformed historical rows rather than widening the cleanup.
    }
    return true;
  });
  const temporary = `${source}.agent-cleanup.tmp`;
  fs.writeFileSync(temporary, `${kept.join("\n")}\n`, "utf8");
  fs.renameSync(temporary, source);
  return { removed };
}

function removeRollouts(archived) {
  for (const row of archived) {
    assertInside(row.originalPath, [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")]);
    if (fs.existsSync(row.originalPath)) fs.rmSync(row.originalPath, { force: true });
  }
  return archived.length;
}

const threads = targetThreads();
const before = inspect(threads);
if (!APPLY) {
  process.stdout.write(`${JSON.stringify({ mode: "dry-run", compact: COMPACT, includeSubagents: INCLUDE_SUBAGENTS, backupRoot: BACKUP_ROOT, before }, null, 2)}\n`);
  process.exit(0);
}
if (threads.length === 0) {
  process.stdout.write(`${JSON.stringify({ mode: "apply", changed: false, before }, null, 2)}\n`);
  process.exit(0);
}

assertInside(BACKUP_ROOT, [BACKUP_PARENT]);
fs.mkdirSync(BACKUP_ROOT, { recursive: false });
const ids = threads.map((row) => row.id);
const databaseRows = await archiveDatabaseRows(ids);
const rollouts = await archiveRollouts(threads);
const sessionIndex = await archiveSessionIndex(ids);
const preparedManifest = {
  version: 1,
  status: "backup_verified_before_delete",
  createdAt: new Date().toISOString(),
  codexHome: CODEX_HOME,
  selection: before.selection,
  before,
  databaseRows,
  rollouts,
  sessionIndex,
};
fs.writeFileSync(path.join(BACKUP_ROOT, "manifest.json"), `${JSON.stringify(preparedManifest, null, 2)}\n`, "utf8");

const deleted = deleteDatabaseRows(ids);
const rewrittenIndex = rewriteSessionIndex(ids);
const removedRolloutFiles = removeRollouts(rollouts.archived);
const remaining = inspect(targetThreads());
const report = {
  ...preparedManifest,
  status: "completed",
  completedAt: new Date().toISOString(),
  compacted: COMPACT,
  deleted,
  rewrittenIndex,
  removedRolloutFiles,
  remaining,
};
if (remaining.threadCount !== 0) throw new Error(`Cleanup incomplete: ${remaining.threadCount} Agent threads remain`);
fs.writeFileSync(path.join(BACKUP_ROOT, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  mode: "apply",
  backupRoot: BACKUP_ROOT,
  removedThreads: deleted.state.threads,
  removedHistoryItems: deleted.history.items,
  removedLogRows: deleted.logs.rows,
  removedRolloutFiles,
  missingRolloutFiles: rollouts.missing.length,
  quickCheck: {
    state: deleted.state.quickCheck,
    history: deleted.history.quickCheck,
    logs: deleted.logs.quickCheck,
    catalog: deleted.catalog.quickCheck,
  },
  removedCatalogRows: deleted.catalog.rows,
  compacted: COMPACT,
  remainingThreads: remaining.threadCount,
}, null, 2)}\n`);
