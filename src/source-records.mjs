import { canonicalSourceRecord } from "./source-adapters/index.mjs";

export const SOURCE_STORAGE_VERSION = 2;

const STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_observations (
  evidence_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  source_family TEXT NOT NULL CHECK(source_family IN ('collaboration','execution')),
  account_scope TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  event_id TEXT,
  stream_id TEXT,
  parent_id TEXT,
  causation_id TEXT,
  cursor INTEGER,
  visibility TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  provider_payload_ref TEXT NOT NULL,
  FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collaboration_events (
  evidence_id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'unknown',
  space_id TEXT,
  conversation_id TEXT,
  thread_id TEXT,
  message_id TEXT,
  reply_to TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  mentions_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  resource_status TEXT,
  due_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(evidence_id) REFERENCES source_observations(evidence_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_events (
  evidence_id TEXT PRIMARY KEY,
  session_id TEXT,
  parent_session_id TEXT,
  workspace TEXT,
  repository TEXT,
  branch TEXT,
  commit_sha TEXT,
  run_id TEXT,
  turn_id TEXT,
  event_seq INTEGER,
  execution_status TEXT,
  tool_name TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  model_provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  FOREIGN KEY(evidence_id) REFERENCES source_observations(evidence_id) ON DELETE CASCADE
);
`;

const STORAGE_INDEXES = `
CREATE INDEX IF NOT EXISTS source_observations_domain_idx
  ON source_observations(source_family, provider, event_kind, evidence_id);
CREATE INDEX IF NOT EXISTS source_observations_stream_idx
  ON source_observations(provider, stream_id, evidence_id);
CREATE INDEX IF NOT EXISTS source_observations_object_idx
  ON source_observations(provider, source_object_id);
CREATE INDEX IF NOT EXISTS collaboration_events_conversation_idx
  ON collaboration_events(conversation_id, message_id);
CREATE INDEX IF NOT EXISTS execution_events_session_idx
  ON execution_events(session_id, event_seq, evidence_id);
`;

function jsonValue(alias, path) {
  return `CASE WHEN json_valid(${alias}.metadata_json) THEN json_extract(${alias}.metadata_json, '${path}') END`;
}

const providerSql = `COALESCE(
  ${jsonValue("s", "$.sourceAdapter.provider")},
  CASE
    WHEN s.kind IN ('codex_rollout','codex_memory') THEN 'codex'
    WHEN s.kind IN ('feishu','feishu_event','feishu_outbound') THEN 'feishu'
  END
)`;

const familySql = `CASE ${providerSql}
  WHEN 'codex' THEN 'execution'
  WHEN 'feishu' THEN 'collaboration'
END`;

const eventKindSql = `CASE e.kind
  WHEN 'feishu_message' THEN 'message'
  WHEN 'feishu_outbound_message' THEN 'message'
  WHEN 'feishu_task' THEN 'task'
  WHEN 'feishu_approval_task' THEN 'approval'
  WHEN 'feishu_document_index' THEN 'document_index'
  WHEN 'feishu_document_content' THEN 'document_content'
  WHEN 'codex_session_meta' THEN 'session_metadata'
  WHEN 'codex_user_message' THEN 'user_intent'
  WHEN 'codex_agent_message' THEN 'assistant_result'
  WHEN 'codex_turn_summary' THEN 'turn_summary'
  WHEN 'codex_compaction_summary' THEN 'compaction'
  WHEN 'codex_tool_call' THEN 'tool_call'
  WHEN 'codex_tool_output' THEN 'tool_result'
  WHEN 'codex_tool_result' THEN 'tool_result'
  WHEN 'codex_patch_result' THEN 'file_change'
  WHEN 'codex_memory_document' THEN 'memory_document'
END`;

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function ensureCanonicalSourceStorage(database) {
  database.exec(STORAGE_SCHEMA);
  const version = Number(database.prepare("SELECT value FROM settings WHERE key='source:storage:version'").get()?.value ?? 0);
  const complete = ["source_observations", "collaboration_events", "execution_events"].every((name) => tableExists(database, name));
  if (version === SOURCE_STORAGE_VERSION && complete) {
    database.exec(STORAGE_INDEXES);
    return false;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DELETE FROM collaboration_events;
      DELETE FROM execution_events;
      DELETE FROM source_observations;

      INSERT INTO source_observations(
        evidence_id, schema_version, provider, source_family, account_scope,
        source_object_id, event_id, stream_id, parent_id, causation_id, cursor,
        visibility, event_kind, provider_payload_ref
      )
      SELECT
        e.id,
        ${SOURCE_STORAGE_VERSION},
        ${providerSql},
        ${familySql},
        COALESCE(${jsonValue("s", "$.sourceAdapter.accountScope")},
          CASE ${providerSql} WHEN 'feishu' THEN 'current-user-tenant' ELSE 'local-user' END),
        COALESCE(e.external_id, e.id),
        COALESCE(${jsonValue("e", "$.eventId")}, e.external_id),
        CASE ${providerSql}
          WHEN 'feishu' THEN COALESCE(${jsonValue("e", "$.conversationKey")}, e.thread_id,
            ${jsonValue("e", "$.taskId")}, ${jsonValue("e", "$.token")})
          WHEN 'codex' THEN COALESCE(e.thread_id, ${jsonValue("e", "$.threadId")})
        END,
        CASE ${providerSql}
          WHEN 'feishu' THEN ${jsonValue("e", "$.replyToMessageId")}
          WHEN 'codex' THEN ${jsonValue("e", "$.parentSessionId")}
        END,
        COALESCE(${jsonValue("e", "$.causationId")}, ${jsonValue("e", "$.callId")}),
        s.cursor_bytes,
        COALESCE(${jsonValue("e", "$.visibility")}, CASE ${providerSql} WHEN 'feishu' THEN 'user' ELSE 'private' END),
        ${eventKindSql},
        e.source_locator
      FROM evidence e
      JOIN sources s ON s.id=e.source_id
      WHERE ${providerSql} IS NOT NULL AND ${eventKindSql} IS NOT NULL;

      INSERT INTO collaboration_events(
        evidence_id, actor_id, actor_kind, space_id, conversation_id, thread_id,
        message_id, reply_to, direction, mentions_json, attachments_json,
        resource_status, due_at, deleted, updated
      )
      SELECT
        o.evidence_id,
        COALESCE(${jsonValue("e", "$.senderOpenId")}, ${jsonValue("e", "$.senderId")}),
        COALESCE(${jsonValue("e", "$.senderType")}, 'unknown'),
        ${jsonValue("e", "$.chatId")},
        o.stream_id,
        COALESCE(${jsonValue("e", "$.threadId")}, ${jsonValue("e", "$.rootId")}),
        CASE WHEN o.event_kind='message' THEN o.source_object_id END,
        ${jsonValue("e", "$.replyToMessageId")},
        CASE WHEN e.kind='feishu_outbound_message' OR ${jsonValue("e", "$.sentBySelf")}=1 THEN 'outgoing' ELSE 'incoming' END,
        COALESCE(${jsonValue("e", "$.mentionOpenIds")}, '[]'),
        COALESCE(${jsonValue("e", "$.attachments")}, '[]'),
        ${jsonValue("e", "$.status")},
        ${jsonValue("e", "$.due")},
        COALESCE(${jsonValue("e", "$.deleted")}, 0),
        COALESCE(${jsonValue("e", "$.updated")}, 0)
      FROM source_observations o
      JOIN evidence e ON e.id=o.evidence_id
      WHERE o.source_family='collaboration';

      INSERT INTO execution_events(
        evidence_id, session_id, parent_session_id, workspace, repository, branch,
        commit_sha, run_id, turn_id, event_seq, execution_status, tool_name,
        artifact_refs_json, model_provider, model, reasoning_effort
      )
      SELECT
        o.evidence_id,
        o.stream_id,
        ${jsonValue("e", "$.parentSessionId")},
        COALESCE(${jsonValue("e", "$.cwd")}, t.cwd),
        COALESCE(${jsonValue("e", "$.repository")}, ${jsonValue("e", "$.repoPath")}, ${jsonValue("t", "$.gitOriginUrl")}),
        COALESCE(${jsonValue("e", "$.branch")}, ${jsonValue("t", "$.gitBranch")}),
        COALESCE(${jsonValue("e", "$.commit")}, ${jsonValue("t", "$.gitSha")}),
        ${jsonValue("e", "$.runId")},
        COALESCE(${jsonValue("e", "$.turnId")}, ${jsonValue("e", "$.window_id")}),
        ${jsonValue("e", "$.eventSeq")},
        CASE
          WHEN e.kind='codex_patch_result' AND ${jsonValue("e", "$.success")}=1 THEN 'succeeded'
          WHEN e.kind='codex_patch_result' AND ${jsonValue("e", "$.success")}=0 THEN 'failed'
          ELSE ${jsonValue("e", "$.status")}
        END,
        ${jsonValue("e", "$.tool_name")},
        COALESCE(${jsonValue("e", "$.artifactRefs")}, ${jsonValue("e", "$.changes")}, '[]'),
        COALESCE(${jsonValue("e", "$.modelProvider")}, ${jsonValue("t", "$.modelProvider")}),
        COALESCE(${jsonValue("e", "$.model")}, ${jsonValue("t", "$.model")}),
        COALESCE(${jsonValue("e", "$.reasoningEffort")}, ${jsonValue("t", "$.reasoningEffort")})
      FROM source_observations o
      JOIN evidence e ON e.id=o.evidence_id
      LEFT JOIN threads t ON t.id=e.thread_id
      WHERE o.source_family='execution';

      DROP VIEW IF EXISTS collaboration_event_projection;
      DROP VIEW IF EXISTS execution_event_projection;
      DROP VIEW IF EXISTS source_observation_projection;
      DELETE FROM settings WHERE key='source:projection:version';
      INSERT INTO settings(key, value, updated_at)
        VALUES('source:storage:version', '${SOURCE_STORAGE_VERSION}', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
    `);
    database.exec(STORAGE_INDEXES);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* transaction was already rolled back */ }
    throw error;
  }
  return true;
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function writeCanonicalSourceRecord(database, evidenceId) {
  const context = database.prepare(`
    SELECT e.*, s.kind AS source_kind, s.cursor_bytes, s.metadata_json AS source_metadata_json,
      t.cwd AS thread_cwd, t.metadata_json AS thread_metadata_json
    FROM evidence e
    JOIN sources s ON s.id=e.source_id
    LEFT JOIN threads t ON t.id=e.thread_id
    WHERE e.id=?
  `).get(evidenceId);
  if (!context) return null;
  const source = {
    kind: context.source_kind,
    cursor_bytes: context.cursor_bytes,
    metadata_json: context.source_metadata_json,
  };
  const thread = context.thread_id ? {
    cwd: context.thread_cwd,
    metadata_json: context.thread_metadata_json,
  } : null;
  const record = canonicalSourceRecord({ source, evidence: context, thread });
  if (!record) {
    database.prepare("DELETE FROM source_observations WHERE evidence_id=?").run(evidenceId);
    return null;
  }
  const o = record.observation;
  database.prepare(`
    INSERT INTO source_observations(
      evidence_id, schema_version, provider, source_family, account_scope,
      source_object_id, event_id, stream_id, parent_id, causation_id, cursor,
      visibility, event_kind, provider_payload_ref
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(evidence_id) DO UPDATE SET
      schema_version=excluded.schema_version, provider=excluded.provider,
      source_family=excluded.source_family, account_scope=excluded.account_scope,
      source_object_id=excluded.source_object_id, event_id=excluded.event_id,
      stream_id=excluded.stream_id, parent_id=excluded.parent_id,
      causation_id=excluded.causation_id, cursor=excluded.cursor,
      visibility=excluded.visibility, event_kind=excluded.event_kind,
      provider_payload_ref=excluded.provider_payload_ref
  `).run(evidenceId, o.schemaVersion, o.provider, o.sourceFamily, o.accountScope,
    o.sourceObjectId, o.eventId, o.streamId, o.parentId, o.causationId, o.cursor,
    o.visibility, o.eventKind, o.providerPayloadRef);

  if (record.collaboration) {
    const c = record.collaboration;
    database.prepare(`
      INSERT INTO collaboration_events(
        evidence_id, actor_id, actor_kind, space_id, conversation_id, thread_id,
        message_id, reply_to, direction, mentions_json, attachments_json,
        resource_status, due_at, deleted, updated
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        actor_id=excluded.actor_id, actor_kind=excluded.actor_kind, space_id=excluded.space_id,
        conversation_id=excluded.conversation_id, thread_id=excluded.thread_id,
        message_id=excluded.message_id, reply_to=excluded.reply_to, direction=excluded.direction,
        mentions_json=excluded.mentions_json, attachments_json=excluded.attachments_json,
        resource_status=excluded.resource_status, due_at=excluded.due_at,
        deleted=excluded.deleted, updated=excluded.updated
    `).run(evidenceId, c.actorId, c.actorKind, c.spaceId, c.conversationId, c.threadId,
      c.messageId, c.replyTo, c.direction, JSON.stringify(c.mentions ?? []), JSON.stringify(c.attachments ?? []),
      c.status, c.dueAt, c.deleted ? 1 : 0, c.updated ? 1 : 0);
    database.prepare("DELETE FROM execution_events WHERE evidence_id=?").run(evidenceId);
  } else if (record.execution) {
    const x = record.execution;
    database.prepare(`
      INSERT INTO execution_events(
        evidence_id, session_id, parent_session_id, workspace, repository, branch,
        commit_sha, run_id, turn_id, event_seq, execution_status, tool_name,
        artifact_refs_json, model_provider, model, reasoning_effort
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        session_id=excluded.session_id, parent_session_id=excluded.parent_session_id,
        workspace=excluded.workspace, repository=excluded.repository, branch=excluded.branch,
        commit_sha=excluded.commit_sha, run_id=excluded.run_id, turn_id=excluded.turn_id,
        event_seq=excluded.event_seq, execution_status=excluded.execution_status,
        tool_name=excluded.tool_name, artifact_refs_json=excluded.artifact_refs_json,
        model_provider=excluded.model_provider, model=excluded.model,
        reasoning_effort=excluded.reasoning_effort
    `).run(evidenceId, x.sessionId, x.parentSessionId, x.workspace, x.repository, x.branch,
      x.commit, x.runId, x.turnId, x.eventSeq, x.status, x.toolName,
      JSON.stringify(x.artifactRefs ?? []), x.modelProvider, x.model, x.reasoningEffort);
    database.prepare("DELETE FROM collaboration_events WHERE evidence_id=?").run(evidenceId);
  }
  return record;
}

