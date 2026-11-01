import { sha256, redactSecrets } from "./utils.mjs";

const SECRET_FIELD = /(?:password|passwd|secret|access.?token|refresh.?token|api.?key|private.?key|authorization|cookie|signature)/i;
const RESOURCE_FIELD = /^(?:file|image|audio|video|media|resource)_(?:key|token)$/i;

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

export function privateAlias(kind, value) {
  return `${kind}_${sha256(`${kind}:${String(value ?? "")}`).slice(0, 16)}`;
}

export function redactEvaluationValue(value, key = "") {
  if (SECRET_FIELD.test(key)) return "[REDACTED]";
  if (RESOURCE_FIELD.test(key)) return "[RESOURCE_REFERENCE]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactEvaluationValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => (
    [childKey, redactEvaluationValue(child, childKey)]
  )));
}

export function normalizeEvaluationMessage(message, self = {}) {
  const rawContent = parseJson(message?.content, message?.content ?? "");
  const senderId = message?.sender?.id ?? "unknown";
  const messageId = message?.message_id ?? message?.id ?? `${senderId}:${message?.create_time ?? ""}`;
  const sentBySelf = Boolean(self.openId && senderId === self.openId)
    || (self.name && message?.sender?.name === self.name);
  return {
    messageKey: privateAlias("message", messageId),
    senderKey: privateAlias("sender", senderId),
    senderName: String(message?.sender?.name ?? "未知发送者").trim(),
    senderType: String(message?.sender?.sender_type ?? "unknown"),
    sentBySelf,
    occurredAt: message?.create_time ?? null,
    updatedAt: message?.update_time ?? null,
    messageType: String(message?.msg_type ?? "text"),
    content: redactEvaluationValue(rawContent),
    deleted: Boolean(message?.deleted),
    updated: Boolean(message?.updated),
  };
}

export function normalizeEvaluationConversation(chat, messages, self = {}) {
  const chatId = chat?.chat_id ?? chat?.p2p_target_id ?? chat?.name ?? "unknown";
  const normalizedMessages = messages
    .map((message) => normalizeEvaluationMessage(message, self))
    .sort((left, right) => String(left.occurredAt ?? "").localeCompare(String(right.occurredAt ?? "")));
  return {
    conversationKey: `eval:p2p:${privateAlias("chat", chatId)}`,
    title: redactSecrets(String(chat?.name ?? "未命名会话").trim()),
    participantKey: privateAlias("person", chat?.p2p_target_id ?? chatId),
    participantType: String(chat?.p2p_target_type ?? "unknown"),
    messages: normalizedMessages,
  };
}

export function isHumanP2pChat(chat, self = {}) {
  if (!chat?.chat_id || String(chat.chat_status ?? "normal") !== "normal") return false;
  if (String(chat.chat_mode ?? "p2p") !== "p2p") return false;
  if (String(chat.p2p_target_type ?? "user") !== "user") return false;
  if (self.openId && chat.p2p_target_id === self.openId) return false;
  return Boolean(String(chat.name ?? "").trim());
}

export function splitConversationBatches(messages, options = {}) {
  const batchSize = Math.max(2, Number(options.batchSize ?? 12));
  const maxBatches = Math.max(1, Number(options.maxBatches ?? 2));
  const selected = messages.slice(-(batchSize * maxBatches));
  const batches = [];
  for (let index = 0; index < selected.length; index += batchSize) {
    batches.push(selected.slice(index, index + batchSize));
  }
  return batches;
}

export function selectEvaluationConversations(conversations, options = {}) {
  const knownPeople = new Set(options.knownPeople ?? []);
  const limit = Math.max(1, Number(options.limit ?? 6));
  return conversations.map((conversation) => {
    const selfCount = conversation.messages.filter((message) => message.sentBySelf).length;
    const otherCount = conversation.messages.length - selfCount;
    const contentChars = conversation.messages.reduce((sum, message) => (
      sum + JSON.stringify(message.content ?? "").length
    ), 0);
    const score = Math.min(40, conversation.messages.length)
      + (selfCount && otherCount ? 25 : 0)
      + (knownPeople.has(conversation.title) ? 25 : 0)
      + Math.min(20, Math.floor(contentChars / 800));
    return { conversation, score, selfCount, otherCount, contentChars };
  }).filter((item) => item.conversation.messages.length >= 2)
    .sort((left, right) => right.score - left.score
      || right.conversation.messages.length - left.conversation.messages.length)
    .slice(0, limit);
}
