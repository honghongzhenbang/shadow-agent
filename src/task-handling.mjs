export const ACTIVE_TASK_STATUSES = new Set([
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
]);

export const USER_ACTION_REASONS = new Set([
  "missing_input",
  "decision",
  "external_authorization",
  "real_world_confirmation",
]);

export const EXTERNAL_AUTHORITY_BOUNDARIES = new Set([
  "external_message",
  "external_document_write",
  "git_commit_push",
  "deployment_release",
  "device_control",
  "destructive_action",
  "privileged_access",
]);

export function parseTaskJson(value, fallback = null) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function normalizeUserAction(value) {
  const input = parseTaskJson(value, null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const reason = String(input.reason ?? "").trim();
  const request = String(input.request ?? "").trim();
  const blockedAction = String(input.blockedAction ?? "").trim() || null;
  if (!USER_ACTION_REASONS.has(reason) || request.length < 3) return null;
  if (reason === "external_authorization" && !EXTERNAL_AUTHORITY_BOUNDARIES.has(blockedAction)) return null;
  return {
    reason,
    request: request.slice(0, 2000),
    blockedAction,
  };
}

function unfinishedDraft(draft) {
  return draft && !["sent", "cancelled", "failed"].includes(String(draft.status ?? ""));
}

function validFuture(value, now) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) && parsed > now;
}

export function classifyTaskHandling({
  card,
  attention = null,
  watch = null,
  outboundDraft = null,
  progressChange = null,
  now = Date.now(),
}) {
  const archivedAt = card?.archived_at ?? card?.archivedAt ?? card?.metadata?.archivedAt;
  const executionRunId = card?.execution_run_id ?? card?.executionRunId;
  const executionSessionKey = card?.execution_session_key ?? card?.executionSessionKey;
  const executionStatus = card?.execution_status ?? card?.executionStatus;
  if (!card || !ACTIVE_TASK_STATUSES.has(String(card.status ?? "")) || archivedAt) {
    return { lane: "completed", state: "terminal", reason: "task_terminal", recoverable: false };
  }
  if (card.status === "review") {
    return { lane: "user", state: "review", reason: "result_review", recoverable: false };
  }
  if (progressChange?.status === "leased") {
    return validFuture(progressChange.lease_until, now)
      ? { lane: "agent", state: "verifying", reason: "progress_review_leased", recoverable: false }
      : { lane: "agent", state: "queued_review", reason: "progress_review_lease_expired", recoverable: true };
  }
  if (progressChange?.status === "pending") {
    return { lane: "agent", state: "queued_review", reason: "progress_review_pending", recoverable: false };
  }

  const kind = String(attention?.continuation_kind ?? "").trim();
  if (!kind) return { lane: "agent", state: "recovery", reason: "missing_continuation", recoverable: true };

  if (kind === "requires_user") {
    const userAction = normalizeUserAction(attention?.continuation_user_action_json);
    if (!userAction) {
      return { lane: "agent", state: "recovery", reason: "invalid_user_gate", recoverable: true };
    }
    return { lane: "user", state: "requires_user", reason: userAction.reason, userAction, recoverable: false };
  }

  if (kind === "outbound_draft") {
    if (unfinishedDraft(outboundDraft)) {
      return { lane: "user", state: "outbound_review", reason: "outbound_hitl", recoverable: false };
    }
    return { lane: "agent", state: "recovery", reason: "outbound_draft_unavailable", recoverable: true };
  }

  if (kind === "condition_watch") {
    if (!watch || String(watch.id) !== String(attention?.continuation_reference_id ?? "")) {
      return { lane: "agent", state: "recovery", reason: "condition_missing", recoverable: true };
    }
    if (!["active", "candidate", "timed_out"].includes(String(watch.status ?? ""))) {
      return { lane: "agent", state: "recovery", reason: "condition_closed", recoverable: true };
    }
    if (["candidate", "timed_out"].includes(watch.status) || !validFuture(watch.timeout_at, now)) {
      return { lane: "agent", state: "recovery", reason: `condition_${watch.status}`, recoverable: true };
    }
    return { lane: "agent", state: "watching", reason: "condition_active", recoverable: false };
  }

  if (kind === "codex_run") {
    const referenceId = String(attention?.continuation_reference_id ?? "").trim();
    const bound = [executionRunId, executionSessionKey].filter(Boolean).map(String);
    if (!referenceId || (bound.length > 0 && !bound.includes(referenceId))) {
      return { lane: "agent", state: "recovery", reason: "codex_binding_invalid", recoverable: true };
    }
    if (["queued", "pending", "starting", "running"].includes(String(executionStatus ?? ""))) {
      return validFuture(attention?.next_review_at, now)
        ? { lane: "agent", state: "running", reason: "codex_active", recoverable: false }
        : { lane: "agent", state: "recovery", reason: "codex_status_due", recoverable: true };
    }
    return { lane: "agent", state: "recovery", reason: "codex_result_due", recoverable: true };
  }

  if (kind === "internal_review") {
    if (validFuture(attention?.next_review_at, now)) {
      return { lane: "agent", state: "scheduled", reason: "internal_review_scheduled", recoverable: false };
    }
    return { lane: "agent", state: "recovery", reason: "internal_review_due", recoverable: true };
  }

  return { lane: "agent", state: "recovery", reason: "unsupported_continuation", recoverable: true };
}

export function canonicalRecoveryContinuation(reason, now = new Date().toISOString()) {
  return {
    continuationKind: "internal_review",
    continuationReferenceId: null,
    continuationSummary: `重新规划任务下一步：${reason}`,
    continuationUserActionJson: null,
    nextReviewAt: now,
  };
}

export function planTaskHandlingCutover({ cards = [], attentions = [], watches = [], outboundDrafts = [], now = new Date().toISOString() }) {
  const attentionByCard = new Map(attentions.map((row) => [row.card_id, row]));
  const watchById = new Map(watches.map((row) => [row.id, row]));
  const draftById = new Map(outboundDrafts.map((row) => [row.id, row]));
  const changes = [];
  const retained = [];
  const nowMs = Date.parse(now);
  for (const card of cards) {
    const attention = attentionByCard.get(card.id) ?? null;
    const referenceId = attention?.continuation_reference_id;
    const handling = classifyTaskHandling({
      card,
      attention,
      watch: referenceId ? watchById.get(referenceId) : null,
      outboundDraft: referenceId ? draftById.get(referenceId) : null,
      now: nowMs,
    });
    if (handling.lane === "completed" || handling.lane === "user" || !handling.recoverable) {
      retained.push({ taskId: card.id, lane: handling.lane, state: handling.state, reason: handling.reason });
      continue;
    }
    if (attention?.continuation_kind === "internal_review"
      && !attention?.continuation_user_action_json
      && !attention?.continuation_reference_id) {
      retained.push({ taskId: card.id, lane: "agent", state: "recovery", reason: handling.reason });
      continue;
    }
    changes.push({
      taskId: card.id,
      title: card.title,
      fromKind: attention?.continuation_kind ?? null,
      reason: handling.reason,
      ...canonicalRecoveryContinuation(handling.reason, now),
    });
  }
  return { changes, retained };
}
