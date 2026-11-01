import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import { processControllerOutbox } from "../src/controller-outbox.mjs";
import {
  conversationKeyForMessage,
  FeishuEventBridge,
  normalizeFeishuEvent,
  shouldQueueMessageForHitl,
} from "../src/realtime/feishu-events.mjs";

function runtimeConfig(root, mode = "hitl", senderIdentity = "user") {
  return {
    projectRoot: root,
    collection: { maxEvidenceChars: 16000 },
    contextGraph: {},
    tracking: {},
    feishu: { realtime: {}, outboundMessages: { mode, senderIdentity } },
  };
}

function message(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "p2p",
    sender_id: "ou_user",
    sender_type: "user",
    content: "请看一下这个问题",
    create_time: "1786507200000",
    mentions: [],
    ...overrides,
  };
}

function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = openDatabase(path.join(root, "test.sqlite"));
  return { root, store };
}

function cleanup(state) {
  state.store.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

test("Feishu events normalize stable keys and identify HITL candidates", () => {
  const normalized = normalizeFeishuEvent({ key: "im.message.receive_v1" }, {
    type: "im.message.receive_v1",
    message_id: "om_123",
    chat_id: "oc_123",
  });
  assert.equal(normalized.eventId, "om_123");
  assert.equal(conversationKeyForMessage({ chat_id: "oc_1", chat_type: "p2p" }), "im:oc_1");
  assert.equal(conversationKeyForMessage({ chat_id: "oc_1", chat_type: "group", root_id: "om_root" }), "im:oc_1:thread:om_root");
  assert.equal(shouldQueueMessageForHitl(message(), "ou_bot"), true);
  assert.equal(shouldQueueMessageForHitl(message({ chat_type: "group", mentions: [{ id: "ou_other" }] }), "ou_bot"), false);
  assert.equal(shouldQueueMessageForHitl(message({ chat_type: "group", mentions: [{ id: { open_id: "ou_bot" } }] }), "ou_bot"), true);
  assert.equal(shouldQueueMessageForHitl(message({ sender_type: "bot" }), "ou_bot"), false);
});

test("ordinary group messages are audited as background without waking OpenClaw", async () => {
  const state = fixture("shadow-events-background-");
  let attentionCount = 0;
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root),
      materialize: () => { throw new Error("background message must not materialize"); },
      scheduleAttention: async () => { attentionCount += 1; },
      runAgent: async () => { throw new Error("must not run agent"); },
      reply: async () => { throw new Error("must not reply"); },
    });
    bridge.botOpenId = "ou_bot";
    const payload = message({
      message_id: "om_background",
      chat_id: "oc_group",
      chat_type: "group",
      mentions: [{ id: { open_id: "ou_other" } }],
    });
    const first = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, payload);
    const duplicate = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, payload);
    assert.equal(first.status, "ignored");
    assert.equal(duplicate.status, "ignored");
    assert.equal(attentionCount, 0);
    assert.equal(state.store.stats().conversation_bindings, 0);
    assert.equal(JSON.parse(state.store.db.prepare("SELECT metadata_json FROM external_event_receipts").get().metadata_json).disposition, "background_ignored");
  } finally {
    cleanup(state);
  }
});

