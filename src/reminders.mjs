import path from "node:path";

import { openClawRuntime, runOpenClawCli, wakeOpenClaw } from "./openclaw/cli.mjs";
import { thinkingForTask } from "./openclaw/reasoning-policy.mjs";
import { nowIso, sha256 } from "./utils.mjs";

const CLOSED_STATUSES = new Set(["acknowledged", "cancelled", "snoozed"]);
const TIMEZONE_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/i;

function findJobId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["jobId", "job_id", "id"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findJobId(child);
    if (found) return found;
  }
  return null;
}

function parseMetadata(row) {
  try { return JSON.parse(row?.metadata_json || "{}"); } catch { return {}; }
}

function withAudit(row, event, details = {}) {
  const metadata = parseMetadata(row);
  const reminderAudit = Array.isArray(metadata.reminderAudit) ? metadata.reminderAudit : [];
  return {
    ...metadata,
    reminderAudit: [...reminderAudit, { at: nowIso(), event, ...details }].slice(-50),
  };
}

function normalizeDueAt(value, { requireFuture = true } = {}) {
  if (typeof value !== "string" || !TIMEZONE_SUFFIX.test(value.trim())) {
    throw new Error("Reminder dueAt must be an ISO timestamp with an explicit timezone (Z or +/-HH:MM).");
  }
  const dueTime = Date.parse(value);
  if (!Number.isFinite(dueTime)) {
    throw new Error("Reminder dueAt must be an ISO timestamp with an explicit timezone (Z or +/-HH:MM).");
  }
  if (requireFuture && dueTime <= Date.now() + 3000) {
    throw new Error("Reminder dueAt must be at least 3 seconds in the future.");
  }
  return new Date(dueTime).toISOString();
}

function reminderInput(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    title: row.title,
    message: row.message,
    dueAt: row.due_at,
    sourceLocator: row.source_locator,
    evidenceIds: JSON.parse(row.source_evidence_ids_json || "[]"),
    taskId: row.task_id,
    explicit: Boolean(row.explicit),
    parentReminderId: row.parent_reminder_id,
    revision: row.revision,
    noWake: Boolean(parseMetadata(row).noWake),
    metadata: parseMetadata(row),
  };
}

function ensureDeliveryEvidence(store, reminder) {
  const source = store.upsertSource({
    sourceKey: "shadow-agent:reminders",
    kind: "reminder",
    uri: "shadow-agent://reminders",
  });
  return store.addEvidence({
    sourceId: source.id,
    kind: "shadow_reminder_delivery",
    occurredAt: reminder.notification_started_at ?? reminder.delivered_at ?? nowIso(),
    title: `提醒到期：${reminder.title}`,
    content: reminder.message,
    sourceLocator: `shadow-agent://reminder/${reminder.id}`,
    externalId: reminder.id,
    fingerprint: sha256(`shadow-reminder-delivery:${reminder.id}:r${reminder.revision || 1}`),
    metadata: {
      reminderId: reminder.id,
      revision: reminder.revision || 1,
      taskId: reminder.task_id,
      dueAt: reminder.due_at,
    },
  });
}

function enqueueCronCleanup(store, reminderId, cronJobId, reason) {
  if (!cronJobId) return null;
  const enqueue = store.ensureControllerAction?.bind(store) ?? store.enqueueControllerAction.bind(store);
  return enqueue({
    idempotencyKey: `remove-reminder-cron:${reminderId}:${sha256(cronJobId).slice(0, 16)}`,
    actionType: "remove_reminder_cron",
    payload: { reminderId, cronJobId, reason },
  });
}

export function normalizeReminderInput(input) {
  const title = String(input.title ?? "").trim();
  const message = String(input.message ?? title).trim();
  if (!title) throw new Error("Reminder title is required.");
  const dueAt = normalizeDueAt(input.dueAt);
  const idempotencyKey = String(input.idempotencyKey || sha256([
    title,
    dueAt,
    input.sourceLocator ?? "manual",
    input.taskId ?? "",
  ].join("\n")));
  return {
    ...input,
    title,
    message,
    dueAt,
    idempotencyKey,
  };
}

export async function removeReminderCron(store, config, reminderId, cronJobId, dependencies = {}, reason = "cleanup") {
  if (!cronJobId) return store.reminder(reminderId);
  const runCli = dependencies.runCli ?? runOpenClawCli;
  try {
    await runCli(config.projectRoot, ["cron", "remove", cronJobId, "--json"], { timeoutMs: 60000 });
    const current = store.reminder(reminderId);
    if (!current) return null;
    return store.updateReminder(reminderId, {
      cronJobId: current.cron_job_id === cronJobId ? null : current.cron_job_id,
      lastError: null,
      metadata: withAudit(current, "cron_removed", { cronJobId, reason }),
    });
  } catch (error) {
    const current = store.reminder(reminderId);
    if (current) {
      store.updateReminder(reminderId, {
        lastError: `Cron removal failed: ${error.message}`,
        metadata: withAudit(current, "cron_remove_failed", { cronJobId, reason, error: error.message }),
      });
    }
    throw error;
  }
}

