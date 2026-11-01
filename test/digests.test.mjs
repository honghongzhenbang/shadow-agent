import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import { buildDigests } from "../src/digests.mjs";

const config = { collection: { maxEvidenceChars: 16000, digestThreadQuietSeconds: 0 } };

test("thread digests keep only the current searchable snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-digest-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "codex:test", kind: "codex_rollout", uri: "test://rollout" });
    store.upsertThread({
      id: "thread-1",
      title: "测试会话",
      cwd: root,
      rolloutPath: "test.jsonl",
      updatedAtMs: Date.now(),
    });
    const firstRaw = store.addEvidence({
      sourceId: source.id,
      kind: "codex_user_message",
      threadId: "thread-1",
      content: "实现第一版影子 Agent",
      title: "user",
      sourceLocator: "test://rollout#1",
      fingerprint: "raw-1",
    });
    assert.equal(store.digestQueueCount(), 1);

    const first = buildDigests(store, config);
    assert.equal(first.queue.processed, 1);
    assert.equal(first.threads.threads, 1);
    assert.equal(first.threads.evidence, 1);
    assert.equal(first.threads.links, 1);
    assert.equal(store.digestQueueCount(), 0);
    let latestDigest = store.db.prepare("SELECT metadata_json FROM evidence WHERE kind='codex_thread_digest' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(JSON.parse(latestDigest.metadata_json).attentionWorthy, true);

    const second = buildDigests(store, config);
    assert.equal(second.queue.selected, 0);
    assert.equal(second.threads.threads, 0);
    assert.equal(second.threads.skipped, 0);
    assert.equal(store.addEvidence({
      sourceId: source.id,
      kind: "codex_user_message",
      threadId: "thread-1",
      content: "实现第一版影子 Agent",
      title: "user",
      sourceLocator: "test://rollout#1",
      fingerprint: "raw-1",
    }).inserted, false);
    assert.equal(store.digestQueueCount(), 0);

    store.addEvidence({
      sourceId: source.id,
      kind: "codex_agent_message",
      threadId: "thread-1",
      content: "第一版已完成采集器。",
      title: "assistant",
      sourceLocator: "test://rollout#2",
      fingerprint: "raw-2",
    });
    assert.equal(store.digestQueueCount(), 1);
    const third = buildDigests(store, config);
    assert.equal(third.queue.processed, 1);
    assert.equal(third.threads.threads, 1);
    assert.equal(third.threads.evidence, 1);
    latestDigest = store.db.prepare("SELECT metadata_json FROM evidence WHERE kind='codex_thread_digest' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(JSON.parse(latestDigest.metadata_json).attentionWorthy, false);

    store.addEvidence({
      sourceId: source.id,
      kind: "codex_user_message",
      threadId: "thread-1",
      content: "补充新的用户要求",
      title: "user",
      sourceLocator: "test://rollout#3",
      fingerprint: "raw-3",
    });
    const fourth = buildDigests(store, config);
    assert.equal(fourth.queue.processed, 1);
    latestDigest = store.db.prepare("SELECT metadata_json FROM evidence WHERE kind='codex_thread_digest' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(JSON.parse(latestDigest.metadata_json).attentionWorthy, true);

    const digests = store.db.prepare("SELECT id FROM evidence WHERE kind='codex_thread_digest'").all();
    assert.equal(digests.length, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE kind='codex_thread_digest_archive'").get().count, 0);
    assert.ok(store.evidenceByIds([firstRaw.id]).length);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("thread digest generation waits for quiet tool activity but not user input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-digest-quiet-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "codex:quiet", kind: "codex_rollout", uri: "test://quiet" });
    store.upsertThread({ id: "thread-quiet", title: "安静期", cwd: root, rolloutPath: "quiet.jsonl" });
    store.addEvidence({
      sourceId: source.id, kind: "codex_tool_output", threadId: "thread-quiet",
      content: "tool output", sourceLocator: "test://quiet#1", fingerprint: "quiet-tool-1",
    });
    assert.equal(store.pendingDigestTargets(10, { threadQuietSeconds: 120 }).length, 0);
    assert.equal(store.pendingDigestTargets(10, { threadQuietSeconds: 120, now: new Date(Date.now() + 121_000) }).length, 1);

    store.addEvidence({
      sourceId: source.id, kind: "codex_user_message", threadId: "thread-quiet",
      content: "new request", sourceLocator: "test://quiet#2", fingerprint: "quiet-user-1",
    });
    assert.equal(store.pendingDigestTargets(10, { threadQuietSeconds: 120 }).length, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fact-referenced old digests become non-searchable archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-digest-archive-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "codex:archive", kind: "codex_rollout", uri: "test://archive" });
    store.upsertThread({ id: "thread-archive", title: "归档", cwd: root, rolloutPath: "archive.jsonl" });
    store.addEvidence({
      sourceId: source.id, kind: "codex_user_message", threadId: "thread-archive",
      content: "first", sourceLocator: "test://archive#1", fingerprint: "archive-user-1",
    });
    buildDigests(store, config);
    const oldDigest = store.db.prepare("SELECT id FROM evidence WHERE kind='codex_thread_digest'").get();
    const factId = "fact-digest-archive";
    store.db.prepare(`
      INSERT INTO graph_entities(id, canonical_key, type, name, first_seen_at, last_seen_at, updated_at, metadata_json)
      VALUES('entity-digest-archive', 'test:digest-archive', 'Concept', 'digest archive', datetime('now'), datetime('now'), datetime('now'), '{}')
    `).run();
    store.db.prepare(`
      INSERT INTO graph_facts(
        id, fingerprint, subject_entity_id, predicate, object_value,
        status, confidence, observed_at, updated_at, metadata_json
      ) VALUES(?, ?, 'entity-digest-archive', 'DESCRIBES', 'first', 'active', 0.5, datetime('now'), datetime('now'), '{}')
    `).run(factId, factId);
    store.db.prepare("INSERT INTO graph_fact_evidence(fact_id,evidence_id,observed_at) VALUES(?,?,datetime('now'))").run(factId, oldDigest.id);

    store.addEvidence({
      sourceId: source.id, kind: "codex_user_message", threadId: "thread-archive",
      content: "second", sourceLocator: "test://archive#2", fingerprint: "archive-user-2",
    });
    const result = buildDigests(store, config);
    assert.equal(result.threads.archived, 1);
    assert.equal(result.threads.deleted, 0);
    assert.equal(store.db.prepare("SELECT kind FROM evidence WHERE id=?").get(oldDigest.id).kind, "codex_thread_digest_archive");
    assert.equal(store.searchEvidence("first", 20).some((row) => row.id === oldDigest.id), false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("thread digests never copy an unbounded thread title", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-agent-digest-title-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "codex:title", kind: "codex_rollout", uri: "test://title" });
    const hugeTitle = `OpenClaw assembled context for this turn:\n${"旧上下文".repeat(10_000)}\nCurrent user request:\n核对机器人通信修复`;
    store.upsertThread({ id: "thread-title", title: hugeTitle, cwd: root, rolloutPath: "title.jsonl" });
    store.addEvidence({
      sourceId: source.id,
      kind: "codex_user_message",
      threadId: "thread-title",
      content: "核对机器人通信修复",
      title: "user",
      sourceLocator: "test://title#1",
      fingerprint: "title-raw-1",
    });
    buildDigests(store, { collection: { maxEvidenceChars: 16000, digestThreadQuietSeconds: 0 }, codex: { titleMaintenance: { maxDigestTitleChars: 100 } } });
    const digest = store.db.prepare("SELECT title, content FROM evidence WHERE kind='codex_thread_digest'").get();
    assert.ok(Array.from(digest.title).length <= 100);
    assert.match(digest.title, /^核对机器人通信修复 · 摘要 1$/);
    assert.match(digest.content, /- title: 核对机器人通信修复/);
    assert.ok(digest.content.length < 10_000);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