test("HITL mode generates pending drafts in stable sessions without sending", async () => {
  const state = fixture("shadow-events-hitl-");
  const attention = [];
  let agentCalls = 0;
  let replies = 0;
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root, "hitl"),
      scheduleAttention: async (input) => { attention.push(input); },
      runAgent: async () => { agentCalls += 1; return { text: "待确认回复" }; },
      reply: async () => { replies += 1; return { stdout: "{}" }; },
    });
    bridge.botOpenId = "ou_bot";
    const p2p = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message());
    const mention = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message({
      message_id: "om_2",
      chat_id: "oc_group",
      chat_type: "group",
      root_id: "om_root",
      mentions: [{ id: { open_id: "ou_bot" } }],
    }));
    assert.equal(p2p.status, "processed");
    assert.equal(mention.status, "processed");
    assert.equal(agentCalls, 2);
    assert.equal(replies, 0);
    assert.equal(attention.length, 2);
    const drafts = state.store.db.prepare("SELECT status,approval_mode,sender_identity,review_context_json FROM outbound_message_drafts ORDER BY created_at").all();
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((draft) => draft.status === "pending_confirmation"));
    assert.ok(drafts.every((draft) => draft.approval_mode === "hitl"));
    assert.ok(drafts.every((draft) => draft.sender_identity === "user"));
    assert.ok(drafts.every((draft) => JSON.parse(draft.review_context_json).trigger?.content));
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='send_feishu_message'").get().count, 0);
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE ack_note LIKE 'handled by dedicated Feishu hitl reply flow%'").get().count, 0);
    assert.ok(state.store.db.prepare("SELECT COUNT(*) AS count FROM context_changes WHERE kind='evidence_batch_ingested' AND status IN ('pending','leased')").get().count >= 1);
    assert.equal(state.store.stats().conversation_bindings, 2);
    const dispositions = state.store.db.prepare("SELECT metadata_json FROM external_event_receipts ORDER BY received_at").all()
      .map((row) => JSON.parse(row.metadata_json).disposition);
    assert.deepEqual(dispositions, ["hitl_review", "hitl_review"]);
  } finally {
    cleanup(state);
  }
});

test("HITL event bridge reuses a draft created during the same Agent turn", async () => {
  const state = fixture("shadow-events-hitl-dedup-");
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root, "hitl"),
      materialize: () => ({}),
      runAgent: async () => {
        state.store.createOutboundDraft({
          idempotencyKey: "agent-created-reply",
          messageKind: "reply",
          senderIdentity: "bot",
          recipientName: "测试同事",
          replyToMessageId: "om_1",
          content: "Agent 已建立的回复草稿",
          reason: "模拟旧工作区规则",
        });
        return { text: "事件桥返回正文" };
      },
    });
    bridge.botOpenId = "ou_bot";
    const result = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message());
    const drafts = state.store.db.prepare("SELECT * FROM outbound_message_drafts").all();
    assert.equal(result.status, "processed");
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].content, "Agent 已建立的回复草稿");
    assert.equal(JSON.parse(drafts[0].review_context_json).trigger.messageId, "om_1");
    assert.equal(result.response_external_id, `outbound-draft:${drafts[0].id}`);
  } finally {
    cleanup(state);
  }
});

test("HITL review snapshot contains the trigger and bounded recent conversation", async () => {
  const state = fixture("shadow-events-review-context-");
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root, "hitl"),
      runAgent: async () => ({ text: "收到，我来核对。" }),
    });
    bridge.botOpenId = "ou_bot";
    await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message({
      message_id: "om_context_1",
      sender_name: "测试同事",
      content: JSON.stringify({ text: "上一个问题处理到哪了？" }),
    }));
    await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message({
      message_id: "om_context_2",
      sender_name: "测试同事",
      content: JSON.stringify({ text: "今天能给结论吗？" }),
    }));
    const draft = state.store.db.prepare("SELECT * FROM outbound_message_drafts ORDER BY created_at DESC LIMIT 1").get();
    const context = JSON.parse(draft.review_context_json);
    assert.equal(context.trigger.content, "今天能给结论吗？");
    assert.equal(context.trigger.senderName, "测试同事");
    assert.ok(context.recentMessages.some((item) => item.content === "上一个问题处理到哪了？"));
    assert.ok(context.recentMessages.length <= 8);
  } finally {
    cleanup(state);
  }
});

