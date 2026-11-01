import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readNativeTerminal } from "../src/openclaw/native-terminal.mjs";
import { openDatabase } from "../src/db.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";

test("native recovery requires a matching successful end and model result, not nearby session text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-native-proof-"));
  const dir = path.join(root, "runtime/openclaw-poc/state/agents/main/agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  const store = openDatabase(":memory:");
  try {
    db.exec("CREATE TABLE trajectory_runtime_events(session_id TEXT,seq INTEGER,run_id TEXT,event_json TEXT,created_at TEXT)");
    const add = (type, seq, data) => db.prepare("INSERT INTO trajectory_runtime_events VALUES(?,?,?,?,?)")
      .run("session", seq, "accepted", JSON.stringify({ type, ts: new Date().toISOString(), sessionKey: "stable", data }), new Date().toISOString());
    const input = { sessionKey: "stable", message: "inspect", idempotencyKey: "op", stateStore: store };
    await assert.rejects(runOpenClawTurn(root, input, { client: {
      async connect() {}, stop() {}, async request(method) {
        if (method === "agent") return { runId: "accepted" };
        throw new Error("Gateway restarted");
      },
    } }));
    add("model.completed", 1, { turnId: "turn", assistantTexts: ["Checked result."], aborted: false });
    assert.equal(readNativeTerminal(root, "stable", "accepted"), null);
    add("session.ended", 2, { turnId: "turn", status: "success" });
    assert.equal(readNativeTerminal(root, "wrong", "accepted"), null);
    const recovered = await runOpenClawTurn(root, input, { client: {
      connect() { assert.fail("durable proof needs no Gateway connection"); },
      request() { assert.fail("must not submit or re-wait"); }, stop() {},
    } });
    assert.equal(recovered.text, "Checked result.");
    assert.equal(recovered.payload.terminal.nativeProof.endSeq, 2);
    add("session.ended", 3, { turnId: "other-turn", status: "success" });
    assert.equal(readNativeTerminal(root, "stable", "accepted"), null);
  } finally { db.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an exact interrupted native run clears its active receipt without resubmitting or fetching unrelated history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-native-interrupted-"));
  const dir = path.join(root, "runtime/openclaw-poc/state/agents/main/agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  const store = openDatabase(":memory:");
  try {
    db.exec("CREATE TABLE trajectory_runtime_events(session_id TEXT,seq INTEGER,run_id TEXT,event_json TEXT,created_at TEXT)");
    const input = { sessionKey: "stable", message: "inspect", idempotencyKey: "op", stateStore: store };
    await assert.rejects(runOpenClawTurn(root, input, { client: {
      async connect() {}, stop() {}, async request(method) {
        if (method === "agent") return { runId: "accepted" };
        throw new Error("Gateway restarted");
      },
    } }));
    const at = new Date().toISOString();
    db.prepare("INSERT INTO trajectory_runtime_events VALUES(?,?,?,?,?)").run("session", 2, "accepted",
      JSON.stringify({ type: "session.ended", ts: at, sessionKey: "stable", data: { turnId: "turn", status: "interrupted" } }), at);
    assert.equal(readNativeTerminal(root, "stable", "not-this-run"), null);
    await assert.rejects(runOpenClawTurn(root, input, { client: {
      connect() { assert.fail("native terminal needs no network"); },
      request() { assert.fail("must not re-run or read unrelated text"); }, stop() {},
    } }), { code: "OPENCLAW_RUN_FAILED" });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'controller:turn-active:%'").get().n, 0);
    assert.equal(store.db.prepare("SELECT json_extract(value,'$.state') AS state FROM settings WHERE key LIKE 'controller:turn:%'").get().state, "failed");
  } finally { db.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
