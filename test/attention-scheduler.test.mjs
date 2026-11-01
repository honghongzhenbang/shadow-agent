import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { groupFeishuMessages } from "../src/attention-scheduler.mjs";
import { openDatabase } from "../src/db.mjs";
import {
  attentionLeaseOwner,
  attentionRetryDelayMs,
  attentionRunIdentity,
  bindWorkSession,
  deferAttentionSession,
  nextAttentionSession,
  routePendingContextChanges,
  stableWorkSessionKey,
} from "../src/work-sessions.mjs";

function tempStore(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  return { root, store: openDatabase(path.join(root, "test.sqlite")) };
}

function addChange(store, input) {
  store.db.prepare(`
    INSERT INTO context_changes(
      event_key, kind, project_key, priority, status, occurred_at, created_at,
      summary, metadata_json
    ) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    input.eventKey,
    input.kind ?? "evidence_batch_ingested",
    input.projectKey ?? null,
    input.priority ?? "normal",
    input.createdAt,
    input.createdAt,
    input.summary ?? input.eventKey,
    JSON.stringify(input.metadata ?? {}),
  );
}

test("high-priority task work bypasses fresh background but cannot starve aged sessions", () => {
  const { root, store } = tempStore("shadow-attention-priority");
  const now = new Date("2026-09-02T07:00:00.000Z");
  try {
    addChange(store, {
      eventKey: "fresh-background",
      createdAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      metadata: { conversationKey: "im:background", evidenceKind: "feishu_message" },
    });
    addChange(store, {
      eventKey: "urgent-task",
      kind: "task_progress_due",
      priority: "high",
      createdAt: now.toISOString(),
      metadata: { conversationKey: "im:task", taskId: "task-1" },
    });
    const originalNow = Date.now;
    Date.now = () => now.getTime();
    try { routePendingContextChanges(store, { directDebounceSeconds: 0 }); } finally { Date.now = originalNow; }
    store.db.prepare("UPDATE context_changes SET not_before=? WHERE event_key='fresh-background'")
      .run(new Date(now.getTime() - 5 * 60_000).toISOString());
    store.db.prepare("UPDATE context_changes SET not_before=? WHERE event_key='urgent-task'")
      .run(now.toISOString());
    assert.equal(
      nextAttentionSession(store, { readyOnly: true, now: now.toISOString() }).session_key,
      stableWorkSessionKey("task", "shadow-task", "task-1"),
    );

    store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE event_key='urgent-task'").run();
    store.db.prepare("UPDATE context_changes SET not_before=? WHERE event_key='fresh-background'")
      .run(new Date(now.getTime() - 20 * 60_000).toISOString());
    addChange(store, {
      eventKey: "new-urgent-task",
      kind: "task_progress_due",
      priority: "high",
      createdAt: now.toISOString(),
      metadata: { conversationKey: "im:new-task", taskId: "task-2" },
    });
    Date.now = () => now.getTime();
    try { routePendingContextChanges(store, { directDebounceSeconds: 0 }); } finally { Date.now = originalNow; }
    store.db.prepare("UPDATE context_changes SET not_before=? WHERE event_key='new-urgent-task'")
      .run(now.toISOString());
    assert.equal(
      nextAttentionSession(store, { readyOnly: true, now: now.toISOString() }).session_key,
      stableWorkSessionKey("conversation", "feishu", "im:background"),
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Feishu observations are grouped by conversation instead of ownership label", () => {
  const groups = groupFeishuMessages([
    { chatId: "chat-a", chatType: "group", threadId: "root-1", signal: "explicit_self_mention" },
    { chatId: "chat-a", chatType: "group", threadId: "root-1", signal: "unassigned_group" },
    { chatId: "chat-a", chatType: "group", threadId: "root-2", signal: "unassigned_group" },
  ]);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("im:chat-a:thread:root-1").length, 2);
});

test("stable work sessions reuse one key and isolate different routes", () => {
  const { root, store } = tempStore("shadow-session-routing");
  try {
    const first = bindWorkSession(store, { kind: "conversation", provider: "feishu", routeKey: "im:chat-a" });
    const second = bindWorkSession(store, { kind: "conversation", provider: "feishu", routeKey: "im:chat-a" });
    const other = bindWorkSession(store, { kind: "conversation", provider: "feishu", routeKey: "im:chat-b" });
    const workstream = bindWorkSession(store, { kind: "workstream", provider: "workstream", routeKey: "examplevision" });
    assert.equal(first.session_key, second.session_key);
    assert.notEqual(first.session_key, other.session_key);
    assert.notEqual(first.session_key, workstream.session_key);
    assert.equal(first.session_key, stableWorkSessionKey("conversation", "feishu", "im:chat-a"));
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending changes route to stable sessions and retain per-source debounce", () => {
  const { root, store } = tempStore("shadow-change-routing");
  const now = new Date("2026-08-13T02:00:00.000Z");
  try {
    addChange(store, {
      eventKey: "direct-a",
      createdAt: now.toISOString(),
      metadata: { conversationKey: "im:chat-a", evidenceKind: "feishu_message", ownershipSignals: ["direct_message"] },
    });
    addChange(store, {
      eventKey: "project-a",
      createdAt: now.toISOString(),
      projectKey: "examplevision",
      metadata: { evidenceKind: "git_history_digest" },
    });
    const originalNow = Date.now;
    Date.now = () => now.getTime();
    try {
      const routed = routePendingContextChanges(store, {
        directDebounceSeconds: 45,
        localChangeDebounceSeconds: 120,
        maxBatchWaitSeconds: 600,
      });
      assert.deepEqual(routed, { routed: 2, sessions: 2 });
    } finally {
      Date.now = originalNow;
    }
    const rows = store.db.prepare("SELECT event_key, session_key, not_before FROM context_changes ORDER BY event_key").all();
    const direct = rows.find((row) => row.event_key === "direct-a");
    const project = rows.find((row) => row.event_key === "project-a");
    assert.equal(direct.session_key, stableWorkSessionKey("conversation", "feishu", "im:chat-a"));
    assert.equal(project.session_key, stableWorkSessionKey("inbox", "shadow", "inbox"));
    assert.equal(Date.parse(direct.not_before) - now.getTime(), 45_000);
    assert.equal(Date.parse(project.not_before) - now.getTime(), 120_000);
    assert.equal(nextAttentionSession(store).session_key, direct.session_key);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attention failures keep one run identity and defer the whole session with bounded backoff", () => {
  const { root, store } = tempStore("shadow-attention-retry");
  const now = new Date("2026-08-31T02:00:00.000Z");
  try {
    addChange(store, { eventKey: "retry-a", createdAt: now.toISOString() });
    addChange(store, { eventKey: "retry-b", createdAt: now.toISOString() });
    const originalNow = Date.now;
    Date.now = () => now.getTime();
    try {
      routePendingContextChanges(store, { localChangeDebounceSeconds: 15 });
    } finally {
      Date.now = originalNow;
    }
    const pending = nextAttentionSession(store);
    const runId = attentionRunIdentity(pending.session_key, pending.first_seq, pending.last_seq, pending.change_count);
    assert.equal(runId, attentionRunIdentity(pending.session_key, pending.first_seq, pending.last_seq, pending.change_count));
    assert.notEqual(runId, attentionRunIdentity(pending.session_key, pending.first_seq, pending.last_seq + 1, pending.change_count));
    assert.notEqual(runId, attentionRunIdentity(pending.session_key, pending.first_seq, pending.last_seq, pending.change_count - 1));
    assert.equal(attentionLeaseOwner(pending.session_key, runId), attentionLeaseOwner(pending.session_key, runId));
    assert.notEqual(attentionLeaseOwner(pending.session_key, runId), attentionLeaseOwner(pending.session_key, `${runId}:next`));
    assert.equal(attentionRetryDelayMs(1, { retryBaseSeconds: 30, retryMaxSeconds: 900 }), 30_000);
    assert.equal(attentionRetryDelayMs(2, { retryBaseSeconds: 30, retryMaxSeconds: 900 }), 60_000);
    assert.equal(attentionRetryDelayMs(10, { retryBaseSeconds: 30, retryMaxSeconds: 900 }), 900_000);

    const retryAt = new Date(now.getTime() + 30_000).toISOString();
    assert.equal(deferAttentionSession(store, {
      sessionKey: pending.session_key,
      leaseOwner: "unused",
      notBefore: retryAt,
    }), 2);
    const rows = store.db.prepare(`
      SELECT status, not_before FROM context_changes WHERE session_key=? ORDER BY seq
    `).all(pending.session_key).map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { status: "pending", not_before: retryAt },
      { status: "pending", not_before: retryAt },
    ]);
    assert.equal(nextAttentionSession(store, { readyOnly: true, now: now.toISOString() }), null);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manual and resolved knowledge changes share one dedicated curator session", () => {
  const { root, store } = tempStore("shadow-knowledge-curation-routing");
  const now = new Date("2026-09-01T02:00:00.000Z");
  try {
    addChange(store, { eventKey: "manual-review", kind: "knowledge_review_due", createdAt: now.toISOString() });
    addChange(store, { eventKey: "resolved-delta", kind: "knowledge_delta_due", createdAt: now.toISOString() });
    const originalNow = Date.now;
    Date.now = () => now.getTime();
    try {
      assert.deepEqual(routePendingContextChanges(store, { knowledgeCurationDebounceSeconds: 15 }), { routed: 2, sessions: 1 });
    } finally {
      Date.now = originalNow;
    }
    const expected = stableWorkSessionKey("workstream", "shadow", "knowledge-curation");
    const rows = store.db.prepare("SELECT session_key, not_before FROM context_changes ORDER BY seq").all();
    assert.equal(rows.every((row) => row.session_key === expected), true);
    assert.equal(rows.every((row) => Date.parse(row.not_before) - now.getTime() === 15_000), true);
    const originalNotBefore = rows.map((row) => row.not_before);
    Date.now = () => now.getTime() + 10_000;
    try {
      assert.deepEqual(routePendingContextChanges(store, { knowledgeCurationDebounceSeconds: 15 }), { routed: 0, sessions: 0 });
    } finally {
      Date.now = originalNow;
    }
    assert.deepEqual(
      store.db.prepare("SELECT not_before FROM context_changes ORDER BY seq").all().map((row) => row.not_before),
      originalNotBefore,
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