test("automatic mode preserves the same realtime reply pipeline for later rollout", async () => {
  const state = fixture("shadow-events-automatic-");
  const agentCalls = [];
  const sends = [];
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root, "automatic", "bot"),
      materialize: () => ({}),
      scheduleAttention: async input => { assert.equal(input.reason, 'feishu-reply-source-review'); },
      runAgent: async (_root, input) => { agentCalls.push(input); return { text: "自动回复测试" }; },
    });
    bridge.botOpenId = "ou_bot";
    const result = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message());
    assert.equal(result.status, "processed");
    assert.equal(agentCalls.length, 1);
    const draft = state.store.db.prepare("SELECT * FROM outbound_message_drafts").get();
    assert.equal(draft.status, "approved");
    assert.equal(draft.approval_mode, "automatic");
    assert.equal(draft.sender_identity, "bot");
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox WHERE action_type='send_feishu_message'").get().count, 1);
    await processControllerOutbox(state.store, runtimeConfig(state.root, "automatic", "bot"), {
      dependencies: {
        sendFeishu: async (_config, args) => {
          sends.push(args);
          return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_reply", chat_id: "oc_1" } }), stderr: "" };
        },
      },
    });
    assert.equal(sends.length, 1);
    assert.ok(sends[0].includes("--as=bot"));
    assert.equal(state.store.outboundDraft(draft.id).status, "sent");
    assert.equal(JSON.parse(state.store.db.prepare("SELECT metadata_json FROM external_event_receipts").get().metadata_json).disposition, "automatic_reply");
  } finally {
    cleanup(state);
  }
});

test("user identity keeps realtime replies behind HITL even if automatic is configured", async () => {
  const state = fixture("shadow-events-user-identity-");
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root, "automatic", "user"),
      materialize: () => ({}),
      runAgent: async () => ({ text: "用户身份待确认回复" }),
    });
    bridge.botOpenId = "ou_bot";
    const result = await bridge.handle({ key: "im.message.receive_v1", identity: "bot" }, message());
    assert.equal(result.status, "processed");
    const draft = state.store.db.prepare("SELECT * FROM outbound_message_drafts").get();
    assert.equal(draft.status, "pending_confirmation");
    assert.equal(draft.approval_mode, "hitl");
    assert.equal(draft.sender_identity, "user");
    assert.equal(draft.reply_to_message_id, null);
    assert.equal(draft.recipient_open_id, "ou_user");
    assert.equal(JSON.parse(draft.metadata_json).outboundTargetMode, "user_direct_message");
  } finally {
    cleanup(state);
  }
});

test("duplicate HITL messages generate once and failed generation retries durably", async () => {
  const state = fixture("shadow-events-retry-");
  let attempts = 0;
  const spec = { key: "im.message.receive_v1", identity: "bot" };
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root, "hitl"),
      materialize: () => ({}),
      runAgent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary scheduler failure");
        return { text: "重试后的待确认回复" };
      },
    });
    bridge.botOpenId = "ou_bot";
    const payload = message({ message_id: "om_retry" });
    const failed = await bridge.handle(spec, payload);
    assert.equal(failed.status, "failed");
    const premature = await bridge.handle(spec, payload);
    assert.equal(premature.status, "failed");
    assert.equal(attempts, 1);
    state.store.db.prepare("UPDATE external_event_receipts SET next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), failed.id);
    const recovered = await bridge.recoverFailedEvents([spec]);
    assert.equal(recovered.recovered, 1);
    assert.equal(attempts, 2);
    assert.equal(state.store.externalEvent(failed.id).status, "processed");
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM outbound_message_drafts").get().count, 1);
    const duplicate = await bridge.handle(spec, payload);
    assert.equal(duplicate.status, "processed");
    assert.equal(attempts, 2);
  } finally {
    cleanup(state);
  }
});

test("non-message events enter the bounded attention scheduler", async () => {
  const state = fixture("shadow-events-non-message-");
  const attention = [];
  try {
    const bridge = new FeishuEventBridge({
      store: state.store,
      config: runtimeConfig(state.root),
      materialize: () => ({}),
      scheduleAttention: async (input) => { attention.push(input); },
    });
    await bridge.handle({ key: "task.task.update_user_access_v2", identity: "user" }, {
      schema: "2.0",
      header: { event_id: "evt_task", event_type: "task.task.update_user_access_v2", create_time: "1786507200000" },
      event: { task_guid: "task_1", event_types: ["task_summary_update"] },
    });
    assert.equal(attention.length, 1);
    assert.equal(attention[0].reason, "feishu-event:task.task.update_user_access_v2");
  } finally {
    cleanup(state);
  }
});
