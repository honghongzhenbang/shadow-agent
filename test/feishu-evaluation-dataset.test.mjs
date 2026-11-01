import assert from "node:assert/strict";
import test from "node:test";

import {
  auditEvaluationDataset,
  buildEvaluationDataset,
  datasetInternals,
  episodeSuitability,
  messageIngressModes,
  normalizeDatasetConversation,
  segmentConversationEpisodes,
} from "../src/feishu-evaluation-dataset.mjs";

const self = { openId: "ou_self", name: "当前用户", botOpenId: "ou_bot" };

function message(id, sender, content, createTime, extra = {}) {
  return {
    message_id: id,
    sender: { id: sender, name: sender === "ou_self" ? "当前用户" : "同事", sender_type: "user" },
    content: JSON.stringify({ text: content }),
    create_time: createTime,
    msg_type: "text",
    ...extra,
  };
}

test("dataset normalization redacts credentials before persistence", () => {
  const conversation = normalizeDatasetConversation({
    chat_id: "oc_private",
    chat_mode: "p2p",
    chat_status: "normal",
    name: "同事",
    p2p_target_id: "ou_peer",
    p2p_target_type: "user",
  }, [message("om_1", "ou_peer", "密码: abcdefgh token=abcdefghijklmnopqrstuvwxyz1234567890", "2026-08-28T01:00:00Z")], self);
  const serialized = JSON.stringify(conversation);
  assert.doesNotMatch(serialized, /abcdefgh/);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.doesNotMatch(serialized, /oc_private|om_1|ou_peer/);
});

test("ingress modes distinguish p2p, mentions, replies, and self authored messages", () => {
  const group = { conversationKey: "eval:group:test", chatMode: "group" };
  const root = { messageKey: "root", sentBySelf: true, messageType: "text" };
  const reply = { messageKey: "reply", sentBySelf: false, parentMessageKey: "root", messageType: "text", mentionsSelf: false, mentionsBot: false };
  const mention = { messageKey: "mention", sentBySelf: false, messageType: "text", mentionsSelf: true, mentionsBot: true };
  assert.ok(messageIngressModes(group, reply, { messageByKey: new Map([["root", root]]) }).includes("group_reply_to_self"));
  const mentionModes = messageIngressModes(group, mention, { messageByKey: new Map() });
  assert.ok(mentionModes.includes("group_mention_self"));
  assert.ok(mentionModes.includes("bot_realtime_event_eligible"));
  assert.ok(messageIngressModes(group, root, { messageByKey: new Map() }).includes("group_self_authored"));
});

test("episode segmentation splits long gaps and freezes deterministic data splits", () => {
  const conversation = normalizeDatasetConversation({
    chat_id: "oc_episode",
    chat_mode: "p2p",
    chat_status: "normal",
    name: "同事",
    p2p_target_id: "ou_peer",
    p2p_target_type: "user",
  }, [
    message("om_1", "ou_peer", "第一件事", "2026-08-27T01:00:00Z"),
    message("om_2", "ou_self", "收到", "2026-08-27T01:05:00Z"),
    message("om_3", "ou_peer", "第二件事", "2026-08-28T02:00:00Z"),
  ], self);
  const episodes = segmentConversationEpisodes(conversation, { hardGapHours: 18, maxMessages: 30, maxBytes: 12_000 });
  assert.equal(episodes.length, 2);
  const first = buildEvaluationDataset([conversation]);
  const second = buildEvaluationDataset([conversation]);
  assert.deepEqual(first.episodes.map((item) => [item.episodeId, item.split]), second.episodes.map((item) => [item.episodeId, item.split]));
  const audit = auditEvaluationDataset(first);
  assert.equal(audit.messages, 3);
  assert.equal(audit.conversations, 1);
});

test("private redaction covers phone and email", () => {
  const value = datasetInternals.redactPrivateText("联系 13800138000 test@example.com");
  assert.equal(value, "联系 [REDACTED_PHONE] [REDACTED_EMAIL]");
});

test("private redaction covers Feishu identifiers", () => {
  const value = datasetInternals.redactPrivateText(
    "failed for oc_abc123 and ou_user456 and om_message789",
  );
  assert.doesNotMatch(value, /oc_abc123|ou_user456|om_message789/);
  assert.match(value, /\[REDACTED_FEISHU_ID\]/);
});

test("private redaction covers sensitive URL parameters", () => {
  const value = datasetInternals.redactPrivateText(
    "https://example.test/join?hash=secret-value&source=chat https://example.test/?ticket=abc123",
  );
  assert.doesNotMatch(value, /secret-value|abc123/);
  assert.match(value, /hash=\[REDACTED\]/);
  assert.match(value, /ticket=\[REDACTED\]/);
});

