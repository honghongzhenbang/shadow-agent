import { nowIso, sha256, stableJson, truncateUtf8, entrySearchSummary } from "./utils.mjs";
import { initializeUserProfile } from "./user-profile-schema.mjs";
import { buildKnowledgeEntry, collectEntryTargets, maintainedEntryRows,
  entryTarget, initializeKnowledgeEntries } from "./knowledge-entries.mjs";
import { initializeContextDelivery, appendChangeEvidence, COMPLETE_EVIDENCE_POLICY } from "./context-delivery.mjs";
import {
  EPISTEMIC_GRAPH_VERSION,
  backfillGraphReviewState,
  enqueueKnowledgeBackfill,
  epistemicGraphStats,
  initializeEpistemicGraph,
  loadOntologyFile,
} from "./graph-model.mjs";
import {
  initializeGraphMaintenance,
  propagateKnowledgeStaleness,
} from "./graph-maintenance.mjs";

export const CONTEXT_GRAPH_VERSION = EPISTEMIC_GRAPH_VERSION;

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_entities (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  project_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS graph_entities_type_idx ON graph_entities(type, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS graph_entities_project_idx ON graph_entities(project_key, type, updated_at DESC);

CREATE TABLE IF NOT EXISTS graph_aliases (
  alias_key TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'name',
  created_at TEXT NOT NULL,
  FOREIGN KEY(entity_id) REFERENCES graph_entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_aliases_entity_idx ON graph_aliases(entity_id);

CREATE TABLE IF NOT EXISTS graph_facts (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  subject_entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_entity_id TEXT,
  object_value TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 1.0,
  valid_from TEXT,
  valid_to TEXT,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(subject_entity_id) REFERENCES graph_entities(id) ON DELETE CASCADE,
  FOREIGN KEY(object_entity_id) REFERENCES graph_entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_facts_subject_idx ON graph_facts(subject_entity_id, status, predicate);
CREATE INDEX IF NOT EXISTS graph_facts_object_idx ON graph_facts(object_entity_id, status, predicate);
CREATE INDEX IF NOT EXISTS graph_facts_temporal_idx ON graph_facts(status, observed_at DESC, valid_to);

CREATE TABLE IF NOT EXISTS graph_entity_evidence (
  entity_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supported_by',
  observed_at TEXT NOT NULL,
  PRIMARY KEY(entity_id, evidence_id, relation),
  FOREIGN KEY(entity_id) REFERENCES graph_entities(id) ON DELETE CASCADE,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS graph_entity_evidence_evidence_idx ON graph_entity_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS graph_fact_evidence (
  fact_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(fact_id, evidence_id),
  FOREIGN KEY(fact_id) REFERENCES graph_facts(id) ON DELETE CASCADE,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS context_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  coalesce_key TEXT,
  kind TEXT NOT NULL,
  entity_id TEXT,
  fact_id TEXT,
  evidence_id TEXT,
  project_key TEXT,
  session_key TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  not_before TEXT,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  acknowledged_at TEXT,
  ack_note TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(entity_id) REFERENCES graph_entities(id) ON DELETE SET NULL,
  FOREIGN KEY(fact_id) REFERENCES graph_facts(id) ON DELETE SET NULL,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS context_changes_queue_idx ON context_changes(status, priority, seq);
CREATE INDEX IF NOT EXISTS context_changes_lease_idx ON context_changes(status, lease_until);

CREATE TABLE IF NOT EXISTS controller_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS controller_outbox_queue_idx ON controller_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS outbound_message_drafts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'feishu',
  message_kind TEXT NOT NULL DEFAULT 'question',
  sender_identity TEXT NOT NULL DEFAULT 'user',
  approval_mode TEXT NOT NULL DEFAULT 'hitl',
  recipient_name TEXT NOT NULL,
  recipient_open_id TEXT,
  chat_id TEXT,
  reply_to_message_id TEXT,
  reply_in_thread INTEGER NOT NULL DEFAULT 0,
  conversation_key TEXT,
  session_key TEXT NOT NULL DEFAULT 'agent:main:shadow-events',
  task_id TEXT,
  content TEXT NOT NULL,
  approved_content TEXT,
  reason TEXT NOT NULL DEFAULT '',
  source_locator TEXT,
  source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  review_context_json TEXT NOT NULL DEFAULT '{}',
  track_reply INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending_confirmation',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'openclaw-main',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  cancelled_at TEXT,
  send_started_at TEXT,
  sent_at TEXT,
  sent_message_id TEXT,
  sent_chat_id TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS outbound_message_drafts_status_idx
  ON outbound_message_drafts(status, created_at);

CREATE TABLE IF NOT EXISTS work_task_attention (
  card_id TEXT PRIMARY KEY,
  deadline_at TEXT,
  user_pinned INTEGER NOT NULL DEFAULT 0,
  importance INTEGER NOT NULL DEFAULT 50,
  business_impact TEXT,
  project_key TEXT,
  owner_session_key TEXT,
  source_conversation_key TEXT,
  binding_reason TEXT,
  binding_revision INTEGER NOT NULL DEFAULT 1,
  bound_at TEXT,
  last_operation_id TEXT,
  last_operation_at TEXT,
  next_review_at TEXT,
  last_progress_requested_at TEXT,
  last_progress_event_key TEXT,
  progress_revision INTEGER NOT NULL DEFAULT 0,
  continuation_kind TEXT,
  continuation_reference_id TEXT,
  continuation_summary TEXT,
  continuation_user_action_json TEXT,
  continuation_change_seq INTEGER,
  continuation_recorded_at TEXT,
  continuation_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  last_result_state TEXT,
  last_result_summary TEXT,
  last_result_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  last_result_checked_at TEXT,
  progress_plan_json TEXT,
  notes TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS work_task_attention_deadline_idx
  ON work_task_attention(deadline_at, user_pinned, importance);

CREATE VIRTUAL TABLE IF NOT EXISTS graph_entity_fts USING fts5(
  entity_id UNINDEXED,
  name,
  summary,
  aliases,
  tokenize='unicode61'
);
`;

const MATERIALIZED_EVIDENCE_KINDS = [
  "codex_thread_digest",
  "git_history_digest",
  "git_repository_snapshot",
  "project_document_digest",
  "project_document",
  "feishu_message",
  "feishu_approval_task",
  "feishu_task",
  "feishu_document_content",
  "shadow_agent_task_result",
];

const BOOTSTRAP_EVIDENCE_KINDS = [
  "codex_thread_digest",
  "git_history_digest",
  "git_repository_snapshot",
  "project_document_digest",
  "project_document",
  "feishu_approval_task",
  "feishu_task",
  "shadow_agent_task_result",
];

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function setting(database, key, fallback = "") {
  return database.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? fallback;
}

function setSetting(database, key, value) {
  database.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, String(value), nowIso());
}

function entityId(canonicalKey) {
  return sha256(`graph-entity:${canonicalKey}`).slice(0, 32);
}

function factId(fingerprint) {
  return sha256(`graph-fact:${fingerprint}`).slice(0, 32);
}

function normalizeAliases(values) {
  return [...new Set(values
    .map((value) => truncateUtf8(String(value ?? "").trim(), 2000))
    .filter(Boolean))].sort();
}

export function emitContextChange(database, input) {
  const completeDelivery = input.metadata?.deliveryPolicy === COMPLETE_EVIDENCE_POLICY;
  const coalesceKey = input.coalesceKey ?? (input.entityId ? `entity:${input.entityId}` : null);
  if (coalesceKey) {
    const queued = database.prepare(`
      SELECT seq, metadata_json, not_before FROM context_changes
      WHERE coalesce_key=? AND status='pending'
      ORDER BY seq DESC LIMIT 1
    `).get(coalesceKey);
    if (queued) {
      const previous = parseJson(queued.metadata_json);
      const incoming = input.metadata ?? {};
      const metadata = input.kind === "evidence_batch_ingested"
        ? {
            ...previous,
            ...incoming,
            count: Number(previous.count ?? 0) + Number(incoming.count ?? 0),
            evidenceIds: [...new Set([
              ...(previous.evidenceIds ?? []),
              ...(incoming.evidenceIds ?? []),
            ])].slice(-100),
            ownershipSignals: [...new Set([
              ...(previous.ownershipSignals ?? []),
              ...(incoming.ownershipSignals ?? []),
            ])],
            titles: [...new Set([
              ...(previous.titles ?? []),
              ...(incoming.titles ?? []),
            ])].slice(-8),
          }
        : incoming;
      const summary = input.kind === "evidence_batch_ingested" && metadata.count > Number(incoming.count ?? 0)
        ? `${input.summary}（待处理包累计 ${metadata.count} 条）`
        : input.summary;
      database.prepare(`
        UPDATE context_changes SET
          kind=?, entity_id=?, fact_id=?, evidence_id=?, project_key=?,
          session_key=COALESCE(?, session_key),
          priority=CASE
            WHEN priority='critical' OR ?='critical' THEN 'critical'
            WHEN priority='high' OR ?='high' THEN 'high'
            ELSE ?
          END,
          occurred_at=?, summary=?, metadata_json=?, not_before=COALESCE(?, not_before)
        WHERE seq=?
      `).run(
        input.kind,
        input.entityId ?? null,
        input.factId ?? null,
        input.evidenceId ?? null,
        input.projectKey ?? null,
        input.sessionKey ?? null,
        input.priority ?? "normal",
        input.priority ?? "normal",
        input.priority ?? "normal",
        input.occurredAt ?? null,
        truncateUtf8(summary, 1200),
        stableJson(metadata),
        completeDelivery && queued.not_before && input.notBefore
          ? [queued.not_before, input.notBefore].sort()[0] : input.notBefore ?? null,
        queued.seq,
      );
      if (completeDelivery) appendChangeEvidence(database, queued.seq, [...(input.metadata?.evidenceIds ?? []), input.evidenceId]);
      return { seq: queued.seq, coalesced: true };
    }
  }
  database.prepare(`
    INSERT INTO context_changes(
      event_key, coalesce_key, kind, entity_id, fact_id, evidence_id, project_key, session_key, priority,
      status, not_before, occurred_at, created_at, summary, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING
  `).run(
    input.eventKey,
    coalesceKey,
    input.kind,
    input.entityId ?? null,
    input.factId ?? null,
    input.evidenceId ?? null,
    input.projectKey ?? null,
    input.sessionKey ?? null,
    input.priority ?? "normal",
    input.notBefore ?? null,
    input.occurredAt ?? null,
    nowIso(),
    truncateUtf8(input.summary, 1200),
    stableJson(input.metadata ?? {}),
  );
  const inserted = database.prepare("SELECT seq FROM context_changes WHERE event_key=?").get(input.eventKey);
  if (completeDelivery) appendChangeEvidence(database, inserted.seq, [...(input.metadata?.evidenceIds ?? []), input.evidenceId]);
  return { seq: inserted.seq, coalesced: false };
}

function rebuildEntitySearch(database) {
  database.exec("DELETE FROM graph_entity_fts");
  for (const row of database.prepare("SELECT id FROM graph_entities").all()) refreshEntitySearch(database, row.id);
}

function refreshEntitySearch(database, id) {
  const entity = database.prepare("SELECT rowid, id, name, summary, metadata_json FROM graph_entities WHERE id=?").get(id);
  if (!entity) return;
  const aliases = database.prepare("SELECT alias FROM graph_aliases WHERE entity_id=? ORDER BY alias").all(id)
    .map((row) => row.alias).join(" ");
  database.prepare("DELETE FROM graph_entity_fts WHERE rowid=?").run(entity.rowid);
  database.prepare("INSERT INTO graph_entity_fts(rowid, entity_id, name, summary, aliases) VALUES(?, ?, ?, ?, ?)")
    .run(entity.rowid, entity.id, entity.name, entrySearchSummary(entity), aliases);
}

function upsertEntity(database, input, options = {}) {
  const id = entityId(input.canonicalKey);
  const existing = database.prepare("SELECT * FROM graph_entities WHERE canonical_key=?").get(input.canonicalKey);
  const timestamp = input.observedAt ?? nowIso();
  const existingMetadata = parseJson(existing?.metadata_json);
  const incomingMetadata = input.metadata ?? {};
  const incomingPresentationPriority = Number(input.presentationPriority ?? incomingMetadata.presentationPriority ?? 10);
  const existingPresentationPriority = Number(existingMetadata.presentationPriority ?? 0);
  const preservePresentation = Boolean(existing) && existingPresentationPriority > incomingPresentationPriority;
  const name = (options.preserveName || preservePresentation) && existing?.name
    ? existing.name
    : truncateUtf8(input.name, 2000);
  const aliases = normalizeAliases([name, input.name, ...(input.aliases ?? [])]);
  const summary = (options.preserveSummary || preservePresentation) && existing?.summary ? existing.summary : (input.summary ?? "");
  const projectKey = input.projectKey ?? existing?.project_key ?? null;
  const status = input.status ?? existing?.status ?? "active";
  const metadataJson = stableJson({
    ...existingMetadata,
    ...incomingMetadata,
    presentationPriority: Math.max(existingPresentationPriority, incomingPresentationPriority),
  });
  const changed = !existing
    || existing.type !== input.type
    || existing.name !== name
    || existing.summary !== summary
    || existing.project_key !== projectKey
    || existing.status !== status
    || existing.metadata_json !== metadataJson;

  database.prepare(`
    INSERT INTO graph_entities(
      id, canonical_key, type, name, summary, project_key, status,
      first_seen_at, last_seen_at, updated_at, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_key) DO UPDATE SET
      type=excluded.type, name=excluded.name, summary=excluded.summary,
      project_key=excluded.project_key, status=excluded.status,
      last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at,
      metadata_json=excluded.metadata_json
  `).run(
    id,
    input.canonicalKey,
    input.type,
    name,
    truncateUtf8(summary, 12000),
    projectKey,
    status,
    existing?.first_seen_at ?? timestamp,
    timestamp,
    nowIso(),
    metadataJson,
  );

  database.prepare("DELETE FROM graph_aliases WHERE entity_id=? AND length(CAST(alias AS BLOB))>2000").run(id);
  for (const alias of aliases) {
    const aliasKey = sha256(`${id}:${alias.toLocaleLowerCase()}`).slice(0, 32);
    database.prepare(`
      INSERT INTO graph_aliases(alias_key, entity_id, alias, kind, created_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(alias_key) DO UPDATE SET entity_id=excluded.entity_id, alias=excluded.alias, kind=excluded.kind
    `).run(aliasKey, id, alias, alias === name ? "name" : "alias", nowIso());
  }
  if (changed || !existing) refreshEntitySearch(database, id);
  if (changed && options.emitChanges) {
    emitContextChange(database, {
      eventKey: `entity:${id}:${sha256(`${name}:${summary}:${status}`).slice(0, 16)}`,
      kind: existing ? "entity_updated" : "entity_created",
      entityId: id,
      projectKey,
      occurredAt: timestamp,
      summary: `${input.type} ${name}${existing ? "发生更新" : "已进入知识图谱"}`,
      metadata: { type: input.type, canonicalKey: input.canonicalKey },
    });
  }
  return { id, changed, inserted: !existing };
}

function upsertFact(database, input, options = {}) {
  const objectKey = input.objectEntityId ?? stableJson(input.objectValue ?? null);
  const fingerprint = sha256(`${input.subjectEntityId}:${input.predicate}:${objectKey}`);
  const id = factId(fingerprint);
  const observedAt = input.observedAt ?? nowIso();
  const existing = database.prepare("SELECT * FROM graph_facts WHERE fingerprint=?").get(fingerprint);

  if (options.singleValued) {
    database.prepare(`
      UPDATE graph_facts SET status='superseded', valid_to=?, updated_at=?
      WHERE subject_entity_id=? AND predicate=? AND status='active'
        AND id<>?
    `).run(observedAt, nowIso(), input.subjectEntityId, input.predicate, id);
  }

  database.prepare(`
    INSERT INTO graph_facts(
      id, fingerprint, subject_entity_id, predicate, object_entity_id, object_value,
      status, confidence, valid_from, valid_to, observed_at, updated_at, metadata_json,
      assertion_mode, epistemic_status, created_by
    ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      status='active', confidence=excluded.confidence, valid_to=NULL,
      observed_at=excluded.observed_at, updated_at=excluded.updated_at,
      metadata_json=excluded.metadata_json, assertion_mode=excluded.assertion_mode,
      epistemic_status=excluded.epistemic_status, created_by=excluded.created_by
  `).run(
    id,
    fingerprint,
    input.subjectEntityId,
    input.predicate,
    input.objectEntityId ?? null,
    input.objectValue === undefined ? null : stableJson(input.objectValue),
    input.confidence ?? 1,
    input.validFrom ?? observedAt,
    observedAt,
    nowIso(),
    stableJson(input.metadata ?? {}),
    input.assertionMode ?? "observed",
    input.epistemicStatus ?? (input.assertionMode === "structural_route" ? "proposed" : "supported"),
    input.createdBy ?? "system",
  );

  if (!existing && options.emitChanges) {
    emitContextChange(database, {
      eventKey: `fact:${id}:${observedAt}`,
      kind: "fact_asserted",
      entityId: input.subjectEntityId,
      factId: id,
      projectKey: input.projectKey,
      occurredAt: observedAt,
      summary: input.summary ?? `新事实：${input.predicate}`,
      metadata: { predicate: input.predicate },
    });
  }
  return { id, inserted: !existing };
}

function linkEntityEvidence(database, entity, evidence, relation = "supported_by") {
  database.prepare(`
    INSERT OR IGNORE INTO graph_entity_evidence(entity_id, evidence_id, relation, observed_at)
    VALUES(?, ?, ?, ?)
  `).run(entity, evidence.id, relation, evidence.occurred_at ?? evidence.collected_at ?? nowIso());
}

function projectEntity(database, projectKey) {
  if (!projectKey) return null;
  return database.prepare("SELECT id FROM graph_entities WHERE canonical_key=?").get(`project:${projectKey}`)?.id ?? null;
}

function evidenceEntityInput(evidence, metadata) {
  if (evidence.thread_id && evidence.kind !== "feishu_message") {
    return {
      canonicalKey: `session:${evidence.thread_id}`,
      type: "Session",
      name: (evidence.title || evidence.thread_id).replace(/\s*\[digest \d+\]$/i, ""),
      summary: evidence.kind === "codex_thread_digest" ? evidence.content : "",
      aliases: [evidence.thread_id],
      projectKey: evidence.project_key,
      observedAt: evidence.occurred_at ?? evidence.collected_at,
      metadata: { threadId: evidence.thread_id, sourceKind: evidence.kind },
    };
  }
  if (evidence.kind === "feishu_message") {
    const conversationKey = metadata.conversationKey
      ?? `im:${metadata.chatId ?? "unknown"}:thread:${metadata.threadId ?? "main"}`;
    return {
      canonicalKey: `conversation:${conversationKey}`,
      type: "Conversation",
      name: evidence.title || conversationKey,
      summary: "可持续查询的会话入口；消息正文保存在 Evidence Log。",
      aliases: [conversationKey, metadata.chatId],
      projectKey: evidence.project_key,
      observedAt: evidence.occurred_at ?? evidence.collected_at,
      metadata: {
        conversationKey,
        chatId: metadata.chatId,
        chatType: metadata.chatType,
        threadId: metadata.threadId,
        sourceKind: evidence.kind,
      },
    };
  }
  const externalKey = evidence.external_id ?? evidence.source_locator ?? evidence.id;
  const type = evidence.kind === "feishu_message"
    ? "Message"
    : evidence.kind === "feishu_approval_task"
      ? "Approval"
      : evidence.kind === "feishu_task"
        ? "ExternalTask"
        : evidence.kind.includes("document")
          ? "Document"
          : "WorkEvent";
  return {
    canonicalKey: `${type.toLocaleLowerCase()}:${externalKey}`,
    type,
    name: evidence.title || evidence.kind,
    summary: evidence.content,
    projectKey: evidence.project_key,
    observedAt: evidence.occurred_at ?? evidence.collected_at,
    metadata: { externalId: evidence.external_id, sourceKind: evidence.kind, sourceLocator: evidence.source_locator },
  };
}

export function initializeContextGraph(database) {
  database.exec(GRAPH_SCHEMA);
  initializeKnowledgeEntries(database);
  initializeContextDelivery(database);
  initializeEpistemicGraph(database);
  initializeUserProfile(database);
  initializeGraphMaintenance(database);
  const columns = new Set(database.prepare("PRAGMA table_info(context_changes)").all().map((row) => row.name));
  if (!columns.has("coalesce_key")) {
    database.exec("ALTER TABLE context_changes ADD COLUMN coalesce_key TEXT");
  }
  if (!columns.has("session_key")) {
    database.exec("ALTER TABLE context_changes ADD COLUMN session_key TEXT");
  }
  if (!columns.has("not_before")) {
    database.exec("ALTER TABLE context_changes ADD COLUMN not_before TEXT");
  }
  const outboundColumns = new Set(database.prepare("PRAGMA table_info(outbound_message_drafts)").all().map((row) => row.name));
  if (!outboundColumns.has("sender_identity")) {
    database.exec("ALTER TABLE outbound_message_drafts ADD COLUMN sender_identity TEXT NOT NULL DEFAULT 'user'");
  }
  if (!outboundColumns.has("approval_mode")) {
    database.exec("ALTER TABLE outbound_message_drafts ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'hitl'");
  }
  if (!outboundColumns.has("review_context_json")) {
    database.exec("ALTER TABLE outbound_message_drafts ADD COLUMN review_context_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!outboundColumns.has("task_id")) {
    database.exec("ALTER TABLE outbound_message_drafts ADD COLUMN task_id TEXT");
  }
  const taskAttentionColumns = new Set(database.prepare("PRAGMA table_info(work_task_attention)").all().map((row) => row.name));
  const taskAttentionMigrations = [
    ["owner_session_key", "owner_session_key TEXT"],
    ["source_conversation_key", "source_conversation_key TEXT"],
    ["binding_reason", "binding_reason TEXT"],
    ["binding_revision", "binding_revision INTEGER NOT NULL DEFAULT 1"],
    ["bound_at", "bound_at TEXT"],
    ["last_operation_id", "last_operation_id TEXT"],
    ["last_operation_at", "last_operation_at TEXT"],
    ["next_review_at", "next_review_at TEXT"],
    ["last_progress_requested_at", "last_progress_requested_at TEXT"],
    ["last_progress_event_key", "last_progress_event_key TEXT"],
    ["progress_revision", "progress_revision INTEGER NOT NULL DEFAULT 0"],
    ["continuation_kind", "continuation_kind TEXT"],
    ["continuation_reference_id", "continuation_reference_id TEXT"],
    ["continuation_summary", "continuation_summary TEXT"],
    ["continuation_user_action_json", "continuation_user_action_json TEXT"],
    ["continuation_change_seq", "continuation_change_seq INTEGER"],
    ["continuation_recorded_at", "continuation_recorded_at TEXT"],
    ["continuation_evidence_ids_json", "continuation_evidence_ids_json TEXT NOT NULL DEFAULT '[]'"],
    ["last_result_state", "last_result_state TEXT"],
    ["last_result_summary", "last_result_summary TEXT"],
    ["last_result_evidence_ids_json", "last_result_evidence_ids_json TEXT NOT NULL DEFAULT '[]'"],
    ["last_result_checked_at", "last_result_checked_at TEXT"],
    ["progress_plan_json", "progress_plan_json TEXT"],
  ];
  for (const [column, definition] of taskAttentionMigrations) {
    if (!taskAttentionColumns.has(column)) database.exec(`ALTER TABLE work_task_attention ADD COLUMN ${definition}`);
  }
  const timestamp = nowIso();
  database.prepare(`
    UPDATE context_changes
    SET status='acknowledged', acknowledged_at=COALESCE(acknowledged_at, ?),
        ack_note=COALESCE(ack_note, 'structural projection is not actionable')
    WHERE status='pending' AND kind IN ('entity_created', 'entity_updated')
  `).run(timestamp);
  database.prepare(`
    UPDATE context_changes
    SET status='acknowledged', acknowledged_at=COALESCE(acknowledged_at, ?),
        ack_note=COALESCE(ack_note, 'superseded by exact knowledge delta review')
    WHERE status='pending' AND kind='evidence_batch_ingested'
      AND evidence_id IN (
        SELECT id FROM evidence
        WHERE kind='shadow_agent_task_result'
          AND json_valid(metadata_json)
          AND json_extract(metadata_json, '$.knowledgeDelta.idempotencyKey') IS NOT NULL
      )
  `).run(timestamp);
  const queued = database.prepare(`
    SELECT seq, kind, entity_id, project_key, metadata_json
    FROM context_changes WHERE status='pending' ORDER BY seq DESC
  `).all();
  const seen = new Set();
  for (const change of queued) {
    const metadata = parseJson(change.metadata_json);
    // Delivered pages have independent cursors; startup must not acknowledge or merge them.
    if (metadata.deliveryPolicy === COMPLETE_EVIDENCE_POLICY) continue;
    const coalesceKey = change.kind === "evidence_batch_ingested"
      ? metadata.conversationKey
        ? `evidence-batch:feishu-conversation:${metadata.conversationKey}`
        : `evidence-batch:${change.project_key ?? "unassigned"}:${metadata.evidenceKind ?? "unknown"}`
      : change.entity_id
        ? `entity:${change.entity_id}`
        : null;
    if (!coalesceKey) continue;
    if (seen.has(coalesceKey)) {
      database.prepare(`
        UPDATE context_changes
        SET status='acknowledged', acknowledged_at=?, ack_note='coalesced by temporal-context-v2'
        WHERE seq=?
      `).run(timestamp, change.seq);
      continue;
    }
    seen.add(coalesceKey);
    database.prepare("UPDATE context_changes SET coalesce_key=? WHERE seq=?").run(coalesceKey, change.seq);
  }
  database.prepare(`
    UPDATE context_changes SET coalesce_key='entity:' || entity_id
    WHERE status='leased' AND entity_id IS NOT NULL AND coalesce_key IS NULL
  `).run();
  database.exec("CREATE INDEX IF NOT EXISTS context_changes_coalesce_idx ON context_changes(coalesce_key, status, seq)");
  database.exec("CREATE INDEX IF NOT EXISTS context_changes_session_queue_idx ON context_changes(status, session_key, not_before, priority, seq)");
  database.exec("CREATE INDEX IF NOT EXISTS work_task_attention_owner_session_idx ON work_task_attention(owner_session_key, updated_at)");
  database.exec("CREATE INDEX IF NOT EXISTS context_changes_task_seq_idx ON context_changes(json_extract(metadata_json, '$.taskId'), seq)");
  database.exec("CREATE INDEX IF NOT EXISTS work_task_attention_next_review_idx ON work_task_attention(next_review_at, importance)");
  // Schema readiness is distinct from completing historical materialization.
  setSetting(database, "contextGraph:schemaVersion", CONTEXT_GRAPH_VERSION);
}

// Shared by incremental collection and the explicit historical repair command.
// Only derived navigation entries are rebuilt; evidence and semantic facts are untouched.
export function refreshKnowledgeEntries(database, rows) {
  const candidates = maintainedEntryRows(database, rows);
  const entries = new Map();
  for (const target of collectEntryTargets(candidates)) {
    const entry = buildKnowledgeEntry(database, target);
    if (!entry) continue;
    const item = upsertEntity(database, entry.input, { emitChanges: false, preserveName: target.kind === "repository" });
    const linked = database.prepare("SELECT evidence_id FROM graph_entity_evidence WHERE entity_id=? AND relation='retrieval_source' ORDER BY evidence_id").all(item.id).map(row => row.evidence_id);
    const desired = entry.sources.map(row => row.id).sort();
    if (stableJson(linked) !== stableJson(desired)) {
      database.prepare("DELETE FROM graph_entity_evidence WHERE entity_id=? AND relation='retrieval_source'").run(item.id);
      for (const source of entry.sources) linkEntityEvidence(database, item.id, source, "retrieval_source");
    }
    const project = projectEntity(database, entry.input.projectKey);
    const existingMembership = database.prepare("SELECT id FROM graph_facts WHERE subject_entity_id=? AND predicate='BELONGS_TO' LIMIT 1").get(item.id);
    if (project && !existingMembership) upsertFact(database, { subjectEntityId: item.id, predicate: "BELONGS_TO", objectEntityId: project,
      projectKey: entry.input.projectKey, observedAt: entry.input.observedAt,
      assertionMode: "structural_route", epistemicStatus: "proposed",
      metadata: { structuralSource: { table: "evidence", key: entry.sources[0].id } },
    }, { emitChanges: false, singleValued: true });
    entries.set(`${target.kind}:${target.key}`, { ...entry, item });
  }
  return entries;
}

export function materializeContextGraph(store, config, options = {}) {
  const database = store.db;
  initializeContextGraph(database);
  const refreshStructural = options.refreshStructural !== false;
  const runMaintenance = options.runMaintenance !== false;
  const ontologyPackages = [];
  if (refreshStructural) {
    for (const ontologyPath of config.contextGraph?.ontologyFiles ?? []) {
      ontologyPackages.push(loadOntologyFile(database, ontologyPath));
    }
  }
  const initialized = setting(database, "contextGraph:version") === CONTEXT_GRAPH_VERSION;
  const emitChanges = initialized && options.emitChanges !== false;
  const startedAt = nowIso();
  const counts = { entities: 0, facts: 0, evidenceLinks: 0, changes: 0 };
  let knowledgeBackfill = { queued: 0 };
  let graphReviewBackfill = { reviewed: 0, linked: 0, requeued: 0 };
  let graphMaintenance = { persisted: false, changes: { total: 0 } };

  database.exec("BEGIN IMMEDIATE");
  try {
    const boundOwner = database.prepare(`SELECT entity.id FROM user_profile_binding binding
      JOIN graph_entities entity ON entity.id=binding.owner_entity_id
      WHERE binding.id='primary' AND entity.status='active'`).get();
    const self = boundOwner ? { id: boundOwner.id, changed: false } : upsertEntity(database, {
      canonicalKey: "person:self",
      type: "Person",
      name: "当前用户",
      summary: "Shadow Agent 所服务的工作责任主体。",
      aliases: ["我", "用户"],
      metadata: { identity: "self" },
    }, { emitChanges: false });
    counts.entities += Number(self.changed);

    database.prepare(`
      UPDATE graph_facts SET status='superseded', valid_to=?, updated_at=?,
        metadata_json=json_set(
          CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
          '$.governance.supersededReason', 'local_workspace_is_not_responsibility',
          '$.governance.supersededAt', ?
        )
      WHERE status='active' AND predicate='TRACKS_PROJECT' AND created_by='system'
        AND NOT EXISTS (SELECT 1 FROM graph_evidence_assessments a WHERE a.fact_id=graph_facts.id)
        AND NOT EXISTS (SELECT 1 FROM graph_derivations d WHERE d.conclusion_fact_id=graph_facts.id)
    `).run(startedAt, startedAt, startedAt);

    const projects = refreshStructural
      ? database.prepare("SELECT * FROM projects ORDER BY project_key").all()
      : [];
    for (const project of projects) {
      const item = upsertEntity(database, {
        canonicalKey: `project:${project.project_key}`,
        type: "Project",
        name: project.name || project.project_key,
        summary: `项目目录：${project.root_path}`,
        aliases: [project.project_key, project.root_path],
        projectKey: project.project_key,
        metadata: { rootPath: project.root_path, source: project.source, ...parseJson(project.metadata_json) },
      }, { emitChanges: false, preserveSummary: true });
      counts.entities += Number(item.changed);
      const fact = upsertFact(database, {
        subjectEntityId: self.id,
        predicate: "HAS_LOCAL_WORKSPACE",
        objectEntityId: item.id,
        projectKey: project.project_key,
        summary: `本机可查询项目工作区 ${project.name || project.project_key}`,
        assertionMode: "structural_route",
        epistemicStatus: "proposed",
        confidence: 1,
        metadata: {
          structuralSource: { table: "projects", key: project.project_key },
          responsibilitySemantics: false,
        },
      }, { emitChanges: false });
      counts.facts += Number(fact.inserted);
    }

    const threads = refreshStructural
      ? database.prepare("SELECT * FROM threads ORDER BY updated_at_ms").all()
      : [];
    for (const thread of threads) {
      const item = upsertEntity(database, {
        canonicalKey: `session:${thread.id}`,
        type: "Session",
        name: thread.title || thread.id,
        summary: thread.cwd ? `Codex 会话目录：${thread.cwd}` : "Codex 会话",
        aliases: [thread.id, thread.cwd],
        projectKey: thread.project_key,
        status: thread.archived ? "archived" : "active",
        observedAt: thread.updated_at_ms ? new Date(thread.updated_at_ms).toISOString() : startedAt,
        metadata: { rolloutPath: thread.rollout_path, createdAtMs: thread.created_at_ms, updatedAtMs: thread.updated_at_ms },
      }, { emitChanges: false, preserveSummary: true });
      counts.entities += Number(item.changed);
      const project = projectEntity(database, thread.project_key);
      if (project) {
        const fact = upsertFact(database, {
          subjectEntityId: item.id,
          predicate: "BELONGS_TO",
          objectEntityId: project,
          projectKey: thread.project_key,
          observedAt: thread.updated_at_ms ? new Date(thread.updated_at_ms).toISOString() : startedAt,
          summary: `会话 ${thread.title || thread.id} 归属于项目 ${thread.project_key}`,
          assertionMode: "structural_route",
          epistemicStatus: "proposed",
          metadata: { structuralSource: { table: "threads", key: thread.id } },
        }, { emitChanges: false, singleValued: true });
        counts.facts += Number(fact.inserted);
      }
    }

    const legacyTasks = refreshStructural
      ? database.prepare("SELECT * FROM tasks ORDER BY created_at").all()
      : [];
    for (const task of legacyTasks) {
      const item = upsertEntity(database, {
        canonicalKey: `legacy-task:${task.id}`,
        type: "HistoricalTask",
        name: task.title,
        summary: task.description,
        aliases: [task.id],
        projectKey: task.project_key,
        status: "archived",
        observedAt: task.updated_at,
        metadata: { originalStatus: task.status, priority: task.priority, riskLevel: task.risk_level, actionType: task.action_type },
      }, { emitChanges: false });
      counts.entities += Number(item.changed);
      const project = projectEntity(database, task.project_key);
      if (project) {
        const fact = upsertFact(database, {
          subjectEntityId: item.id,
          predicate: "BELONGS_TO",
          objectEntityId: project,
          projectKey: task.project_key,
          observedAt: task.updated_at,
          assertionMode: "structural_route",
          epistemicStatus: "proposed",
          metadata: { structuralSource: { table: "tasks", key: task.id } },
        }, { emitChanges: false, singleValued: true });
        counts.facts += Number(fact.inserted);
      }
      for (const evidenceId of parseJson(task.source_evidence_ids_json, [])) {
        const evidence = database.prepare("SELECT id, occurred_at, collected_at FROM evidence WHERE id=?").get(evidenceId);
        if (evidence) {
          linkEntityEvidence(database, item.id, evidence, "derived_from");
          counts.evidenceLinks += 1;
        }
      }
    }

    const cursor = Number(setting(database, "contextGraph:evidenceRowid", "0")) || 0;
    const activeKinds = initialized ? MATERIALIZED_EVIDENCE_KINDS : BOOTSTRAP_EVIDENCE_KINDS;
    const placeholders = activeKinds.map(() => "?").join(",");
    const cycleLimit = config.contextGraph?.maxEvidencePerCycle ?? 2000;
    const evidenceRows = initialized
      ? database.prepare(`
          SELECT rowid AS evidence_rowid, * FROM evidence
          WHERE rowid>? AND kind IN (${placeholders})
          ORDER BY rowid ASC LIMIT ?
        `).all(cursor, ...activeKinds, cycleLimit)
      : database.prepare(`
          WITH ranked AS (
            SELECT rowid AS evidence_rowid, *,
              row_number() OVER (
                PARTITION BY kind, COALESCE(
                  thread_id,
                  CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.repoPath') END,
                  project_key,
                  external_id,
                  source_locator
                )
                ORDER BY rowid DESC
              ) AS graph_rank
            FROM evidence
            WHERE kind IN (${placeholders})
              AND (
                kind<>'codex_thread_digest'
                OR (json_valid(metadata_json) AND COALESCE(json_extract(metadata_json, '$.chunkIndex'), 0)=0)
              )
          )
          SELECT * FROM ranked WHERE graph_rank=1
          ORDER BY evidence_rowid DESC LIMIT ?
        `).all(...activeKinds, cycleLimit);
    const batches = new Map();
    const entries = refreshKnowledgeEntries(database, initialized ? evidenceRows : undefined);
    let maxRowid = initialized
      ? cursor
      : Number(database.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM evidence").get()?.value ?? 0);

    for (const evidence of evidenceRows) {
      maxRowid = Math.max(maxRowid, Number(evidence.evidence_rowid));
      const metadata = parseJson(evidence.metadata_json);
      if (evidence.kind === "codex_thread_digest" && Number(metadata.chunkIndex ?? 0) > 0) {
        const existingSession = database.prepare("SELECT id FROM graph_entities WHERE canonical_key=?")
          .get(`session:${evidence.thread_id}`)?.id;
        if (existingSession) {
          linkEntityEvidence(database, existingSession, evidence);
          counts.evidenceLinks += 1;
        }
        continue;
      }
      const target = entryTarget(evidence);
      const entry = target && entries.get(`${target.kind}:${target.key}`);
      if (target && !entry) continue;
      const input = entry?.input ?? evidenceEntityInput(evidence, metadata);
      const item = entry?.item ?? upsertEntity(database, input, {
        emitChanges: false,
        preserveName: ["Session", "Repository"].includes(input.type),
      });
      counts.entities += Number(item.changed);
      if (evidence.kind !== "feishu_message") {
        linkEntityEvidence(database, item.id, evidence);
        counts.evidenceLinks += 1;
      }

      const project = projectEntity(database, evidence.project_key);
      if (project && item.id !== project && !entry) {
        const fact = upsertFact(database, {
          subjectEntityId: item.id,
          predicate: "BELONGS_TO",
          objectEntityId: project,
          projectKey: evidence.project_key,
          observedAt: evidence.occurred_at ?? evidence.collected_at,
          summary: `${input.name} 归属于项目 ${evidence.project_key}`,
          assertionMode: "structural_route",
          epistemicStatus: "proposed",
          metadata: { structuralSource: { table: "evidence", key: evidence.id } },
        }, { emitChanges: false, singleValued: true });
        counts.facts += Number(fact.inserted);
      }

      if (emitChanges) {
        // Document digests already publish the semantic review event for these files.
        if (evidence.kind === "project_document") continue;
        if (evidence.kind === "codex_thread_digest" && metadata.attentionWorthy !== true) continue;
        // Resolved-task knowledge deltas already emit one exact review event.
        // A second generic evidence-batch wake would split the same semantic job.
        if (evidence.kind === "shadow_agent_task_result" && metadata.knowledgeDelta?.idempotencyKey) continue;
        const ownershipSignal = evidence.kind === "feishu_message"
          ? String(metadata.ownershipSignal ?? "unknown")
          : null;
        const conversationKey = evidence.kind === "feishu_message"
          ? String(metadata.conversationKey ?? `im:${metadata.chatId ?? "unknown"}:thread:${metadata.threadId ?? "main"}`)
          : null;
        const key = conversationKey
          ? `feishu-conversation:${conversationKey}`
          : `${evidence.project_key ?? "unassigned"}:${evidence.kind}`;
        const batch = batches.get(key) ?? {
          count: 0,
          kind: evidence.kind,
          projectKey: evidence.project_key,
          entityId: item.id,
          evidenceId: evidence.id,
          occurredAt: evidence.occurred_at ?? evidence.collected_at,
          titles: [],
          evidenceIds: [],
          ownershipSignals: [],
          conversationKey,
        };
        batch.count += 1;
        batch.entityId = item.id;
        batch.evidenceId = evidence.id;
        batch.occurredAt = evidence.occurred_at ?? evidence.collected_at;
        if (evidence.title && batch.titles.length < 3) batch.titles.push(evidence.title);
        if (batch.evidenceIds.length < 100) batch.evidenceIds.push(evidence.id);
        if (ownershipSignal && !batch.ownershipSignals.includes(ownershipSignal)) batch.ownershipSignals.push(ownershipSignal);
        batches.set(key, batch);
      }
    }

    if (maxRowid > cursor) setSetting(database, "contextGraph:evidenceRowid", maxRowid);
    for (const [key, batch] of batches) {
      emitContextChange(database, {
        eventKey: `evidence-batch:${key}:${maxRowid}`,
        coalesceKey: `evidence-batch:${key}`,
        kind: "evidence_batch_ingested",
        entityId: batch.entityId,
        evidenceId: batch.evidenceId,
        projectKey: batch.projectKey,
        occurredAt: batch.occurredAt,
        summary: batch.conversationKey
          ? `飞书会话 ${batch.titles[0] ?? batch.conversationKey} 新增 ${batch.count} 条消息，等待结合会话上下文判断`
          : `${batch.projectKey ?? "未归类"} 新增 ${batch.count} 条 ${batch.kind} 证据${batch.titles.length ? `：${batch.titles.join("；")}` : ""}`,
        metadata: {
          evidenceKind: batch.kind,
          count: batch.count,
          maxRowid,
          conversationKey: batch.conversationKey,
          evidenceIds: batch.evidenceIds,
          ownershipSignals: batch.ownershipSignals,
          titles: batch.titles,
        },
      });
      counts.changes += 1;
    }

    if (runMaintenance) {
      knowledgeBackfill = enqueueKnowledgeBackfill(database, {
        limit: config.contextGraph?.maxKnowledgeBackfillPerCycle ?? 500,
        reason: initialized ? "incremental-knowledge-enrichment" : "legacy-knowledge-backfill",
      });
      graphReviewBackfill = backfillGraphReviewState(database, {
        limit: config.contextGraph?.maxKnowledgeBackfillPerCycle ?? 500,
      });
      graphMaintenance = propagateKnowledgeStaleness(database);
    }

    if (!initialized) {
      setSetting(database, "contextGraph:version", CONTEXT_GRAPH_VERSION);
      setSetting(database, "controller:mode", "openclaw-single-controller");
      emitContextChange(database, {
        eventKey: `graph-bootstrap:${CONTEXT_GRAPH_VERSION}`,
        kind: "graph_bootstrapped",
        priority: "high",
        summary: "V4 认知路由图已建立；原始经历留在证据日志，图谱保存耐久事实和求知路径。",
        metadata: { version: CONTEXT_GRAPH_VERSION, evidenceCursor: maxRowid, ontologyPackages },
      });
      counts.changes += 1;
    }

    if (!initialized) rebuildEntitySearch(database);
    setSetting(database, "contextGraph:lastMaterializedAt", nowIso());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    version: CONTEXT_GRAPH_VERSION,
    startedAt,
    completedAt: nowIso(),
    evidenceCursor: Number(setting(database, "contextGraph:evidenceRowid", "0")),
    ontologyPackages,
    knowledgeBackfill,
    graphReviewBackfill,
    graphMaintenance,
    ...counts,
  };
}

export function contextGraphStats(database, { initialize = true } = {}) {
  if (initialize) initializeContextGraph(database);
  const scalar = (sql) => Number(database.prepare(sql).get()?.value ?? 0);
  return {
    version: setting(database, "contextGraph:version", "uninitialized"),
    entities: scalar("SELECT COUNT(*) AS value FROM graph_entities"),
    activeFacts: scalar("SELECT COUNT(*) AS value FROM graph_facts WHERE status='active'"),
    evidenceLinks: scalar("SELECT COUNT(*) AS value FROM graph_entity_evidence"),
    pendingChanges: scalar("SELECT COUNT(*) AS value FROM context_changes WHERE status='pending' OR (status='leased' AND lease_until<datetime('now'))"),
    leasedChanges: scalar("SELECT COUNT(*) AS value FROM context_changes WHERE status='leased' AND lease_until>=datetime('now')"),
    acknowledgedChanges: scalar("SELECT COUNT(*) AS value FROM context_changes WHERE status='acknowledged'"),
    outboxPending: scalar("SELECT COUNT(*) AS value FROM controller_outbox WHERE status IN ('pending','retry')"),
    lastMaterializedAt: setting(database, "contextGraph:lastMaterializedAt", ""),
    controllerMode: setting(database, "controller:mode", "unknown"),
    graphMaintenanceRuns: scalar("SELECT COUNT(*) AS value FROM graph_maintenance_runs"),
    factsNeedingReview: scalar("SELECT COUNT(*) AS value FROM graph_facts WHERE status='active' AND epistemic_status='needs_review'"),
    epistemic: epistemicGraphStats(database),
  };
}