async function removeCronBestEffort(store, config, reminderId, cronJobId, dependencies, reason) {
  if (!cronJobId) return { removed: false, queued: false };
  try {
    await removeReminderCron(store, config, reminderId, cronJobId, dependencies, reason);
    return { removed: true, queued: false };
  } catch (error) {
    enqueueCronCleanup(store, reminderId, cronJobId, reason);
    return { removed: false, queued: true, error: error.message };
  }
}

export async function scheduleReminder(store, config, input, dependencies = {}) {
  const normalized = normalizeReminderInput(input);
  const reminder = store.createReminder(normalized);
  if (!reminder.inserted) {
    if (reminder.status === "scheduled" && reminder.cron_job_id) return reminder;
    if (!["pending_schedule", "schedule_failed"].includes(reminder.status)) return reminder;
  }
  const revision = Math.max(1, Number(reminder.revision) || 1);
  const runtime = openClawRuntime(config.projectRoot);
  const fireScript = path.join(config.projectRoot, "scripts", "fire-shadow-reminder.mjs");
  const runCli = dependencies.runCli ?? runOpenClawCli;
  try {
    const result = await runCli(config.projectRoot, [
      "cron", "add",
      "--name", `Shadow Reminder: ${normalized.title.slice(0, 80)}`,
      "--description", `Shadow Agent reminder ${reminder.id}`,
      "--at", normalized.dueAt,
      "--command-argv", JSON.stringify([runtime.nodeExecutable, fireScript, reminder.id]),
      "--command-cwd", config.projectRoot,
      "--command-env", `SHADOW_AGENT_DATABASE=${config.paths.database}`,
      ...(normalized.noWake ? ["--command-env", "SHADOW_REMINDER_NO_WAKE=1"] : []),
      "--declaration-key", `shadow-reminder:${reminder.id}:r${revision}`,
      "--delete-after-run",
      "--wake", "now",
      "--json",
    ], { timeoutMs: 60000 });
    const cronJobId = findJobId(result.payload);
    if (!cronJobId) throw new Error("OpenClaw Cron did not return a job id.");
    const latest = store.reminder(reminder.id);
    if (!latest || CLOSED_STATUSES.has(latest.status) || Number(latest.revision || 1) !== revision) {
      await removeCronBestEffort(store, config, reminder.id, cronJobId, dependencies, "stale_schedule_result");
      return store.reminder(reminder.id);
    }
    return store.updateReminder(reminder.id, {
      status: "scheduled",
      cronJobId,
      lastError: null,
      metadata: withAudit(latest, "scheduled", { cronJobId, revision }),
    });
  } catch (error) {
    const latest = store.reminder(reminder.id);
    if (latest && !CLOSED_STATUSES.has(latest.status) && Number(latest.revision || 1) === revision) {
      store.updateReminder(reminder.id, {
        status: "schedule_failed",
        lastError: error.message,
        metadata: withAudit(latest, "schedule_failed", { revision, error: error.message }),
      });
    }
    throw error;
  }
}

export async function deliverReminder(store, config, reminderId) {
  const current = store.reminder(reminderId);
  if (!current) throw new Error(`Reminder not found: ${reminderId}`);
  if (CLOSED_STATUSES.has(current.status) || current.status === "delivered") return current;
  if (Date.parse(current.due_at) > Date.now() + 1000) return current;

  const reminder = store.deliverReminder(reminderId);
  ensureDeliveryEvidence(store, reminder);
  const enqueue = store.ensureControllerAction?.bind(store) ?? store.enqueueControllerAction.bind(store);
  enqueue({
    idempotencyKey: `wake-reminder:${reminder.id}:r${reminder.revision || 1}`,
    actionType: "wake_reminder",
    payload: { reminderId: reminder.id, revision: reminder.revision || 1 },
  });
  return store.reminder(reminder.id);
}