test("normalization maps lark-cli reply_to into the parent relation", () => {
  const conversation = normalizeDatasetConversation({
    chat_id: "oc_reply",
    chat_mode: "group",
    name: "群聊",
  }, [
    message("om_root", "ou_self", "请大家确认接口", "2026-08-28T01:00:00Z"),
    message("om_reply", "ou_peer", "已确认", "2026-08-28T01:01:00Z", { reply_to: "om_root" }),
  ], self);
  const reply = conversation.messages.at(-1);
  assert.ok(reply.parentMessageKey);
  const modes = messageIngressModes(conversation, reply, {
    messageByKey: new Map(conversation.messages.map((item) => [item.messageKey, item])),
  });
  assert.ok(modes.includes("group_reply_to_self"));
  assert.ok(modes.includes("thread_activity"));
});

test("group reply roots and replies are isolated from the main stream", () => {
  const conversation = normalizeDatasetConversation({
    chat_id: "oc_stream",
    chat_mode: "group",
    name: "群聊",
  }, [
    message("om_root", "ou_self", "请确认接口改动", "2026-08-28T01:00:00Z"),
    message("om_main", "ou_peer", "另一件不相关的事情", "2026-08-28T01:01:00Z"),
    message("om_reply", "ou_peer", "接口已经确认", "2026-08-28T01:02:00Z", { reply_to: "om_root" }),
  ], self);
  const episodes = segmentConversationEpisodes(conversation);
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map((item) => item.messageCount).sort(), [1, 2]);
});

test("episode suitability separates reply, continuity, and negative control uses", () => {
  const p2p = normalizeDatasetConversation({
    chat_id: "oc_suitable",
    chat_mode: "p2p",
    name: "同事",
  }, [
    message("om_1", "ou_self", "我先整理接口现状和验证范围", "2026-08-28T01:00:00Z"),
    message("om_2", "ou_peer", "请把现场日志也补充进去，今天下午给我", "2026-08-28T01:05:00Z"),
  ], self);
  const episode = segmentConversationEpisodes(p2p)[0];
  const suitability = episodeSuitability(episode);
  assert.equal(suitability.eligibility.ownershipAndTask, true);
  assert.equal(suitability.eligibility.replyDrafting, true);
  assert.equal(suitability.eligibility.continuity, false);

  const background = {
    ...episode,
    chatMode: "group",
    ingressModes: ["group_background"],
  };
  assert.equal(episodeSuitability(background).eligibility.negativeControl, true);
});

test("mixed human and app messages remain in one original-content episode", () => {
  const conversation = normalizeDatasetConversation({
    chat_id: "oc_mixed",
    chat_mode: "group",
    name: "项目群",
  }, [
    message("om_human_1", "ou_peer", "请确认今天构建是否通过", "2026-08-28T01:00:00Z"),
    message("om_app", "cli_app", "构建 #123 已通过，产物已归档", "2026-08-28T01:01:00Z", {
      sender: { id: "cli_app", name: "构建机器人", sender_type: "app" },
      msg_type: "interactive",
      content: JSON.stringify({ card: { title: "构建结果", body: "构建 #123 已通过，产物已归档" } }),
    }),
    message("om_human_2", "ou_peer", "那就继续安排设备验证", "2026-08-28T01:02:00Z"),
  ], self);
  const episode = segmentConversationEpisodes(conversation)[0];
  const suitability = episodeSuitability(episode);

  assert.equal(episode.messages.length, 3);
  assert.deepEqual(episode.messages.map((item) => item.senderType), ["user", "app", "user"]);
  assert.equal(suitability.eligibility.mixedHumanBotContext, true);
  assert.equal(suitability.measurements.botOrAppCount, 1);
  assert.equal(suitability.measurements.humanMessageCount, 2);
  assert.match(JSON.stringify(episode.messages[1].content), /构建 #123 已通过/);
  assert.ok(episode.ingressModes.includes("bot_or_app_message"));
});

test("only the oldest episode in a capped conversation carries boundary risk", () => {
  const conversation = {
    ...normalizeDatasetConversation({
      chat_id: "oc_capped",
      chat_mode: "p2p",
      name: "同事",
    }, [
      message("om_1", "ou_peer", "第一段需要保留足够上下文", "2026-08-27T01:00:00Z"),
      message("om_2", "ou_self", "收到第一段", "2026-08-27T01:05:00Z"),
      message("om_3", "ou_peer", "第二段需要保留足够上下文", "2026-08-28T02:00:00Z"),
      message("om_4", "ou_self", "收到第二段", "2026-08-28T02:05:00Z"),
    ], self),
    captureLikelyCapped: true,
  };
  const dataset = buildEvaluationDataset([conversation], { hardGapHours: 18 });
  assert.equal(dataset.episodes.length, 2);
  assert.equal(dataset.episodes[0].captureBoundaryRisk, true);
  assert.equal(dataset.episodes[1].captureBoundaryRisk, false);
  assert.ok(episodeSuitability(dataset.episodes[0]).issues.includes("capture_boundary_risk"));
  assert.equal(episodeSuitability(dataset.episodes[1]).issues.includes("capture_boundary_risk"), false);
});
