import assert from "node:assert/strict";
import test from "node:test";

import {
  isHumanP2pChat,
  normalizeEvaluationConversation,
  redactEvaluationValue,
  selectEvaluationConversations,
  splitConversationBatches,
} from "../src/feishu-conversation-evaluation.mjs";

test("private Feishu evaluation redacts secrets and resource locators before persistence", () => {
  const value = redactEvaluationValue({
    url: "https://example.test/doc?token=secret-value&signature=signed-value",
    access_token: "plain-secret",
    file_key: "downloadable-resource",
  });
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /secret-value|signed-value|plain-secret|downloadable-resource/);
});

test("human P2P filter excludes apps and the current user", () => {
  const self = { openId: "self" };
  assert.equal(isHumanP2pChat({ chat_id: "c1", chat_status: "normal", chat_mode: "p2p", p2p_target_type: "user", p2p_target_id: "other", name: "同事" }, self), true);
  assert.equal(isHumanP2pChat({ chat_id: "c2", chat_status: "normal", chat_mode: "p2p", p2p_target_type: "app", p2p_target_id: "bot", name: "机器人" }, self), false);
  assert.equal(isHumanP2pChat({ chat_id: "c3", chat_status: "normal", chat_mode: "p2p", p2p_target_type: "user", p2p_target_id: "self", name: "自己" }, self), false);
});

test("conversation normalization hashes identifiers and keeps chronological bounded batches", () => {
  const conversation = normalizeEvaluationConversation(
    { chat_id: "raw-chat", name: "同事", p2p_target_id: "raw-person", p2p_target_type: "user" },
    [
      { message_id: "m2", create_time: "2026-08-02T00:00:00Z", sender: { id: "other", name: "同事" }, content: "{\"text\":\"二\"}" },
      { message_id: "m1", create_time: "2026-08-01T00:00:00Z", sender: { id: "self", name: "我" }, content: "{\"text\":\"一\"}" },
      { message_id: "m3", create_time: "2026-08-03T00:00:00Z", sender: { id: "other", name: "同事" }, content: "{\"text\":\"三\"}" },
    ],
    { openId: "self", name: "我" },
  );
  assert.doesNotMatch(JSON.stringify(conversation), /raw-chat|raw-person|\"m1\"/);
  assert.equal(conversation.messages[0].sentBySelf, true);
  assert.deepEqual(splitConversationBatches(conversation.messages, { batchSize: 2, maxBatches: 1 })
    .flat().map((item) => item.content.text), ["二", "三"]);
});

test("selection favors known people and two-sided rich conversations", () => {
  const selected = selectEvaluationConversations([
    { title: "已知同事", messages: [{ sentBySelf: true, content: "a" }, { sentBySelf: false, content: "b" }] },
    { title: "未知同事", messages: Array.from({ length: 5 }, () => ({ sentBySelf: false, content: "x" })) },
  ], { knownPeople: ["已知同事"], limit: 1 });
  assert.equal(selected[0].conversation.title, "已知同事");
});
