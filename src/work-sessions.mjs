import { nowIso, sha256, stableJson } from "./utils.mjs";

const URGENT_SIGNALS = new Set(["direct_message", "explicit_self_mention", "reply_to_self"]);

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function sessionRoute(change) {
  const metadata = parseJson(change.metadata_json);
  const taskId = metadata.taskId ?? (metadata.targetType === "workboard_task" ? metadata.targetId : null);
  if (taskId && !["knowledge_review_due", "knowledge_delta_due"].includes(change.kind)) {
    return { kind: "task", provider: "shadow-task", routeKey: String(taskId), taskId,
      metadata: { title: metadata.taskTitle, source: "task-change-router" } };
  }
  if (["knowledge_review_due", "knowledge_delta_due"].includes(change.kind)) {
    return {
      kind: "workstream",
      provider: "shadow",
      routeKey: "knowledge-curation",
      metadata: {
        projectKey: "knowledge-curation",
        evidenceIds: metadata.evidenceIds ?? (change.evidence_id ? [change.evidence_id] : []),
        routingReason: "dedicated-knowledge-curation",
      },
    };
  }
  if (metadata.conversationKey) {
    return {
      kind: "conversation",
      provider: metadata.provider ?? (String(metadata.conversationKey).startsWith("voice:") ? "voice" : "feishu"),
      routeKey: String(metadata.conversationKey),
      metadata: {
        conversationKey: metadata.conversationKey,
        ownershipSignals: metadata.ownershipSignals ?? [],
      },
    };
  }
  return {
    kind: "inbox",
    provider: "shadow",
    routeKey: "inbox",
    metadata: {
      projectCandidate: change.project_key ?? null,
      routingReason: change.project_key
        ? "project-is-a-knowledge-scope-not-a-session-owner"
        : "unclassified-background-change",
    },
  };
}

function delayForChange(change, attention = {}) {
  const metadata = parseJson(change.metadata_json);
  if (["knowledge_review_due", "knowledge_delta_due"].includes(change.kind)) {
    return Math.max(5, Number(attention.knowledgeCurationDebounceSeconds ?? 15)) * 1000;
  }
  const signals = new Set(metadata.ownershipSignals ?? []);
  if ([...signals].some((signal) => URGENT_SIGNALS.has(signal))) {
    return Math.max(5, Number(attention.directDebounceSeconds ?? 45)) * 1000;
  }
  if (signals.has("self_authored")) {
    return Math.max(5, Number(attention.selfAuthoredDebounceSeconds ?? 90)) * 1000;
  }
  if (metadata.evidenceKind === "feishu_message") {
    const botOnly = (metadata.senderTypes ?? []).length > 0
      && metadata.senderTypes.every((type) => ["app", "bot"].includes(String(type).toLowerCase()));
    const seconds = botOnly ? attention.botDebounceSeconds ?? 600 : attention.groupDebounceSeconds ?? 300;
    return Math.max(30, Number(seconds)) * 1000;
  }
  if (metadata.evidenceKind === "feishu_document_content") {
    return Math.max(30, Number(attention.documentChangeDebounceSeconds ?? 300)) * 1000;
  }
  return Math.max(15, Number(attention.localChangeDebounceSeconds ?? 120)) * 1000;
}

export function stableWorkSessionKey(kind, provider, routeKey) {
  if (kind === "inbox") return "agent:main:shadow:inbox";
  const suffix = sha256(`${kind}:${provider}:${routeKey}`).slice(0, 20);
  return `agent:main:shadow:${kind}:${suffix}`;
}

export function bindWorkSessionForDatabase(database, input) {
  const provider = String(input.provider);
  const conversationKey = String(input.routeKey ?? input.conversationKey);
  const existing = database.prepare(`
    SELECT * FROM conversation_bindings WHERE provider=? AND conversation_key=?
  `).get(provider, conversationKey);
  const id = existing?.id ?? sha256(`work-session:${provider}:${conversationKey}`).slice(0, 32);
  const sessionKey = existing?.session_key ?? input.sessionKey ?? `agent:main:external:${id.slice(0, 16)}`;
  const timestamp = nowIso();
  let priorMetadata = {};
  try { priorMetadata = JSON.parse(existing?.metadata_json ?? "{}"); } catch { /* invalid legacy metadata */ }
  const metadata = { ...priorMetadata, ...(input.metadata ?? {}) };
  database.prepare(`
    INSERT INTO conversation_bindings(
      id, provider, conversation_key, session_key, session_kind, generation,
      context_epoch, checkpoint_evidence_id, status, task_id, created_at,
      last_event_at, last_dispatched_at, last_completed_at, last_message_id, metadata_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, conversation_key) DO UPDATE SET
      session_kind=excluded.session_kind,
      task_id=COALESCE(excluded.task_id, conversation_bindings.task_id),
      last_event_at=excluded.last_event_at,
      last_message_id=COALESCE(excluded.last_message_id, conversation_bindings.last_message_id),
      metadata_json=excluded.metadata_json
  `).run(
    id,
    provider,
    conversationKey,
    sessionKey,
    input.kind ?? existing?.session_kind ?? "conversation",
    Number(existing?.generation ?? input.generation ?? 1),
    existing?.context_epoch ?? input.contextEpoch ?? "1",
    input.checkpointEvidenceId ?? existing?.checkpoint_evidence_id ?? null,
    input.status ?? existing?.status ?? "active",
    input.taskId ?? null,
    existing?.created_at ?? timestamp,
    input.eventAt ?? timestamp,
    existing?.last_dispatched_at ?? null,
    existing?.last_completed_at ?? null,
    input.lastMessageId ?? null,
    stableJson(metadata),
  );
  return database.prepare("SELECT * FROM conversation_bindings WHERE id=?").get(id);
}

