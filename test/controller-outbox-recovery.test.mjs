import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";
import { evaluateConditionWatches, recoverConditionReviewActions } from "../src/condition-watches.mjs";

function enqueue(store) {
  return store.enqueueControllerAction({
    idempotencyKey: "condition:review:1", actionType: "wake_condition",
    payload: { text: "Review existing result", sessionKey: "agent:main:test" },
  });
}

test("successful wake without a condition decision remains pending and uses a new review turn after backoff", async () => {
  const store = openDatabase(":memory:");
  try {
    const watch = store.createConditionWatch({ idempotencyKey: "review", title: "External response", conditionText: "Check result",
      selector: { kinds: ["feishu_message"] }, timeoutAt: new Date(Date.now() - 1000).toISOString() });
    evaluateConditionWatches(store);
    const keys = [];
    const dependencies = { wake: async (_root, _text, _session, options) => {
      keys.push(options.idempotencyKey);
      return { text: "I will check" };
    } };
    const result = await processControllerOutbox(store, {}, { dependencies });
    assert.equal(result.completed, 0);
    assert.equal(result.retried, 1);
    assert.equal(store.conditionWatch(watch.id).status, "timed_out");
    assert.match(store.conditionWatch(watch.id).last_error, /without resolving/);
    assert.equal((await processControllerOutbox(store, {}, { dependencies })).claimed, 0);
    store.db.prepare("UPDATE controller_outbox SET next_attempt_at='2020-01-01'").run();
    await processControllerOutbox(store, {}, { dependencies: { wake: async (...args) => {
      keys.push(args[3].idempotencyKey);
      store.updateConditionWatch(watch.id, { status: "active", candidateAt: null, timeoutAt: new Date(Date.now() + 3600000).toISOString() });
    } } });
    assert.notEqual(keys[0], keys[1]);
    assert.equal(store.db.prepare("SELECT status FROM controller_outbox").get().status, "completed");
  } finally { store.close(); }
});

test("old failed and false-completed condition wakes recover once without duplicating in-flight reviews", () => {
  const store = openDatabase(":memory:");
  try {
    for (const status of ["failed", "completed"]) {
      const watch = store.createConditionWatch({ idempotencyKey: status, title: status, conditionText: "Review",
        status: "candidate", selector: { kinds: ["feishu_message"] } });
      const old = store.enqueueControllerAction({ idempotencyKey: `condition-candidate:${watch.id}:old`, actionType: "wake_condition", payload: {} });
      store.finishControllerAction(old.id, { status });
    }
    assert.equal(recoverConditionReviewActions(store).length, 2);
    assert.equal(recoverConditionReviewActions(store).length, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM controller_outbox WHERE status='pending'").get().n, 2);
  } finally { store.close(); }
});

test("a pending condition turn keeps its exact idempotency key past ten observations", async () => {
  const store = openDatabase(":memory:");
  try {
    const watch = store.createConditionWatch({ idempotencyKey: "pending", title: "Wait", conditionText: "Review", status: "candidate" });
    recoverConditionReviewActions(store);
    store.db.prepare("UPDATE controller_outbox SET attempts=10").run();
    const result = await processControllerOutbox(store, {}, { dependencies: { wake: async () => {
      throw Object.assign(new Error("still running"), { code: "OPENCLAW_RUN_PENDING" });
    } } });
    assert.equal(result.retried, 1);
    assert.equal(JSON.parse(store.db.prepare("SELECT payload_json FROM controller_outbox").get().payload_json).reviewAttempt, undefined);
    store.updateConditionWatch(watch.id, { status: "cancelled" });
    store.db.prepare("UPDATE controller_outbox SET next_attempt_at='2020-01-01'").run();
    assert.equal((await processControllerOutbox(store, {}, { dependencies: { wake: () => assert.fail("stale review must not run") } })).completed, 1);
  } finally { store.close(); }
});

test("a long outbox wake renews its claim instead of being reclaimed after five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = openDatabase(":memory:");
  let finish;
  try {
    const action = enqueue(store);
    const work = processControllerOutbox(store, {}, { dependencies: { wake: () => new Promise((resolve) => { finish = resolve; }) } });
    store.db.prepare("UPDATE controller_outbox SET updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(action.id);
    t.mock.timers.tick(30_000);
    assert.equal(store.claimControllerActions().length, 0);
    finish({ text: "done" });
    assert.equal((await work).completed, 1);
  } finally { store.close(); }
});

test("unconfirmed runtime observation is retried past the ordinary action failure limit", async () => {
  const store = openDatabase(":memory:");
  try {
    const action = enqueue(store);
    store.db.prepare("UPDATE controller_outbox SET attempts=10 WHERE id=?").run(action.id);
    const result = await processControllerOutbox(store, {}, { dependencies: { wake: async () => {
      const error = new Error("Original run outcome remains unknown");
      error.code = "OPENCLAW_RUN_UNCONFIRMED";
      throw error;
    } } });
    assert.equal(result.retried, 1);
    assert.equal(result.failed, 0);
    assert.equal(store.db.prepare("SELECT status FROM controller_outbox WHERE id=?").get(action.id).status, "retry");
  } finally { store.close(); }
});

test("partial model text plus failed terminal cannot complete the durable outbox action", async () => {
  const store = openDatabase(":memory:");
  try {
    const action = enqueue(store);
    store.db.prepare("UPDATE controller_outbox SET attempts=9 WHERE id=?").run(action.id);
    const client = {
      async connect() {}, stop() {},
      async request(method) {
        if (method === "agent") return { runId: "outbox-run" };
        if (method === "agent.wait") return { status: "error", error: "provider error", endedAt: Date.now() };
        return { messages: [{ role: "assistant", timestamp: Date.now(), content: "Looking into it", stopReason: "toolUse" }] };
      },
    };
    const result = await processControllerOutbox(store, {}, { dependencies: {
      wake: (root, message, sessionKey, options) => runOpenClawTurn(root, { ...options, message, sessionKey }, { client }),
    } });
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 1);
    assert.equal(store.db.prepare("SELECT status FROM controller_outbox WHERE id=?").get(action.id).status, "failed");
  } finally { store.close(); }
});
