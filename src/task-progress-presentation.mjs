const METADATA_FIELDS = ["taskId", "taskTitle", "taskStatus", "taskPriority", "trigger", "requestedAt", "nextReviewAt",
  "executionStatus", "executionSessionKey", "executionRunId", "handlingReason", "executionObservation", "taskCheckpoint"];
const CHECKPOINT_FIELDS = ["taskId", "changeSeq", "resultState", "resultSummary", "evidenceIds", "continuation",
  "cardStatus", "terminal", "recordedAt", "checkpointRevision", "bindingRevision", "ownerSessionKey", "execution",
  "progressPlan", "applied", "reason"];
const LEGACY_FIELDS = ["taskId", "changeSeq", "resultState", "resultSummary", "evidenceIds", "continuation", "cardStatus", "terminal", "recordedAt"];
const GUARD_FIELDS = ["checkpointRevision", "bindingRevision", "ownerSessionKey", "execution", "applied", "reason"];
const CONTINUATION_FIELDS = ["kind", "summary", "referenceId", "nextReviewAt", "sessionKey", "model", "userAction"];
const PLAN_FIELDS = ["outcome", "successCriteria", "authorizedScope", "approach", "nextAction", "stopCondition", "whyNow"];

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function knownFields(value, fields) { return object(value) && Object.keys(value).every((key) => fields.includes(key)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function evidenceSet(value) {
  if (!Array.isArray(value) || value.length > 30
    || value.some((id) => typeof id !== "string" || !id.length || id.length > 128)) return null;
  return [...new Set(value)].sort();
}

// Existing checkpoint assertions only; no prose classifier or new model-facing state.
// continuation.summary can change independently of the plan in the existing writer;
// changes to that next-action description remain visible, even with an unchanged plan.
export function taskProgressReview(row) {
  try {
    const metadata = JSON.parse(row.metadata_json);
    const cp = metadata?.taskCheckpoint;
    const continuation = cp?.continuation;
    if (row.kind !== "task_progress_due" || row.status !== "acknowledged"
      || !knownFields(metadata, METADATA_FIELDS) || metadata.trigger !== "bounded_progress_audit"
      || metadata.executionObservation != null
      || ![null, undefined, "idle", "completed"].includes(metadata.executionStatus)
      || !knownFields(cp, CHECKPOINT_FIELDS) || cp.resultState !== "unchanged"
      || !LEGACY_FIELDS.every((field) => Object.hasOwn(cp, field)) || cp.terminal !== false
      || cp.taskId !== metadata.taskId || cp.changeSeq !== row.seq
      || typeof cp.cardStatus !== "string" || !cp.cardStatus.length
      || typeof cp.resultSummary !== "string" || !cp.resultSummary.length
      || !knownFields(continuation, CONTINUATION_FIELDS) || !["internal_review", "condition_watch"].includes(continuation.kind)
      || !CONTINUATION_FIELDS.every((field) => Object.hasOwn(continuation, field))
      || !["referenceId", "sessionKey", "model"].every((key) => continuation[key] === null || typeof continuation[key] === "string")
      || continuation.userAction != null || typeof continuation.summary !== "string" || !continuation.summary.length
      || !Number.isFinite(Date.parse(continuation.nextReviewAt)) || !Number.isFinite(Date.parse(cp.recordedAt))) return null;
    const legacy = !GUARD_FIELDS.some(field => Object.hasOwn(cp, field));
    let revision = cp.checkpointRevision;
    if (legacy) {
      // Pre-guard writer (688b3c2/cac57fb): only an identified watch can establish
      // a bounded repeated action. Do not default missing modern guard fields.
      const prefix = `task-progress-due:${cp.taskId}:`;
      const ordinal = String(row.event_key).startsWith(prefix) ? row.event_key.slice(prefix.length) : "";
      revision = Number(ordinal);
      if (!/^[1-9][0-9]*$/.test(ordinal) || !Number.isSafeInteger(revision)
        || row.coalesce_key !== `task-progress:${cp.taskId}` || continuation.kind !== "condition_watch"
        || !METADATA_FIELDS.filter(field => !["executionObservation", "taskCheckpoint"].includes(field))
          .every(field => Object.hasOwn(metadata, field))
        || metadata.executionStatus !== null || metadata.executionRunId !== null || metadata.executionSessionKey !== null
        || typeof row.session_key !== "string" || !row.session_key.length) return null;
    } else if (!CHECKPOINT_FIELDS.every(field => Object.hasOwn(cp, field))
      || cp.applied !== true || cp.reason != null || !Number.isSafeInteger(revision) || revision < 1
      || !Number.isSafeInteger(cp.bindingRevision) || cp.bindingRevision < 0
      || !(cp.ownerSessionKey === null || typeof cp.ownerSessionKey === "string")
      || !knownFields(cp.execution, ["runId", "sessionKey"])
      || !["runId", "sessionKey"].every(key => Object.hasOwn(cp.execution, key)
        && (cp.execution[key] === null || typeof cp.execution[key] === "string"))) return null;
    if (continuation.kind === "condition_watch" && !continuation.referenceId) return null;
    const evidenceIds = evidenceSet(cp.evidenceIds);
    if (!evidenceIds) return null;
    let plan = null;
    if (cp.progressPlan != null) {
      if (!knownFields(cp.progressPlan, [...PLAN_FIELDS, "revision", "updatedAt"])
        || !PLAN_FIELDS.every((field) => typeof cp.progressPlan[field] === "string" && cp.progressPlan[field].length >= 3)
        || !Number.isInteger(cp.progressPlan.revision) || cp.progressPlan.revision < 1) return null;
      plan = Object.fromEntries(PLAN_FIELDS.map((field) => [field, cp.progressPlan[field]]));
    }
    const { nextReviewAt, summary, ...next } = continuation;
    const key = JSON.stringify(canonical({ format: legacy ? "legacy_watch" : "guarded", taskId: cp.taskId, resultState: cp.resultState, evidenceIds,
      cardStatus: cp.cardStatus, bindingRevision: cp.bindingRevision, ownerSessionKey: cp.ownerSessionKey,
      execution: cp.execution, plan, next: { ...next, summary },
      source: { sessionKey: row.session_key, projectKey: row.project_key, entityId: row.entity_id,
        factId: row.fact_id, evidenceId: row.evidence_id, priority: row.priority },
      taskTitle: metadata.taskTitle, taskStatus: metadata.taskStatus, taskPriority: metadata.taskPriority,
      executionStatus: metadata.executionStatus, executionSessionKey: metadata.executionSessionKey,
      executionRunId: metadata.executionRunId }));
    if (new TextEncoder().encode(key).length > 12 * 1024) return null;
    return { key, seq: row.seq, eventId: row.event_key, revision,
      nextTrigger: { ...continuation } };
  } catch { return null; }
}

function compareMessages(a, b) {
  return a.at.localeCompare(b.at)
    || (a.eventSeq != null && b.eventSeq != null ? a.eventSeq - b.eventSeq : 0)
    || (a.role === b.role ? a.id.localeCompare(b.id) : a.role === "user" ? -1 : 1);
}

// Raw identities survive page overlap and refresh. Aggregates are disposable projections.
export function aggregateTaskProgress(messages, { boundaryTimes = null } = {}) {
  const result = [];
  let run = null;
  for (const message of [...messages].sort(compareMessages)) {
    const candidate = message.progressReview;
    const interrupted = candidate && run && (boundaryTimes
      ? boundaryTimes.some(at => at >= run.lastAt && at <= message.at) : candidate.breakBefore);
    const joins = candidate && run && candidate.key === run.key && !interrupted
      && candidate.previousSeq === run.lastSeq && candidate.revision === run.lastRevision + 1;
    if (!joins) {
      result.push(message);
      run = candidate ? { key: candidate.key, lastSeq: candidate.seq, lastRevision: candidate.revision,
        firstAt: message.at, lastAt: message.at, messageIds: [message.id], eventIds: [candidate.eventId], sequences: [candidate.seq] } : null;
      continue;
    }
    run.lastSeq = candidate.seq;
    run.lastRevision = candidate.revision;
    run.lastAt = message.at;
    run.messageIds.push(message.id);
    run.eventIds.push(candidate.eventId);
    run.sequences.push(candidate.seq);
    result[result.length - 1] = { ...message, id: run.messageIds[0],
      aggregation: { kind: "no_change", count: run.messageIds.length, firstCheckedAt: run.firstAt,
        lastCheckedAt: message.at, nextTrigger: candidate.nextTrigger,
        messageIds: [...run.messageIds], eventIds: [...run.eventIds], sequences: [...run.sequences] } };
  }
  return result;
}

function compareComment(a, b) { return a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)); }

