import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveTaskOwnerSession } from "./agent-operations.mjs";
import { emitContextChange } from "./context-graph.mjs";
import { classifyTaskHandling } from "./task-handling.mjs";
import { nowIso } from "./utils.mjs";
import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from "./openclaw/gateway-client.mjs";

const ACTIVE_STATUSES = ["triage", "backlog", "todo", "scheduled", "ready", "running", "review", "blocked"];

function parse(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function workboardPath(config, options) {
  return options.workboardPath
    ?? path.join(config.projectRoot, "runtime", "openclaw-poc", "state", "plugins", "workboard", "workboard.sqlite");
}

function activeCards(databasePath, cardId = null) {
  if (!fs.existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    return database.prepare(`
      SELECT id, title, notes, status, priority, updated_at, execution_status,
        execution_session_key, execution_run_id, automation_json
      FROM workboard_cards
      WHERE archived_at IS NULL
        AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
        ${cardId ? "AND id=?" : ""}
      ORDER BY updated_at DESC
    `).all(...ACTIVE_STATUSES, ...(cardId ? [cardId] : []));
  } finally {
    database.close();
  }
}

function priorityScore(card, overlay, now) {
  const priority = { urgent: 600, high: 400, normal: 200, low: 50 }[card.priority] ?? 100;
  const status = { blocked: 300, running: 220, review: 180, ready: 140, todo: 100 }[card.status] ?? 0;
  const pinned = Number(overlay?.user_pinned) ? 1000 : 0;
  const deadline = overlay?.deadline_at ? Date.parse(overlay.deadline_at) : NaN;
  const due = Number.isFinite(deadline)
    ? deadline <= now ? 1200 : Math.max(0, 900 - Math.floor((deadline - now) / 3_600_000) * 10)
    : 0;
  const ageHours = Math.max(0, (now - Number(card.updated_at || now)) / 3_600_000);
  const freshness = Math.max(0, 160 - Math.log2(ageHours + 1) * 24);
  return pinned + due + priority + status + freshness + Number(overlay?.importance ?? 50);
}

function pendingProgressTaskIds(store) {
  return new Set(store.db.prepare(`
    SELECT metadata_json FROM context_changes
    WHERE kind='task_progress_due' AND status IN ('pending','leased')
  `).all().map((row) => parse(row.metadata_json, {}).taskId).filter(Boolean));
}

function activeWatches(store) {
  const map = new Map();
  for (const row of store.db.prepare(`
    SELECT * FROM condition_watches
    WHERE task_id IS NOT NULL AND status IN ('active','candidate','timed_out')
    ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'timed_out' THEN 1 ELSE 2 END, updated_at DESC
  `).all()) {
    if (!map.has(row.task_id)) map.set(row.task_id, row);
  }
  return map;
}

function unfinishedOutboundDrafts(store) {
  const map = new Map();
  for (const row of store.db.prepare(`
    SELECT * FROM outbound_message_drafts
    WHERE task_id IS NOT NULL AND status NOT IN ('sent','cancelled','failed')
    ORDER BY updated_at DESC
  `).all()) {
    if (!map.has(row.task_id)) map.set(row.task_id, row);
  }
  return map;
}

function nextReviewFor(card, minutes, now) {
  const multiplier = card.status === "running" ? 0.5 : card.priority === "normal" ? 2 : 1;
  return new Date(now + Math.max(15, minutes * multiplier) * 60_000).toISOString();
}

function syncTrackedContinuation(store, cardId, watch, timestamp) {
  store.db.prepare(`
    INSERT INTO work_task_attention(
      card_id, next_review_at, continuation_kind, continuation_reference_id,
      continuation_user_action_json, updated_by, updated_at
    ) VALUES(?, ?, 'condition_watch', ?, NULL, 'task-progress-supervisor', ?)
    ON CONFLICT(card_id) DO UPDATE SET
      next_review_at=excluded.next_review_at,
      continuation_kind='condition_watch',
      continuation_reference_id=excluded.continuation_reference_id,
      continuation_user_action_json=NULL,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(cardId, watch.timeout_at, watch.id, timestamp);
}

export async function observeTaskExecution(projectRoot, card) {
  if (!card.execution_run_id) return { status: "unknown", reason: "missing_run_id" };
  const client = new OpenClawGatewayClient({ ...loadOpenClawGatewaySettings(projectRoot), autoReconnect: false });
  try {
    await client.connect();
    // This bounds only the read-only observation, never the execution itself.
    return await client.request("agent.wait", { runId: card.execution_run_id, timeoutMs: 1000 }, 5000);
  } finally { client.stop(); }
}

export async function auditTaskProgress(store, config, options = {}) {
  const enabled = options.enabled ?? config.taskSupervision?.enabled ?? true;
  if (!enabled) return { available: true, checked: 0, due: 0, enqueued: 0, skipped: "disabled", events: [] };
  const databasePath = workboardPath(config, options);
  if (!fs.existsSync(databasePath)) return { available: false, checked: 0, due: 0, enqueued: 0, events: [] };
  const nowText = options.now ? new Date(options.now).toISOString() : nowIso();
  const now = Date.parse(nowText);
  const maximum = Math.max(1, Math.min(5, Number(options.limit ?? config.taskSupervision?.maxTasksPerAudit) || 1));
  const reviewMinutes = Math.max(30, Number(options.defaultReviewMinutes ?? config.taskSupervision?.defaultReviewMinutes) || 120);
  const staleMinutes = Math.max(15, Number(options.initialStaleMinutes ?? config.taskSupervision?.initialStaleMinutes) || 60);
  const cards = activeCards(databasePath);
  const pending = pendingProgressTaskIds(store);
  const maxInFlight = Math.max(1, Math.min(5, Number(options.maxInFlight ?? config.taskSupervision?.maxInFlight) || 2));
  const leased = store.db.prepare(`
    SELECT DISTINCT json_extract(metadata_json, '$.taskId') AS task_id FROM context_changes
    WHERE kind='task_progress_due' AND status='leased' AND lease_until>?
  `).all(nowText).map((row) => row.task_id).filter(Boolean);
  if (leased.length >= maxInFlight) {
    return {
      available: true,
      checked: cards.length,
      due: 0,
      enqueued: 0,
      skipped: "progress_review_capacity",
      inFlightTaskIds: leased,
      events: [],
    };
  }
  const watches = activeWatches(store);
  const drafts = unfinishedOutboundDrafts(store);
  const overlays = new Map(store.db.prepare("SELECT * FROM work_task_attention").all().map((row) => [row.card_id, row]));
  const candidates = [];

  for (const card of cards) {
    const watch = watches.get(card.id);
    const automation = parse(card.automation_json, {});
    let overlay = overlays.get(card.id);
    const owner = overlay?.owner_session_key ? store.workSessionByKey(overlay.owner_session_key) : null;
    if (owner?.status !== "active" || owner.session_kind !== "task" || owner.task_id !== card.id) {
      overlay = resolveTaskOwnerSession(store, { ...card, automation }).attention;
    }
    overlays.set(card.id, overlay);
    if (pending.has(card.id)) continue;
    if (watch?.status === "active" && watch.timeout_at && Date.parse(watch.timeout_at) > now) {
      if (!overlay?.continuation_kind || overlay.continuation_kind === "condition_watch") {
        syncTrackedContinuation(store, card.id, watch, nowText);
        overlay = {
          ...overlay,
          continuation_kind: "condition_watch",
          continuation_reference_id: watch.id,
          continuation_user_action_json: null,
          next_review_at: watch.timeout_at,
        };
      }
    }
    const handling = classifyTaskHandling({
      card,
      attention: overlay,
      watch,
      outboundDraft: drafts.get(card.id),
      now,
    });
    if (handling.lane === "user" || ["running", "watching", "scheduled"].includes(handling.state)) continue;
    if (!overlay?.continuation_kind && now - Number(card.updated_at || now) < staleMinutes * 60_000) continue;
    candidates.push({ card, overlay, handling, score: priorityScore(card, overlay, now) });
  }

  const selected = candidates.sort((left, right) =>
    right.score - left.score
      || String(left.overlay?.last_progress_requested_at ?? "").localeCompare(String(right.overlay?.last_progress_requested_at ?? "")))
    .slice(0, Math.min(maximum, maxInFlight - leased.length));
  const events = [];
  const observations = [];
  for (const { card, overlay, handling } of selected) {
    let executionObservation = null;
    if (overlay?.continuation_kind === "codex_run") {
      try {
        executionObservation = await (options.observeExecution ?? observeTaskExecution)(config.projectRoot, card);
      } catch (error) {
        executionObservation = { status: "unknown", error: String(error.message).slice(0, 1000) };
      }
      const currentCard = activeCards(databasePath, card.id)[0];
      const currentOverlay = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(card.id);
      if (!currentCard || currentCard.updated_at !== card.updated_at
        || currentCard.execution_run_id !== card.execution_run_id || currentCard.status !== card.status
        || ["updated_at", "continuation_kind", "continuation_reference_id", "next_review_at"]
          .some((key) => currentOverlay?.[key] !== overlay?.[key])) {
        observations.push({ taskId: card.id, runId: card.execution_run_id, status: "discarded", reason: "task_changed_during_observation" });
        continue;
      }
      // No cached card status is accepted as a liveness receipt.
      const active = executionObservation?.status === "pending"
        && ["running", "queued", "starting"].includes(executionObservation.livenessState);
      observations.push({ taskId: card.id, runId: card.execution_run_id, status: executionObservation?.status ?? "unknown", active });
      if (active) {
        store.db.prepare(`UPDATE work_task_attention SET next_review_at=?, last_progress_requested_at=?, updated_at=? WHERE card_id=?`)
          .run(nextReviewFor(card, reviewMinutes, now), nowText, nowText, card.id);
        continue;
      }
    }
    const revision = Number(overlay?.progress_revision ?? 0) + 1;
    const eventKey = `task-progress-due:${card.id}:${revision}`;
    const nextReviewAt = nextReviewFor(card, reviewMinutes, now);
    store.transaction(() => {
      emitContextChange(store.db, {
        eventKey,
        coalesceKey: `task-progress:${card.id}`,
        kind: "task_progress_due",
        projectKey: overlay?.project_key ?? null,
        sessionKey: overlay.owner_session_key,
        priority: ["urgent", "high"].includes(card.priority) ? "high" : "normal",
        notBefore: nowText,
        occurredAt: nowText,
        summary: `活动任务到达结果复查时间：${card.title}`,
        metadata: {
          taskId: card.id,
          taskTitle: card.title,
          taskStatus: card.status,
          taskPriority: card.priority,
          trigger: "bounded_progress_audit",
          requestedAt: nowText,
          nextReviewAt,
          executionStatus: card.execution_status ?? null,
          executionSessionKey: card.execution_session_key ?? null,
          executionRunId: card.execution_run_id ?? null,
          handlingReason: handling.reason,
          executionObservation: executionObservation ? {
            status: executionObservation.status,
            livenessState: executionObservation.livenessState ?? null,
            endedAt: executionObservation.endedAt ?? null,
            error: executionObservation.error ? String(executionObservation.error).slice(0, 1000) : null,
            observedAt: nowText,
          } : null,
        },
      });
      store.db.prepare(`
        UPDATE work_task_attention
        SET next_review_at=?, last_progress_requested_at=?, last_progress_event_key=?,
          progress_revision=?,
          continuation_reference_id=CASE WHEN continuation_kind='codex_run' THEN continuation_reference_id ELSE NULL END,
          continuation_kind=CASE WHEN continuation_kind='codex_run' THEN 'codex_run' ELSE 'internal_review' END,
          continuation_user_action_json=NULL,
          continuation_summary=?, updated_by='task-progress-supervisor', updated_at=?
        WHERE card_id=?
      `).run(
        nextReviewAt,
        nowText,
        eventKey,
        revision,
        `重新规划任务下一步：${handling.reason}`,
        nowText,
        card.id,
      );
    });
    events.push({ eventKey, taskId: card.id, title: card.title, sessionKey: overlay.owner_session_key, nextReviewAt });
  }
  return { available: true, checked: cards.length, due: candidates.length, enqueued: events.length, events, observations };
}
