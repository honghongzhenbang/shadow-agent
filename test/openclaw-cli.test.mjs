import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";

import { isNonTerminalOpenClawWait, waitForOpenClawRun, runOpenClawTurn, pendingOpenClawTurn } from "../src/openclaw/cli.mjs";

test("OpenClaw pending wait observations do not fail or end a long run", async () => {
  const observations = [
    { status: "pending", livenessState: "running" },
    { status: "pending", livenessState: "running" },
    { status: "ok", stopReason: "completed" },
  ];
  const calls = [];
  const client = {
    async request(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      return observations.shift();
    },
  };

  const result = await waitForOpenClawRun(client, "run-long", {
    waitSliceSeconds: 60,
    pendingBackoffMs: 0,
  });

  assert.equal(result.status, "ok");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === "agent.wait"));
  assert.ok(calls.every((call) => call.params.timeoutMs === 60_000));
  assert.ok(calls.every((call) => call.timeoutMs === 75_000));
});

test("OpenClaw terminal timeout remains a real terminal outcome", async () => {
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      return {
        status: "timeout",
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        endedAt: Date.now(),
      };
    },
  };

  const result = await waitForOpenClawRun(client, "run-timeout", {
    waitSliceSeconds: 60,
    pendingBackoffMs: 0,
  });

  assert.equal(result.status, "timeout");
  assert.equal(calls, 1);
});

test("OpenClaw wait-window timeout without an end timestamp keeps observing the active run", async () => {
  const observations = [
    { status: "timeout", timeoutPhase: "gateway_draining" },
    { status: "timeout", timeoutPhase: "queue", providerStarted: false },
    { status: "ok", stopReason: "completed", endedAt: Date.now() },
  ];
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      return observations.shift();
    },
  };

  const result = await waitForOpenClawRun(client, "run-long", {
    waitSliceSeconds: 60,
    pendingBackoffMs: 0,
  });

  assert.equal(result.status, "ok");
  assert.equal(calls, 3);
  assert.equal(isNonTerminalOpenClawWait({ status: "timeout", timeoutPhase: "provider" }), false);
});

function fakeGateway(observation, history = []) {
  const calls = [];
  return {
    calls, stopped: false,
    async connect() {},
    stop() { this.stopped = true; },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "agent") return { runId: "accepted-run" };
      if (method === "agent.wait") {
        if (observation instanceof Error) throw observation;
        return observation;
      }
      if (method === "chat.history") return { sessionId: "session-1", messages: history };
      throw new Error(`Unexpected method ${method}`);
    },
  };
}

const turn = { sessionKey: "test:turn", message: "inspect task", idempotencyKey: "test-run", historySinceAt: "2026-01-01T00:00:00Z" };
const partial = [{ role: "assistant", timestamp: Date.now(), content: "I am checking the result.", stopReason: "toolUse" }];

test("completed receipt is replayable offline without re-waiting or becoming unresolved", async () => {
  const store = openDatabase(":memory:");
  try {
    const input = { ...turn, stateStore: store };
    await runOpenClawTurn("unused", input, { client: fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "Verified." } }) });
    const offline = { connect() { assert.fail("completed result needs no Gateway"); }, stop() {} };
    for (let index = 0; index < 5; index++) {
      const replay = await runOpenClawTurn("unused", input, { client: offline });
      assert.equal(replay.text, "Verified.");
      assert.equal(replay.payload.replayed, true);
      assert.equal(pendingOpenClawTurn(store, turn.sessionKey), null);
    }
  } finally { store.close(); }
});