export function workSessionByKeyForDatabase(database, sessionKey) {
  return database.prepare("SELECT * FROM conversation_bindings WHERE session_key=?").get(sessionKey) ?? null;
}

export function bindWorkSession(store, input) {
  const kind = String(input.kind ?? "conversation");
  const provider = String(input.provider ?? kind);
  const routeKey = String(input.routeKey);
  return store.bindWorkSession({
    ...input,
    kind,
    provider,
    routeKey,
    sessionKey: input.sessionKey ?? stableWorkSessionKey(kind, provider, routeKey),
  });
}

export function bindTaskSession(store, card) {
  if (!card?.id) throw new Error("Task session requires a Workboard card id.");
  return bindWorkSession(store, {
    kind: "task", provider: "shadow-task", routeKey: card.id, taskId: card.id,
    metadata: { title: card.title ?? card.id, source: "task-owner-router" },
  });
}

export function routePendingContextChanges(store, attention = {}) {
  const database = store.db;
  const rows = database.prepare(`
    SELECT * FROM context_changes
    WHERE status='pending' AND (session_key IS NULL OR not_before IS NULL
      OR (json_extract(metadata_json,'$.taskId') IS NOT NULL
        AND kind NOT IN ('knowledge_review_due','knowledge_delta_due')
        AND session_key NOT LIKE 'agent:main:shadow:task:%'))
    ORDER BY seq
  `).all();
  if (!rows.length) return { routed: 0, sessions: 0 };

  const maximumWaitMs = Math.max(60, Number(attention.maxBatchWaitSeconds ?? 600)) * 1000;
  const touchedSessions = new Set();
  const update = database.prepare(`
    UPDATE context_changes
    SET session_key=?, not_before=?
    WHERE seq=? AND status='pending'
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const change of rows) {
      const route = sessionRoute(change);
      const binding = bindWorkSession(store, {
        ...route,
        eventAt: change.occurred_at ?? change.created_at,
        metadata: {
          ...route.metadata,
          source: "context-change-router",
        },
      });
      const firstQueuedAt = Date.parse(change.created_at) || Date.now();
      const target = Math.min(firstQueuedAt + maximumWaitMs, Date.now() + delayForChange(change, attention));
      update.run(binding.session_key, route.kind === "task" && change.not_before ? change.not_before : new Date(target).toISOString(), change.seq);
      touchedSessions.add(binding.session_key);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { routed: rows.length, sessions: touchedSessions.size };
}

export function nextAttentionSession(store, { readyOnly = false, now = nowIso(), priorityGraceMinutes = 15 } = {}) {
  const comparison = readyOnly ? "AND not_before<=?" : "";
  const graceCutoff = new Date(Date.parse(now) - Math.max(1, Number(priorityGraceMinutes) || 15) * 60_000).toISOString();
  const params = readyOnly ? [now, now, now, now, graceCutoff] : [now, now, now, graceCutoff];
  return store.db.prepare(`
    SELECT session_key,
      MIN(COALESCE(not_before, created_at)) AS due_at,
      COUNT(*) AS change_count,
      MIN(seq) AS first_seq,
      MAX(seq) AS last_seq,
      MAX(CASE WHEN kind IN ('task_progress_due', 'human_agent_operation') THEN 1 ELSE 0 END) AS has_task_work,
      MAX(CASE WHEN kind='human_agent_operation' THEN 1 ELSE 0 END) AS has_user_input,
      MAX(CASE WHEN kind IN ('knowledge_review_due', 'knowledge_delta_due') THEN 1 ELSE 0 END) AS has_knowledge_work,
      MIN(CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END) AS priority_rank
    FROM context_changes
    WHERE (status='pending' OR (status='leased' AND lease_until<?))
      AND session_key IS NOT NULL ${comparison}
      AND NOT EXISTS (
        SELECT 1 FROM settings turn_state WHERE turn_state.key LIKE 'controller:turn-active:%'
          AND json_extract(turn_state.value, '$.sessionKey')=context_changes.session_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM conversation_bindings binding JOIN context_changes prior
          ON json_extract(prior.metadata_json,'$.taskId')=binding.task_id
        WHERE binding.session_key=context_changes.session_key AND binding.session_kind='task'
          AND prior.session_key<>binding.session_key AND prior.status='leased' AND prior.lease_until>?
      )
    GROUP BY session_key
    ORDER BY
      CASE WHEN due_at<=? AND has_user_input=1 THEN 0 ELSE 1 END,
      CASE WHEN priority_rank<=1 OR due_at<=? THEN 0 ELSE 1 END,
      due_at, priority_rank, first_seq
    LIMIT 1
  `).get(...params) ?? null;
}

export function releaseAttentionLease(store, leaseOwner) {
  return Number(store.db.prepare(`
    UPDATE context_changes
    SET status='pending', lease_owner=NULL, lease_until=NULL
    WHERE status='leased' AND lease_owner=?
  `).run(leaseOwner).changes ?? 0);
}

export function deferAttentionSession(store, {
  sessionKey,
  leaseOwner,
  notBefore,
  preserveLease = false,
}) {
  const database = store.db;
  const target = String(notBefore);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (leaseOwner && !preserveLease) {
      database.prepare(`
        UPDATE context_changes
        SET status='pending', lease_owner=NULL, lease_until=NULL
        WHERE status='leased' AND lease_owner=?
      `).run(leaseOwner);
    }
    const changed = Number(database.prepare(`
      UPDATE context_changes
      SET not_before=CASE
        WHEN not_before IS NULL OR not_before<? THEN ?
        ELSE not_before
      END
      WHERE status='pending' AND session_key=?
    `).run(target, target, sessionKey).changes ?? 0);
    database.exec("COMMIT");
    return changed;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function attentionRetryDelayMs(failureCount, attention = {}) {
  const baseMs = Math.max(1, Number(attention.retryBaseSeconds ?? 30)) * 1000;
  const maxMs = Math.max(baseMs, Number(attention.retryMaxSeconds ?? 900) * 1000);
  const exponent = Math.max(0, Math.min(20, Number(failureCount ?? 1) - 1));
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

export function attentionRunIdentity(sessionKey, firstSeq, lastSeq = firstSeq, changeCount = 1, attempt = 0) {
  const base = `${sessionKey}:${Number(firstSeq ?? 0)}:${Number(lastSeq ?? firstSeq ?? 0)}:${Number(changeCount ?? 0)}`;
  return `attention:${sha256(attempt ? `${base}:attempt:${attempt}` : base).slice(0, 32)}`;
}

export function attentionAttempt(store, pending) {
  const base = attentionRunIdentity(pending.session_key, pending.first_seq, pending.last_seq, pending.change_count);
  const key = `controller:attention-attempt:${sha256(pending.session_key)}`;
  const previous = parseJson(store.getSetting(key));
  const attempt = previous?.base === base ? Number(previous.attempt || 0) : 0;
  return { key, base, attempt, runId: attentionRunIdentity(pending.session_key, pending.first_seq, pending.last_seq, pending.change_count, attempt) };
}

export function advanceAttentionAttempt(store, attempt) {
  if (!attempt) return;
  store.setSetting(attempt.key, JSON.stringify({ base: attempt.base, attempt: attempt.attempt + 1 }));
}

export function captureAttentionBatch(store, pending) {
  const row = store.db.prepare(`SELECT MIN(seq) AS firstSeq, MAX(seq) AS lastSeq, COUNT(*) AS remaining
    FROM context_changes WHERE session_key=? AND status IN ('pending','leased') AND not_before<=?`)
    .get(pending.session_key, nowIso());
  return row?.remaining ? { ...row, sessionKey: pending.session_key } : null;
}

export function attentionBatchProgress(store, batch) {
  if (!batch) return { progressed: false, remaining: 0 };
  const { remaining } = store.db.prepare(`SELECT COUNT(*) AS remaining FROM context_changes
    WHERE session_key=? AND seq BETWEEN ? AND ? AND status IN ('pending','leased')`)
    .get(batch.sessionKey, batch.firstSeq, batch.lastSeq);
  return { progressed: remaining < batch.remaining, remaining };
}

export function attentionLeaseOwner(sessionKey, runId) {
  return `attention:${sha256(sessionKey).slice(0, 12)}:${sha256(runId).slice(0, 16)}`;
}

export function sessionRuntimeDetail(binding, pendingCount) {
  const metadata = parseJson(binding?.metadata_json);
  const label = binding?.session_kind === "conversation"
    ? metadata.title ?? metadata.name ?? metadata.conversationTitle ?? metadata.conversationKey ?? binding.conversation_key
    : binding?.session_kind === "task"
      ? metadata.title ?? binding.task_id
    : binding?.session_kind === "workstream"
      ? metadata.projectKey ?? binding.conversation_key
      : "未归类收件箱";
  return stableJson({
    sessionKey: binding?.session_key,
    kind: binding?.session_kind,
    label,
    pendingCount: Number(pendingCount ?? 0),
  });
}
