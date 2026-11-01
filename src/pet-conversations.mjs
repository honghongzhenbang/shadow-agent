import { readOperationDelivery } from "./operation-delivery-view.mjs";
import { DIRECT_INPUT_SESSION_KEY } from "./direct-input.mjs";
import { aggregateTaskProgress, taskProgressReview } from "./task-progress-presentation.mjs";

function parse(text, fallback = {}) {
  try { return JSON.parse(text || ""); } catch { return fallback; }
}

function timestamp(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

// UI projections only: receipts, operations and Workboard remain the owners of data.
export function mainConversationPage(store, { before = null, limit = 30 } = {}) {
  const size = Math.max(1, Math.min(50, Number(limit) || 30));
  const rows = store.db.prepare(`SELECT r.rowid AS cursor, r.*, e.content AS user_text
    FROM direct_input_receipts r LEFT JOIN evidence e ON e.id=r.evidence_id
    WHERE r.session_key=? AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`)
    .all(DIRECT_INPUT_SESSION_KEY, Number(before) || Number.MAX_SAFE_INTEGER, size + 1);
  const page = rows.slice(0, size).reverse();
  return {
    sessionKey: DIRECT_INPUT_SESSION_KEY,
    hasMore: rows.length > size,
    before: page[0]?.cursor ?? null,
    messages: page.flatMap((row) => [
      { id: `${row.id}:user`, role: "user", text: row.user_text || "原始消息已不可用", at: row.created_at },
      { id: `${row.id}:assistant`, role: "assistant", text: row.response_text || "",
        status: row.status, error: row.last_error, at: row.completed_at || row.updated_at,
        tasks: parse(row.metadata_json).createdTasks ?? parse(row.created_task_ids_json, []).map((id) => ({ id, title: id })) },
    ]),
  };
}

// All projections retain raw identities. Audit reads never alter canonical events.
export function taskConversationPage(store, card, { limit = 40, before = null, view = "progress", sequences = null } = {}) {
  if (sequences !== null) {
    if (view !== "audit" || !Array.isArray(sequences) || !sequences.length || sequences.length > 100
      || sequences.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) throw new Error("Audit requires 1-100 positive event sequences");
    const ids = [...new Set(sequences)];
    const audit = store.db.prepare(`SELECT * FROM context_changes
      WHERE json_extract(metadata_json,'$.taskId')=? AND seq IN (${ids.map(() => "?").join(",")}) ORDER BY seq`)
      .all(card.id, ...ids);
    return { taskId: card.id, view, messages: [], audit, auditComments: [], hasMore: false, before: null,
      missingSequences: ids.filter((seq) => !audit.some((row) => row.seq === seq)) };
  }
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
  const beforeSeq = before?.seq ?? Number.MAX_SAFE_INTEGER;
  const rows = store.db.prepare(`SELECT *
    FROM context_changes WHERE json_extract(metadata_json,'$.taskId')=? AND seq<?
    ORDER BY seq DESC LIMIT ?`).all(card.id, beforeSeq, size + 1);
  const selected = rows.slice(0, size);
  const messages = [];
  for (const row of selected) {
    const metadata = parse(row.metadata_json) ?? {};
    if (metadata.userText) messages.push({
      id: `operation:${metadata.operationId ?? row.seq}`, role: "user", text: metadata.userText,
      eventSeq: row.seq, eventId: row.event_key,
      operationDelivery: readOperationDelivery(store.db, card.id, metadata.operationId),
      at: row.occurred_at || row.created_at,
      status: row.status === "pending" ? "queued" : row.status === "leased" ? "processing" : null,
    });
    if (metadata.taskCheckpoint?.resultSummary) messages.push({
      id: `checkpoint:${row.seq}`, role: "assistant", text: metadata.taskCheckpoint.resultSummary,
      eventSeq: row.seq, eventId: row.event_key,
      at: timestamp(metadata.taskCheckpoint.recordedAt || row.occurred_at || row.created_at),
    });
  }
  // Workboard comments include legacy conversation and deliverables. Never read the source chat transcript.
  const allComments = (card.metadata?.comments ?? []).map((comment) => ({ ...comment, at: timestamp(comment.createdAt) }));
  const comments = allComments.sort((a, b) => b.at.localeCompare(a.at) || String(b.id).localeCompare(String(a.id)))
    .filter((comment) => !before?.comment || comment.at < before.comment.at
      || (comment.at === before.comment.at && String(comment.id).localeCompare(before.comment.id) < 0));
  const commentPage = comments.slice(0, size);
  for (const comment of commentPage) {
    const at = comment.at;
    const body = String(comment.body ?? "");
    const operation = body.match(/\[shadow-operation:([^\]]+)\]/)?.[1];
    const userPrefix = "用户在任务卡片中继续交代：\n";
    const isUser = body.startsWith(userPrefix);
    const text = (isUser ? body.slice(userPrefix.length) : body).replace(/\s*\[shadow-operation:[^\]]+\]/g, "");
    if (operation && isUser) {
      const stored = store.db.prepare("SELECT metadata_json FROM context_changes WHERE event_key=?").get(`agent-operation:${operation}`);
      const metadata = parse(stored?.metadata_json) ?? {};
      if (metadata.taskId === card.id && metadata.userText === text) continue;
    }
    // Equal prose is not proof that a legacy comment is the same event.
    messages.push({ id: `comment:${comment.id}`, role: isUser ? "user" : "assistant", text, at,
      commentCursor: { at, id: String(comment.id) } });
  }
  const boundaryTimes = [...allComments.map((comment) => comment.at), ...(card.events ?? []).map((event) => timestamp(event.at))];
  const checkpoints = new Map(messages.map((message) => [message.id, message]));
  for (const [index, row] of selected.entries()) {
    const message = checkpoints.get(`checkpoint:${row.seq}`);
    const review = taskProgressReview(row);
    if (!message || !review) continue;
    const previous = rows[index + 1];
    const previousMetadata = parse(previous?.metadata_json) ?? {};
    const previousAt = timestamp(previousMetadata.taskCheckpoint?.recordedAt || previous?.occurred_at || previous?.created_at);
    message.progressReview = { ...review, previousSeq: previous?.seq ?? null,
      breakBefore: boundaryTimes.some((at) => at >= previousAt && at <= message.at) };
  }
  messages.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const lastComment = commentPage.at(-1);
  const commentCursor = lastComment ? { at: lastComment.at, id: String(lastComment.id) } : null;
  return { taskId: card.id, view,
    messages: view === "progress" ? aggregateTaskProgress(messages) : messages,
    rawMessages: messages, boundaryTimes,
    window: { seqFrom: rows.length > size ? selected.at(-1).seq : 0, seqBefore: beforeSeq,
      commentFrom: comments.length > size ? commentCursor : null, commentBefore: before?.comment ?? null },
    ...(view === "audit" ? { audit: [...selected].reverse(), auditComments: commentPage } : {}),
    hasMore: rows.length > size || comments.length > size,
    before: { seq: selected.at(-1)?.seq ?? 0,
      comment: commentCursor ?? before?.comment ?? null } };
}
