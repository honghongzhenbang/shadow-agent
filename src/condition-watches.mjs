import { nowIso, sha256 } from "./utils.mjs";

const ACTIVE_STATUSES = ["active"];
const CANDIDATE_SELECTION_VERSION = 2;
const STRONG_SCOPE_KEYS = [
  "threadIds",
  "externalIds",
  "conversationKeys",
  "sourceLocatorPrefixes",
];

function parse(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function asStrings(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

function metadata(row) {
  return parse(row.metadata_json, {});
}

function hasValues(value) {
  return asStrings(value).length > 0;
}

export function selectorHasStrongScope(selector = {}) {
  return STRONG_SCOPE_KEYS.some((key) => hasValues(selector[key]));
}

export function evidenceMatchesSelector(row, selector = {}) {
  const selectors = Object.keys(selector).filter((key) => selector[key] !== undefined && selector[key] !== null);
  if (!selectors.length) return false;
  const meta = metadata(row);
  const checks = [
    ["kinds", row.kind],
    ["projectKeys", row.project_key],
    ["threadIds", row.thread_id],
    ["externalIds", row.external_id],
    ["conversationKeys", meta.conversationKey ?? meta.chatId],
    ["eventTypes", meta.eventType],
  ];
  for (const [key, actual] of checks) {
    const expected = asStrings(selector[key]);
    if (expected.length && !expected.includes(String(actual ?? ""))) return false;
  }
  const prefixes = asStrings(selector.sourceLocatorPrefixes);
  if (prefixes.length && !prefixes.some((prefix) => String(row.source_locator ?? "").startsWith(prefix))) return false;
  const containsAny = asStrings(selector.containsAny).map((item) => item.toLocaleLowerCase());
  if (containsAny.length && !selectorHasStrongScope(selector)) {
    const text = `${row.title ?? ""}\n${row.content ?? ""}`.toLocaleLowerCase();
    if (!containsAny.some((item) => text.includes(item))) return false;
  }
  return true;
}

function reviewedEvidenceIds(watch, watchMetadata) {
  return new Set([
    ...parse(watch.source_evidence_ids_json, []),
    ...parse(watch.candidate_evidence_ids_json, []),
    ...(Array.isArray(watchMetadata.reviewHistory) ? watchMetadata.reviewHistory : [])
      .flatMap((entry) => entry?.candidateEvidenceIds ?? []),
  ].map(String));
}

function recoveryRows(store, watch, selector, watchMetadata, maximumRows, maximumCandidates) {
  if (Number(watchMetadata.candidateSelectionVersion ?? 1) >= CANDIDATE_SELECTION_VERSION) return [];
  if (!selectorHasStrongScope(selector)) return [];
  const cursor = Number(watch.last_evidence_rowid || watch.baseline_evidence_rowid || 0);
  const baseline = Number(watch.baseline_evidence_rowid || 0);
  if (cursor <= baseline) return [];
  const lowerBound = Math.max(baseline, cursor - maximumRows);
  const excluded = reviewedEvidenceIds(watch, watchMetadata);
  return store.db.prepare(`
    SELECT rowid AS evidence_rowid, * FROM evidence
    WHERE rowid>? AND rowid<=? ORDER BY rowid DESC LIMIT ?
  `).all(lowerBound, cursor, maximumRows)
    .filter((row) => !excluded.has(String(row.id)) && evidenceMatchesSelector(row, selector))
    .slice(0, maximumCandidates)
    .reverse();
}

export function conditionReviewGeneration(watch) {
  return sha256(JSON.stringify([watch.status, watch.candidate_at, watch.timeout_at,
    watch.candidate_evidence_ids_json])).slice(0, 24);
}

function wakePayload(watch, reason, evidenceIds = []) {
  const evidenceText = evidenceIds.length ? `候选证据：${evidenceIds.join(", ")}。` : "";
  const taskText = watch.task_id ? `关联 Workboard 任务：${watch.task_id}` : "未关联 Workboard 任务；只能作为独立通知条件处理。";
  return {
    watchId: watch.id,
    generation: conditionReviewGeneration(watch),
    sessionKey: watch.session_key,
    text: [
      reason === "timeout" ? "一个持续跟踪条件已到兜底检查时间。" : "一个持续跟踪条件发现了新增候选证据。",
      `跟踪 ID：${watch.id}`,
      `条件：${watch.condition_text}`,
      taskText,
      evidenceText,
      "请调用 shadow_condition_list 读取有界候选正文和身份信息。若关联任务，先回到该任务目标与验收标准，判断回复确认了什么、还缺什么，并优先推进可查询或可执行的内部动作。",
      "先检查父卡是否已完成或归档；已结束的任务只需取消失效条件并记录原因，不得因此重新激活任务。历史候选须核对后续结果，不把旧消息当成刚收到的新任务。",
      "再用 shadow_condition_resolve 标记满足、继续跟踪或取消。continue 必须同时保存结构化 continuation；只有备注或恢复等待状态不算推进。不要仅凭关键词自动完成任务。",
    ].filter(Boolean).join("\n"),
  };
}

// Delivery receipts are not semantic decisions. Repair missing/failed review
// delivery using the same durable queue, without completing or reopening cards.
export function recoverConditionReviewActions(store, { now = Date.now(), limit = 20 } = {}) {
  const recovered = [];
  for (const watch of store.listConditionWatches({ limit, statuses: ["candidate", "timed_out"] })) {
    const generation = conditionReviewGeneration(watch);
    const key = `condition-review:${watch.id}:${generation}`;
    const prior = store.db.prepare("SELECT * FROM controller_outbox WHERE idempotency_key=?").get(key);
    if (prior) {
      if (["completed", "failed"].includes(prior.status) && now - Date.parse(prior.updated_at) >= 900_000) {
        store.finishControllerAction(prior.id, { status: "retry", retryAt: new Date(now).toISOString(),
          error: "Condition still awaits an explicit Agent decision" });
        recovered.push(prior.id);
      }
      continue;
    }
    const inFlight = store.db.prepare(`SELECT 1 FROM controller_outbox WHERE action_type='wake_condition'
      AND status IN ('pending','processing','retry')
      AND (json_extract(payload_json,'$.watchId')=? OR idempotency_key LIKE ? OR idempotency_key LIKE ?)
      LIMIT 1`).get(watch.id, `condition-candidate:${watch.id}:%`, `condition-timeout:${watch.id}:%`);
    if (inFlight) continue;
    const action = store.enqueueControllerAction({ idempotencyKey: key, actionType: "wake_condition",
      payload: wakePayload(watch, watch.status === "timed_out" ? "timeout" : "candidate", parse(watch.candidate_evidence_ids_json, [])) });
    recovered.push(action.id);
  }
  return recovered;
}

export function evaluateConditionWatches(store, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? options.conditionBatchSize) || 20));
  const evidenceLimit = Math.max(10, Math.min(1000, Number(options.evidenceLimit ?? options.evidenceBatchSize) || 200));
  const recoveryLimit = Math.max(100, Math.min(10_000, Number(options.recoveryEvidenceRows) || 2000));
  const candidateLimit = Math.max(1, Math.min(50, Number(options.candidateLimit) || 20));
  const defaultTaskReviewMinutes = Math.max(15, Number(options.defaultTaskReviewMinutes) || 120);
  const now = options.now ? new Date(options.now).toISOString() : nowIso();
  const watches = store.listConditionWatches({ limit, statuses: ACTIVE_STATUSES });
  const result = { checked: 0, candidates: 0, recovered: 0, timedOut: 0, reviewDeadlinesAssigned: 0, actions: [] };
  for (const originalWatch of watches) {
    result.checked += 1;
    let watch = originalWatch;
    const selector = parse(watch.selector_json, {});
    const watchMetadata = metadata(watch);
    const nextMetadata = {
      ...watchMetadata,
      candidateSelectionVersion: CANDIDATE_SELECTION_VERSION,
      candidateSelectionMigratedAt: Number(watchMetadata.candidateSelectionVersion ?? 1) < CANDIDATE_SELECTION_VERSION
        ? now
        : watchMetadata.candidateSelectionMigratedAt,
    };
    let timeoutAt = watch.timeout_at;
    const purpose = watchMetadata.purpose ?? (watch.task_id ? "task_outcome" : "notification");
    if (!timeoutAt && watch.task_id && purpose === "task_outcome") {
      timeoutAt = new Date(Date.parse(now) + defaultTaskReviewMinutes * 60_000).toISOString();
      nextMetadata.defaultReviewAssignedAt = now;
      nextMetadata.defaultReviewMinutes = defaultTaskReviewMinutes;
      result.reviewDeadlinesAssigned += 1;
    }
    const rows = store.db.prepare(`
      SELECT rowid AS evidence_rowid, * FROM evidence
      WHERE rowid>? ORDER BY rowid LIMIT ?
    `).all(Number(watch.last_evidence_rowid || watch.baseline_evidence_rowid || 0), evidenceLimit);
    const lastEvidenceRowid = rows.length
      ? Number(rows.at(-1).evidence_rowid)
      : Number(watch.last_evidence_rowid || watch.baseline_evidence_rowid || 0);
    const recovered = recoveryRows(store, watch, selector, watchMetadata, recoveryLimit, candidateLimit);
    const combined = [...recovered, ...rows];
    const matches = [...new Map(combined
      .filter((row) => evidenceMatchesSelector(row, selector))
      .map((row) => [row.id, row])).values()].slice(-candidateLimit);
    if (matches.length) {
      const evidenceIds = matches.map((row) => row.id);
      const updated = store.updateConditionWatch(watch.id, {
        status: "candidate",
        lastEvidenceRowid,
        candidateEvidenceIds: evidenceIds,
        timeoutAt,
        lastCheckedAt: now,
        candidateAt: now,
        lastError: null,
        metadata: nextMetadata,
      });
      const action = store.enqueueControllerAction({
        idempotencyKey: `condition-review:${watch.id}:${conditionReviewGeneration(updated)}`,
        actionType: "wake_condition",
        payload: wakePayload(updated, "candidate", evidenceIds),
      });
      result.candidates += 1;
      if (recovered.some((row) => evidenceIds.includes(row.id))) result.recovered += 1;
      result.actions.push(action.id);
      continue;
    }
    if (timeoutAt && Date.parse(timeoutAt) <= Date.parse(now)) {
      const updated = store.updateConditionWatch(watch.id, {
        status: "timed_out",
        lastEvidenceRowid,
        timeoutAt,
        lastCheckedAt: now,
        candidateAt: now,
        lastError: null,
        metadata: nextMetadata,
      });
      const action = store.enqueueControllerAction({
        idempotencyKey: `condition-review:${watch.id}:${conditionReviewGeneration(updated)}`,
        actionType: "wake_condition",
        payload: wakePayload(updated, "timeout"),
      });
      result.timedOut += 1;
      result.actions.push(action.id);
      continue;
    }
    watch = store.updateConditionWatch(watch.id, {
      lastEvidenceRowid,
      timeoutAt,
      lastCheckedAt: now,
      lastError: null,
      metadata: nextMetadata,
    });
  }
  return result;
}