export function mergeTaskConversationPage(current, page, { older = false } = {}) {
  const state = current ?? { rawMessages: new Map(), head: null };
  const incoming = page.rawMessages ?? page.messages;
  const window = page.window;
  if (window) {
    for (const [id, message] of state.rawMessages) {
      const inEvents = message.eventSeq != null && message.eventSeq >= window.seqFrom && message.eventSeq < window.seqBefore;
      const inComments = message.commentCursor && (!window.commentBefore || compareComment(message.commentCursor, window.commentBefore) < 0)
        && (!window.commentFrom || compareComment(message.commentCursor, window.commentFrom) >= 0);
      if (inEvents || inComments) state.rawMessages.delete(id);
    }
  }
  for (const message of incoming) state.rawMessages.set(message.id, message);
  // A burst larger than one page can leave a gap above the old head. Resume from
  // the new page's cursor; overlapping pages are idempotent by original identity.
  const eventGap = !older && state.head && window?.seqFrom > state.head.maxSeq;
  const commentGap = !older && state.head && window?.commentFrom
    && (!state.head.maxComment || compareComment(window.commentFrom, state.head.maxComment) > 0);
  if (!state.before || older || eventGap || commentGap) {
    state.before = page.before;
    state.hasMore = page.hasMore;
  }
  if (!older) state.head = {
    maxSeq: Math.max(0, ...incoming.map((message) => message.eventSeq ?? 0)),
    maxComment: incoming.map((message) => message.commentCursor).filter(Boolean).sort(compareComment).at(-1) ?? null,
  };
  state.boundaryTimes = page.boundaryTimes ?? state.boundaryTimes ?? null;
  state.messages = aggregateTaskProgress([...state.rawMessages.values()], { boundaryTimes: state.boundaryTimes });
  return state;
}