export async function notifyReminder(store, config, reminderId, dependencies = {}) {
  let reminder = store.reminder(reminderId);
  if (!reminder) throw new Error(`Reminder not found: ${reminderId}`);
  if (CLOSED_STATUSES.has(reminder.status) || reminder.status === "delivered") return reminder;
  if (reminder.status !== "notification_pending") {
    reminder = await deliverReminder(store, config, reminderId);
    if (reminder.status !== "notification_pending") return reminder;
  }
  ensureDeliveryEvidence(store, reminder);
  const metadata = parseMetadata(reminder);
  const noWake = dependencies.noWake ?? metadata.noWake ?? process.env.SHADOW_REMINDER_NO_WAKE === "1";
  const wake = dependencies.wake ?? wakeOpenClaw;
  try {
    if (!noWake) {
      await wake(
        config.projectRoot,
        `提醒已到期：${reminder.title}\n${reminder.message}\n提醒 ID：${reminder.id}，版本：${reminder.revision || 1}。这是可重试通知；同一提醒 ID 和版本只处理一次。宠物已显示提醒；不要据此把关联任务标记完成。`,
        "agent:main:shadow-reminders",
        { thinking: thinkingForTask(config, "reminder"), triggerKind: "reminder",
          idempotencyKey: `wake-reminder:${reminder.id}:r${reminder.revision || 1}`, stateStore: store },
      );
    }
    return store.completeReminderDelivery(reminder.id);
  } catch (error) {
    const latest = store.reminder(reminder.id);
    if (latest && !CLOSED_STATUSES.has(latest.status) && latest.status !== "delivered") {
      store.updateReminder(reminder.id, {
        status: "notification_pending",
        lastError: error.message,
        metadata: withAudit(latest, "notification_failed", { error: error.message }),
      });
    }
    throw error;
  }
}

export async function updateReminder(store, config, reminderId, changes, dependencies = {}) {
  const current = store.reminder(reminderId);
  if (!current) throw new Error(`Reminder not found: ${reminderId}`);
  if (CLOSED_STATUSES.has(current.status)) throw new Error(`Reminder cannot be updated from status: ${current.status}`);
  const title = changes.title === undefined ? current.title : String(changes.title).trim();
  const message = changes.message === undefined ? current.message : String(changes.message).trim();
  if (!title) throw new Error("Reminder title is required.");
  const dueAt = changes.dueAt === undefined ? normalizeDueAt(current.due_at) : normalizeDueAt(changes.dueAt);
  const oldCronJobId = current.cron_job_id;
  const metadata = withAudit(current, "updated", {
    previousDueAt: current.due_at,
    dueAt,
    previousCronJobId: oldCronJobId,
  });
  const updated = store.rescheduleReminder(reminderId, { title, message, dueAt, metadata });
  store.cancelReminderControllerActions(reminderId, { exceptTypes: ["remove_reminder_cron"] });
  await removeCronBestEffort(store, config, reminderId, oldCronJobId, dependencies, "reminder_updated");
  return scheduleReminder(store, config, reminderInput(updated), dependencies);
}

export async function cancelReminder(store, config, reminderId, dependencies = {}) {
  const current = store.reminder(reminderId);
  if (!current) throw new Error(`Reminder not found: ${reminderId}`);
  const cronJobId = current.cron_job_id;
  const metadata = withAudit(current, "cancelled", { cronJobId });
  let cancelled = store.cancelReminderRecord(reminderId, { metadata, lastError: null });
  store.cancelReminderControllerActions(reminderId, { exceptTypes: ["remove_reminder_cron"] });
  await removeCronBestEffort(store, config, reminderId, cronJobId, dependencies, "reminder_cancelled");
  cancelled = store.reminder(reminderId);
  return cancelled;
}

export async function snoozeReminder(store, config, reminderId, delay, dependencies = {}) {
  const original = store.reminder(reminderId);
  if (!original) throw new Error(`Reminder not found: ${reminderId}`);
  if (CLOSED_STATUSES.has(original.status)) throw new Error(`Reminder cannot be snoozed from status: ${original.status}`);

  let dueAt;
  let snoozeMetadata;
  if (delay && typeof delay === "object" && delay.dueAt) {
    dueAt = normalizeDueAt(delay.dueAt);
    snoozeMetadata = { snoozedUntil: dueAt };
  } else {
    const durationMinutes = Number(delay ?? 10);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 7 * 24 * 60) {
      throw new Error("Reminder snooze minutes must be between 1 and 10080.");
    }
    dueAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
    snoozeMetadata = { snoozedMinutes: durationMinutes, snoozedUntil: dueAt };
  }

  const child = await scheduleReminder(store, config, {
    title: original.title,
    message: original.message,
    dueAt,
    sourceLocator: original.source_locator,
    evidenceIds: JSON.parse(original.source_evidence_ids_json || "[]"),
    taskId: original.task_id,
    explicit: Boolean(original.explicit),
    parentReminderId: original.id,
    idempotencyKey: `snooze:${original.id}:${dueAt}`,
    metadata: snoozeMetadata,
  }, dependencies);
  store.updateReminder(original.id, {
    status: "snoozed",
    acknowledgedAt: nowIso(),
    metadata: {
      ...withAudit(original, "snoozed", { ...snoozeMetadata, snoozedTo: child.id }),
      ...snoozeMetadata,
      snoozedTo: child.id,
    },
  });
  store.cancelReminderControllerActions(original.id, { exceptTypes: ["remove_reminder_cron"] });
  await removeCronBestEffort(store, config, original.id, original.cron_job_id, dependencies, "reminder_snoozed");
  return child;
}
