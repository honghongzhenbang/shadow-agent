import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase, openDatabaseReadOnly } from "../src/db.mjs";

test("checkpoint revision migration preserves existing task attention and is repeatable", () => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "shadow-checkpoint-migration-")));
  const databasePath = path.join(root, "test.sqlite");
  let store = openDatabase(databasePath);
  try {
    store.db.prepare(`INSERT INTO work_task_attention(card_id, binding_revision, progress_revision,
      continuation_kind, last_result_summary, progress_plan_json, updated_by, updated_at)
      VALUES('legacy', 7, 4, 'internal_review', 'Keep existing result', '{"revision":3}', 'test', '2026-10-20')`).run();
    store.db.exec("ALTER TABLE work_task_attention DROP COLUMN checkpoint_revision");
    const old = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='legacy'").get();
    store.close();
    store = openDatabase(databasePath);
    assert.deepEqual({ ...store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='legacy'").get() },
      { ...old, checkpoint_revision: 0 });
    store.db.prepare("UPDATE work_task_attention SET checkpoint_revision=9 WHERE card_id='legacy'").run();
    store.close();
    store = openDatabase(databasePath);
    assert.equal(store.db.prepare("SELECT checkpoint_revision FROM work_task_attention WHERE card_id='legacy'").get().checkpoint_revision, 9);
  } finally {
    store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("shadow-checkpoint-migration-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("evidence and tasks are idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-db-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "test", kind: "test", uri: "test://source" });
    const first = store.addEvidence({
      sourceId: source.id,
      kind: "message",
      title: "hello",
      content: "world",
      sourceLocator: "test://source#1",
      fingerprint: "same-evidence",
    });
    const second = store.addEvidence({
      sourceId: source.id,
      kind: "message",
      title: "hello",
      content: "world",
      sourceLocator: "test://source#1",
      fingerprint: "same-evidence",
    });
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(store.stats().evidence, 1);

    const searchable = store.addEvidence({
      sourceId: source.id,
      kind: "codex_user_message",
      title: "通信协议 重构",
      content: "推进机器人 TCP 心跳和握手重构",
      sourceLocator: "test://source#2",
      fingerprint: "searchable-evidence",
    });
    assert.equal(store.searchEvidence("通信协议", 5)[0].id, searchable.id);
    assert.equal(store.stats().evidence, 2);

    store.createPatrolRun("patrol-history-1", { trigger: "test" });
    const historyTask = store.addTask({
      fingerprint: "patrol-history-task",
      title: "Review protocol changes",
      description: "Inspect the current communication protocol changes.",
      metadata: { patrolRunId: "patrol-history-1" },
    });
    const historyAction = store.createAction({
      idempotencyKey: "patrol-history-action",
      taskId: historyTask.id,
      actionType: "inspect_protocol",
      riskLevel: "read",
      commandSummary: "Inspect protocol evidence",
    });
    store.finishAction(historyAction.id, { status: "completed", result: "Protocol evidence reviewed." });
    store.updateTask(historyTask.id, { status: "done" });
    store.markEvidencePatrolled("patrol-history-1", [searchable.id]);
    store.finishPatrolRun("patrol-history-1", {
      status: "completed",
      evidenceCount: 1,
      taskCount: 1,
      summary: "Reviewed protocol changes and created a follow-up task.",
      metadata: { trace: [] },
    });
    const history = store.listAgentHistory({ query: "protocol", limit: 10 });
    assert.equal(history.length, 1);
    assert.equal(history[0].discovered_task_count, 1);
    assert.equal(history[0].action_count, 1);
    const historyDetails = store.agentHistoryDetails("patrol-history-1");
    assert.equal(historyDetails.tasks[0].id, historyTask.id);
    assert.equal(historyDetails.actions[0].id, historyAction.id);
    assert.equal(historyDetails.evidenceKinds[0].kind, "codex_user_message");

    const taskOne = store.addTask({ fingerprint: "same-task", title: "inspect", evidenceIds: [first.id] });
    const taskTwo = store.addTask({ fingerprint: "same-task", title: "inspect", evidenceIds: [first.id] });
    assert.equal(taskOne.inserted, true);
    assert.equal(taskTwo.inserted, false);
    assert.equal(store.stats().tasks, 2);
    const action = store.createAction({
      idempotencyKey: "same-task-action",
      taskId: taskOne.id,
      actionType: "inspect",
      riskLevel: "read",
      commandSummary: "inspect evidence",
    });
    store.finishAction(action.id, { status: "completed", result: "inspection complete", metadata: { codexThreadId: "thread-1" } });
    const details = store.taskDetails(taskOne.id);
    assert.equal(details.task.id, taskOne.id);
    assert.equal(details.evidence[0].id, first.id);
    assert.equal(details.actions[0].metadata.codexThreadId, "thread-1");
    store.updateTask(taskOne.id, { status: "done" });
    const reopened = store.updateTaskNextStep(taskOne.id, "补充现场设备回归验证");
    assert.equal(reopened.task.status, "planned");
    assert.match(reopened.task.description, /## 下一步/);
    assert.match(reopened.task.description, /现场设备回归验证/);
    assert.equal(reopened.actions[0].metadata.updatedCurrentTask, true);
    const confirmed = store.confirmTaskDone(taskOne.id, "现场验证已经完成");
    assert.equal(confirmed.task.status, "done");
    assert.match(confirmed.task.result, /现场验证已经完成/);
    assert.equal(confirmed.actions[0].metadata.userConfirmed, true);

    store.addTask({ fingerprint: "maintenance-task", title: "repair agent", priority: "critical", domain: "agent_maintenance" });
    const userTask = store.addTask({ fingerprint: "user-task", title: "handle project issue", priority: "normal", domain: "user_work" });
    assert.equal(store.pendingAutoTasks(["read"], 1)[0].id, userTask.id);
    assert.equal(store.taskSnapshot(4).queued[0].domain, "user_work");

    const evolvingOne = store.addTask({ title: "review current bug", actionType: "audit_bug", evidenceIds: [first.id] });
    const evolvingTwo = store.addTask({ title: "review current bug", actionType: "audit_bug", evidenceIds: [searchable.id] });
    assert.equal(evolvingOne.id, evolvingTwo.id);
    store.appendTaskEvidence(evolvingOne.id, [searchable.id]);
    assert.deepEqual(JSON.parse(store.db.prepare("SELECT source_evidence_ids_json FROM tasks WHERE id=?").get(evolvingOne.id).source_evidence_ids_json), [first.id, searchable.id].sort());

    for (let index = 0; index < 6; index += 1) {
      store.addTask({
        fingerprint: `queue-cap-${index}`,
        title: `queue task ${index}`,
        priority: index < 2 ? "high" : "normal",
        domain: "user_work",
        riskLevel: "read",
      });
    }
    const balance = store.rebalanceActiveReadTasks(4);
    assert.ok(balance.backlogged >= 2);
    assert.equal(store.taskSnapshot(20).counts.queued, 4);
    assert.ok(store.taskSnapshot(20).counts.backlog >= 2);
    assert.equal(store.pendingAutoTasks(["read"], 20).some((task) => task.status === "backlog"), false);

    const eventOne = store.receiveExternalEvent({
      provider: "feishu",
      eventType: "im.message.receive_v1",
      eventId: "evt-1",
      dedupeKey: "feishu:evt-1",
      conversationKey: "chat-1",
      evidenceId: first.id,
    });
    const eventTwo = store.receiveExternalEvent({
      provider: "feishu",
      eventType: "im.message.receive_v1",
      eventId: "evt-1",
      dedupeKey: "feishu:evt-1",
      conversationKey: "chat-1",
      evidenceId: first.id,
    });
    assert.equal(eventOne.inserted, true);
    assert.equal(eventTwo.inserted, false);
    assert.equal(store.startExternalEvent(eventOne.id).attempts, 1);
    assert.equal(store.finishExternalEvent(eventOne.id, { responseExternalId: "reply-1" }).status, "processed");
    assert.equal(store.stats().external_event_receipts, 1);

    const bindingOne = store.bindConversation({
      provider: "feishu",
      conversationKey: "chat-1",
      lastMessageId: "message-1",
    });
    const bindingTwo = store.bindConversation({
      provider: "feishu",
      conversationKey: "chat-1",
      lastMessageId: "message-2",
    });
    assert.equal(bindingOne.session_key, bindingTwo.session_key);
    assert.equal(bindingTwo.last_message_id, "message-2");

    const reminderOne = store.createReminder({
      idempotencyKey: "reminder-1",
      title: "提交日报",
      dueAt: "2026-08-12T12:30:00.000Z",
      evidenceIds: [first.id],
    });
    const reminderTwo = store.createReminder({
      idempotencyKey: "reminder-1",
      title: "提交日报",
      dueAt: "2026-08-12T12:30:00.000Z",
    });
    assert.equal(reminderOne.inserted, true);
    assert.equal(reminderTwo.inserted, false);
    store.updateReminder(reminderOne.id, { status: "scheduled", cronJobId: "cron-1" });
    assert.equal(store.deliverReminder(reminderOne.id).status, "notification_pending");
    assert.equal(store.reminder(reminderOne.id).delivered_at, null);
    assert.equal(store.completeReminderDelivery(reminderOne.id).status, "delivered");
    assert.equal(store.listReminders()[0].id, reminderOne.id);
    assert.equal(store.acknowledgeReminder(reminderOne.id).status, "acknowledged");
    assert.equal(store.listReminders().length, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("openDatabaseReadOnly neither initializes nor modifies the database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-db-readonly-"));
  const databasePath = path.join(root, "test.sqlite");
  const writable = openDatabase(databasePath);
  try {
    writable.upsertSource({ sourceKey: "readonly-proof", kind: "test", uri: "test://readonly" });
  } finally {
    writable.close();
  }

  const before = fs.readFileSync(databasePath);
  const beforeStat = fs.statSync(databasePath);
  const readOnly = openDatabaseReadOnly(databasePath);
  try {
    assert.equal(readOnly.db.prepare("SELECT COUNT(*) AS count FROM sources").get().count, 1);
    assert.equal(readOnly.stats().sources, 1);
    assert.throws(
      () => readOnly.db.exec("CREATE TABLE must_not_exist(id TEXT)"),
      /read.?only|readonly|writing/i,
    );
  } finally {
    readOnly.close();
  }

  const after = fs.readFileSync(databasePath);
  const afterStat = fs.statSync(databasePath);
  assert.deepEqual(after, before);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  const missingPath = path.join(root, "missing", "never-created.sqlite");
  assert.throws(() => openDatabaseReadOnly(missingPath));
  assert.equal(fs.existsSync(path.dirname(missingPath)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("external event receipts recover failed and stale processing leases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-external-retry-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const receipt = store.receiveExternalEvent({
      provider: "feishu",
      eventType: "im.message.receive_v1",
      eventId: "evt-retry",
      dedupeKey: "feishu:retry",
      metadata: { retryPayload: { message_id: "om-retry" } },
    });
    assert.equal(store.startExternalEvent(receipt.id).attempts, 1);
    const failed = store.finishExternalEvent(receipt.id, { status: "failed", error: "temporary" });
    assert.equal(failed.status, "failed");
    assert.ok(failed.next_attempt_at);
    store.db.prepare("UPDATE external_event_receipts SET next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), receipt.id);
    assert.deepEqual(store.recoverExternalEvents().map((row) => row.id), [receipt.id]);
    assert.equal(store.startExternalEvent(receipt.id).attempts, 2);
    assert.equal(store.finishExternalEvent(receipt.id, { status: "processed" }).next_attempt_at, null);

    const stale = store.receiveExternalEvent({
      provider: "feishu",
      eventType: "task.task.update_user_access_v2",
      eventId: "evt-stale",
      dedupeKey: "feishu:stale",
      metadata: { retryPayload: { event_id: "evt-stale" } },
    });
    store.startExternalEvent(stale.id);
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.db.prepare(`
      UPDATE external_event_receipts SET processing_started_at=?, updated_at=? WHERE id=?
    `).run(old, old, stale.id);
    assert.ok(store.recoverExternalEvents({ staleSeconds: 30 }).some((row) => row.id === stale.id));
    assert.equal(store.externalEvent(stale.id).status, "failed");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reminder migration preserves legacy rows while adding runtime state columns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-db-reminder-migration-"));
  const databasePath = path.join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE reminders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_schedule',
      source_locator TEXT,
      source_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      task_id TEXT,
      explicit INTEGER NOT NULL DEFAULT 1,
      cron_job_id TEXT,
      parent_reminder_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT,
      last_error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(parent_reminder_id) REFERENCES reminders(id) ON DELETE SET NULL
    );
  `);
  legacy.prepare(`
    INSERT INTO reminders(
      id, idempotency_key, title, message, due_at, status, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-reminder",
    "legacy-key",
    "保留旧提醒",
    "旧数据不能丢失",
    "2026-08-15T01:00:00.000Z",
    "scheduled",
    "2026-08-14T00:00:00.000Z",
    "2026-08-14T00:00:00.000Z",
  );
  legacy.close();

  const migrated = openDatabase(databasePath);
  try {
    const reminder = migrated.reminder("legacy-reminder");
    assert.equal(reminder.title, "保留旧提醒");
    assert.equal(reminder.status, "scheduled");
    assert.equal(reminder.revision, 1);
    assert.equal(reminder.notification_started_at, null);
    assert.equal(reminder.cancelled_at, null);
  } finally {
    migrated.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