test("bounded observation yields a long run without failing or submitting a replacement", async () => {
  const store = openDatabase(":memory:");
  try {
    const input = { ...turn, stateStore: store, observeOnce: true };
    const active = fakeGateway({ status: "pending", livenessState: "running" });
    await assert.rejects(runOpenClawTurn("unused", input, { client: active }), { code: "OPENCLAW_RUN_PENDING" });
    assert.deepEqual(active.calls.map(c => c.method), ["agent", "agent.wait"]);
    assert.equal(pendingOpenClawTurn(store, turn.sessionKey).state, "running");
    const complete = fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "Done later." } });
    assert.equal((await runOpenClawTurn("unused", input, { client: complete })).text, "Done later.");
    assert.equal(complete.calls.some(c => c.method === "agent"), false);
  } finally { store.close(); }
});

test("full turn rejects intermediate text when runtime reports a failed terminal", async () => {
  const client = fakeGateway({ status: "error", error: "provider failed", endedAt: Date.now() }, partial);
  await assert.rejects(runOpenClawTurn("unused", turn, { client }), (error) => {
    assert.equal(error.code, "OPENCLAW_RUN_FAILED");
    assert.equal(error.runId, "accepted-run");
    assert.match(error.partialText, /checking/);
    assert.equal(error.turnMetrics.status, "failed");
    return true;
  });
  assert.equal(client.stopped, true);
});

test("observation loss preserves run identity and partial text, never succeeds", async () => {
  const client = fakeGateway(new Error("connection lost"), partial);
  await assert.rejects(runOpenClawTurn("unused", turn, { client }), (error) => {
    assert.equal(error.code, "OPENCLAW_RUN_UNCONFIRMED");
    assert.equal(error.runId, "accepted-run");
    assert.match(error.partialText, /checking/);
    return true;
  });
});

test("successful terminal must have a final reply, not tool-call commentary", async () => {
  const endedAt = Date.parse("2026-01-01T00:01:00Z");
  const inRunPartial = partial.map((message) => ({ ...message, timestamp: endedAt - 1 }));
  const client = fakeGateway({ status: "ok", endedAt }, inRunPartial);
  await assert.rejects(runOpenClawTurn("unused", turn, { client }), { code: "OPENCLAW_REPLY_UNCONFIRMED" });
  const final = fakeGateway({ status: "ok", endedAt }, [
    ...inRunPartial, { role: "assistant", timestamp: endedAt, content: "Verified result.", stopReason: "stop" },
  ]);
  const result = await runOpenClawTurn("unused", turn, { client: final });
  assert.equal(result.text, "Verified result.");
  const later = fakeGateway({ status: "ok", endedAt }, [
    { role: "assistant", timestamp: endedAt + 1, content: "A later result.", stopReason: "stop" },
  ]);
  await assert.rejects(runOpenClawTurn("unused", turn, { client: later }), { code: "OPENCLAW_REPLY_UNCONFIRMED" });
});

test("lost wait is reconciled with the accepted run across retries, not a second agent submission", async () => {
  const store = openDatabase(":memory:");
  try {
    const first = fakeGateway(new Error("connection lost"), partial);
    const input = { ...turn, stateStore: store };
    await assert.rejects(runOpenClawTurn("unused", input, { client: first }), { code: "OPENCLAW_RUN_UNCONFIRMED" });
    const next = fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "Recovered final." } });
    const result = await runOpenClawTurn("unused", input, { client: next });
    assert.equal(result.text, "Recovered final.");
    assert.equal(next.calls.filter((call) => call.method === "agent").length, 0);
    assert.equal(next.calls[0].params.runId, "accepted-run");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'controller:turn:%'").get().n, 1);
  } finally { store.close(); }
});

