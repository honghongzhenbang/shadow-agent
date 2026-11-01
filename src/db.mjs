import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureDirectory, nowIso, sha256, stableJson } from "./utils.mjs";
import { contextGraphStats, initializeContextGraph } from "./context-graph.mjs";
import { bindWorkSessionForDatabase, workSessionByKeyForDatabase } from "./work-sessions.mjs";
import {
  ensureCanonicalSourceStorage,
  querySourceRecords,
  sourceRecordForEvidence,
  writeCanonicalSourceRecord,
} from "./source-records.mjs";

const SEARCH_INDEX_VERSION = "selective-external-v4";
const SEARCHABLE_EVIDENCE_KINDS = [
  "codex_user_message",
  "codex_agent_message",
  "codex_turn_summary",
  "codex_compaction_summary",
  "codex_memory_document",
  "manual_knowledge",
  "codex_thread_digest",
  "git_history_digest",
  "project_document_digest",
  "git_repository_snapshot",
  "project_document",
  "import_document",
  "feishu_message",
  "feishu_approval_task",
  "feishu_task",
  "feishu_document_index",
  "feishu_document_content",
  "shadow_agent_task_result",
  "shadow_reminder_delivery",
  "feishu_outbound_message",
];
const SEARCHABLE_KINDS_SQL = SEARCHABLE_EVIDENCE_KINDS.map((kind) => `'${kind}'`).join(",");
const THREAD_DIGEST_INPUT_KINDS = new Set([
  "codex_user_message",
  "codex_agent_message",
  "codex_turn_summary",
  "codex_compaction_summary",
  "codex_patch_result",
  "codex_tool_call",
  "codex_tool_output",
  "codex_tool_result",
]);
const IMMEDIATE_THREAD_DIGEST_REASONS = new Set([
  "new_codex_user_message",
  "new_codex_turn_summary",
  "new_codex_compaction_summary",
]);

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function boundedText(value, maximum = 4000) {
  return String(value ?? "").trim().slice(0, maximum);
}