function observationFromRow(row) {
  return {
    schemaVersion: row.schema_version,
    evidenceId: row.evidence_id,
    sourceId: row.source_id,
    provider: row.provider,
    sourceFamily: row.source_family,
    accountScope: row.account_scope,
    sourceObjectId: row.source_object_id,
    eventId: row.event_id,
    occurredAt: row.occurred_at,
    ingestedAt: row.collected_at,
    streamId: row.stream_id,
    parentId: row.parent_id,
    causationId: row.causation_id,
    sourceLocator: row.source_locator,
    contentHash: row.fingerprint,
    cursor: row.cursor,
    visibility: row.visibility,
    payloadKind: row.kind,
    eventKind: row.event_kind,
    providerPayloadRef: row.provider_payload_ref,
    projectKey: row.project_key,
    threadId: row.evidence_thread_id,
    role: row.role,
    title: row.title,
  };
}

export function sourceRecordForEvidence(database, evidenceId) {
  const row = database.prepare(`
    SELECT o.*, e.source_id, e.occurred_at, e.collected_at, e.source_locator,
      e.fingerprint, e.kind, e.project_key, e.thread_id AS evidence_thread_id, e.role, e.title
    FROM source_observations o JOIN evidence e ON e.id=o.evidence_id
    WHERE o.evidence_id=?
  `).get(evidenceId);
  if (!row) return null;
  const observation = observationFromRow(row);
  if (observation.sourceFamily === "collaboration") {
    const c = database.prepare("SELECT * FROM collaboration_events WHERE evidence_id=?").get(evidenceId);
    return { observation, collaboration: {
      actorId: c.actor_id, actorKind: c.actor_kind, spaceId: c.space_id,
      conversationId: c.conversation_id, threadId: c.thread_id, messageId: c.message_id,
      replyTo: c.reply_to, direction: c.direction, mentions: parseJson(c.mentions_json, []),
      attachments: parseJson(c.attachments_json, []), status: c.resource_status, dueAt: c.due_at,
      deleted: Boolean(c.deleted), updated: Boolean(c.updated),
    } };
  }
  const x = database.prepare("SELECT * FROM execution_events WHERE evidence_id=?").get(evidenceId);
  return { observation, execution: {
    sessionId: x.session_id, parentSessionId: x.parent_session_id, workspace: x.workspace,
    repository: x.repository, branch: x.branch, commit: x.commit_sha, runId: x.run_id,
    turnId: x.turn_id, eventSeq: x.event_seq, status: x.execution_status, toolName: x.tool_name,
    artifactRefs: parseJson(x.artifact_refs_json, []), modelProvider: x.model_provider,
    model: x.model, reasoningEffort: x.reasoning_effort,
  } };
}

export function querySourceRecords(database, options = {}) {
  const clauses = [];
  const parameters = [];
  for (const [column, values] of [
    ["o.provider", options.providers],
    ["o.source_family", options.sourceFamilies],
    ["o.event_kind", options.eventKinds],
  ]) {
    const unique = [...new Set((values ?? []).map(String).filter(Boolean))];
    if (!unique.length) continue;
    clauses.push(`${column} IN (${unique.map(() => "?").join(",")})`);
    parameters.push(...unique);
  }
  if (options.streamId) {
    clauses.push("o.stream_id=?");
    parameters.push(String(options.streamId));
  }
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 20)));
  const rows = database.prepare(`
    SELECT o.evidence_id
    FROM source_observations o JOIN evidence e ON e.id=o.evidence_id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY COALESCE(e.occurred_at, e.collected_at) DESC, o.evidence_id
    LIMIT ?
  `).all(...parameters, limit);
  return rows.map((row) => sourceRecordForEvidence(database, row.evidence_id));
}