test("new input cannot bypass an unresolved run; attention can observe the older run first", async () => {
  const store = openDatabase(":memory:");
  try {
    await assert.rejects(runOpenClawTurn("unused", { ...turn, stateStore: store }, {
      client: fakeGateway(new Error("connection lost")),
    }));
    const newTurn = { ...turn, stateStore: store, message: "new work", idempotencyKey: "new-input" };
    const blocked = fakeGateway({ status: "ok" });
    await assert.rejects(runOpenClawTurn("unused", newTurn, { client: blocked }), { code: "OPENCLAW_SESSION_RECONCILIATION_REQUIRED" });
    assert.equal(blocked.calls.length, 0);
    const recovered = fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "Older result." } });
    const result = await runOpenClawTurn("unused", { ...newTurn, resumePending: true }, { client: recovered });
    assert.equal(result.payload.resumedEarlierTurn, true);
    assert.equal(recovered.calls.some((call) => call.method === "agent"), false);
    const fresh = fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "New result." } });
    await runOpenClawTurn("unused", newTurn, { client: fresh });
    assert.equal(fresh.calls.filter((call) => call.method === "agent").length, 1);
  } finally { store.close(); }
});

test("lost submission acknowledgement never resubmits an ambiguously accepted operation", async () => {
  const store = openDatabase(":memory:");
  try {
    const client = fakeGateway({ status: "ok" });
    client.request = async () => { throw new Error("acknowledgement lost"); };
    const input = { ...turn, stateStore: store };
    await assert.rejects(runOpenClawTurn("unused", input, { client }), { code: "OPENCLAW_RUN_UNCONFIRMED" });
    const resume = fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "Completed." } });
    await runOpenClawTurn("unused", input, { client: resume });
    assert.equal(resume.calls[0].method, "agent.wait");
    assert.equal(resume.calls[0].params.runId, "test-run");
    assert.equal(resume.calls.some((call) => call.method === "agent"), false);
  } finally { store.close(); }
});

test("an old failed operation stays deduplicated after another operation uses the same session", async () => {
  const store = openDatabase(":memory:");
  try {
    const input = { ...turn, stateStore: store };
    await assert.rejects(runOpenClawTurn("unused", input, {
      client: fakeGateway({ status: "error", error: "failed", endedAt: Date.now() }),
    }), { code: "OPENCLAW_RUN_FAILED" });
    await runOpenClawTurn("unused", { ...input, idempotencyKey: "different-operation" }, {
      client: fakeGateway({ status: "ok", terminalReply: { disposition: "visible", text: "Other result." } }),
    });
    const retry = fakeGateway({ status: "ok" });
    await assert.rejects(runOpenClawTurn("unused", input, { client: retry }), { code: "OPENCLAW_RUN_FAILED" });
    assert.equal(retry.calls.some((call) => call.method === "agent" || call.method === "agent.wait"), false);
  } finally { store.close(); }
});

test("racing callers cannot submit two unresolved runs for one session", async () => {
  const store = openDatabase(":memory:");
  let connected = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  try {
    const clients = [fakeGateway(new Error("disconnected")), fakeGateway(new Error("disconnected"))];
    for (const client of clients) client.connect = async () => { if (++connected === 2) release(); await barrier; };
    const results = await Promise.allSettled(clients.map((client, index) => runOpenClawTurn("unused", {
      ...turn, stateStore: store, idempotencyKey: `race-${index}`,
    }, { client })));
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(clients.flatMap((client) => client.calls).filter((call) => call.method === "agent").length, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'controller:turn-active:%'").get().n, 1);
  } finally { store.close(); }
});

test("explicit silent completion is allowed only for control wakeups, never for missing user replies", async () => {
  const silent = { status: "ok", terminalReply: { disposition: "silent" } };
  const result = await runOpenClawTurn("unused", { ...turn, allowSilent: true }, { client: fakeGateway(silent) });
  assert.equal(result.text, "");
  await assert.rejects(runOpenClawTurn("unused", turn, { client: fakeGateway(silent) }), { code: "OPENCLAW_REPLY_UNCONFIRMED" });
  await assert.rejects(runOpenClawTurn("unused", { ...turn, allowSilent: true }, {
    client: fakeGateway({ status: "ok", terminalReply: { disposition: "empty" } }),
  }), { code: "OPENCLAW_REPLY_UNCONFIRMED" });
});
