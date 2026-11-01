import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../../../src/db.mjs";
import { buildSessionBootstrap, createShadowContextEngine } from "./context-engine.js";

function removeDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

test("context engine keeps one projection identity across dynamic session state and delegates compaction", async () => {
  const databasePath = path.join(os.tmpdir(), `shadow-context-engine-${process.pid}-${Date.now()}.sqlite`);
  const store = openDatabase(databasePath);
  try {
    const sessionKey = "agent:main:shadow:test-context-engine";
    store.bindWorkSession({
      provider: "feishu",
      routeKey: "chat:test:thread:root",
      sessionKey,
      sessionKind: "conversation",
      metadata: { title: "激光跟踪通信讨论" },
    });
    // Dynamic private facts are delivered per turn, never baked into native-thread identity.
    const first = buildSessionBootstrap({ databasePath }, sessionKey);
    const second = buildSessionBootstrap({ databasePath }, sessionKey);
    assert.equal(first.epoch, second.epoch);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.match(first.text, /soft relations/);
    assert.doesNotMatch(first.text, /激光跟踪通信讨论|维护机器人协议/);

    let compactedWith = null;
    const engine = createShadowContextEngine({ databasePath }, async (params) => {
      compactedWith = params;
      return { ok: true, compacted: true };
    });
    const assembled = await engine.assemble({
      sessionId: "runtime-id",
      sessionKey,
      messages: [{ role: "user", content: "继续检查心跳" }],
      tokenBudget: 10000,
    });
    assert.equal(assembled.contextProjection.mode, "thread_bootstrap");
    assert.equal(assembled.contextProjection.epoch, first.epoch);
    assert.equal(assembled.contextProjection.fingerprint, first.fingerprint);
    assert.equal(assembled.promptAuthority, "preassembly_may_overflow");
    assert.equal(assembled.messages.length, 1);
    assert.equal(engine.info.transcriptSemantics.currentTurnFence, "before-current-turn-entry-v1");
    assert.equal(engine.info.transcriptSemantics.turnAdvancementIdempotency, "atomic-idempotent-v1");
    const commitParams = {
      advancementKey: "advance:test:1",
      admission: { entryId: "user-entry" },
      terminal: { entryId: "assistant-entry" },
      messages: [
        { role: "user", content: "继续检查心跳" },
        { role: "assistant", content: "检查完成" },
      ],
      sessionId: "runtime-id",
      sessionKey,
    };
    assert.equal((await engine.commitTurn(commitParams)).status, "committed");
    assert.equal((await engine.commitTurn(commitParams)).status, "duplicate");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM context_engine_turn_commits").get().count,
      1,
    );
    const compactResult = await engine.compact({ sessionId: "runtime-id", sessionFile: "test.jsonl" });
    assert.equal(compactResult.compacted, true);
    assert.equal(compactedWith.sessionFile, "test.jsonl");

    store.setSetting("profile:test-change", "2");
    const changed = buildSessionBootstrap({ databasePath }, sessionKey);
    assert.equal(changed.epoch, first.epoch);
    assert.equal(changed.fingerprint, first.fingerprint);
    assert.equal(changed.text, first.text);
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

test("context engine projection identity does not depend on database availability", () => {
  const bootstrap = buildSessionBootstrap({ databasePath: path.join(os.tmpdir(), "missing-shadow-context.sqlite") }, "agent:main:test");
  assert.equal(bootstrap.epoch, "shadow-session-contract-v1");
  assert.match(bootstrap.text, /Dynamic duties, pending counts/);
});
