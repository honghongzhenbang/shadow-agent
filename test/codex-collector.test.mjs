import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectCodex, readLinesFromOffset } from "../src/collectors/codex.mjs";
import { openDatabase } from "../src/db.mjs";

test("Codex rollout collection resumes from a byte cursor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-codex-"));
  const codexHome = path.join(root, ".codex");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "08");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {
      p1: { id: "p1", name: "Demo", rootPaths: [root] },
    },
  }), "utf8");
  const rollout = path.join(sessionDirectory, "rollout-test.jsonl");
  const rows = [
    { timestamp: "2026-08-08T01:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: root, source: "test" } },
    { timestamp: "2026-08-08T01:01:00Z", type: "event_msg", payload: { type: "user_message", client_id: "m1", message: "实现一个测试" } },
    { timestamp: "2026-08-08T01:02:00Z", type: "event_msg", payload: { type: "agent_message", message: "已经开始" } },
  ];
  fs.writeFileSync(rollout, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
  const config = {
    paths: { codexHome },
    collection: { includeArchivedSessions: true, maxEvidenceChars: 16000 },
    policy: { blockedPaths: [] },
  };
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  try {
    await collectCodex(store, config);
    const firstCount = store.stats().evidence;
    assert.equal(firstCount, 3);
    await collectCodex(store, config);
    assert.equal(store.stats().evidence, firstCount);
    fs.appendFileSync(rollout, `${JSON.stringify({ timestamp: "2026-08-08T01:03:00Z", type: "event_msg", payload: { type: "agent_message", message: "测试完成" } })}\n`, "utf8");
    await collectCodex(store, config);
    assert.equal(store.stats().evidence, firstCount + 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex rollout collection applies one newest-first global line budget", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-codex-budget-"));
  const codexHome = path.join(root, ".codex");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "08");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": {} }), "utf8");
  const makeRows = (threadId, label) => [
    { timestamp: "2026-08-08T01:00:00Z", type: "session_meta", payload: { id: threadId, cwd: root, source: "test" } },
    { timestamp: "2026-08-08T01:01:00Z", type: "event_msg", payload: { type: "user_message", message: `${label} request` } },
    { timestamp: "2026-08-08T01:02:00Z", type: "event_msg", payload: { type: "agent_message", message: `${label} response` } },
  ];
  const older = path.join(sessionDirectory, "rollout-older.jsonl");
  const newer = path.join(sessionDirectory, "rollout-newer.jsonl");
  fs.writeFileSync(older, `${makeRows("thread-old", "old").map(JSON.stringify).join("\n")}\n`, "utf8");
  fs.writeFileSync(newer, `${makeRows("thread-new", "new").map(JSON.stringify).join("\n")}\n`, "utf8");
  fs.utimesSync(older, new Date("2026-08-08T01:00:00Z"), new Date("2026-08-08T01:00:00Z"));
  fs.utimesSync(newer, new Date("2026-08-08T02:00:00Z"), new Date("2026-08-08T02:00:00Z"));
  const config = {
    paths: { codexHome },
    collection: { includeArchivedSessions: true, maxEvidenceChars: 16000, maxRolloutLinesPerCycle: 2 },
    policy: { blockedPaths: [] },
  };
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  try {
    const first = await collectCodex(store, config);
    assert.equal(first.metrics.lines, 2);
    assert.equal(first.metrics.lineBudgetExhausted, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE content LIKE '%new request%'").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE content LIKE '%old request%'").get().count, 0);

    const second = await collectCodex(store, config);
    assert.equal(second.metrics.lines, 2);
    assert.equal(second.metrics.lineBudgetExhausted, true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE content LIKE '%new response%'").get().count, 1);

    const third = await collectCodex(store, config, { maxTotalRolloutLines: 10 });
    assert.equal(third.metrics.lines, 2);
    assert.equal(third.metrics.lineBudgetExhausted, false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE content LIKE '%old response%'").get().count, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex rollout reads a fixed file snapshot while the active session keeps appending", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-codex-snapshot-"));
  const rollout = path.join(root, "rollout-active.jsonl");
  fs.writeFileSync(rollout, "first\nsecond\n", "utf8");
  const snapshotSize = fs.statSync(rollout).size;
  const lines = [];
  try {
    for await (const row of readLinesFromOffset(rollout, 0, Infinity, snapshotSize)) {
      lines.push(row.line);
      if (lines.length === 1) fs.appendFileSync(rollout, "third\n", "utf8");
    }
    assert.deepEqual(lines, ["first", "second"]);
    assert.equal(fs.statSync(rollout).size > snapshotSize, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
