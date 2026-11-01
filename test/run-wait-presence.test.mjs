import assert from "node:assert/strict";
import test from "node:test";
import { patchRunWaitPresence } from "../scripts/apply-run-wait-presence.mjs";
import { openDatabase } from "../src/db.mjs";
import { runOpenClawTurn, pendingOpenClawTurn } from "../src/openclaw/cli.mjs";
import { enqueueLostRunReconciliation } from "../src/daemon.mjs";

test("wait presence patch is additive, idempotent and refuses upstream drift", () => {
  const source = '\t\t\t\ttimeoutPhase: activeRunRegistered ? "gateway_draining" : "queue",';
  const patched = patchRunWaitPresence(source);
  assert.match(patched, /runKnown: context.chatAbortControllers.has\(runId\)/);
  assert.equal(patchRunWaitPresence(patched), patched);
  const legacy = `${source}\n\t\t\t\t// shadow-run-wait-presence-v1\n\t\t\t\trunKnown: activeRunRegistered,`;
  assert.equal(patchRunWaitPresence(legacy), patched);
  assert.throws(() => patchRunWaitPresence("different upstream"), /Unsupported/);
  assert.throws(() => patchRunWaitPresence(source + source), /Unsupported/);
});

for (const absent of [true, false]) test(`unknown Gateway run, durable absence=${absent}, never blindly resubmits`, async () => {
  const store = openDatabase(":memory:");
  const input = { sessionKey: "agent:main:test", message: "Inspect", triggerKind: "attention", stateStore: store,
    idempotencyKey: "original", observeOnce: true };
  let submissions = 0;
  const client = { async connect() {}, stop() {}, async request(method) {
    if (method === "agent") { submissions++; return { runId: "native" }; }
    return { status: "timeout", timeoutPhase: "queue", providerStarted: false, runKnown: false };
  } };
  try {
    await assert.rejects(runOpenClawTurn("unused", input, { client: {
      ...client, async request(method) {
        if (method === "agent") { submissions++; return { runId: "native" }; }
        throw new Error("Gateway disconnected");
      },
    } }), { code: "OPENCLAW_RUN_UNCONFIRMED" });
    const error = await runOpenClawTurn("unused", input, { client, nativeRunAbsent: () => absent }).catch(error => error);
    assert.equal(error.code, absent ? "OPENCLAW_RUN_LOST" : "OPENCLAW_RUN_PENDING");
    assert.equal(submissions, 1);
    if (absent) {
      assert.equal(pendingOpenClawTurn(store, input.sessionKey), null);
      enqueueLostRunReconciliation(store, { sessionKey: input.sessionKey, runId: error.runId });
      enqueueLostRunReconciliation(store, { sessionKey: input.sessionKey, runId: error.runId });
      const changes = store.db.prepare("SELECT * FROM context_changes").all();
      assert.equal(changes.length, 1);
      assert.equal(changes[0].session_key, input.sessionKey);
      assert.equal(changes[0].kind, "runtime_reconciliation_due");
      assert.equal(JSON.parse(changes[0].metadata_json).outcome, "unknown");
    } else assert.equal(pendingOpenClawTurn(store, input.sessionKey).state, "running");
  } finally { store.close(); }
});
