import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "../src/db.mjs";
import { emitContextChange } from "../src/context-graph.mjs";
import { nextAttentionWork, confirmAttentionProgress } from "../src/daemon.mjs";
import { runOpenClawTurn, deferPendingOpenClawTurn } from "../src/openclaw/cli.mjs";
import { deferAttentionSession, attentionAttempt, advanceAttentionAttempt, captureAttentionBatch, attentionBatchProgress } from "../src/work-sessions.mjs";

test("a terminal model response without ACK backs off and gets a new semantic attempt, never a hot replay", async () => {
  const store = openDatabase(":memory:");
  try {
    const sessionKey = "agent:main:no-progress";
    const now = new Date().toISOString();
    emitContextChange(store.db, { eventKey: "unprocessed", kind: "human_agent_operation", sessionKey, notBefore: now, summary: "execute" });
    const pending = nextAttentionWork(store, { readyOnly: true });
    const attempt = attentionAttempt(store, pending);
    const batch = captureAttentionBatch(store, pending);
    const client = { async connect() {}, stop() {}, async request(method) {
      if (method === "agent") return { runId: attempt.runId };
      if (method === "agent.wait") return { status: "ok", terminalReply: { disposition: "visible", text: "Tool validation failed." } };
      return { messages: [] };
    } };
    await runOpenClawTurn("unused", { sessionKey, message: "process", stateStore: store, idempotencyKey: attempt.runId, attentionBatch: batch }, { client });
    assert.equal(attentionBatchProgress(store, batch).progressed, false);
    assert.throws(() => confirmAttentionProgress(store, batch), { code: "OPENCLAW_ATTENTION_NO_PROGRESS" });
    advanceAttentionAttempt(store, attempt);
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    deferAttentionSession(store, { sessionKey, notBefore: retryAt });
    assert.equal(nextAttentionWork(store, { readyOnly: true }), null);
    const next = nextAttentionWork(store, { readyOnly: true, now: retryAt });
    assert.notEqual(attentionAttempt(store, next).runId, attempt.runId);
    assert.equal(store.db.prepare("SELECT status FROM context_changes").get().status, "pending");
    store.db.prepare("UPDATE context_changes SET status='acknowledged'").run();
    assert.equal(attentionBatchProgress(store, batch).progressed, true);
  } finally { store.close(); }
});

test("attention recovery preserves leased changes and resumes even after acknowledgement or restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-attention-recovery-"));
  const databasePath = path.join(root, "test.sqlite");
  let store = openDatabase(databasePath);
  try {
    const sessionKey = "agent:main:test-recovery";
    const now = new Date().toISOString();
    emitContextChange(store.db, { eventKey: "pending-1", kind: "task_progress_due", sessionKey, notBefore: now, summary: "review" });
    store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='owner-1', lease_until=?")
      .run(new Date(Date.now() + 600_000).toISOString());
    const disconnected = {
      async connect() {}, stop() {},
      async request(method) {
        if (method === "agent") return { runId: "native-run" };
        if (method === "agent.wait") throw new Error("connection lost");
        return { messages: [] };
      },
    };
    await assert.rejects(runOpenClawTurn("unused", {
      sessionKey, message: "inspect", idempotencyKey: "operation-1", triggerKind: "attention", stateStore: store,
    }, { client: disconnected }), { code: "OPENCLAW_RUN_UNCONFIRMED" });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    assert.equal(deferPendingOpenClawTurn(store, sessionKey, retryAt), true);
    deferAttentionSession(store, { sessionKey, leaseOwner: "owner-1", notBefore: retryAt, preserveLease: true });
    assert.equal(store.db.prepare("SELECT status FROM context_changes").get().status, "leased");
    assert.equal(nextAttentionWork(store, { readyOnly: true, now }), null);
    // The old model may finish and ACK while the caller is disconnected.
    store.db.prepare("UPDATE context_changes SET status='acknowledged'").run();
    store.close();
    store = openDatabase(databasePath);
    const recovery = nextAttentionWork(store, { readyOnly: true, now: retryAt });
    assert.equal(recovery.session_key, sessionKey);
    assert.equal(recovery.recoveryRunId, "operation-1");
    let submissions = 0;
    const resumed = {
      async connect() {}, stop() {},
      async request(method, params) {
        if (method === "agent") submissions++;
        if (method === "agent.wait") {
          assert.equal(params.runId, "native-run");
          return { status: "ok", terminalReply: { disposition: "visible", text: "Finished." } };
        }
        return { messages: [] };
      },
    };
    await runOpenClawTurn("unused", {
      sessionKey, message: "resume observation only", idempotencyKey: recovery.recoveryRunId,
      stateStore: store, triggerKind: "attention", resumePending: true,
    }, { client: resumed });
    assert.equal(submissions, 0);
    assert.equal(nextAttentionWork(store, { readyOnly: true, now: retryAt }), null);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
