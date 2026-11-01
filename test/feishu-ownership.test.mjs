import assert from "node:assert/strict";
import test from "node:test";

import { backfillFeishuMessageOwnership } from "../src/collectors/feishu.mjs";
import { openDatabase } from "../src/db.mjs";
import {
  classifyFeishuMessageOwnership,
  planPersonalMessageBatch,
  permitsImmediatePersonalWake,
} from "../src/feishu-ownership.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const self = { openId: "ou_self", name: "示例人员19" };

test("personal Feishu ownership distinguishes self, others, and unassigned group messages", () => {
  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_sender", name: "示例人员49" },
    mentions: [{ id: "ou_other", name: "示例人员11" }],
  }, self).signal, "explicit_other_mention");

  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_sender", name: "示例人员24" },
    mentions: [],
  }, self).signal, "unassigned_group");

  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_sender", name: "示例人员11" },
    mentions: [{ id: "ou_self", name: "示例人员19" }],
  }, self).signal, "explicit_self_mention");

  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_bot", name: "Lab Assistant" },
    mentions: [],
    content: "示例人员19今日未查询到每日进度记录",
  }, self).signal, "explicit_self_mention");

  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_self", name: "示例人员19" },
    mentions: [],
  }, self).signal, "self_authored");

  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "p2p",
    sender: { id: "ou_sender", name: "示例人员46" },
  }, self).signal, "direct_message");

  assert.equal(classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_sender", name: "示例人员49" },
    reply_to_self: true,
  }, self).signal, "reply_to_self");
});

test("background group evidence wakes only an already activated conversation", () => {
  const background = classifyFeishuMessageOwnership({
    chat_type: "group",
    sender: { id: "ou_sender", name: "示例人员49" },
    mentions: [{ id: "ou_other", name: "示例人员11" }],
  }, self);
  assert.equal(permitsImmediatePersonalWake(background), false);
  assert.equal(permitsImmediatePersonalWake(background, { metadata_json: '{"ownershipActivated":true}' }), false);
  assert.equal(permitsImmediatePersonalWake(background, {
    metadata_json: JSON.stringify({ ownershipActivatedUntil: new Date(Date.now() + 60_000).toISOString() }),
  }), true);
  assert.equal(permitsImmediatePersonalWake({ immediate: true }), true);
});

test("group conversation activation expires without being extended by background traffic", () => {
  const startedAt = Date.parse("2026-08-29T01:00:00Z");
  const explicit = planPersonalMessageBatch([
    { immediate: true, occurredAt: "2026-08-29T01:00:00Z" },
  ], null, { activationHours: 24, now: startedAt });
  assert.equal(explicit.shouldWake, true);
  assert.equal(explicit.reason, "explicit_personal_signal");

  const binding = { metadata_json: JSON.stringify({ ownershipActivatedUntil: explicit.ownershipActivatedUntil }) };
  const continued = planPersonalMessageBatch([
    { immediate: false, occurredAt: "2026-08-29T12:00:00Z" },
  ], binding, { activationHours: 24, now: startedAt });
  assert.equal(continued.shouldWake, true);
  assert.equal(continued.ownershipActivatedUntil, explicit.ownershipActivatedUntil);

  const expired = planPersonalMessageBatch([
    { immediate: false, occurredAt: "2026-08-30T02:00:00Z" },
  ], binding, { activationHours: 24, now: startedAt });
  assert.equal(expired.shouldWake, false);
  assert.equal(expired.reason, "background_evidence_only");
});

test("legacy Feishu evidence receives ownership metadata without scanning unrelated evidence", () => {
  const databasePath = path.join(os.tmpdir(), `feishu-ownership-backfill-${process.pid}-${Date.now()}.sqlite`);
  const store = openDatabase(databasePath);
  try {
    const source = store.upsertSource({ sourceKey: "feishu-test", kind: "feishu", uri: "feishu://test" });
    const feishu = store.addEvidence({
      sourceId: source.id,
      kind: "feishu_message",
      content: JSON.stringify({
        sender: { id: "ou_sender", name: "示例人员49" },
        mentions: [{ id: "ou_other", name: "示例人员11" }],
      }),
      sourceLocator: "feishu://message/legacy",
      externalId: "legacy",
      metadata: { chatType: "group" },
    });
    store.db.prepare("UPDATE evidence SET metadata_json=? WHERE id=?")
      .run('{"chatType":"group","threadId":undefined}', feishu.id);
    store.addEvidence({
      sourceId: source.id,
      kind: "tool_output",
      content: "unrelated",
      sourceLocator: "test://unrelated",
      externalId: "unrelated",
    });

    assert.deepEqual(backfillFeishuMessageOwnership(store, self), {
      scanned: 1,
      updated: 1,
      skipped: false,
    });
    const metadata = JSON.parse(store.db.prepare("SELECT metadata_json FROM evidence WHERE id=?").get(feishu.id).metadata_json);
    assert.equal(metadata.ownershipSignal, "explicit_other_mention");
    assert.equal(metadata.threadId, null);
    assert.deepEqual(backfillFeishuMessageOwnership(store, self), { scanned: 0, updated: 0, skipped: true });
  } finally {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
});