function readableMessageContent(value, depth = 0) {
  if (value == null || depth > 3) return "";
  if (typeof value === "object") {
    for (const key of ["text", "content", "message", "body"]) {
      if (value[key] != null) {
        const nested = readableMessageContent(value[key], depth + 1);
        if (nested) return nested;
      }
    }
    return boundedText(stableJson(value));
  }
  const text = boundedText(value);
  if (!text || !/^[\[{]/.test(text)) return text;
  const parsed = parseJson(text, null);
  return parsed == null ? text : readableMessageContent(parsed, depth + 1) || text;
}

function normalizeReviewMessage(input, fallbackDirection = "incoming") {
  if (!input || typeof input !== "object") return null;
  const content = readableMessageContent(input.content ?? input.text ?? input.body);
  if (!content) return null;
  return {
    direction: input.direction === "outgoing" ? "outgoing" : fallbackDirection,
    senderName: boundedText(input.senderName ?? input.sender_name ?? "", 200),
    content,
    occurredAt: boundedText(input.occurredAt ?? input.occurred_at ?? "", 80),
    messageId: boundedText(input.messageId ?? input.message_id ?? "", 200),
  };
}

function normalizeOutboundReviewContext(input = {}, capturedAt = nowIso()) {
  const source = typeof input === "string" ? { summary: input } : (input ?? {});
  const trigger = normalizeReviewMessage(source.trigger);
  const recentMessages = (Array.isArray(source.recentMessages) ? source.recentMessages : [])
    .map((item) => normalizeReviewMessage(item))
    .filter(Boolean)
    .slice(-8);
  const basis = source.basis && typeof source.basis === "object" ? source.basis : {};
  return {
    schemaVersion: 1,
    capturedAt: boundedText(source.capturedAt ?? capturedAt, 80),
    summary: boundedText(source.summary ?? source.contextSummary ?? ""),
    trigger,
    recentMessages,
    basis: {
      reason: boundedText(basis.reason ?? source.reason ?? "", 2000),
      sourceLocator: boundedText(basis.sourceLocator ?? source.sourceLocator ?? "", 4000),
      evidenceIds: [...new Set(basis.evidenceIds ?? source.evidenceIds ?? [])].map(String).slice(0, 30),
      sessionKey: boundedText(basis.sessionKey ?? source.sessionKey ?? "", 1000),
    },
  };
}

function reviewContextHasContent(context) {
  return Boolean(context?.trigger || context?.recentMessages?.length || context?.summary);
}

function outboundAudit(row, event, details = {}) {
  const metadata = parseJson(row?.metadata_json, {});
  return {
    ...metadata,
    audit: [
      ...(Array.isArray(metadata.audit) ? metadata.audit : []),
      { event, at: nowIso(), ...details },
    ].slice(-100),
  };
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  cursor_bytes INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  last_error TEXT,
  last_seen_at TEXT NOT NULL,
  last_collected_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  rollout_path TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  project_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  indexed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source_id, path),
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT,
  collected_at TEXT NOT NULL,
  project_key TEXT,
  thread_id TEXT,
  role TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  external_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS evidence_collected_idx ON evidence(collected_at DESC);
CREATE INDEX IF NOT EXISTS evidence_occurred_idx ON evidence(occurred_at DESC);
CREATE INDEX IF NOT EXISTS evidence_project_idx ON evidence(project_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS evidence_thread_idx ON evidence(thread_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS evidence_kind_project_collected_idx ON evidence(kind, project_key, collected_at DESC);
CREATE INDEX IF NOT EXISTS evidence_thread_kind_occurred_idx ON evidence(thread_id, kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS evidence_kind_external_id_idx ON evidence(kind, external_id);
CREATE INDEX IF NOT EXISTS evidence_conversation_stream_idx ON evidence(
  kind,
  CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.conversationKey') END,
  occurred_at DESC
);
DROP INDEX IF EXISTS evidence_git_repo_idx;
CREATE INDEX IF NOT EXISTS evidence_git_repo_safe_idx ON evidence(
  kind,
  CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.repoPath') END
);

CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  risk_level TEXT NOT NULL DEFAULT 'read',
  action_type TEXT NOT NULL DEFAULT 'investigate',
  domain TEXT NOT NULL DEFAULT 'user_work',
  project_key TEXT,
  source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_review_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, priority, updated_at);

CREATE TABLE IF NOT EXISTS patrol_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  codex_thread_id TEXT,
  summary TEXT,
  no_action_reason TEXT,
  raw_response TEXT,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS patrol_evidence (
  patrol_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(patrol_id, evidence_id),
  FOREIGN KEY(patrol_id) REFERENCES patrol_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS patrol_evidence_evidence_idx ON patrol_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS evidence_links (
  parent_evidence_id TEXT NOT NULL,
  child_evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(parent_evidence_id, child_evidence_id, relation),
  FOREIGN KEY(parent_evidence_id) REFERENCES evidence(id) ON DELETE CASCADE,
  FOREIGN KEY(child_evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS evidence_links_child_idx ON evidence_links(child_evidence_id);

CREATE TABLE IF NOT EXISTS action_log (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT,
  action_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  command_summary TEXT,
  result TEXT,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS controller_turn_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  session_hash TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  prompt_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  assistant_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_names_json TEXT NOT NULL DEFAULT '{}',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  history_complete INTEGER NOT NULL DEFAULT 1,
  budget_status TEXT NOT NULL DEFAULT 'within_budget',
  budget_flags_json TEXT NOT NULL DEFAULT '[]',
  error TEXT
);

CREATE INDEX IF NOT EXISTS controller_turn_metrics_time_idx
  ON controller_turn_metrics(completed_at DESC);
CREATE INDEX IF NOT EXISTS controller_turn_metrics_budget_idx
  ON controller_turn_metrics(budget_status, completed_at DESC);

CREATE TABLE IF NOT EXISTS digest_queue (
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY(entity_type, entity_key)
);

CREATE INDEX IF NOT EXISTS digest_queue_order_idx ON digest_queue(queued_at, entity_type, entity_key);

CREATE TABLE IF NOT EXISTS external_event_receipts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  conversation_key TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  processing_started_at TEXT,
  next_attempt_at TEXT,
  updated_at TEXT,
  last_error TEXT,
  evidence_id TEXT,
  response_external_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS external_event_status_idx
  ON external_event_receipts(status, last_received_at);

CREATE TABLE IF NOT EXISTS conversation_bindings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_kind TEXT NOT NULL DEFAULT 'conversation',
  generation INTEGER NOT NULL DEFAULT 1,
  context_epoch TEXT NOT NULL DEFAULT '1',
  checkpoint_evidence_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  task_id TEXT,
  created_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  last_dispatched_at TEXT,
  last_completed_at TEXT,
  last_message_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(provider, conversation_key)
);

CREATE INDEX IF NOT EXISTS conversation_session_idx
  ON conversation_bindings(session_key);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_schedule',
  source_locator TEXT,
  source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  explicit INTEGER NOT NULL DEFAULT 1,
  cron_job_id TEXT,
  parent_reminder_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notification_started_at TEXT,
  delivered_at TEXT,
  acknowledged_at TEXT,
  cancelled_at TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(parent_reminder_id) REFERENCES reminders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS reminders_status_due_idx ON reminders(status, due_at);

CREATE TABLE IF NOT EXISTS condition_watches (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  condition_text TEXT NOT NULL,
  selector_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  baseline_evidence_rowid INTEGER NOT NULL DEFAULT 0,
  last_evidence_rowid INTEGER NOT NULL DEFAULT 0,
  candidate_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  task_id TEXT,
  conversation_provider TEXT,
  conversation_key TEXT,
  session_key TEXT NOT NULL DEFAULT 'agent:main:shadow-events',
  timeout_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  candidate_at TEXT,
  resolved_at TEXT,
  last_error TEXT,
  resolution_note TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS condition_watches_status_idx
  ON condition_watches(status, timeout_at, updated_at);

CREATE TABLE IF NOT EXISTS direct_input_receipts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  evidence_id TEXT NOT NULL UNIQUE,
  session_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  response_text TEXT,
  created_task_ids_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS direct_input_receipts_status_idx
  ON direct_input_receipts(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function rebuildEvidenceSearchIndex(db) {
  db.exec(`
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS evidence_search_ai;
    DROP TRIGGER IF EXISTS evidence_search_ad;
    DROP TRIGGER IF EXISTS evidence_search_au_delete;
    DROP TRIGGER IF EXISTS evidence_search_au_insert;
    DROP TABLE IF EXISTS evidence_fts;
    CREATE VIRTUAL TABLE evidence_fts USING fts5(
      title,
      content,
      content='evidence',
      content_rowid='rowid',
      tokenize='unicode61'
    );
    CREATE TRIGGER evidence_search_ai AFTER INSERT ON evidence
    WHEN new.kind IN (${SEARCHABLE_KINDS_SQL}) BEGIN
      INSERT INTO evidence_fts(rowid, title, content) VALUES(new.rowid, new.title, new.content);
    END;
    CREATE TRIGGER evidence_search_ad AFTER DELETE ON evidence
    WHEN old.kind IN (${SEARCHABLE_KINDS_SQL}) BEGIN
      INSERT INTO evidence_fts(evidence_fts, rowid, title, content)
      VALUES('delete', old.rowid, old.title, old.content);
    END;
    CREATE TRIGGER evidence_search_au_delete AFTER UPDATE OF title, content, kind ON evidence
    WHEN old.kind IN (${SEARCHABLE_KINDS_SQL}) BEGIN
      INSERT INTO evidence_fts(evidence_fts, rowid, title, content)
      VALUES('delete', old.rowid, old.title, old.content);
    END;
    CREATE TRIGGER evidence_search_au_insert AFTER UPDATE OF title, content, kind ON evidence
    WHEN new.kind IN (${SEARCHABLE_KINDS_SQL}) BEGIN
      INSERT INTO evidence_fts(rowid, title, content) VALUES(new.rowid, new.title, new.content);
    END;
    INSERT INTO evidence_fts(rowid, title, content)
      SELECT rowid, title, content FROM evidence WHERE kind IN (${SEARCHABLE_KINDS_SQL});
    INSERT INTO settings(key, value, updated_at)
      VALUES('search:index:version', '${SEARCH_INDEX_VERSION}', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
    COMMIT;
  `);
}

function ensureEvidenceSearchIndex(db) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence_fts'").get()?.sql ?? "";
  const version = db.prepare("SELECT value FROM settings WHERE key='search:index:version'").get()?.value ?? "";
  if (!schema.includes("content='evidence'") || version !== SEARCH_INDEX_VERSION) rebuildEvidenceSearchIndex(db);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrateDatabase(db) {
  ensureColumn(db, "work_task_attention", "checkpoint_revision", "checkpoint_revision INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "domain", "domain TEXT NOT NULL DEFAULT 'user_work'");
  ensureColumn(db, "conversation_bindings", "session_kind", "session_kind TEXT NOT NULL DEFAULT 'conversation'");
  ensureColumn(db, "conversation_bindings", "generation", "generation INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "conversation_bindings", "context_epoch", "context_epoch TEXT NOT NULL DEFAULT '1'");
  ensureColumn(db, "conversation_bindings", "checkpoint_evidence_id", "checkpoint_evidence_id TEXT");
  ensureColumn(db, "conversation_bindings", "status", "status TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "conversation_bindings", "last_dispatched_at", "last_dispatched_at TEXT");
  ensureColumn(db, "conversation_bindings", "last_completed_at", "last_completed_at TEXT");
  ensureColumn(db, "reminders", "revision", "revision INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "reminders", "notification_started_at", "notification_started_at TEXT");
  ensureColumn(db, "reminders", "cancelled_at", "cancelled_at TEXT");
  ensureColumn(db, "outbound_message_drafts", "task_id", "task_id TEXT");
  ensureColumn(db, "external_event_receipts", "processing_started_at", "processing_started_at TEXT");
  ensureColumn(db, "external_event_receipts", "next_attempt_at", "next_attempt_at TEXT");
  ensureColumn(db, "external_event_receipts", "updated_at", "updated_at TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS external_event_retry_idx
      ON external_event_receipts(status, next_attempt_at, processing_started_at)
  `);
  db.exec("CREATE INDEX IF NOT EXISTS tasks_domain_status_idx ON tasks(domain, status, priority, updated_at)");
  db.exec("CREATE INDEX IF NOT EXISTS conversation_kind_status_idx ON conversation_bindings(session_kind, status, last_event_at)");
  const migrationKey = "migration:task-domain:v1";
  const migrated = db.prepare("SELECT value FROM settings WHERE key=?").get(migrationKey)?.value === "done";
  if (!migrated) {
    db.exec(`
      UPDATE tasks
      SET domain='agent_maintenance'
      WHERE lower(title || ' ' || description || ' ' || action_type) LIKE '%shadow agent%'
         OR title || ' ' || description LIKE '%影子 Agent%'
         OR title || ' ' || description LIKE '%影子Agent%'
         OR lower(title || ' ' || description) LIKE '%lark-cli%'
         OR action_type IN ('authorize_feishu', 'repair_agent', 'agent_maintenance');
    `);
    db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES(?, 'done', ?)
      ON CONFLICT(key) DO UPDATE SET value='done', updated_at=excluded.updated_at
    `).run(migrationKey, nowIso());
  }

  const maintenanceV2 = "migration:task-domain:v2";
  const migratedV2 = db.prepare("SELECT value FROM settings WHERE key=?").get(maintenanceV2)?.value === "done";
  if (!migratedV2) {
    db.exec(`
      UPDATE tasks
      SET domain='agent_maintenance'
      WHERE lower(title || ' ' || description) LIKE '%shadow-agent%'
         OR lower(title || ' ' || description) LIKE '%shadow_agent%';
      UPDATE tasks
      SET domain='personal_admin'
      WHERE title LIKE '%ChatGPT 桌面端%';
    `);
    db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES(?, 'done', ?)
      ON CONFLICT(key) DO UPDATE SET value='done', updated_at=excluded.updated_at
    `).run(maintenanceV2, nowIso());
  }

  const domainV3 = "migration:task-domain:v3";
  const migratedV3 = db.prepare("SELECT value FROM settings WHERE key=?").get(domainV3)?.value === "done";
  if (!migratedV3) {
    db.exec(`
      UPDATE tasks
      SET domain='user_work'
      WHERE action_type LIKE '%daily_report%'
         OR action_type LIKE '%weekly_report%';
    `);
    db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES(?, 'done', ?)
      ON CONFLICT(key) DO UPDATE SET value='done', updated_at=excluded.updated_at
    `).run(domainV3, nowIso());
  }
}

export function openDatabase(databasePath) {
  ensureDirectory(path.dirname(databasePath));
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(SCHEMA);
    initializeContextGraph(db);
    migrateDatabase(db);
    ensureCanonicalSourceStorage(db);
    ensureEvidenceSearchIndex(db);
    return new ShadowStore(db);
  } catch (error) {
    // The caller never received this handle; closing also rolls back unfinished initialization.
    try { db.close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Database initialization and connection cleanup failed", { cause: error });
    }
    throw error;
  }
}

export function openDatabaseReadOnly(databasePath) {
  return new ShadowStore(new DatabaseSync(databasePath, { readOnly: true }), { readOnly: true });
}

export class ShadowStore {
  constructor(db, { readOnly = false } = {}) {
    this.db = db;
    this.readOnly = readOnly;
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertSource({ sourceKey, kind, uri, sizeBytes = 0, mtimeMs = 0, status = "ready", lastError = null, metadata = {} }) {
    const existing = this.getSource(sourceKey);
    const id = existing?.id ?? sha256(`source:${sourceKey}`).slice(0, 32);
    this.db.prepare(`
      INSERT INTO sources(id, source_key, kind, uri, cursor_bytes, size_bytes, mtime_ms, status, last_error, last_seen_at, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        kind=excluded.kind, uri=excluded.uri, size_bytes=excluded.size_bytes,
        mtime_ms=excluded.mtime_ms, status=excluded.status, last_error=excluded.last_error,
        last_seen_at=excluded.last_seen_at, metadata_json=excluded.metadata_json
    `).run(
      id,
      sourceKey,
      kind,
      uri,
      existing?.cursor_bytes ?? 0,
      sizeBytes,
      mtimeMs,
      status,
      lastError,
      nowIso(),
      stableJson(metadata),
    );
    return this.getSource(sourceKey);
  }

  getSource(sourceKey) {
    return this.db.prepare("SELECT * FROM sources WHERE source_key = ?").get(sourceKey) ?? null;
  }

  updateSourceCursor(sourceKey, { cursorBytes, sizeBytes, mtimeMs, status = "ready", lastError = null }) {
    this.db.prepare(`
      UPDATE sources SET cursor_bytes=?, size_bytes=?, mtime_ms=?, status=?, last_error=?,
        last_collected_at=?, last_seen_at=? WHERE source_key=?
    `).run(cursorBytes, sizeBytes, mtimeMs, status, lastError, nowIso(), nowIso(), sourceKey);
  }

  markSourceError(sourceKey, error) {
    this.db.prepare("UPDATE sources SET status='error', last_error=?, last_seen_at=? WHERE source_key=?")
      .run(String(error), nowIso(), sourceKey);
  }

  upsertProject({ projectKey, name, rootPath, source = "codex", metadata = {} }) {
    const id = sha256(`project:${projectKey}`).slice(0, 32);
    this.db.prepare(`
      INSERT INTO projects(id, project_key, name, root_path, source, updated_at, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET name=excluded.name, root_path=excluded.root_path,
        source=excluded.source, updated_at=excluded.updated_at, metadata_json=excluded.metadata_json
    `).run(id, projectKey, name, rootPath, source, nowIso(), stableJson(metadata));
    return id;
  }

  upsertThread(thread) {
    const existing = this.db.prepare("SELECT title, cwd, project_key FROM threads WHERE id=?").get(thread.id) ?? null;
    const title = thread.title ?? "";
    const cwd = thread.cwd ?? "";
    const projectKey = thread.projectKey ?? null;
    this.db.prepare(`
      INSERT INTO threads(id, title, cwd, rollout_path, created_at_ms, updated_at_ms, archived, project_key, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, cwd=excluded.cwd,
        rollout_path=excluded.rollout_path, created_at_ms=excluded.created_at_ms,
        updated_at_ms=excluded.updated_at_ms, archived=excluded.archived,
        project_key=excluded.project_key, metadata_json=excluded.metadata_json
    `).run(
      thread.id,
      title,
      cwd,
      thread.rolloutPath ?? "",
      thread.createdAtMs ?? 0,
      thread.updatedAtMs ?? 0,
      thread.archived ? 1 : 0,
      projectKey,
      stableJson(thread.metadata ?? {}),
    );
    if (existing && (existing.title !== title || existing.cwd !== cwd || existing.project_key !== projectKey)) {
      this.enqueueDigest("thread", thread.id, "thread_metadata_changed");
    }
  }

  upsertArtifact({ sourceId, artifactPath, kind, sizeBytes = 0, mtimeMs = 0, contentHash = null, metadata = {} }) {
    const id = sha256(`artifact:${sourceId}:${artifactPath}`).slice(0, 32);
    const previous = this.db.prepare("SELECT * FROM artifacts WHERE source_id=? AND path=?").get(sourceId, artifactPath) ?? null;
    this.db.prepare(`
      INSERT INTO artifacts(id, source_id, path, kind, size_bytes, mtime_ms, content_hash, indexed_at, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, path) DO UPDATE SET kind=excluded.kind, size_bytes=excluded.size_bytes,
        mtime_ms=excluded.mtime_ms, content_hash=excluded.content_hash,
        indexed_at=excluded.indexed_at, metadata_json=excluded.metadata_json
    `).run(id, sourceId, artifactPath, kind, sizeBytes, mtimeMs, contentHash, nowIso(), stableJson(metadata));
    return { id, previous, changed: !previous || previous.content_hash !== contentHash || previous.mtime_ms !== mtimeMs || previous.size_bytes !== sizeBytes };
  }

  addEvidence(input) {
    this.db.exec("SAVEPOINT add_evidence_record");
    try {
      const result = this.addEvidenceRecord(input);
      this.db.exec("RELEASE SAVEPOINT add_evidence_record");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK TO SAVEPOINT add_evidence_record"); } catch { /* savepoint already closed */ }
      try { this.db.exec("RELEASE SAVEPOINT add_evidence_record"); } catch { /* savepoint already closed */ }
      throw error;
    }
  }

  addEvidenceRecord(input) {
    const fingerprint = input.fingerprint ?? sha256(stableJson({
      sourceId: input.sourceId,
      kind: input.kind,
      externalId: input.externalId,
      locator: input.sourceLocator,
      content: input.content,
    }));
    const existing = this.db.prepare("SELECT id, occurred_at FROM evidence WHERE fingerprint=?").get(fingerprint);
    if (existing) {
      if (!existing.occurred_at && input.occurredAt) {
        this.db.prepare("UPDATE evidence SET occurred_at=? WHERE id=?").run(input.occurredAt, existing.id);
      }
      writeCanonicalSourceRecord(this.db, existing.id);
      return { id: existing.id, inserted: false };
    }
    const id = sha256(`evidence:${fingerprint}`).slice(0, 32);
    this.db.prepare(`
      INSERT INTO evidence(id, fingerprint, source_id, kind, occurred_at, collected_at,
        project_key, thread_id, role, title, content, source_locator, external_id, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fingerprint,
      input.sourceId,
      input.kind,
      input.occurredAt ?? null,
      nowIso(),
      input.projectKey ?? null,
      input.threadId ?? null,
      input.role ?? null,
      input.title ?? "",
      input.content ?? "",
      input.sourceLocator,
      input.externalId ?? null,
      stableJson(input.metadata ?? {}),
    );
    writeCanonicalSourceRecord(this.db, id);
    if (THREAD_DIGEST_INPUT_KINDS.has(input.kind) && input.threadId) {
      this.enqueueDigest("thread", input.threadId, `new_${input.kind}`);
    } else if (input.kind === "git_commit" && input.metadata?.repoPath) {
      this.enqueueDigest("git", input.metadata.repoPath, "new_git_commit");
    } else if (input.kind === "project_document" && input.projectKey) {
      this.enqueueDigest("project_documents", input.projectKey, "new_project_document");
    }
    return { id, inserted: true };
  }

  refreshSourceRecord(evidenceId) {
    return writeCanonicalSourceRecord(this.db, evidenceId);
  }

  enqueueDigest(entityType, entityKey, reason = "changed") {
    if (!entityType || !entityKey) return;
    this.db.prepare(`
      INSERT INTO digest_queue(entity_type, entity_key, queued_at, reason, attempts, last_error)
      VALUES(?, ?, ?, ?, 0, NULL)
      ON CONFLICT(entity_type, entity_key) DO UPDATE SET
        queued_at=excluded.queued_at, reason=excluded.reason, attempts=0, last_error=NULL
    `).run(String(entityType), String(entityKey), nowIso(), String(reason));
  }

  pendingDigestTargets(limit = 30, { threadQuietSeconds = 0, now = new Date() } = {}) {
    const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
    if (!boundedLimit) return [];
    const quietSeconds = Math.max(0, Math.floor(Number(threadQuietSeconds) || 0));
    const quietBefore = new Date(now.getTime() - quietSeconds * 1000).toISOString();
    const immediateReasons = [...IMMEDIATE_THREAD_DIGEST_REASONS];
    const placeholders = immediateReasons.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT entity_type, entity_key, queued_at, reason, attempts, last_error
      FROM digest_queue
      WHERE entity_type <> 'thread'
         OR reason IN (${placeholders})
         OR queued_at <= ?
      ORDER BY queued_at, entity_type, entity_key
      LIMIT ?
    `).all(...immediateReasons, quietBefore, boundedLimit);
  }

  finalizeThreadDigestGeneration(threadId, digestHash, currentEvidenceId) {
    const oldRows = this.db.prepare(`
      SELECT e.id,
        EXISTS(SELECT 1 FROM graph_fact_evidence gfe WHERE gfe.evidence_id=e.id)
          OR EXISTS(SELECT 1 FROM graph_evidence_assessments gea WHERE gea.evidence_id=e.id)
          AS preserves_fact_provenance
      FROM evidence e
      WHERE e.thread_id=? AND e.kind='codex_thread_digest'
        AND COALESCE(json_extract(e.metadata_json,'$.digestHash'),'') <> ?
    `).all(threadId, digestHash);
    if (!oldRows.length) return { archived: 0, deleted: 0 };

    const archivedIds = oldRows.filter((row) => row.preserves_fact_provenance).map((row) => row.id);
    const deletedIds = oldRows.filter((row) => !row.preserves_fact_provenance).map((row) => row.id);
    const archive = this.db.prepare(`
      UPDATE evidence
      SET kind='codex_thread_digest_archive',
          metadata_json=json_set(
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
            '$.archivedAt', ?, '$.archiveReason', 'retained_fact_provenance'
          )
      WHERE id=?
    `);
    const remove = this.db.prepare("DELETE FROM evidence WHERE id=?");
    this.transaction(() => {
      for (const id of archivedIds) archive.run(nowIso(), id);
      for (const id of deletedIds) remove.run(id);
    });
    if (currentEvidenceId && archivedIds.length) {
      this.linkEvidence(currentEvidenceId, archivedIds, "supersedes");
    }
    return { archived: archivedIds.length, deleted: deletedIds.length };
  }

  completeDigestTarget(entityType, entityKey) {
    this.db.prepare("DELETE FROM digest_queue WHERE entity_type=? AND entity_key=?").run(entityType, entityKey);
  }

  failDigestTarget(entityType, entityKey, error) {
    this.db.prepare(`
      UPDATE digest_queue
      SET attempts=attempts+1, last_error=?, queued_at=?
      WHERE entity_type=? AND entity_key=?
    `).run(String(error), nowIso(), entityType, entityKey);
  }

  digestQueueCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM digest_queue").get().count);
  }

  searchEvidence(query, limit = 50) {
    const terms = String(query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 12);
    if (!terms.length) return [];
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    return this.db.prepare(`
      SELECT e.*, bm25(evidence_fts) AS rank
      FROM evidence_fts
      JOIN evidence e ON e.rowid=evidence_fts.rowid
      WHERE evidence_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(expression, limit);
  }

  sourceRecord(evidenceId) {
    return sourceRecordForEvidence(this.db, evidenceId);
  }

  querySourceRecords(options = {}) {
    return querySourceRecords(this.db, options);
  }

  compactRawTraces(maxChars = 2600) {
    const headChars = Math.max(400, Math.floor(maxChars * 0.7));
    const tailChars = Math.max(400, maxChars - headChars);
    const result = this.db.prepare(`
      UPDATE evidence
      SET content = substr(content, 1, ?) || char(10) ||
        '...[middle omitted by storage migration; inspect source locator]...' || char(10) ||
        substr(content, -?)
      WHERE kind IN ('codex_tool_call','codex_tool_output','codex_tool_result','codex_patch_result')
        AND length(content) > ?
    `).run(headChars, tailChars, maxChars + 200);
    return Number(result.changes ?? 0);
  }

  optimizeStorage({ maxTraceChars = 2600, vacuum = false } = {}) {
    const compactedRawTraces = this.compactRawTraces(maxTraceChars);
    this.db.exec("PRAGMA optimize");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (vacuum) this.db.exec("VACUUM");
    return { compactedRawTraces, vacuum };
  }

  addKnowledgeCandidate(input) {
    const evidenceIds = [...new Set(input.evidenceIds ?? [])].sort();
    const fingerprint = sha256(stableJson({ category: input.category, subject: input.subject, statement: input.statement }));
    const id = sha256(`knowledge:${fingerprint}`).slice(0, 32);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO knowledge_candidates(id, fingerprint, category, subject, statement, confidence,
        status, evidence_ids_json, created_at, updated_at, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET confidence=MAX(confidence, excluded.confidence),
        evidence_ids_json=excluded.evidence_ids_json, updated_at=excluded.updated_at,
        metadata_json=excluded.metadata_json
    `).run(
      id,
      fingerprint,
      input.category,
      input.subject,
      input.statement,
      Number(input.confidence ?? 0.5),
      input.status ?? "candidate",
      JSON.stringify(evidenceIds),
      timestamp,
      timestamp,
      stableJson(input.metadata ?? {}),
    );
    return id;
  }

  addTask(input) {
    const evidenceIds = [...new Set(input.evidenceIds ?? [])].sort();
    const normalizedTitle = String(input.title ?? "").replace(/^继续已有任务[:：]\s*/, "").trim();
    const normalizedActionType = String(input.actionType ?? "investigate").replace(/^continue_/, "");
    const fingerprint = input.fingerprint ?? sha256(stableJson({
      title: normalizedTitle,
      projectKey: input.projectKey ?? null,
      actionType: normalizedActionType,
      domain: input.domain ?? "user_work",
    }));
    const existing = this.db.prepare("SELECT id, status FROM tasks WHERE fingerprint=?").get(fingerprint);
    if (existing) return { id: existing.id, inserted: false, status: existing.status };
    const id = sha256(`task:${fingerprint}`).slice(0, 32);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO tasks(id, fingerprint, title, description, status, priority, risk_level,
        action_type, domain, project_key, source_evidence_ids_json, created_at, updated_at,
        next_review_at, metadata_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fingerprint,
      input.title,
      input.description ?? "",
      input.status ?? "new",
      input.priority ?? "normal",
      input.riskLevel ?? "read",
      input.actionType ?? "investigate",
      input.domain ?? "user_work",
      input.projectKey ?? null,
      JSON.stringify(evidenceIds),
      timestamp,
      timestamp,
      input.nextReviewAt ?? null,
      stableJson(input.metadata ?? {}),
    );
    return { id, inserted: true, status: input.status ?? "new" };
  }

  updateTask(id, changes) {
    const allowed = new Map([
      ["status", "status"],
      ["result", "result"],
      ["lastError", "last_error"],
      ["nextReviewAt", "next_review_at"],
      ["attempts", "attempts"],
      ["domain", "domain"],
    ]);
    const entries = Object.entries(changes).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    const sets = entries.map(([key]) => `${allowed.get(key)}=?`);
    const values = entries.map(([, value]) => value);
    sets.push("updated_at=?");
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...values);
  }

  confirmTaskDone(id, note = "") {
    const task = this.db.prepare("SELECT id, result, metadata_json FROM tasks WHERE id=?").get(id);
    if (!task) return null;
    const timestamp = nowIso();
    const confirmation = String(note ?? "").trim();
    let metadata = {};
    try { metadata = JSON.parse(task.metadata_json || "{}"); } catch { /* preserve a usable empty object */ }
    metadata.manualUpdates = [
      ...(Array.isArray(metadata.manualUpdates) ? metadata.manualUpdates : []),
      { type: "confirmed_done", note: confirmation, at: timestamp, source: "pet-ui" },
    ].slice(-50);
    const result = confirmation
      ? [task.result, `人工确认：${confirmation}`].filter(Boolean).join("\n\n")
      : task.result || "用户确认实际工作已完成。";
    this.db.prepare(`
      UPDATE tasks SET status='done', result=?, last_error=NULL, updated_at=?, metadata_json=?
      WHERE id=?
    `).run(result, timestamp, stableJson(metadata), id);
    const action = this.createAction({
      idempotencyKey: `manual-complete:${id}:${timestamp}`,
      taskId: id,
      actionType: "user_confirm_done",
      riskLevel: "local-write",
      commandSummary: "用户确认任务已完成",
      metadata: { source: "pet-ui" },
    });
    this.finishAction(action.id, {
      status: "completed",
      result: confirmation || "用户确认实际工作已完成。",
      metadata: { source: "pet-ui", userConfirmed: true },
    });
    return this.taskDetails(id);
  }

  updateTaskNextStep(id, nextStep) {
    const task = this.db.prepare("SELECT id, description, status, metadata_json FROM tasks WHERE id=?").get(id);
    const normalized = String(nextStep ?? "").trim();
    if (!task || !normalized) return task ? this.taskDetails(id) : null;
    const timestamp = nowIso();
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const bullet = lines.map((line) => `- ${line}`).join("\n");
    const currentDescription = String(task.description ?? "");
    const description = currentDescription.includes("## 下一步")
      ? `${currentDescription.trim()}\n${bullet}`
      : `${currentDescription.trim()}\n\n## 下一步\n${bullet}`.trim();
    let metadata = {};
    try { metadata = JSON.parse(task.metadata_json || "{}"); } catch { /* preserve a usable empty object */ }
    metadata.nextSteps = [
      ...(Array.isArray(metadata.nextSteps) ? metadata.nextSteps : []),
      { text: normalized, at: timestamp, source: "pet-ui" },
    ].slice(-50);
    const status = ["done", "cancelled", "failed"].includes(task.status) ? "planned" : task.status;
    this.db.prepare(`
      UPDATE tasks SET description=?, status=?, last_error=NULL, updated_at=?, metadata_json=?
      WHERE id=?
    `).run(description, status, timestamp, stableJson(metadata), id);
    const action = this.createAction({
      idempotencyKey: `manual-next-step:${id}:${timestamp}`,
      taskId: id,
      actionType: "user_add_next_step",
      riskLevel: "local-write",
      commandSummary: "用户补充下一步待办",
      metadata: { source: "pet-ui" },
    });
    this.finishAction(action.id, {
      status: "completed",
      result: normalized,
      metadata: { source: "pet-ui", updatedCurrentTask: true },
    });
    return this.taskDetails(id);
  }

  appendTaskEvidence(id, evidenceIds) {
    const row = this.db.prepare("SELECT source_evidence_ids_json FROM tasks WHERE id=?").get(id);
    if (!row) return false;
    const current = JSON.parse(row.source_evidence_ids_json || "[]");
    const merged = [...new Set([...current, ...(evidenceIds ?? [])])].sort();
    this.db.prepare("UPDATE tasks SET source_evidence_ids_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(merged), nowIso(), id);
    return true;
  }

  rebalanceActiveReadTasks(limit = 4) {
    const maximum = Math.max(0, Number(limit) || 0);
    const active = this.db.prepare(`
      SELECT id
      FROM tasks
      WHERE status IN ('new','planned') AND domain='user_work' AND risk_level='read'
      ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at DESC,
        CASE json_extract(metadata_json, '$.assignmentBasis')
          WHEN 'explicit_assignment' THEN 0
          WHEN 'user_commitment' THEN 1
          WHEN 'known_responsibility' THEN 2
          ELSE 3
        END
    `).all();
    const overflow = active.slice(maximum);
    if (!overflow.length) return { active: active.length, backlogged: 0 };
    const update = this.db.prepare("UPDATE tasks SET status='backlog' WHERE id=?");
    this.transaction(() => {
      for (const task of overflow) update.run(task.id);
    });
    return { active: Math.min(active.length, maximum), backlogged: overflow.length };
  }

  recentEvidence(limit = 100, since = null) {
    if (since) {
      return this.db.prepare(`SELECT * FROM evidence WHERE collected_at > ? ORDER BY collected_at DESC LIMIT ?`).all(since, limit);
    }
    return this.db.prepare("SELECT * FROM evidence ORDER BY collected_at DESC LIMIT ?").all(limit);
  }

  unpatrolledEvidence(limit = 120) {
    return this.db.prepare(`
      SELECT e.*
      FROM evidence e
      LEFT JOIN patrol_evidence pe ON pe.evidence_id=e.id
      WHERE pe.evidence_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM evidence_links superseded
          WHERE superseded.child_evidence_id=e.id AND superseded.relation='supersedes'
        )
        AND e.kind IN (
          'codex_memory_document',
          'codex_thread_digest',
          'git_history_digest',
          'project_document_digest',
          'git_repository_snapshot',
          'import_document',
          'feishu_message',
          'feishu_approval_task',
          'feishu_task',
          'feishu_document_index',
          'feishu_document_content',
          'shadow_agent_task_result'
        )
      ORDER BY
        CASE e.kind
          WHEN 'feishu_approval_task' THEN 0
          WHEN 'feishu_task' THEN 1
          WHEN 'feishu_message' THEN 2
          WHEN 'shadow_agent_task_result' THEN 3
          WHEN 'codex_thread_digest' THEN 4
          WHEN 'git_history_digest' THEN 5
          WHEN 'project_document_digest' THEN 6
          WHEN 'feishu_document_content' THEN 7
          WHEN 'feishu_document_index' THEN 8
          WHEN 'codex_memory_document' THEN 9
          WHEN 'git_repository_snapshot' THEN 10
          ELSE 15
        END,
        COALESCE(e.occurred_at, e.collected_at) DESC
      LIMIT ?
    `).all(limit);
  }

  markEvidencePatrolled(patrolId, evidenceIds) {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO patrol_evidence(patrol_id, evidence_id, processed_at) VALUES(?, ?, ?)
    `);
    this.transaction(() => {
      for (const evidenceId of [...new Set(evidenceIds ?? [])]) statement.run(patrolId, evidenceId, nowIso());
    });
  }

  linkEvidence(parentEvidenceId, childEvidenceIds, relation = "summarizes") {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO evidence_links(parent_evidence_id, child_evidence_id, relation, created_at)
      VALUES(?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const childEvidenceId of [...new Set(childEvidenceIds ?? [])]) {
        statement.run(parentEvidenceId, childEvidenceId, relation, nowIso());
      }
    });
  }

  openTasks(limit = 80) {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE status IN ('new','planned','running','waiting_user','blocked','failed')
      ORDER BY CASE domain WHEN 'user_work' THEN 0 WHEN 'personal_admin' THEN 1 ELSE 2 END,
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at ASC LIMIT ?
    `).all(limit);
  }

  confirmedKnowledge(limit = 200) {
    return this.db.prepare(`
      SELECT * FROM knowledge_candidates WHERE status IN ('confirmed','candidate')
      ORDER BY status='confirmed' DESC, confidence DESC, updated_at DESC LIMIT ?
    `).all(limit);
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY name, root_path").all();
  }

  evidenceByIds(ids) {
    const unique = [...new Set(ids ?? [])].filter(Boolean);
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM evidence WHERE id IN (${placeholders})`).all(...unique);
  }

  recentConversationMessages(conversationKey, { limit = 8, excludeMessageId = null } = {}) {
    if (!conversationKey) return [];
    const maximum = Math.max(1, Math.min(8, Number(limit) || 8));
    const scanLimit = Math.max(24, maximum * 4);
    const incoming = this.db.prepare(`
      SELECT id, occurred_at, collected_at, external_id, content, metadata_json
      FROM evidence
      WHERE kind='feishu_message'
        AND json_extract(metadata_json, '$.conversationKey')=?
      ORDER BY COALESCE(occurred_at, collected_at) DESC, rowid DESC
      LIMIT ?
    `).all(String(conversationKey), scanLimit).map((row) => {
      const metadata = parseJson(row.metadata_json, {});
      const payload = parseJson(row.content, row.content);
      const messageId = payload?.message_id ?? row.external_id ?? row.id;
      return normalizeReviewMessage({
        direction: "incoming",
        senderName: payload?.sender_name ?? payload?.sender?.name ?? metadata.senderName ?? "对方",
        content: payload?.content ?? payload,
        occurredAt: row.occurred_at ?? row.collected_at,
        messageId,
      });
    });
    const outgoing = this.db.prepare(`
      SELECT id, recipient_name, approved_content, content, sent_at, created_at, sent_message_id
      FROM outbound_message_drafts
      WHERE conversation_key=? AND status='sent'
      ORDER BY COALESCE(sent_at, created_at) DESC
      LIMIT ?
    `).all(String(conversationKey), scanLimit).map((row) => normalizeReviewMessage({
      direction: "outgoing",
      senderName: "Shadow Agent",
      content: row.approved_content ?? row.content,
      occurredAt: row.sent_at ?? row.created_at,
      messageId: row.sent_message_id ?? row.id,
    }, "outgoing"));
    return [...incoming, ...outgoing]
      .filter(Boolean)
      .filter((item) => !excludeMessageId || item.messageId !== String(excludeMessageId))
      .sort((left, right) => Date.parse(left.occurredAt || 0) - Date.parse(right.occurredAt || 0))
      .slice(-maximum);
  }

  buildOutboundReviewContext(input = {}) {
    const recentMessages = input.recentMessages ?? this.recentConversationMessages(input.conversationKey, {
      limit: input.limit ?? 8,
      excludeMessageId: input.trigger?.messageId ?? input.trigger?.message_id ?? null,
    });
    return normalizeOutboundReviewContext({ ...input, recentMessages });
  }

  outboundDraftReviewContext(draftOrId) {
    const draft = typeof draftOrId === "string" ? this.outboundDraft(draftOrId) : draftOrId;
    if (!draft) return normalizeOutboundReviewContext({});
    const stored = normalizeOutboundReviewContext(parseJson(draft.review_context_json, {}), draft.created_at);
    if (reviewContextHasContent(stored)) return stored;
    const evidenceIds = parseJson(draft.source_evidence_ids_json, []);
    const evidence = this.evidenceByIds(evidenceIds);
    const linkedMessage = evidence.find((item) => item.kind === "feishu_message") ?? null;
    const payload = linkedMessage ? parseJson(linkedMessage.content, linkedMessage.content) : null;
    return this.buildOutboundReviewContext({
      capturedAt: draft.created_at,
      conversationKey: draft.conversation_key,
      summary: linkedMessage ? "" : boundedText(evidence[0]?.content ?? ""),
      trigger: linkedMessage ? {
        direction: "incoming",
        senderName: payload?.sender_name ?? payload?.sender?.name ?? draft.recipient_name,
        content: payload?.content ?? payload,
        occurredAt: linkedMessage.occurred_at ?? linkedMessage.collected_at,
        messageId: payload?.message_id ?? linkedMessage.external_id ?? draft.reply_to_message_id,
      } : null,
      reason: draft.reason,
      sourceLocator: draft.source_locator,
      evidenceIds,
      sessionKey: draft.session_key,
    });
  }

  setOutboundDraftReviewContext(id, reviewContext, { onlyIfEmpty = true } = {}) {
    const current = this.outboundDraft(id);
    if (!current) throw new Error(`Outbound draft not found: ${id}`);
    const existing = normalizeOutboundReviewContext(parseJson(current.review_context_json, {}), current.created_at);
    if (onlyIfEmpty && reviewContextHasContent(existing)) return current;
    const normalized = normalizeOutboundReviewContext(reviewContext, current.created_at);
    this.db.prepare("UPDATE outbound_message_drafts SET review_context_json=?, updated_at=? WHERE id=?")
      .run(stableJson(normalized), nowIso(), id);
    return this.outboundDraft(id);
  }

  pendingAutoTasks(riskLevels, limit = 3) {
    const risks = [...new Set(riskLevels ?? [])];
    if (!risks.length) return [];
    const placeholders = risks.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('new','planned','failed')
        AND risk_level IN (${placeholders})
        AND (status='new' OR next_review_at IS NULL OR next_review_at <= ?)
      ORDER BY CASE domain WHEN 'user_work' THEN 0 WHEN 'personal_admin' THEN 1 ELSE 2 END,
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at ASC
      LIMIT ?
    `).all(...risks, nowIso(), limit);
  }

  createAction(input) {
    const existing = this.db.prepare("SELECT * FROM action_log WHERE idempotency_key=?").get(input.idempotencyKey);
    if (existing) return { ...existing, inserted: false };
    const id = sha256(`action:${input.idempotencyKey}`).slice(0, 32);
    this.db.prepare(`
      INSERT INTO action_log(id, idempotency_key, task_id, action_type, risk_level, status,
        started_at, command_summary, metadata_json)
      VALUES(?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(
      id,
      input.idempotencyKey,
      input.taskId ?? null,
      input.actionType,
      input.riskLevel,
      nowIso(),
      input.commandSummary ?? null,
      stableJson(input.metadata ?? {}),
    );
    return { id, inserted: true, status: "running" };
  }

  finishAction(id, input) {
    this.db.prepare(`
      UPDATE action_log SET status=?, completed_at=?, result=?, error=?, metadata_json=? WHERE id=?
    `).run(
      input.status,
      nowIso(),
      input.result ?? null,
      input.error ?? null,
      stableJson(input.metadata ?? {}),
      id,
    );
  }

  recordControllerTurnMetric(input, { retentionRows = 2000 } = {}) {
    const row = {
      ...input,
      id: String(input.id ?? input.runId),
      runId: String(input.runId ?? input.id),
    };
    if (!row.id || !row.runId) throw new Error("Controller turn metric requires a run id.");
    this.db.prepare(`
      INSERT INTO controller_turn_metrics(
        id, run_id, session_hash, trigger_kind, status, started_at, completed_at,
        duration_ms, prompt_bytes, response_bytes, assistant_calls, tool_calls,
        tool_names_json, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, model, history_complete, budget_status,
        budget_flags_json, error
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status=excluded.status, completed_at=excluded.completed_at,
        duration_ms=excluded.duration_ms, response_bytes=excluded.response_bytes,
        assistant_calls=excluded.assistant_calls, tool_calls=excluded.tool_calls,
        tool_names_json=excluded.tool_names_json, input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens, total_tokens=excluded.total_tokens,
        model=excluded.model, history_complete=excluded.history_complete,
        budget_status=excluded.budget_status, budget_flags_json=excluded.budget_flags_json,
        error=excluded.error
    `).run(
      row.id,
      row.runId,
      row.sessionHash,
      row.triggerKind,
      row.status,
      row.startedAt,
      row.completedAt,
      row.durationMs ?? 0,
      row.promptBytes ?? 0,
      row.responseBytes ?? 0,
      row.assistantCalls ?? 0,
      row.toolCalls ?? 0,
      stableJson(row.toolNames ?? {}),
      row.inputTokens ?? 0,
      row.outputTokens ?? 0,
      row.cacheReadTokens ?? 0,
      row.cacheWriteTokens ?? 0,
      row.totalTokens ?? 0,
      row.model ?? null,
      row.historyComplete === false ? 0 : 1,
      row.budgetStatus ?? "within_budget",
      stableJson(row.budgetFlags ?? []),
      row.error ?? null,
    );
    const keep = Math.max(100, Math.min(20_000, Number(retentionRows) || 2000));
    this.db.prepare(`
      DELETE FROM controller_turn_metrics WHERE id IN (
        SELECT id FROM controller_turn_metrics ORDER BY completed_at DESC LIMIT -1 OFFSET ?
      )
    `).run(keep);
    return this.db.prepare("SELECT * FROM controller_turn_metrics WHERE run_id=?").get(row.runId);
  }

  controllerTurnMetrics({ limit = 100, since = null } = {}) {
    const maximum = Math.max(1, Math.min(2000, Number(limit) || 100));
    if (since) {
      return this.db.prepare(`
        SELECT * FROM controller_turn_metrics WHERE completed_at>=?
        ORDER BY completed_at DESC LIMIT ?
      `).all(since, maximum);
    }
    return this.db.prepare(`
      SELECT * FROM controller_turn_metrics ORDER BY completed_at DESC LIMIT ?
    `).all(maximum);
  }

  lastPatrolRun() {
    return this.db.prepare(`
      SELECT * FROM patrol_runs WHERE status='completed' ORDER BY completed_at DESC LIMIT 1
    `).get() ?? null;
  }

  sourceStatuses() {
    return this.db.prepare(`
      SELECT source_key, kind, uri, status, last_error, last_seen_at, last_collected_at,
        cursor_bytes, size_bytes FROM sources ORDER BY kind, source_key
    `).all();
  }

  createPatrolRun(id, metadata = {}) {
    this.db.prepare(`INSERT INTO patrol_runs(id, started_at, status, metadata_json) VALUES(?, ?, 'running', ?)`)
      .run(id, nowIso(), stableJson(metadata));
  }

  finishPatrolRun(id, input) {
    this.db.prepare(`
      UPDATE patrol_runs SET completed_at=?, status=?, evidence_count=?, task_count=?, codex_thread_id=?,
        summary=?, no_action_reason=?, raw_response=?, error=?, metadata_json=? WHERE id=?
    `).run(
      nowIso(),
      input.status,
      input.evidenceCount ?? 0,
      input.taskCount ?? 0,
      input.codexThreadId ?? null,
      input.summary ?? null,
      input.noActionReason ?? null,
      input.rawResponse ?? null,
      input.error ?? null,
      stableJson(input.metadata ?? {}),
      id,
    );
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, String(value), nowIso());
  }

  setContextRuntimeState(phase, detail = "") {
    const heartbeat = nowIso();
    this.setSetting("runtime:context:phase", phase);
    this.setSetting("runtime:context:detail", detail);
    this.setSetting("runtime:context:lastHeartbeat", heartbeat);
  }

  receiveExternalEvent(input) {
    const dedupeKey = String(input.dedupeKey || `${input.provider}:${input.eventType}:${input.eventId}`);
    const existing = this.db.prepare("SELECT * FROM external_event_receipts WHERE dedupe_key=?").get(dedupeKey);
    if (existing) {
      this.db.prepare(`
        UPDATE external_event_receipts
        SET last_received_at=?, updated_at=?, metadata_json=? WHERE id=?
      `).run(nowIso(), nowIso(), stableJson(input.metadata ?? {}), existing.id);
      return { ...this.externalEvent(existing.id), inserted: false };
    }
    const id = sha256(`external-event:${dedupeKey}`).slice(0, 32);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO external_event_receipts(
        id, provider, event_type, event_id, dedupe_key, conversation_key, status,
        received_at, last_received_at, evidence_id, metadata_json, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)
    `).run(
      id,
      String(input.provider),
      String(input.eventType),
      String(input.eventId),
      dedupeKey,
      input.conversationKey ?? null,
      timestamp,
      timestamp,
      input.evidenceId ?? null,
      stableJson(input.metadata ?? {}),
      timestamp,
    );
    return { ...this.externalEvent(id), inserted: true };
  }

  externalEvent(id) {
    return this.db.prepare("SELECT * FROM external_event_receipts WHERE id=?").get(id) ?? null;
  }

  startExternalEvent(id) {
    const timestamp = nowIso();
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    this.db.prepare(`
      UPDATE external_event_receipts
      SET status='processing', attempts=attempts+1, processing_started_at=?,
        next_attempt_at=NULL, last_error=NULL, updated_at=?
      WHERE id=? AND (
        status='received'
        OR (status='failed' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
        OR (status='processing' AND COALESCE(processing_started_at, updated_at, received_at)<=?)
      )
    `).run(timestamp, timestamp, id, timestamp, staleBefore);
    return this.externalEvent(id);
  }

  finishExternalEvent(id, { status = "processed", error = null, responseExternalId = null } = {}) {
    const current = this.externalEvent(id);
    if (!current) throw new Error(`External event receipt not found: ${id}`);
    const timestamp = nowIso();
    const retryAt = status === "failed" && Number(current.attempts) < 10
      ? new Date(Date.now() + Math.min(15 * 60, 5 * (2 ** Math.min(8, Math.max(0, Number(current.attempts) - 1)))) * 1000).toISOString()
      : null;
    this.db.prepare(`
      UPDATE external_event_receipts
      SET status=?, processed_at=?, processing_started_at=NULL, next_attempt_at=?,
        updated_at=?, last_error=?, response_external_id=COALESCE(?, response_external_id)
      WHERE id=?
    `).run(
      status,
      ["processed", "ignored"].includes(status) ? timestamp : current.processed_at,
      retryAt,
      timestamp,
      error ? String(error) : null,
      responseExternalId,
      id,
    );
    return this.externalEvent(id);
  }

  recoverExternalEvents({ limit = 20, staleSeconds = 300 } = {}) {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
    const timestamp = nowIso();
    const staleBefore = new Date(Date.now() - Math.max(30, Number(staleSeconds) || 300) * 1000).toISOString();
    this.db.prepare(`
      UPDATE external_event_receipts
      SET status='failed', processing_started_at=NULL, next_attempt_at=?, updated_at=?,
        last_error=COALESCE(last_error, 'Recovered stale processing lease.')
      WHERE status='processing'
        AND COALESCE(processing_started_at, updated_at, received_at)<=?
    `).run(timestamp, timestamp, staleBefore);
    return this.db.prepare(`
      SELECT * FROM external_event_receipts
      WHERE status='failed' AND attempts<10
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      ORDER BY COALESCE(next_attempt_at, received_at), received_at
      LIMIT ?
    `).all(timestamp, maximum);
  }

  bindWorkSession(input) {
    return bindWorkSessionForDatabase(this.db, input);
  }

  bindConversation(input) {
    return this.bindWorkSession({ ...input, kind: input.kind ?? "conversation", routeKey: input.conversationKey });
  }

  workSessionByKey(sessionKey) {
    return workSessionByKeyForDatabase(this.db, sessionKey);
  }

  markWorkSessionDispatched(sessionKey, timestamp = nowIso()) {
    this.db.prepare("UPDATE conversation_bindings SET last_dispatched_at=? WHERE session_key=?").run(timestamp, sessionKey);
    return this.workSessionByKey(sessionKey);
  }

  markWorkSessionCompleted(sessionKey, timestamp = nowIso()) {
    this.db.prepare("UPDATE conversation_bindings SET last_completed_at=? WHERE session_key=?").run(timestamp, sessionKey);
    return this.workSessionByKey(sessionKey);
  }

  createReminder(input) {
    const idempotencyKey = String(input.idempotencyKey);
    const existing = this.db.prepare("SELECT * FROM reminders WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) return { ...existing, inserted: false };
    const id = input.id ?? sha256(`reminder:${idempotencyKey}`).slice(0, 32);
    const timestamp = nowIso();
    const dueAt = new Date(input.dueAt).toISOString();
    this.db.prepare(`
      INSERT INTO reminders(
        id, idempotency_key, title, message, due_at, status, source_locator,
        source_evidence_ids_json, task_id, explicit, cron_job_id, parent_reminder_id,
        revision, created_at, updated_at, metadata_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      idempotencyKey,
      String(input.title),
      String(input.message ?? input.title),
      dueAt,
      input.status ?? "pending_schedule",
      input.sourceLocator ?? null,
      stableJson([...new Set(input.evidenceIds ?? [])]),
      input.taskId ?? null,
      input.explicit === false ? 0 : 1,
      input.cronJobId ?? null,
      input.parentReminderId ?? null,
      Math.max(1, Number(input.revision) || 1),
      timestamp,
      timestamp,
      stableJson(input.metadata ?? {}),
    );
    return { ...this.reminder(id), inserted: true };
  }

  reminder(id) {
    return this.db.prepare("SELECT * FROM reminders WHERE id=?").get(id) ?? null;
  }

  updateReminder(id, input) {
    const current = this.reminder(id);
    if (!current) throw new Error(`Reminder not found: ${id}`);
    const value = (inputKey, rowKey = inputKey) => Object.hasOwn(input, inputKey) ? input[inputKey] : current[rowKey];
    const dueAt = Object.hasOwn(input, "dueAt") ? new Date(input.dueAt).toISOString() : current.due_at;
    this.db.prepare(`
      UPDATE reminders SET
        title=?, message=?, due_at=?, status=?, cron_job_id=?, revision=?,
        notification_started_at=?, delivered_at=?, acknowledged_at=?, cancelled_at=?,
        last_error=?, updated_at=?, metadata_json=?
      WHERE id=?
    `).run(
      value("title"),
      value("message"),
      dueAt,
      value("status"),
      value("cronJobId", "cron_job_id"),
      value("revision"),
      value("notificationStartedAt", "notification_started_at"),
      value("deliveredAt", "delivered_at"),
      value("acknowledgedAt", "acknowledged_at"),
      value("cancelledAt", "cancelled_at"),
      input.lastError === undefined ? current.last_error : input.lastError,
      nowIso(),
      stableJson(input.metadata ?? JSON.parse(current.metadata_json || "{}")),
      id,
    );
    return this.reminder(id);
  }

  deliverReminder(id) {
    const current = this.reminder(id);
    if (!current) throw new Error(`Reminder not found: ${id}`);
    if (["acknowledged", "cancelled", "snoozed"].includes(current.status)) return current;
    if (current.status === "delivered") return current;
    return this.updateReminder(id, {
      status: "notification_pending",
      notificationStartedAt: current.notification_started_at ?? nowIso(),
    });
  }

  completeReminderDelivery(id) {
    const current = this.reminder(id);
    if (!current) throw new Error(`Reminder not found: ${id}`);
    if (["acknowledged", "cancelled", "snoozed"].includes(current.status)) return current;
    if (current.status === "delivered") return current;
    return this.updateReminder(id, {
      status: "delivered",
      deliveredAt: current.delivered_at ?? nowIso(),
      lastError: null,
    });
  }

  rescheduleReminder(id, input) {
    const current = this.reminder(id);
    if (!current) throw new Error(`Reminder not found: ${id}`);
    if (["acknowledged", "cancelled", "snoozed"].includes(current.status)) {
      throw new Error(`Reminder cannot be updated from status: ${current.status}`);
    }
    return this.updateReminder(id, {
      title: input.title ?? current.title,
      message: input.message ?? current.message,
      dueAt: input.dueAt ?? current.due_at,
      status: "pending_schedule",
      cronJobId: null,
      revision: Number(current.revision || 1) + 1,
      notificationStartedAt: null,
      deliveredAt: null,
      acknowledgedAt: null,
      cancelledAt: null,
      lastError: null,
      metadata: input.metadata ?? JSON.parse(current.metadata_json || "{}"),
    });
  }

  cancelReminderRecord(id, input = {}) {
    const current = this.reminder(id);
    if (!current) throw new Error(`Reminder not found: ${id}`);
    if (current.status === "cancelled") return current;
    if (["acknowledged", "snoozed"].includes(current.status)) return current;
    return this.updateReminder(id, {
      status: "cancelled",
      cancelledAt: current.cancelled_at ?? input.cancelledAt ?? nowIso(),
      lastError: input.lastError,
      metadata: input.metadata ?? JSON.parse(current.metadata_json || "{}"),
    });
  }

  acknowledgeReminder(id) {
    const current = this.reminder(id);
    if (!current) throw new Error(`Reminder not found: ${id}`);
    if (current.status === "cancelled") return current;
    return this.updateReminder(id, { status: "acknowledged", acknowledgedAt: nowIso() });
  }

  listReminders({ limit = 20, includeAcknowledged = false } = {}) {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
    const where = includeAcknowledged
      ? "1=1"
      : "status NOT IN ('acknowledged','cancelled','snoozed')";
    return this.db.prepare(`
      SELECT * FROM reminders WHERE ${where}
      ORDER BY CASE status WHEN 'delivered' THEN 0 WHEN 'notification_pending' THEN 1 WHEN 'schedule_failed' THEN 2 ELSE 3 END,
        due_at ASC, updated_at DESC LIMIT ?
    `).all(maximum);
  }

  createConditionWatch(input) {
    const idempotencyKey = String(input.idempotencyKey);
    const existing = this.db.prepare("SELECT * FROM condition_watches WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) return { ...existing, inserted: false };
    const id = input.id ?? sha256(`condition-watch:${idempotencyKey}`).slice(0, 32);
    const timestamp = nowIso();
    const baseline = Number(input.baselineEvidenceRowid
      ?? this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM evidence").get().value);
    const timeoutAt = input.timeoutAt ? new Date(input.timeoutAt).toISOString() : null;
    this.db.prepare(`
      INSERT INTO condition_watches(
        id, idempotency_key, title, condition_text, selector_json, status,
        baseline_evidence_rowid, last_evidence_rowid, candidate_evidence_ids_json,
        source_evidence_ids_json, task_id, conversation_provider, conversation_key,
        session_key, timeout_at, created_at, updated_at, metadata_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      idempotencyKey,
      String(input.title),
      String(input.conditionText),
      stableJson(input.selector ?? {}),
      input.status ?? "active",
      baseline,
      baseline,
      stableJson([...new Set(input.evidenceIds ?? [])]),
      input.taskId ?? null,
      input.conversationProvider ?? null,
      input.conversationKey ?? null,
      input.sessionKey ?? "agent:main:shadow-events",
      timeoutAt,
      timestamp,
      timestamp,
      stableJson(input.metadata ?? {}),
    );
    return { ...this.conditionWatch(id), inserted: true };
  }

  conditionWatch(id) {
    return this.db.prepare("SELECT * FROM condition_watches WHERE id=?").get(id) ?? null;
  }

  listConditionWatches({ limit = 50, statuses = ["active", "candidate", "timed_out"] } = {}) {
    const maximum = Math.max(1, Math.min(200, Number(limit) || 50));
    const selected = [...new Set(statuses.map(String))];
    if (!selected.length) return [];
    return this.db.prepare(`
      SELECT * FROM condition_watches
      WHERE status IN (${selected.map(() => "?").join(",")})
      ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'timed_out' THEN 1 ELSE 2 END,
        COALESCE(timeout_at, '9999-12-31T23:59:59.999Z'), updated_at
      LIMIT ?
    `).all(...selected, maximum);
  }

  updateConditionWatch(id, input) {
    const current = this.conditionWatch(id);
    if (!current) throw new Error(`Condition watch not found: ${id}`);
    const candidateIds = input.candidateEvidenceIds === undefined
      ? current.candidate_evidence_ids_json
      : stableJson([...new Set(input.candidateEvidenceIds)]);
    const timeoutAt = input.timeoutAt === undefined
      ? current.timeout_at
      : input.timeoutAt ? new Date(input.timeoutAt).toISOString() : null;
    this.db.prepare(`
      UPDATE condition_watches SET
        status=?, last_evidence_rowid=?, candidate_evidence_ids_json=?,
        timeout_at=?, updated_at=?, last_checked_at=?, candidate_at=?, resolved_at=?,
        last_error=?, resolution_note=?, metadata_json=?
      WHERE id=?
    `).run(
      input.status ?? current.status,
      input.lastEvidenceRowid ?? current.last_evidence_rowid,
      candidateIds,
      timeoutAt,
      nowIso(),
      input.lastCheckedAt === undefined ? current.last_checked_at : input.lastCheckedAt,
      input.candidateAt === undefined ? current.candidate_at : input.candidateAt,
      input.resolvedAt === undefined ? current.resolved_at : input.resolvedAt,
      input.lastError === undefined ? current.last_error : input.lastError,
      input.resolutionNote === undefined ? current.resolution_note : input.resolutionNote,
      stableJson(input.metadata ?? JSON.parse(current.metadata_json || "{}")),
      id,
    );
    return this.conditionWatch(id);
  }

  createDirectInputReceipt(input) {
    const evidenceId = String(input.evidenceId ?? "").trim();
    const sessionKey = String(input.sessionKey ?? "").trim();
    if (!evidenceId) throw new Error("Direct input receipt requires an Evidence ID.");
    if (!sessionKey) throw new Error("Direct input receipt requires a stable session.");
    const idempotencyKey = String(input.idempotencyKey ?? `direct-input:${evidenceId}`);
    const existing = this.db.prepare(`
      SELECT * FROM direct_input_receipts
      WHERE idempotency_key=? OR evidence_id=?
    `).get(idempotencyKey, evidenceId);
    if (existing) return { ...existing, inserted: false };
    const id = input.id ?? sha256(`direct-input-receipt:${idempotencyKey}`).slice(0, 32);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO direct_input_receipts(
        id, idempotency_key, evidence_id, session_key, status,
        created_at, updated_at, metadata_json
      ) VALUES(?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(id, idempotencyKey, evidenceId, sessionKey, timestamp, timestamp, stableJson(input.metadata ?? {}));
    return { ...this.db.prepare("SELECT * FROM direct_input_receipts WHERE id=?").get(id), inserted: true };
  }

  directInputReceipt(id) {
    return this.db.prepare("SELECT * FROM direct_input_receipts WHERE id=?").get(String(id)) ?? null;
  }

  listDirectInputReceipts({ limit = 10 } = {}) {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 10));
    return this.db.prepare(`
      SELECT * FROM direct_input_receipts
      ORDER BY created_at DESC LIMIT ?
    `).all(maximum);
  }

  updateDirectInputReceipt(id, input = {}) {
    const current = this.directInputReceipt(id);
    if (!current) throw new Error(`Direct input receipt not found: ${id}`);
    const status = String(input.status ?? current.status);
    if (!["queued", "processing", "retry", "completed", "failed"].includes(status)) {
      throw new Error(`Invalid direct input status: ${status}`);
    }
    const timestamp = nowIso();
    const startedAt = input.startedAt === undefined
      ? current.started_at
      : input.startedAt;
    const completedAt = input.completedAt === undefined
      ? current.completed_at
      : input.completedAt;
    const responseText = input.responseText === undefined
      ? current.response_text
      : input.responseText == null ? null : String(input.responseText).slice(0, 256_000);
    const taskIds = input.createdTaskIds === undefined
      ? current.created_task_ids_json
      : stableJson([...new Set(input.createdTaskIds ?? [])].map(String).slice(0, 50));
    const metadata = input.metadata === undefined
      ? current.metadata_json
      : stableJson(input.metadata ?? {});
    this.db.prepare(`
      UPDATE direct_input_receipts SET
        status=?, response_text=?, created_task_ids_json=?, run_id=?,
        started_at=?, completed_at=?, updated_at=?, last_error=?, metadata_json=?
      WHERE id=?
    `).run(
      status,
      responseText,
      taskIds,
      input.runId === undefined ? current.run_id : input.runId,
      startedAt,
      completedAt,
      timestamp,
      input.lastError === undefined ? current.last_error : input.lastError,
      metadata,
      current.id,
    );
    return this.directInputReceipt(current.id);
  }

  recoverDirectInputActions() {
    const receipts = this.db.prepare(`
      SELECT * FROM direct_input_receipts
      WHERE status IN ('queued','processing','retry')
      ORDER BY created_at
    `).all();
    return receipts.map((receipt) => this.ensureControllerAction({
      idempotencyKey: `process-direct-input:${receipt.id}`,
      actionType: "process_direct_input",
      payload: {
        requestId: receipt.id,
        evidenceId: receipt.evidence_id,
        sessionKey: receipt.session_key,
      },
    }));
  }

  enqueueControllerAction(input) {
    const idempotencyKey = String(input.idempotencyKey);
    const existing = this.db.prepare("SELECT * FROM controller_outbox WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) return { ...existing, inserted: false };
    const id = input.id ?? sha256(`controller-outbox:${idempotencyKey}`).slice(0, 32);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO controller_outbox(
        id, idempotency_key, action_type, payload_json, status, attempts,
        next_attempt_at, last_error, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
    `).run(id, idempotencyKey, String(input.actionType), stableJson(input.payload ?? {}), input.nextAttemptAt ?? timestamp, timestamp, timestamp);
    return { ...this.db.prepare("SELECT * FROM controller_outbox WHERE id=?").get(id), inserted: true };
  }

  ensureControllerAction(input) {
    const action = this.enqueueControllerAction(input);
    if (action.inserted || !["completed", "failed", "cancelled"].includes(action.status)) return action;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE controller_outbox
      SET action_type=?, payload_json=?, status='retry', attempts=0,
        next_attempt_at=?, last_error=NULL, updated_at=?
      WHERE id=?
    `).run(String(input.actionType), stableJson(input.payload ?? {}), input.nextAttemptAt ?? timestamp, timestamp, action.id);
    return { ...this.db.prepare("SELECT * FROM controller_outbox WHERE id=?").get(action.id), inserted: false, revived: true };
  }

  cancelReminderControllerActions(reminderId, { exceptTypes = [] } = {}) {
    const excluded = new Set(exceptTypes.map(String));
    const rows = this.db.prepare(`
      SELECT * FROM controller_outbox WHERE status IN ('pending','retry','processing')
    `).all();
    const ids = rows.filter((row) => {
      if (excluded.has(row.action_type)) return false;
      try { return JSON.parse(row.payload_json || "{}").reminderId === reminderId; } catch { return false; }
    }).map((row) => row.id);
    const update = this.db.prepare(`
      UPDATE controller_outbox SET status='cancelled', next_attempt_at=NULL,
        last_error='Cancelled because the reminder changed state.', updated_at=? WHERE id=?
    `);
    const timestamp = nowIso();
    for (const id of ids) update.run(timestamp, id);
    return ids.length;
  }

  recoverReminderActions(timestamp = nowIso()) {
    const reminders = this.db.prepare(`
      SELECT * FROM reminders
      WHERE status IN ('pending_schedule','schedule_failed','notification_pending')
         OR (status='scheduled' AND due_at<=?)
    `).all(timestamp);
    const actions = [];
    for (const reminder of reminders) {
      const revision = Math.max(1, Number(reminder.revision) || 1);
      let actionType = "schedule_reminder";
      let prefix = "schedule-reminder";
      if (reminder.status === "notification_pending") {
        actionType = "wake_reminder";
        prefix = "wake-reminder";
      } else if (reminder.status === "scheduled") {
        actionType = "deliver_reminder";
        prefix = "deliver-reminder";
      }
      actions.push(this.ensureControllerAction({
        idempotencyKey: `${prefix}:${reminder.id}:r${revision}`,
        actionType,
        payload: { reminderId: reminder.id, revision },
      }));
    }
    return actions;
  }

  claimControllerActions(limit = 5) {
    const maximum = Math.max(1, Math.min(20, Number(limit) || 5));
    return this.transaction(() => {
      const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const now = nowIso();
      const rows = this.db.prepare(`
        SELECT * FROM controller_outbox
        WHERE ((status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?))
          OR (status='processing' AND updated_at<=?))
        ORDER BY created_at LIMIT ?
      `).all(now, staleBefore, maximum);
      const claim = this.db.prepare(`
        UPDATE controller_outbox
        SET status='processing', attempts=attempts+1, updated_at=?, last_error=NULL
        WHERE id=?
      `);
      for (const row of rows) claim.run(now, row.id);
      return rows.map((row) => ({ ...row, status: "processing", attempts: row.attempts + 1, updated_at: now }));
    });
  }

  claimControllerAction(id) {
    const timestamp = nowIso();
    const claimed = this.db.prepare(`
      UPDATE controller_outbox
      SET status='processing', attempts=attempts+1, updated_at=?, last_error=NULL
      WHERE id=? AND status IN ('pending','retry')
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    `).run(timestamp, id, timestamp);
    if (!Number(claimed.changes ?? 0)) return null;
    return this.db.prepare("SELECT * FROM controller_outbox WHERE id=?").get(id) ?? null;
  }

  finishControllerAction(id, { status = "completed", error = null, retryAt = null } = {}) {
    this.db.prepare(`
      UPDATE controller_outbox
      SET status=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=? AND status<>'cancelled'
    `).run(status, retryAt, error ? String(error) : null, nowIso(), id);
    return this.db.prepare("SELECT * FROM controller_outbox WHERE id=?").get(id) ?? null;
  }

  createOutboundDraft(input) {
    const recipientName = String(input.recipientName ?? "").trim();
    const content = String(input.content ?? "").trim();
    const messageKind = String(input.messageKind ?? (input.replyToMessageId ? "reply" : "question"));
    const senderIdentity = input.senderIdentity === "bot" ? "bot" : "user";
    const approvalMode = input.approvalMode === "automatic" ? "automatic" : "hitl";
    const trackReply = input.trackReply !== false;
    if (!recipientName) throw new Error("Outbound draft recipient is required.");
    if (!content) throw new Error("Outbound draft content is required.");
    if (content.length > 5000) throw new Error("Outbound draft content is too long.");
    if (!input.replyToMessageId && !input.recipientOpenId && !input.chatId) {
      throw new Error("Outbound draft requires a Feishu user, chat, or reply target.");
    }
    if (messageKind === "question" && trackReply && !String(input.taskId ?? "").trim()) {
      throw new Error("A proactive question that expects a reply must be bound to a Workboard taskId.");
    }
    const idempotencyKey = String(input.idempotencyKey ?? sha256(stableJson({
      provider: "feishu",
      messageKind,
      recipientName,
      recipientOpenId: input.recipientOpenId ?? null,
      chatId: input.chatId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      senderIdentity,
      approvalMode,
      content,
      sourceLocator: input.sourceLocator ?? null,
    })));
    const existing = this.db.prepare("SELECT * FROM outbound_message_drafts WHERE idempotency_key=?").get(idempotencyKey);
    if (existing) return { ...existing, inserted: false };
    const id = input.id ?? sha256(`outbound-draft:${idempotencyKey}`).slice(0, 32);
    const timestamp = nowIso();
    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    const reviewContext = normalizeOutboundReviewContext({
      ...(input.reviewContext ?? {}),
      reason: input.reviewContext?.reason ?? input.reason,
      sourceLocator: input.reviewContext?.sourceLocator ?? input.sourceLocator,
      evidenceIds: input.reviewContext?.evidenceIds ?? evidenceIds,
      sessionKey: input.reviewContext?.sessionKey ?? input.sessionKey,
    }, timestamp);
    const initialStatus = approvalMode === "automatic" ? "approved" : "pending_confirmation";
    const metadata = {
      ...(input.metadata ?? {}),
      hitlRequired: approvalMode === "hitl",
      audit: [{
        event: approvalMode === "automatic" ? "automatic_send_queued" : "draft_created",
        at: timestamp,
        by: input.createdBy ?? "openclaw-main",
      }],
    };
    this.db.prepare(`
      INSERT INTO outbound_message_drafts(
        id, idempotency_key, provider, message_kind, sender_identity, approval_mode, recipient_name,
        recipient_open_id, chat_id, reply_to_message_id, reply_in_thread,
        conversation_key, session_key, task_id, content, approved_content, reason, source_locator,
        source_evidence_ids_json, review_context_json, track_reply, status, revision, created_by,
        created_at, updated_at, approved_at, metadata_json
      ) VALUES(
        ?, ?, 'feishu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, 1, ?, ?, ?, ?, ?
      )
    `).run(
      id,
      idempotencyKey,
      messageKind,
      senderIdentity,
      approvalMode,
      recipientName,
      input.recipientOpenId ?? null,
      input.chatId ?? null,
      input.replyToMessageId ?? null,
      input.replyInThread ? 1 : 0,
      input.conversationKey ?? null,
      input.sessionKey ?? "agent:main:shadow-events",
      input.taskId ?? null,
      content,
      approvalMode === "automatic" ? content : null,
      String(input.reason ?? "").trim(),
      input.sourceLocator ?? null,
      stableJson(evidenceIds),
      stableJson(reviewContext),
      trackReply ? 1 : 0,
      initialStatus,
      input.createdBy ?? "openclaw-main",
      timestamp,
      timestamp,
      approvalMode === "automatic" ? timestamp : null,
      stableJson(metadata),
    );
    if (approvalMode === "automatic") {
      this.enqueueControllerAction({
        idempotencyKey: `send-feishu-message:${id}:r1`,
        actionType: "send_feishu_message",
        payload: { draftId: id, revision: 1 },
      });
    }
    return { ...this.outboundDraft(id), inserted: true };
  }

  outboundDraft(id) {
    return this.db.prepare("SELECT * FROM outbound_message_drafts WHERE id=?").get(id) ?? null;
  }

  outboundDraftForReply(replyToMessageId, { approvalMode = null } = {}) {
    if (!replyToMessageId) return null;
    return this.db.prepare(`
      SELECT * FROM outbound_message_drafts
      WHERE reply_to_message_id=?
        AND status NOT IN ('cancelled','sent')
        AND (? IS NULL OR approval_mode=?)
      ORDER BY created_at DESC LIMIT 1
    `).get(String(replyToMessageId), approvalMode, approvalMode) ?? null;
  }

  retainInactiveSourceBackground(evidenceIds) {
    const excluded = new Set(evidenceIds);
    if (!excluded.size) return 0;
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT seq, metadata_json FROM context_changes
        WHERE status='pending' AND kind='evidence_batch_ingested'`).all();
      let updated = 0;
      for (const row of rows) {
        const metadata = parseJson(row.metadata_json, {});
        const members = this.db.prepare('SELECT evidence_id FROM context_change_evidence WHERE change_seq=?').all(row.seq);
        const ids = members.length ? members.map(item => item.evidence_id) : metadata.evidenceIds ?? [];
        // Policy exclusion is not a read ACK; never swallow another member or consumer lease.
        if (!ids.length || ids.some(id => !excluded.has(id))) continue;
        const published = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='information_dispatches'").get()
          && this.db.prepare('SELECT 1 FROM information_dispatches WHERE source_change_seq=? LIMIT 1').get(row.seq);
        if (published) continue;
        metadata.sourceDisposition = { kind: 'background_policy', evidenceIds: ids,
          reason: 'inactive_feishu_group', agentReviewed: false };
        updated += Number(this.db.prepare(`UPDATE context_changes SET status='acknowledged',acknowledged_at=?,
          ack_note='retained as inactive group background; not semantically reviewed',metadata_json=?
          WHERE seq=? AND status='pending'`).run(nowIso(), stableJson(metadata), row.seq).changes);
      }
      return updated;
    });
  }

  listOutboundDrafts({ limit = 20, statuses = ["pending_confirmation", "approved", "sending", "failed"] } = {}) {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
    const selected = [...new Set(statuses.map(String))];
    if (!selected.length) return [];
    return this.db.prepare(`
      SELECT * FROM outbound_message_drafts
      WHERE status IN (${selected.map(() => "?").join(",")})
      ORDER BY CASE status
        WHEN 'pending_confirmation' THEN 0 WHEN 'failed' THEN 1
        WHEN 'approved' THEN 2 WHEN 'sending' THEN 3 ELSE 4 END,
        created_at ASC LIMIT ?
    `).all(...selected, maximum);
  }

  approveOutboundDraft(id, input = {}) {
    return this.transaction(() => {
      const current = this.outboundDraft(id);
      if (!current) throw new Error(`Outbound draft not found: ${id}`);
      if (current.status !== "pending_confirmation") {
        throw new Error(`Outbound draft cannot be approved from status ${current.status}.`);
      }
      const approvedContent = String(input.content ?? current.content).trim();
      if (!approvedContent) throw new Error("Approved outbound content is required.");
      if (approvedContent.length > 5000) throw new Error("Approved outbound content is too long.");
      const revision = Math.max(1, Number(current.revision) || 1) + 1;
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE outbound_message_drafts SET
          content=?, approved_content=?, status='approved', revision=?,
          approved_at=?, updated_at=?, cancelled_at=NULL, last_error=NULL,
          metadata_json=? WHERE id=?
      `).run(
        approvedContent,
        approvedContent,
        revision,
        timestamp,
        timestamp,
        stableJson(outboundAudit(current, "approved_by_user", {
          edited: approvedContent !== current.content,
          revision,
        })),
        id,
      );
      this.enqueueControllerAction({
        idempotencyKey: `send-feishu-message:${id}:r${revision}`,
        actionType: "send_feishu_message",
        payload: { draftId: id, revision },
      });
      return this.outboundDraft(id);
    });
  }

  cancelOutboundDraft(id, input = {}) {
    return this.transaction(() => {
      const current = this.outboundDraft(id);
      if (!current) throw new Error(`Outbound draft not found: ${id}`);
      if (current.status === "cancelled") return current;
      if (["sending", "sent"].includes(current.status)) {
        throw new Error(`Outbound draft cannot be cancelled from status ${current.status}.`);
      }
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE outbound_message_drafts SET status='cancelled', cancelled_at=?,
          updated_at=?, last_error=NULL, metadata_json=? WHERE id=?
      `).run(timestamp, timestamp, stableJson(outboundAudit(
        current,
        input.auditEvent ?? "cancelled_by_user",
        { by: input.by ?? "user", ...(input.reason ? { reason: String(input.reason) } : {}) },
      )), id);
      const actions = this.db.prepare(`
        SELECT id, payload_json FROM controller_outbox
        WHERE action_type='send_feishu_message' AND status IN ('pending','retry')
      `).all();
      const update = this.db.prepare(`
        UPDATE controller_outbox SET status='cancelled', next_attempt_at=NULL,
          last_error='Cancelled by user before send.', updated_at=? WHERE id=?
      `);
      for (const action of actions) {
        if (parseJson(action.payload_json, {}).draftId === id) update.run(timestamp, action.id);
      }
      return this.outboundDraft(id);
    });
  }

  markOutboundDraftSending(id, revision) {
    const current = this.outboundDraft(id);
    if (!current) throw new Error(`Outbound draft not found: ${id}`);
    if (Number(current.revision) !== Number(revision)) throw new Error("Outbound draft revision is stale.");
    if (current.status === "sent") return current;
    if (!["approved", "failed", "sending"].includes(current.status)) {
      throw new Error(`Outbound draft is not approved: ${current.status}.`);
    }
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE outbound_message_drafts SET status='sending', send_started_at=?,
        updated_at=?, last_error=NULL, metadata_json=? WHERE id=?
    `).run(timestamp, timestamp, stableJson(outboundAudit(current, "send_started", { revision })), id);
    return this.outboundDraft(id);
  }

  markOutboundDraftFailed(id, revision, error) {
    const current = this.outboundDraft(id);
    if (!current || current.status === "sent" || Number(current.revision) !== Number(revision)) return current;
    this.db.prepare(`
      UPDATE outbound_message_drafts SET status='failed', updated_at=?, last_error=?,
        metadata_json=? WHERE id=?
    `).run(
      nowIso(),
      String(error),
      stableJson(outboundAudit(current, "send_failed", { revision, error: String(error) })),
      id,
    );
    return this.outboundDraft(id);
  }

  markOutboundDraftSent(id, revision, input = {}) {
    const current = this.outboundDraft(id);
    if (!current) throw new Error(`Outbound draft not found: ${id}`);
    if (Number(current.revision) !== Number(revision)) throw new Error("Outbound draft revision is stale.");
    if (current.status === "sent") return current;
    const timestamp = input.sentAt ?? nowIso();
    this.db.prepare(`
      UPDATE outbound_message_drafts SET status='sent', sent_at=?, sent_message_id=?,
        sent_chat_id=?, updated_at=?, last_error=NULL, metadata_json=? WHERE id=?
    `).run(
      timestamp,
      input.messageId ?? null,
      input.chatId ?? null,
      timestamp,
      stableJson(outboundAudit(current, current.approval_mode === "automatic" ? "sent_after_automatic_approval" : "sent_after_user_approval", {
        revision,
        messageId: input.messageId ?? null,
        chatId: input.chatId ?? null,
      })),
      id,
    );
    return this.outboundDraft(id);
  }

  taskSnapshot(limit = 4) {
    const rows = (where, order, max = limit) => this.db.prepare(`
      SELECT tasks.id, tasks.title, tasks.description, tasks.status, tasks.priority,
        tasks.risk_level, tasks.action_type, tasks.domain, tasks.project_key,
        projects.name AS project_name, tasks.created_at, tasks.updated_at,
        tasks.last_error, tasks.result
      FROM tasks
      LEFT JOIN projects ON projects.project_key=tasks.project_key
      WHERE ${where} ${order} LIMIT ?
    `).all(max);
    return {
      running: rows("tasks.status='running'", "ORDER BY tasks.updated_at DESC", 3),
      needsUser: rows(`tasks.status IN ('new','planned','waiting_user','blocked','failed')
        AND tasks.domain='user_work'
        AND (tasks.status IN ('waiting_user','blocked','failed') OR tasks.risk_level<>'read')`,
        "ORDER BY CASE tasks.status WHEN 'waiting_user' THEN 0 WHEN 'failed' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, tasks.updated_at DESC", 4),
      queued: rows("tasks.status IN ('new','planned') AND tasks.domain='user_work' AND tasks.risk_level='read'",
        "ORDER BY CASE tasks.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, tasks.updated_at DESC"),
      completed: rows("tasks.status='done' AND tasks.domain='user_work'", "ORDER BY tasks.updated_at DESC"),
      failed: rows("tasks.status='failed' AND tasks.domain='user_work'", "ORDER BY tasks.updated_at DESC", 2),
      maintenance: rows("tasks.status IN ('new','planned','running','waiting_user','blocked','failed') AND tasks.domain='agent_maintenance'",
        "ORDER BY CASE tasks.status WHEN 'running' THEN 0 ELSE 1 END, tasks.updated_at DESC", 3),
      counts: {
        needsUser: this.db.prepare(`SELECT COUNT(*) AS count FROM tasks
          WHERE status IN ('new','planned','waiting_user','blocked','failed') AND domain='user_work'
            AND (status IN ('waiting_user','blocked','failed') OR risk_level<>'read')`).get().count,
        queued: this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('new','planned') AND domain='user_work' AND risk_level='read'").get().count,
        backlog: this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='backlog' AND domain='user_work'").get().count,
        failed: this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='failed' AND domain='user_work'").get().count,
      },
      runtime: {
        phase: this.getSetting("runtime:context:phase", "offline"),
        detail: this.getSetting("runtime:context:detail", ""),
        lastHeartbeat: this.getSetting("runtime:context:lastHeartbeat", ""),
      },
    };
  }

  listAgentHistory({ limit = 120, query = "" } = {}) {
    const maximum = Math.max(1, Math.min(300, Number(limit) || 120));
    const normalized = String(query || "").trim();
    const like = `%${normalized}%`;
    return this.db.prepare(`
      SELECT patrol_runs.id, patrol_runs.started_at, patrol_runs.completed_at,
        patrol_runs.status, patrol_runs.evidence_count, patrol_runs.task_count,
        patrol_runs.summary, patrol_runs.no_action_reason, patrol_runs.error,
        (
          SELECT COUNT(*) FROM tasks
          WHERE json_extract(tasks.metadata_json, '$.patrolRunId')=patrol_runs.id
        ) AS discovered_task_count,
        (
          SELECT COUNT(*) FROM action_log
          WHERE action_log.started_at>=patrol_runs.started_at
            AND action_log.started_at<=COALESCE(patrol_runs.completed_at, datetime('now'))
        ) AS action_count,
        (
          SELECT tasks.title FROM tasks
          WHERE json_extract(tasks.metadata_json, '$.patrolRunId')=patrol_runs.id
          ORDER BY tasks.created_at DESC LIMIT 1
        ) AS preview_task
      FROM patrol_runs
      WHERE (
        ?='' OR patrol_runs.id LIKE ? OR COALESCE(patrol_runs.summary, '') LIKE ?
        OR COALESCE(patrol_runs.no_action_reason, '') LIKE ? OR COALESCE(patrol_runs.error, '') LIKE ?
        OR EXISTS (
          SELECT 1 FROM tasks
          WHERE json_extract(tasks.metadata_json, '$.patrolRunId')=patrol_runs.id
            AND (tasks.title LIKE ? OR tasks.description LIKE ?)
        )
      )
      ORDER BY patrol_runs.started_at DESC
      LIMIT ?
    `).all(normalized, like, like, like, like, like, like, maximum);
  }

  agentHistoryDetails(id) {
    const parse = (value, fallback) => {
      try { return JSON.parse(value || ""); } catch { return fallback; }
    };
    const run = this.db.prepare(`
      SELECT id, started_at, completed_at, status, evidence_count, task_count,
        codex_thread_id, summary, no_action_reason, error, metadata_json
      FROM patrol_runs WHERE id=?
    `).get(id);
    if (!run) return null;
    run.metadata = parse(run.metadata_json, {});
    delete run.metadata_json;

    const tasks = this.db.prepare(`
      SELECT tasks.id, tasks.title, tasks.description, tasks.status, tasks.priority,
        tasks.risk_level, tasks.action_type, tasks.domain, tasks.created_at, tasks.updated_at,
        tasks.result, tasks.last_error, projects.name AS project_name
      FROM tasks
      LEFT JOIN projects ON projects.project_key=tasks.project_key
      WHERE json_extract(tasks.metadata_json, '$.patrolRunId')=?
      ORDER BY tasks.created_at, tasks.id
    `).all(id);
    const actions = this.db.prepare(`
      SELECT action_log.id, action_log.task_id, action_log.action_type, action_log.risk_level,
        action_log.status, action_log.started_at, action_log.completed_at,
        action_log.command_summary, action_log.result, action_log.error, action_log.metadata_json,
        tasks.title AS task_title
      FROM action_log
      LEFT JOIN tasks ON tasks.id=action_log.task_id
      WHERE action_log.started_at>=?
        AND action_log.started_at<=COALESCE(?, datetime('now'))
      ORDER BY action_log.started_at, action_log.id
    `).all(run.started_at, run.completed_at).map((row) => ({
      ...row,
      metadata: parse(row.metadata_json, {}),
      metadata_json: undefined,
    }));
    const evidenceKinds = this.db.prepare(`
      SELECT evidence.kind, COUNT(*) AS count
      FROM patrol_evidence
      JOIN evidence ON evidence.id=patrol_evidence.evidence_id
      WHERE patrol_evidence.patrol_id=?
      GROUP BY evidence.kind ORDER BY count DESC, evidence.kind
    `).all(id);
    const evidence = this.db.prepare(`
      SELECT evidence.id, evidence.kind, evidence.title,
        substr(evidence.content, 1, 1200) AS content,
        evidence.occurred_at, evidence.collected_at, evidence.source_locator
      FROM patrol_evidence
      JOIN evidence ON evidence.id=patrol_evidence.evidence_id
      WHERE patrol_evidence.patrol_id=?
      ORDER BY COALESCE(evidence.occurred_at, evidence.collected_at) DESC
      LIMIT 40
    `).all(id);

    return { run, tasks, actions, evidenceKinds, evidence };
  }

  taskDetails(id) {
    const task = this.db.prepare(`
      SELECT tasks.*, projects.name AS project_name
      FROM tasks
      LEFT JOIN projects ON projects.project_key=tasks.project_key
      WHERE tasks.id=?
    `).get(id);
    if (!task) return null;
    const parse = (value, fallback) => {
      try { return JSON.parse(value || ""); } catch { return fallback; }
    };
    const evidenceIds = parse(task.source_evidence_ids_json, []);
    const taskMetadata = parse(task.metadata_json, {});
    const evidence = evidenceIds.length
      ? this.db.prepare(`
          SELECT id, kind, occurred_at, collected_at, title,
            substr(content, 1, 5000) AS content, source_locator, external_id, metadata_json
          FROM evidence
          WHERE id IN (${evidenceIds.map(() => "?").join(",")})
          ORDER BY COALESCE(occurred_at, collected_at) DESC
        `).all(...evidenceIds).map((row) => ({ ...row, metadata: parse(row.metadata_json, {}) }))
      : [];
    const actions = this.db.prepare(`
      SELECT id, action_type, risk_level, status, started_at, completed_at,
        command_summary, result, error, metadata_json
      FROM action_log WHERE task_id=? ORDER BY started_at DESC
    `).all(id).map((row) => ({ ...row, metadata: parse(row.metadata_json, {}) }));
    const patrol = taskMetadata.patrolRunId
      ? this.db.prepare(`
          SELECT id, started_at, completed_at, status, evidence_count, task_count,
            codex_thread_id, summary, no_action_reason, error, metadata_json
          FROM patrol_runs WHERE id=?
        `).get(taskMetadata.patrolRunId) ?? null
      : null;
    if (patrol) {
      patrol.metadata = parse(patrol.metadata_json, {});
      delete patrol.metadata_json;
    }
    return {
      task: {
        ...task,
        source_evidence_ids_json: undefined,
        metadata_json: undefined,
        metadata: taskMetadata,
      },
      patrol,
      actions,
      evidence,
    };
  }

  stats() {
    const tables = ["sources", "projects", "threads", "artifacts", "evidence", "knowledge_candidates", "tasks", "patrol_runs", "action_log", "controller_turn_metrics", "digest_queue", "external_event_receipts", "conversation_bindings", "reminders", "condition_watches", "direct_input_receipts", "controller_outbox", "outbound_message_drafts"];
    const counts = {};
    for (const table of tables) counts[table] = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    counts.openTasks = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('new','planned','running','waiting_user','blocked','failed')").get().count;
    counts.backlogTasks = this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status='backlog'").get().count;
    counts.sourceErrors = this.db.prepare("SELECT COUNT(*) AS count FROM sources WHERE status='error'").get().count;
    counts.digestQueue = counts.digest_queue;
    counts.unpatrolledEvidence = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM evidence e
      LEFT JOIN patrol_evidence pe ON pe.evidence_id=e.id
      WHERE pe.evidence_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM evidence_links superseded
          WHERE superseded.child_evidence_id=e.id AND superseded.relation='supersedes'
        )
        AND e.kind IN (
          'codex_memory_document','codex_thread_digest','git_history_digest','project_document_digest',
          'git_repository_snapshot','import_document','feishu_message','feishu_approval_task',
          'feishu_task','feishu_document_index','feishu_document_content','shadow_agent_task_result'
        )
    `).get().count;
    counts.contextGraph = contextGraphStats(this.db, { initialize: !this.readOnly });
    counts.legacyTasks = counts.tasks;
    return counts;
  }
}
