import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../src/db.mjs";
import { auditTaskProgress } from "../src/task-progress-supervisor.mjs";

function createWorkboard(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE workboard_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      execution_status TEXT,
      execution_session_key TEXT,
      execution_run_id TEXT,
      automation_json TEXT
    );
  `);
  return database;
}

test("bounded task supervisor skips watched work and wakes one due card exactly once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-task-progress-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  const workboardPath = path.join(root, "workboard.sqlite");
  const workboard = createWorkboard(workboardPath);
  const now = Date.parse("2026-08-25T03:00:00.000Z");
  try {
    const insert = workboard.prepare(`
      INSERT INTO workboard_cards(
        id, title, notes, status, priority, updated_at, archived_at,
        execution_status, execution_session_key, execution_run_id, automation_json
      ) VALUES(?, ?, '', ?, ?, ?, NULL, NULL, NULL, NULL, ?)
    `);
    insert.run("task-watched", "等待明确回复", "blocked", "high", now - 8 * 3_600_000,
      JSON.stringify({ projectKey: "examplevision" }));
    insert.run("task-due", "核对并推进构建结果", "todo", "urgent", now - 6 * 3_600_000,
      JSON.stringify({ projectKey: "examplevision" }));
    insert.run("task-next", "下一张待复查任务", "todo", "high", now - 5 * 3_600_000,
      JSON.stringify({ projectKey: "examplevision" }));
    store.createConditionWatch({
      idempotencyKey: "watched-condition",
      title: "等待外部回复",
      conditionText: "收到明确回复",
      selector: { conversationKeys: ["im:tracked"] },
      taskId: "task-watched",
      timeoutAt: "2026-08-25T05:00:00.000Z",
    });

    const first = await auditTaskProgress(store, { projectRoot: root, taskSupervision: {} }, {
      workboardPath,
      now,
      limit: 1,
      initialStaleMinutes: 60,
      defaultReviewMinutes: 120,
    });
    assert.equal(first.enqueued, 1);
    assert.equal(first.events[0].taskId, "task-due");
    const change = store.db.prepare("SELECT * FROM context_changes WHERE kind='task_progress_due'").get();
    assert.equal(JSON.parse(change.metadata_json).taskId, "task-due");
    assert.ok(change.session_key);
    const dueAttention = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='task-due'").get();
    assert.equal(dueAttention.next_review_at, "2026-08-25T05:00:00.000Z");
    assert.equal(dueAttention.continuation_kind, "internal_review");
    const watchedAttention = store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='task-watched'").get();
    assert.equal(watchedAttention.continuation_kind, "condition_watch");

    const second = await auditTaskProgress(store, { projectRoot: root, taskSupervision: {} }, {
      workboardPath,
      now: "2026-08-25T03:05:00.000Z",
      limit: 1,
      initialStaleMinutes: 60,
      defaultReviewMinutes: 120,
    });
    assert.equal(second.enqueued, 1);
    assert.equal(second.events[0].taskId, "task-next");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE kind='task_progress_due'").get().count, 2);

    store.db.prepare("UPDATE context_changes SET status='leased', lease_until='2026-08-25T04:00:00.000Z' WHERE kind='task_progress_due'").run();
    const third = await auditTaskProgress(store, { projectRoot: root, taskSupervision: {} }, {
      workboardPath,
      now: "2026-08-25T03:10:00.000Z",
      limit: 1,
      maxInFlight: 2,
    });
    assert.equal(third.enqueued, 0);
    assert.equal(third.skipped, "progress_review_capacity");
    assert.deepEqual(new Set(third.inFlightTaskIds), new Set(["task-due", "task-next"]));
  } finally {
    workboard.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending and expired reviews cannot monopolize capacity, valid leases still bound admission", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-progress-capacity-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  const workboardPath = path.join(root, "workboard.sqlite");
  const workboard = createWorkboard(workboardPath);
  const now = Date.parse("2026-10-15T03:00:00Z");
  try {
    const insert = workboard.prepare("INSERT INTO workboard_cards(id,title,status,priority,updated_at) VALUES(?,?,'todo','normal',?)");
    for (let i = 0; i < 6; i++) insert.run(`task-${i}`, `Task ${i}`, now - 86_400_000);
    const audit = (options = {}) => auditTaskProgress(store, { projectRoot: root }, { workboardPath, now, limit: 2, maxInFlight: 2, ...options });
    assert.equal((await audit()).enqueued, 2);
    assert.equal((await audit()).enqueued, 2);
    store.db.prepare("UPDATE context_changes SET status='leased', lease_until=? WHERE kind='task_progress_due'")
      .run(new Date(now + 60_000).toISOString());
    assert.equal((await audit()).skipped, "progress_review_capacity");
    const recovered = await audit({ now: now + 120_000 });
    assert.equal(recovered.enqueued, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM context_changes").get().n, 6);
    assert.equal((await audit({ now: now + 180_000 })).enqueued, 0);
    assert.equal(store.db.prepare("SELECT COUNT(DISTINCT json_extract(metadata_json,'$.taskId')) AS n FROM context_changes").get().n, 6);
  } finally {
    workboard.close(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review admission preserves deadline priority ahead of unreviewed low-priority work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-progress-order-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  const workboardPath = path.join(root, "workboard.sqlite");
  const workboard = createWorkboard(workboardPath);
  const now = Date.parse("2026-10-15T03:00:00Z");
  try {
    const insert = workboard.prepare("INSERT INTO workboard_cards(id,title,status,priority,updated_at) VALUES(?,?,'todo',?,?)");
    insert.run("overdue", "Previously reviewed delivery", "urgent", now - 86_400_000);
    insert.run("unreviewed", "Older low priority work", "low", now - 7 * 86_400_000);
    store.db.prepare(`INSERT INTO work_task_attention(card_id, owner_session_key, deadline_at,
      last_progress_requested_at, next_review_at, continuation_kind, updated_by, updated_at)
      VALUES('overdue','agent:main:test',?,?,?,'internal_review','test',?)`)
      .run(new Date(now - 60_000).toISOString(), new Date(now - 3_600_000).toISOString(),
        new Date(now - 60_000).toISOString(), new Date(now - 3_600_000).toISOString());
    const audit = () => auditTaskProgress(store, { projectRoot: root }, { workboardPath, now, limit: 1 });
    assert.equal((await audit()).events[0].taskId, "overdue");
    assert.equal((await audit()).events[0].taskId, "unreviewed");
  } finally {
    workboard.close(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale Codex execution is observed by original run, alive work waits and terminal work is reviewed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-progress-execution-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  const workboardPath = path.join(root, "workboard.sqlite");
  const workboard = createWorkboard(workboardPath);
  const now = Date.parse("2026-10-15T03:00:00Z");
  try {
    workboard.prepare(`INSERT INTO workboard_cards(id,title,status,priority,updated_at,execution_status,execution_run_id,execution_session_key)
      VALUES('long-run','Long engineering job','running','normal',?,'running','native-run','native-session')`).run(now - 43 * 86_400_000);
    store.db.prepare(`INSERT INTO work_task_attention(card_id, owner_session_key, continuation_kind, continuation_reference_id, updated_by, updated_at)
      VALUES('long-run','agent:main:test','codex_run','native-run','test',?)`).run(new Date(now).toISOString());
    const calls = [];
    const audit = (at, observation) => auditTaskProgress(store, { projectRoot: root }, {
      workboardPath, now: at,
      observeExecution: async (_, card) => { calls.push(card.execution_run_id); return observation; },
    });
    const active = await audit(now, { status: "pending", livenessState: "running" });
    assert.equal(active.enqueued, 0);
    assert.equal(active.observations[0].active, true);
    assert.equal((await audit(now + 60_000, { status: "error" })).enqueued, 0);
    assert.equal(calls.length, 1);
    const terminal = await audit(now + 4 * 3_600_000, { status: "ok", endedAt: now + 1000 });
    assert.equal(terminal.enqueued, 1);
    const change = store.db.prepare("SELECT metadata_json FROM context_changes WHERE kind='task_progress_due'").get();
    assert.equal(JSON.parse(change.metadata_json).executionRunId, "native-run");
    assert.equal(JSON.parse(change.metadata_json).executionObservation.status, "ok");
    assert.equal(store.db.prepare("SELECT continuation_kind FROM work_task_attention").get().continuation_kind, "codex_run");
    assert.equal(workboard.prepare("SELECT status FROM workboard_cards").get().status, "running");
    assert.deepEqual(calls, ["native-run", "native-run"]);

    workboard.prepare(`INSERT INTO workboard_cards(id,title,status,priority,updated_at,execution_status,execution_run_id)
      VALUES('closed-during-probe','User completed work','running','normal',?,'running','other-run')`).run(now - 86_400_000);
    store.db.prepare(`INSERT INTO work_task_attention(card_id, owner_session_key, continuation_kind, continuation_reference_id, updated_by, updated_at)
      VALUES('closed-during-probe','agent:main:other','codex_run','other-run','test',?)`).run(new Date(now).toISOString());
    const changed = await auditTaskProgress(store, { projectRoot: root }, {
      workboardPath, now,
      observeExecution: async () => {
        workboard.prepare("UPDATE workboard_cards SET status='done' WHERE id='closed-during-probe'").run();
        return { status: "pending", livenessState: "running" };
      },
    });
    assert.equal(changed.enqueued, 0);
    assert.equal(changed.observations[0].reason, "task_changed_during_observation");
  } finally {
    workboard.close(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
