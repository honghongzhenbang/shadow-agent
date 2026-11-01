import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { openDatabase } from "../src/db.mjs";
import {
  cancelReminder,
  deliverReminder,
  normalizeReminderInput,
  scheduleReminder,
  snoozeReminder,
  updateReminder,
} from "../src/reminders.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-reminders-"));
  fs.mkdirSync(path.join(root, "tools", "node-v24.19.0-win-x64"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools", "openclaw-runtime", "node_modules", "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(root, "tools", "node-v24.19.0-win-x64", "node.exe"), "test");
  fs.writeFileSync(path.join(root, "tools", "openclaw-runtime", "node_modules", "openclaw", "openclaw.mjs"), "test");
  const database = path.join(root, "test.sqlite");
  return {
    root,
    config: { projectRoot: root, paths: { database } },
    store: openDatabase(database),
  };
}

function cronStub() {
  let nextId = 0;
  const calls = [];
  return {
    calls,
    runCli: async (_root, args) => {
      calls.push(args);
      if (args[0] === "cron" && args[1] === "add") return { payload: { job: { id: `cron-${++nextId}` } } };
      if (args[0] === "cron" && args[1] === "remove") return { payload: { removed: true } };
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`);
    },
  };
}

test("reminder validation requires a future timestamp with an explicit timezone", () => {
  assert.throws(() => normalizeReminderInput({ title: "测试", dueAt: "invalid" }), /timezone/);
  assert.throws(() => normalizeReminderInput({ title: "测试", dueAt: "2026-08-15T09:00:00" }), /timezone/);
  assert.throws(() => normalizeReminderInput({ title: "测试", dueAt: new Date(Date.now() - 1000).toISOString() }), /future/);
  const normalized = normalizeReminderInput({
    title: "测试",
    dueAt: new Date(Date.now() + 60_000).toISOString().replace("Z", "+00:00"),
  });
  assert.match(normalized.dueAt, /Z$/);
});

test("delivery remains notification_pending until the durable wake succeeds", async () => {
  const { root, config, store } = fixture();
  const cron = cronStub();
  let wakeCalls = 0;
  try {
    const scheduled = await scheduleReminder(store, config, {
      title: "提交日报",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "durable-delivery",
    }, cron);
    store.updateReminder(scheduled.id, { dueAt: new Date(Date.now() - 1000).toISOString() });

    const pending = await deliverReminder(store, config, scheduled.id);
    assert.equal(pending.status, "notification_pending");
    assert.equal(pending.delivered_at, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='wake_reminder'").get().count, 1);

    const firstAttempt = await processControllerOutbox(store, config, {
      dependencies: { wake: async (_root, _text, _session, options) => {
        assert.equal(options.thinking, "low");
        assert.equal(options.triggerKind, "reminder");
        wakeCalls += 1;
        throw new Error("gateway offline");
      } },
    });
    assert.equal(firstAttempt.retried, 1);
    assert.equal(store.reminder(scheduled.id).status, "notification_pending");
    assert.equal(store.reminder(scheduled.id).delivered_at, null);

    store.db.prepare("UPDATE controller_outbox SET next_attempt_at=? WHERE action_type='wake_reminder'")
      .run(new Date(Date.now() - 1000).toISOString());
    const secondAttempt = await processControllerOutbox(store, config, {
      dependencies: { wake: async () => { wakeCalls += 1; } },
    });
    assert.equal(secondAttempt.completed, 1);
    assert.equal(store.reminder(scheduled.id).status, "delivered");
    assert.ok(store.reminder(scheduled.id).delivered_at);
    assert.equal(wakeCalls, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE kind='shadow_reminder_delivery'").get().count, 1);

    const noDuplicate = await processControllerOutbox(store, config, {
      dependencies: { wake: async () => { wakeCalls += 1; } },
    });
    assert.equal(noDuplicate.claimed, 0);
    assert.equal(wakeCalls, 2);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending, failed and notification-pending reminders recover through the outbox", async () => {
  const { root, config, store } = fixture();
  const cron = cronStub();
  let wakeCalls = 0;
  try {
    const future = new Date(Date.now() + 120_000).toISOString();
    const pending = store.createReminder({ idempotencyKey: "recover-pending", title: "待调度", dueAt: future });
    const failed = store.createReminder({ idempotencyKey: "recover-failed", title: "调度失败", dueAt: future, status: "schedule_failed" });
    const notifying = store.createReminder({
      idempotencyKey: "recover-notification",
      title: "待通知",
      dueAt: new Date(Date.now() - 1000).toISOString(),
      status: "notification_pending",
    });

    const result = await processControllerOutbox(store, config, {
      limit: 10,
      dependencies: { runCli: cron.runCli, wake: async () => { wakeCalls += 1; } },
    });
    assert.equal(result.recovered, 3);
    assert.equal(result.completed, 3);
    assert.equal(store.reminder(pending.id).status, "scheduled");
    assert.equal(store.reminder(failed.id).status, "scheduled");
    assert.equal(store.reminder(notifying.id).status, "delivered");
    assert.equal(wakeCalls, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reminders update, cancel and custom-snooze with cron cleanup and audit", async () => {
  const { root, config, store } = fixture();
  const cron = cronStub();
  try {
    const original = await scheduleReminder(store, config, {
      title: "旧标题",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "mutable-reminder",
    }, cron);
    const newDueAt = new Date(Date.now() + 180_000).toISOString();
    const updated = await updateReminder(store, config, original.id, {
      title: "新标题",
      dueAt: newDueAt,
    }, cron);
    assert.equal(updated.title, "新标题");
    assert.equal(updated.due_at, newDueAt);
    assert.equal(updated.revision, 2);
    assert.equal(updated.status, "scheduled");
    assert.notEqual(updated.cron_job_id, original.cron_job_id);
    assert.ok(cron.calls.some((args) => args[1] === "remove" && args[2] === original.cron_job_id));

    const cancelled = await cancelReminder(store, config, original.id, cron);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.cancelled_at);
    assert.equal(cancelled.cron_job_id, null);
    assert.ok(JSON.parse(cancelled.metadata_json).reminderAudit.some((entry) => entry.event === "cancelled"));

    const delivered = store.createReminder({
      idempotencyKey: "custom-snooze",
      title: "稍后处理",
      dueAt: new Date(Date.now() - 1000).toISOString(),
      status: "delivered",
    });
    const snoozeUntil = new Date(Date.now() + 240_000).toISOString();
    const child = await snoozeReminder(store, config, delivered.id, { dueAt: snoozeUntil }, cron);
    assert.equal(child.due_at, snoozeUntil);
    assert.equal(child.parent_reminder_id, delivered.id);
    assert.equal(store.reminder(delivered.id).status, "snoozed");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel keeps audit state and queues cron cleanup when immediate removal fails", async () => {
  const { root, config, store } = fixture();
  const cron = cronStub();
  try {
    const reminder = await scheduleReminder(store, config, {
      title: "取消失败恢复",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "cancel-recovery",
    }, cron);
    const failedRemoval = async (_root, args) => {
      if (args[1] === "remove") throw new Error("cron unavailable");
      return cron.runCli(_root, args);
    };
    const cancelled = await cancelReminder(store, config, reminder.id, { runCli: failedRemoval });
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.last_error, /Cron removal failed/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='remove_reminder_cron' AND status='pending'").get().count, 1);

    const recovered = await processControllerOutbox(store, config, {
      dependencies: { runCli: cron.runCli },
    });
    assert.equal(recovered.completed, 1);
    assert.equal(store.reminder(reminder.id).cron_job_id, null);
    assert.equal(store.reminder(reminder.id).last_error, null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
