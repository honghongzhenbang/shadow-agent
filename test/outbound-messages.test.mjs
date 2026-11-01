import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { processControllerOutbox } from "../src/controller-outbox.mjs";
import { openDatabase } from "../src/db.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-outbound-"));
  const store = openDatabase(path.join(root, "test.sqlite"));
  return { root, store, config: { projectRoot: root, feishu: {} } };
}

function cleanup({ root, store }) {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}

test("all Feishu outbound messages require explicit HITL approval", async () => {
  const state = fixture();
  const calls = [];
  try {
    const draft = state.store.createOutboundDraft({
      idempotencyKey: "hitl-question",
      messageKind: "question",
      recipientName: "测试同事",
      recipientOpenId: "ou_test_user",
      content: "请确认原始问题。",
      reason: "缺少接口责任边界的直接证据",
      sessionKey: "agent:main:shadow:test",
      taskId: "task-1",
      trackReply: true,
    });
    assert.equal(draft.status, "pending_confirmation");
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox").get().count, 0);

    const beforeApproval = await processControllerOutbox(state.store, state.config, {
      dependencies: { sendFeishu: async () => { throw new Error("must not send"); } },
    });
    assert.equal(beforeApproval.claimed, 0);

    const approved = state.store.approveOutboundDraft(draft.id, { content: "请确认修改后的问题。" });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_content, "请确认修改后的问题。");
    assert.equal(approved.revision, 2);

    const sent = await processControllerOutbox(state.store, state.config, {
      dependencies: {
        sendFeishu: async (_config, args) => {
          calls.push(args);
          return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_sent", chat_id: "oc_sent" } }), stderr: "" };
        },
      },
    });
    assert.equal(sent.completed, 1);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--as=user"));
    assert.ok(calls[0].includes("--user-id=ou_test_user"));
    assert.ok(calls[0].includes("--text=请确认修改后的问题。"));
    assert.equal(state.store.outboundDraft(draft.id).status, "sent");
    assert.equal(state.store.outboundDraft(draft.id).sent_message_id, "om_sent");
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM condition_watches").get().count, 1);
    const watch = state.store.db.prepare("SELECT * FROM condition_watches").get();
    assert.equal(watch.task_id, "task-1");
    assert.ok(Date.parse(watch.timeout_at) > Date.now());
    const attention = state.store.db.prepare("SELECT * FROM work_task_attention WHERE card_id='task-1'").get();
    assert.equal(attention.continuation_kind, "condition_watch");
    assert.equal(attention.continuation_reference_id, watch.id);
    assert.equal(attention.next_review_at, watch.timeout_at);
    assert.match(attention.continuation_summary, /等待测试同事/);
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE kind='feishu_outbound_message'").get().count, 1);
  } finally {
    cleanup(state);
  }
});

test("reply drafts preserve the selected Feishu sender identity in the same HITL queue", async () => {
  const state = fixture();
  let sentArgs = null;
  try {
    const draft = state.store.createOutboundDraft({
      idempotencyKey: "hitl-reply",
      messageKind: "reply",
      senderIdentity: "bot",
      recipientName: "测试同事",
      replyToMessageId: "om_source",
      replyInThread: true,
      conversationKey: "im:oc_source:thread:om_root",
      content: "收到，我先核对。",
      reason: "回应对方的直接询问",
    });
    state.store.approveOutboundDraft(draft.id);
    await processControllerOutbox(state.store, state.config, {
      dependencies: {
        sendFeishu: async (_config, args) => {
          sentArgs = args;
          return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_reply", chat_id: "oc_source" } }), stderr: "" };
        },
      },
    });
    assert.deepEqual(sentArgs.slice(0, 3), ["im", "+messages-reply", "--message-id=om_source"]);
    assert.ok(sentArgs.includes("--reply-in-thread"));
    assert.ok(sentArgs.includes("--as=bot"));
  } finally {
    cleanup(state);
  }
});

test("automatic approval uses the same auditable outbox without a confirmation draft", async () => {
  const state = fixture();
  let sentArgs = null;
  try {
    const draft = state.store.createOutboundDraft({
      idempotencyKey: "automatic-reply",
      messageKind: "reply",
      senderIdentity: "bot",
      approvalMode: "automatic",
      recipientName: "测试同事",
      replyToMessageId: "om_auto_source",
      content: "自动模式回复。",
      reason: "显式 automatic 模式",
      trackReply: false,
    });
    assert.equal(draft.status, "approved");
    assert.equal(draft.approval_mode, "automatic");
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM controller_outbox").get().count, 1);
    await processControllerOutbox(state.store, state.config, {
      dependencies: {
        sendFeishu: async (_config, args) => {
          sentArgs = args;
          return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_auto", chat_id: "oc_auto" } }), stderr: "" };
        },
      },
    });
    assert.ok(sentArgs.includes("--as=bot"));
    assert.equal(state.store.outboundDraft(draft.id).status, "sent");
    assert.equal(state.store.db.prepare("SELECT COUNT(*) AS count FROM condition_watches").get().count, 0);
  } finally {
    cleanup(state);
  }
});

test("cancelled drafts never enter the send queue", async () => {
  const state = fixture();
  try {
    const draft = state.store.createOutboundDraft({
      idempotencyKey: "hitl-cancel",
      messageKind: "message",
      recipientName: "测试同事",
      chatId: "oc_cancel",
      content: "这条消息不应发送。",
      reason: "验证取消路径",
    });
    const cancelled = state.store.cancelOutboundDraft(draft.id, { reason: "尚未验证，不应承诺完成时间。" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(JSON.parse(cancelled.metadata_json).audit.at(-1).reason, "尚未验证，不应承诺完成时间。");
    const result = await processControllerOutbox(state.store, state.config, {
      dependencies: { sendFeishu: async () => { throw new Error("must not send"); } },
    });
    assert.equal(result.claimed, 0);
  } finally {
    cleanup(state);
  }
});

test("failed approved sends retry with the same draft revision", async () => {
  const state = fixture();
  let calls = 0;
  try {
    const draft = state.store.createOutboundDraft({
      idempotencyKey: "hitl-retry",
      messageKind: "question",
      taskId: "task-retry",
      recipientName: "测试同事",
      chatId: "oc_retry",
      content: "请回复测试结果。",
      reason: "等待外部验证",
    });
    state.store.approveOutboundDraft(draft.id);
    const first = await processControllerOutbox(state.store, state.config, {
      dependencies: { sendFeishu: async () => { calls += 1; throw new Error("temporary failure"); } },
    });
    assert.equal(first.retried, 1);
    assert.equal(state.store.outboundDraft(draft.id).status, "failed");
    state.store.db.prepare("UPDATE controller_outbox SET next_attempt_at=? WHERE action_type='send_feishu_message'")
      .run(new Date(Date.now() - 1000).toISOString());
    const second = await processControllerOutbox(state.store, state.config, {
      dependencies: {
        sendFeishu: async () => {
          calls += 1;
          return { stdout: JSON.stringify({ ok: true, data: { message_id: "om_retry", chat_id: "oc_retry" } }), stderr: "" };
        },
      },
    });
    assert.equal(second.completed, 1);
    assert.equal(calls, 2);
    assert.equal(state.store.outboundDraft(draft.id).status, "sent");
  } finally {
    cleanup(state);
  }
});
