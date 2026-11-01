import { bindTaskSession, bindWorkSessionForDatabase, workSessionByKeyForDatabase } from "./work-sessions.mjs";
import { nowIso } from "./utils.mjs";

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function cardAutomation(card) {
  return parseJson(card?.automation ?? card?.automation_json, {});
}

function referencedEvidenceIds(store, notes) {
  const messageIds = [...String(notes).matchAll(/feishu:\/\/message\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
  const threadIds = [...String(notes).matchAll(/shadow-agent:\/\/thread-digest\/([0-9a-f-]{36})/gi)].map((match) => match[1]);
  const clauses = [];
  const parameters = [];
  if (messageIds.length) {
    clauses.push(`external_id IN (${messageIds.map(() => "?").join(",")})`);
    parameters.push(...messageIds);
  }
  if (threadIds.length) {
    clauses.push(`thread_id IN (${threadIds.map(() => "?").join(",")})`);
    parameters.push(...threadIds);
  }
  if (!clauses.length) return [];
  return store.db.prepare(`SELECT id FROM evidence WHERE ${clauses.join(" OR ")}`)
    .all(...parameters).map((row) => row.id);
}

function evidenceIdsFromCard(store, card, explicitIds = []) {
  const automation = cardAutomation(card);
  const metadata = parseJson(card?.metadata, {});
  const notes = String(card?.notes ?? "");
  const match = notes.match(/(?:Evidence ids?|Source Evidence|来源 Evidence|证据(?:编号|ID)?)\s*[：:]\s*([^\r\n]+)/i);
  return unique([
    ...explicitIds,
    ...(automation.evidenceIds ?? []),
    ...(automation.sourceEvidenceIds ?? []),
    ...(metadata.evidenceIds ?? []),
    ...(match ? match[1].split(/[,，\s]+/) : []),
    ...referencedEvidenceIds(store, notes),
  ]).slice(0, 80);
}

function evidenceRouting(store, evidenceIds) {
  if (!evidenceIds.length) return { sessionKey: null, conversationKey: null, projectKey: null };
  const rows = store.db.prepare(`
    SELECT project_key, thread_id, metadata_json
    FROM evidence WHERE id IN (${evidenceIds.map(() => "?").join(",")})
    ORDER BY COALESCE(occurred_at, collected_at) DESC
  `).all(...evidenceIds);
  for (const row of rows) {
    const binding = row.thread_id ? store.workSessionByKey(row.thread_id) : null;
    if (binding?.status === "active" && binding.session_kind !== "workstream") {
      return {
        sessionKey: binding.session_key,
        conversationKey: null,
        projectKey: row.project_key ?? null,
      };
    }
    const metadata = parseJson(row.metadata_json, {});
    const conversationKey = metadata.conversationKey ?? metadata.conversation_key ?? null;
    if (conversationKey) {
      return {
        sessionKey: null,
        conversationKey: String(conversationKey),
        projectKey: row.project_key ?? null,
      };
    }
  }
  return {
    sessionKey: null,
    conversationKey: null,
    projectKey: rows.find((row) => row.project_key)?.project_key ?? null,
  };
}

function conversationKeyForChat(store, chatId) {
  if (!chatId) return null;
  const exact = `im:${chatId}`;
  const binding = store.db.prepare(`
    SELECT conversation_key FROM conversation_bindings
    WHERE provider='feishu' AND status='active'
      AND (conversation_key=? OR conversation_key LIKE ?)
    ORDER BY CASE WHEN conversation_key=? THEN 0 ELSE 1 END, last_event_at DESC
    LIMIT 1
  `).get(exact, `${exact}:%`, exact);
  return binding?.conversation_key ?? exact;
}

function persistTaskOwner(store, cardId, route) {
  const current = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(cardId);
  const timestamp = nowIso();
  const changed = !current
    || current.owner_session_key !== route.sessionKey
    || current.source_conversation_key !== (route.sourceConversationKey ?? null)
    || current.binding_reason !== route.bindingReason;
  if (current) {
    store.db.prepare(`
      UPDATE work_task_attention SET
        owner_session_key=?, source_conversation_key=?, binding_reason=?,
        binding_revision=?, bound_at=?, project_key=COALESCE(?, project_key),
        updated_by='agent-operation-router', updated_at=?
      WHERE card_id=?
    `).run(
      route.sessionKey,
      route.sourceConversationKey ?? null,
      route.bindingReason,
      Number(current.binding_revision || 1) + (changed ? 1 : 0),
      changed ? timestamp : (current.bound_at ?? timestamp),
      route.projectKey ?? null,
      timestamp,
      cardId,
    );
  } else {
    store.db.prepare(`
      INSERT INTO work_task_attention(
        card_id, project_key, owner_session_key, source_conversation_key,
        binding_reason, binding_revision, bound_at, updated_by, updated_at
      ) VALUES(?, ?, ?, ?, ?, 1, ?, 'agent-operation-router', ?)
    `).run(
      cardId,
      route.projectKey ?? null,
      route.sessionKey,
      route.sourceConversationKey ?? null,
      route.bindingReason,
      timestamp,
      timestamp,
    );
  }
  return store.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(cardId);
}

export function resolveTaskOwnerSession(store, card, options = {}) {
  const cardId = String(options.cardId ?? card?.id ?? "").trim();
  if (!cardId) throw new Error("A Workboard card id is required to resolve task ownership.");
  const current = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(cardId);
  const automation = cardAutomation(card);
  const metadata = parseJson(card?.metadata, {});
  const evidenceIds = evidenceIdsFromCard(store, card, options.evidenceIds ?? []);
  const fromEvidence = evidenceRouting(store, evidenceIds);
  const sourceConversationKey = options.sourceConversationKey ?? options.conversationKey
    ?? current?.source_conversation_key
    ?? automation.conversationKey
    ?? metadata.conversationKey
    ?? fromEvidence.conversationKey
    ?? conversationKeyForChat(store, automation.chatId ?? metadata.chatId);
  const projectKey = options.projectKey
    ?? automation.projectKey
    ?? metadata.projectKey
    ?? current?.project_key
    ?? fromEvidence.projectKey
    ?? null;

  const binding = bindTaskSession(store, { ...card, id: cardId });
  const bindingReason = "dedicated_task_session";
  const attention = persistTaskOwner(store, cardId, {
    sessionKey: binding.session_key,
    sourceConversationKey: sourceConversationKey ?? null,
    projectKey,
    bindingReason,
  });
  // Move only explicitly task-scoped, unclaimed work; never copy a source transcript.
  store.db.prepare(`UPDATE context_changes SET session_key=?
    WHERE status='pending' AND json_extract(metadata_json, '$.taskId')=?
      AND kind NOT IN ('knowledge_review_due','knowledge_delta_due')`)
    .run(binding.session_key, cardId);
  store.db.prepare(`UPDATE condition_watches SET session_key=? WHERE task_id=?
    AND status IN ('active','candidate','timed_out')`).run(binding.session_key, cardId);
  store.db.prepare(`UPDATE controller_outbox SET payload_json=json_set(payload_json, '$.sessionKey', ?)
    WHERE status IN ('pending','retry') AND action_type='apply_workboard_operation'
      AND json_extract(payload_json, '$.cardId')=?`).run(binding.session_key, cardId);
  return {
    sessionKey: binding.session_key,
    binding,
    bindingReason,
    sourceConversationKey: sourceConversationKey ?? null,
    projectKey,
    attention,
  };
}

export function resolveTaskOwnerForDatabase(database, card, options = {}) {
  return resolveTaskOwnerSession({
    db: database,
    bindWorkSession: input => bindWorkSessionForDatabase(database, input),
    workSessionByKey: sessionKey => workSessionByKeyForDatabase(database, sessionKey),
  }, card, options);
}
