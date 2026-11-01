import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateConditionWatches,
  evidenceMatchesSelector,
  selectorHasStrongScope,
} from "../src/condition-watches.mjs";
import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { openDatabase } from "../src/db.mjs";

test("condition watches inspect only new evidence and queue semantic review", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-condition-watch-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "test", kind: "test", uri: "test://source" });
    store.addEvidence({
      sourceId: source.id,
      kind: "feishu_task",
      title: "旧任务状态",
      content: "pending",
      sourceLocator: "feishu://task/task-1",
      externalId: "task-1",
    });
    const watch = store.createConditionWatch({
      idempotencyKey: "watch-1",
      title: "等待任务完成",
      conditionText: "task-1 已完成",
      selector: { kinds: ["feishu_task"], externalIds: ["task-1"], containsAny: ["completed"] },
      sessionKey: "agent:main:task-1",
    });
    assert.equal(evaluateConditionWatches(store).candidates, 0);
    const newEvidence = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_task",
      title: "任务状态更新",
      content: "completed",
      sourceLocator: "feishu://task/task-1#completed",
      externalId: "task-1",
    });
    const result = evaluateConditionWatches(store);
    assert.equal(result.candidates, 1);
    assert.equal(store.conditionWatch(watch.id).status, "candidate");
    assert.deepEqual(JSON.parse(store.conditionWatch(watch.id).candidate_evidence_ids_json), [newEvidence.id]);
    let wakeSession = null;
    const processed = await processControllerOutbox(store, { projectRoot: root }, {
      dependencies: { wake: async (_root, _text, sessionKey, options) => {
        assert.equal(options.thinking, "high");
        wakeSession = sessionKey;
        store.updateConditionWatch(watch.id, { status: "completed", resolutionNote: "Verified by Agent" });
      } },
    });
    assert.equal(processed.completed, 1);
    assert.equal(wakeSession, "agent:main:task-1");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty selectors never match and timeouts use a persistent fallback", async () => {
  assert.equal(evidenceMatchesSelector({ kind: "anything", metadata_json: "{}" }, {}), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-condition-timeout-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const watch = store.createConditionWatch({
      idempotencyKey: "timeout-watch",
      title: "等待外部反馈",
      conditionText: "收到外部反馈",
      selector: { kinds: ["feishu_message"] },
      timeoutAt: new Date(Date.now() - 1000).toISOString(),
    });
    const result = evaluateConditionWatches(store);
    assert.equal(result.timedOut, 1);
    assert.equal(store.conditionWatch(watch.id).status, "timed_out");
    assert.equal(store.stats().controller_outbox, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact structural scope surfaces non-text replies while broad watches still require keywords", () => {
  const image = {
    kind: "feishu_message",
    title: "示例人员39发送了一张图片",
    content: "[Image: image_key]",
    external_id: "message-image",
    source_locator: "feishu://message/message-image",
    metadata_json: JSON.stringify({ conversationKey: "im:tracked-chat" }),
  };
  assert.equal(selectorHasStrongScope({ conversationKeys: ["im:tracked-chat"] }), true);
  assert.equal(evidenceMatchesSelector(image, {
    kinds: ["feishu_message"],
    conversationKeys: ["im:tracked-chat"],
    containsAny: ["重新采集", "3hz"],
  }), true);
  assert.equal(evidenceMatchesSelector(image, {
    kinds: ["feishu_message"],
    containsAny: ["重新采集", "3hz"],
  }), false);
  assert.equal(evidenceMatchesSelector(image, {
    kinds: ["feishu_message"],
    conversationKeys: ["im:other-chat"],
    containsAny: ["重新采集"],
  }), false);
});

test("candidate selection v2 recovers one bounded structurally scoped reply skipped by the old cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-condition-recovery-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const source = store.upsertSource({ sourceKey: "feishu", kind: "feishu", uri: "feishu://messages" });
    const watch = store.createConditionWatch({
      idempotencyKey: "recover-watch",
      title: "等待重新采集结果",
      conditionText: "示例人员39反馈重新采集结果",
      selector: {
        kinds: ["feishu_message"],
        conversationKeys: ["im:tracked-chat"],
        containsAny: ["重新采集", "3hz"],
      },
      taskId: "task-reacquire",
      sessionKey: "agent:main:tracked-chat",
    });
    const image = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      title: "示例人员39发送了一张图片",
      content: "[Image: image_key]",
      sourceLocator: "feishu://message/image-reply",
      externalId: "image-reply",
      metadata: { conversationKey: "im:tracked-chat", senderName: "示例人员39" },
    });
    const imageRowid = store.db.prepare("SELECT rowid AS value FROM evidence WHERE id=?").get(image.id).value;
    store.db.prepare("UPDATE condition_watches SET last_evidence_rowid=? WHERE id=?").run(imageRowid, watch.id);

    const result = evaluateConditionWatches(store, {
      now: "2026-08-25T02:00:00.000Z",
      recoveryEvidenceRows: 2000,
    });
    const recovered = store.conditionWatch(watch.id);
    assert.equal(result.recovered, 1);
    assert.equal(recovered.status, "candidate");
    assert.deepEqual(JSON.parse(recovered.candidate_evidence_ids_json), [image.id]);
    assert.equal(JSON.parse(recovered.metadata_json).candidateSelectionVersion, 2);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task outcome watches without an explicit timeout receive a bounded review deadline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-condition-review-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  try {
    const watch = store.createConditionWatch({
      idempotencyKey: "task-review-watch",
      title: "等待任务结果",
      conditionText: "收到任务结果",
      selector: { externalIds: ["external-task-1"] },
      taskId: "task-1",
    });
    const result = evaluateConditionWatches(store, {
      now: "2026-08-25T02:00:00.000Z",
      defaultTaskReviewMinutes: 120,
    });
    const updated = store.conditionWatch(watch.id);
    assert.equal(result.reviewDeadlinesAssigned, 1);
    assert.equal(updated.timeout_at, "2026-08-25T04:00:00.000Z");
    assert.equal(JSON.parse(updated.metadata_json).defaultReviewMinutes, 120);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
