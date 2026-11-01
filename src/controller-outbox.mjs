import { recordOperationDeliveryFailure } from "./operation-delivery-feedback.mjs";
import { wakeOpenClaw } from "./openclaw/cli.mjs";
import { thinkingForTask } from "./openclaw/reasoning-policy.mjs";
import {
  deliverReminder,
  notifyReminder,
  removeReminderCron,
  scheduleReminder,
} from "./reminders.mjs";
import { sendApprovedOutboundMessage } from "./outbound-messages.mjs";
import { enqueueAgentAttention, markAgentOperationApplied } from "./agent-operations.mjs";
import {
  applyWorkboardOperationThroughGateway,
  bindWorkboardExecutionThroughGateway,
} from "./workboard-operations.mjs";
import { processDirectInputRequest } from "./direct-input.mjs";
import { logger } from "./logger.mjs";
import { conditionReviewGeneration, recoverConditionReviewActions } from "./condition-watches.mjs";
import { assertTaskStopRequest, recordTaskExecutionStop } from './task-closure-lifecycle.mjs';
import { stopTaskExecutionsThroughGateway } from './task-execution-stop.mjs';

function parse(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function reminderInput(row) {
  const metadata = parse(row.metadata_json, {});
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    title: row.title,
    message: row.message,
    dueAt: row.due_at,
    sourceLocator: row.source_locator,
    evidenceIds: parse(row.source_evidence_ids_json, []),
    taskId: row.task_id,
    explicit: Boolean(row.explicit),
    parentReminderId: row.parent_reminder_id,
    revision: row.revision,
    noWake: Boolean(metadata.noWake),
    metadata,
  };
}

async function executeAction(store, config, action, dependencies) {
  const payload = parse(action.payload_json, {});
  if (action.action_type === "schedule_reminder") {
    const reminder = store.reminder(payload.reminderId);
    if (!reminder) throw new Error(`Reminder not found: ${payload.reminderId}`);
    if (payload.revision && Number(payload.revision) !== Number(reminder.revision || 1)) return reminder;
    if (["scheduled", "notification_pending", "delivered", "acknowledged", "cancelled", "snoozed"].includes(reminder.status)) return reminder;
    if (Date.parse(reminder.due_at) <= Date.now() + 3000) {
      return deliverReminder(store, config, reminder.id);
    }
    return scheduleReminder(store, config, reminderInput(reminder), { runCli: dependencies.runCli });
  }
  if (action.action_type === "deliver_reminder") {
    const reminder = store.reminder(payload.reminderId);
    if (!reminder) throw new Error(`Reminder not found: ${payload.reminderId}`);
    if (payload.revision && Number(payload.revision) !== Number(reminder.revision || 1)) return reminder;
    return deliverReminder(store, config, reminder.id);
  }
  if (action.action_type === "wake_reminder") {
    const reminder = store.reminder(payload.reminderId);
    if (!reminder) throw new Error(`Reminder not found: ${payload.reminderId}`);
    if (payload.revision && Number(payload.revision) !== Number(reminder.revision || 1)) return reminder;
    return notifyReminder(store, config, reminder.id, {
      wake: dependencies.wake,
      noWake: dependencies.noWake,
    });
  }
  if (action.action_type === "remove_reminder_cron") {
    return removeReminderCron(
      store,
      config,
      payload.reminderId,
      payload.cronJobId,
      { runCli: dependencies.runCli },
      payload.reason ?? "outbox_recovery",
    );
  }
  if (action.action_type === "wake_condition") {
    const watch = payload.watchId ? store.conditionWatch(payload.watchId) : null;
    if (payload.watchId && (!watch || !["candidate", "timed_out"].includes(watch.status)
      || conditionReviewGeneration(watch) !== payload.generation)) return { superseded: true };
    const advanceReview = () => {
      payload.reviewAttempt = Number(payload.reviewAttempt ?? 0) + 1;
      store.db.prepare("UPDATE controller_outbox SET payload_json=? WHERE id=?").run(JSON.stringify(payload), action.id);
    };
    try {
      const result = await (dependencies.wake ?? wakeOpenClaw)(
      config.projectRoot,
      String(payload.text ?? "持续跟踪条件发生变化，请检查。"),
      String(payload.sessionKey ?? "agent:main:shadow-events"),
      { thinking: thinkingForTask(config, "task_review"), triggerKind: "controller_outbox",
        idempotencyKey: payload.reviewAttempt ? `${action.idempotency_key}:review:${payload.reviewAttempt}` : action.idempotency_key,
        stateStore: store, observeOnce: true },
    );
      if (watch) {
        const current = store.conditionWatch(watch.id);
        if (current && ["candidate", "timed_out"].includes(current.status)
          && conditionReviewGeneration(current) === payload.generation) {
          advanceReview();
          const error = new Error("Agent turn ended without resolving the condition; awaiting an explicit review");
          error.code = "CONDITION_REVIEW_NOT_APPLIED";
          store.updateConditionWatch(watch.id, { lastError: error.message });
          throw error;
        }
      }
      return result;
    } catch (error) {
      if (watch && error.code === "OPENCLAW_RUN_FAILED") advanceReview();
      throw error;
    }
  }
  if (action.action_type === "send_feishu_message") {
    return sendApprovedOutboundMessage(
      store,
      config,
      String(payload.draftId),
      Number(payload.revision),
      { send: dependencies.sendFeishu },
    );
  }
  if (action.action_type === "apply_workboard_operation") {
    const apply = dependencies.applyWorkboardOperation
      ?? ((operation) => applyWorkboardOperationThroughGateway(config.projectRoot, operation));
    const result = await apply(payload);
    store.transaction(() => {
      markAgentOperationApplied(store, payload.operationId, result);
      enqueueAgentAttention(store, {
        operationId: payload.operationId,
        sessionKey: payload.sessionKey,
        reason: "workboard-operation-applied",
      });
    });
    return result;
  }
  if (action.action_type === 'stop_task_execution') {
    assertTaskStopRequest(store, payload);
    let result;
    try {
      result = await (dependencies.stopTaskExecutions ??
        (input => stopTaskExecutionsThroughGateway(config.projectRoot, input)))(payload);
    } catch (error) {
      recordTaskExecutionStop(store, payload, { status: 'unconfirmed', error: String(error.message).slice(0, 1200) });
      throw error;
    }
    recordTaskExecutionStop(store, payload, result);
    if (result.status === 'pending') throw new Error('停止请求已发送，原执行仍在运行，等待复查。');
    return result;
  }
  if (action.action_type === "bind_workboard_execution") {
    const bind = dependencies.bindWorkboardExecution
      ?? ((binding, options) => bindWorkboardExecutionThroughGateway(config.projectRoot, binding, options));
    return bind(payload, { database: store.db });
  }
  if (action.action_type === "process_direct_input") {
    return processDirectInputRequest(
      store,
      config,
      String(payload.requestId),
      {
        runConversation: dependencies.runDirectInputConversation,
        listCards: dependencies.listWorkboardCards,
      },
    );
  }
  if (action.action_type === "schedule_attention") {
    if (typeof dependencies.scheduleAttention !== "function") {
      throw new Error("schedule_attention requires the context daemon scheduler.");
    }
    return dependencies.scheduleAttention({
      reason: payload.reason ?? "agent-operation",
      count: Number(payload.count ?? 1),
      sessionKey: payload.sessionKey ?? null,
      operationId: payload.operationId ?? null,
    });
  }
  throw new Error(`Unknown controller action type: ${action.action_type}`);
}

export async function processControllerOutbox(store, config, options = {}) {
  const recoveredReminders = store.recoverReminderActions?.() ?? [];
  const recoveredDirectInputs = store.recoverDirectInputActions?.() ?? [];
  const recoveredConditions = recoverConditionReviewActions(store);
  const actions = store.claimControllerActions(options.limit ?? 5);
  const result = {
    recovered: recoveredReminders.length + recoveredDirectInputs.length + recoveredConditions.length,
    recoveredConditions: recoveredConditions.length,
    recoveredReminders: recoveredReminders.length,
    recoveredDirectInputs: recoveredDirectInputs.length,
    claimed: actions.length,
    completed: 0,
    retried: 0,
    failed: 0,
  };
  // Long model runs keep the existing outbox lease alive; five minutes is not an execution timeout.
  const leaseTimer = setInterval(() => {
    try {
      for (const action of actions) {
        store.db.prepare("UPDATE controller_outbox SET updated_at=? WHERE id=? AND status='processing'")
          .run(new Date().toISOString(), action.id);
      }
    } catch (error) {
      logger.warn("Controller outbox lease renewal failed", { error: error.message });
    }
  }, 30_000);
  leaseTimer.unref();
  try {
    for (const action of actions) {
      if (store.db.prepare('SELECT status FROM controller_outbox WHERE id=?').get(action.id)?.status !== 'processing') continue;
      try {
        await executeAction(store, config, action, options.dependencies ?? {});
        store.finishControllerAction(action.id, { status: "completed" });
        result.completed += 1;
      } catch (error) {
        const attempts = Number(action.attempts || 1);
        const awaitingRun = ["OPENCLAW_RUN_PENDING", "OPENCLAW_RUN_UNCONFIRMED", "OPENCLAW_REPLY_UNCONFIRMED",
          "OPENCLAW_SESSION_RECONCILIATION_REQUIRED"].includes(error.code);
        const needsReview = error.code === "CONDITION_REVIEW_NOT_APPLIED";
        const terminal = !awaitingRun && !needsReview && attempts >= 10;
        const delaySeconds = needsReview ? 900 : Math.min(900, 5 * (2 ** Math.min(8, attempts - 1)));
        store.transaction(() => {
          store.finishControllerAction(action.id, {
          status: terminal ? "failed" : "retry",
          error: error.message,
          retryAt: terminal ? null : new Date(Date.now() + delaySeconds * 1000).toISOString(),
        });
          if (terminal) recordOperationDeliveryFailure(store.db, action.id);
          if (terminal && action.action_type === 'stop_task_execution') {
            const payload = parse(action.payload_json, {});
            recordTaskExecutionStop(store, payload, { status: 'unconfirmed',
              error: `停止重试已耗尽，未确认执行停止：${String(error.message).slice(0, 1000)}` });
          }
        });
        if (action.action_type === "process_direct_input") {
          const payload = parse(action.payload_json, {});
          try {
            store.updateDirectInputReceipt(String(payload.requestId), {
              status: terminal ? "failed" : "retry",
              lastError: error.message,
              completedAt: terminal ? new Date().toISOString() : undefined,
            });
          } catch { /* preserve the original controller error */ }
        }
        if (terminal) result.failed += 1;
        else result.retried += 1;
      }
    }
  } finally { clearInterval(leaseTimer); }
  return result;
}
