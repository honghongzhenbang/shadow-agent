import { defineSourceAdapter } from "../contracts.mjs";

export const feishuSourceAdapter = defineSourceAdapter({
  provider: "feishu",
  family: "collaboration",
  displayName: "飞书",
  accountScope: "current-user-tenant",
  capabilities: {
    subscribeEvents: true,
    readDelta: true,
    historyBackfill: true,
    readWindow: true,
    resolveArtifact: true,
    resumeSession: false,
    observeTools: false,
    sendMessage: true,
    sendAsUser: true,
  },
  sourceKinds: ["feishu", "feishu_event", "feishu_outbound"],
  evidenceKinds: [
    "feishu_message",
    "feishu_task",
    "feishu_approval_task",
    "feishu_document_index",
    "feishu_document_content",
    "feishu_outbound_message",
  ],
});

const FEISHU_EVENT_KINDS = Object.freeze({
  feishu_message: "message",
  feishu_outbound_message: "message",
  feishu_task: "task",
  feishu_approval_task: "approval",
  feishu_document_index: "document_index",
  feishu_document_content: "document_content",
});

function parseMetadata(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

export function feishuCanonicalSourceRecord({ source, evidence }) {
  if (!FEISHU_EVENT_KINDS[evidence.kind]) return null;
  const metadata = parseMetadata(evidence.metadata_json ?? evidence.metadata);
  const conversationId = metadata.conversationKey ?? evidence.thread_id ?? metadata.taskId ?? metadata.token ?? null;
  const outgoing = evidence.kind === "feishu_outbound_message" || metadata.sentBySelf === true;
  return {
    observation: {
      schemaVersion: 2,
      provider: feishuSourceAdapter.provider,
      sourceFamily: feishuSourceAdapter.family,
      accountScope: parseMetadata(source.metadata_json)?.sourceAdapter?.accountScope ?? feishuSourceAdapter.accountScope,
      sourceObjectId: evidence.external_id ?? evidence.id,
      eventId: metadata.eventId ?? evidence.external_id ?? null,
      streamId: conversationId,
      parentId: metadata.replyToMessageId ?? null,
      causationId: metadata.causationId ?? null,
      cursor: source.cursor_bytes ?? null,
      visibility: metadata.visibility ?? "user",
      eventKind: FEISHU_EVENT_KINDS[evidence.kind],
      providerPayloadRef: evidence.source_locator,
    },
    collaboration: {
      actorId: metadata.senderOpenId ?? metadata.senderId ?? null,
      actorKind: metadata.senderType ?? "unknown",
      spaceId: metadata.chatId ?? null,
      conversationId,
      threadId: metadata.threadId ?? metadata.rootId ?? null,
      messageId: FEISHU_EVENT_KINDS[evidence.kind] === "message" ? evidence.external_id ?? evidence.id : null,
      replyTo: metadata.replyToMessageId ?? null,
      direction: outgoing ? "outgoing" : "incoming",
      mentions: metadata.mentionOpenIds ?? [],
      attachments: metadata.attachments ?? [],
      status: metadata.status ?? null,
      dueAt: metadata.due ?? null,
      deleted: metadata.deleted === true,
      updated: metadata.updated === true,
    },
  };
}

function mentionId(mention) {
  return mention?.id?.open_id ?? mention?.open_id ?? mention?.id ?? null;
}

function mentionName(mention) {
  return mention?.name ?? mention?.id?.name ?? null;
}

export function feishuConversationKey(message) {
  const chatId = String(message?.chat_id ?? "unknown");
  if (message?.chat_type === "p2p") return `im:${chatId}`;
  return `im:${chatId}:thread:${message?.thread_id ?? message?.root_id ?? "main"}`;
}

export function feishuMessageProjectionMetadata(message, overrides = {}) {
  const sender = message?.sender ?? {};
  const senderId = message?.sender_id?.open_id ?? message?.sender_id
    ?? sender?.sender_id?.open_id ?? sender?.sender_id ?? sender?.id?.open_id ?? sender?.id;
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  return {
    chatId: message?.chat_id ?? null,
    chatType: message?.chat_type ?? null,
    threadId: message?.thread_id ?? message?.root_id ?? null,
    rootId: message?.root_id ?? null,
    conversationKey: overrides.conversationKey ?? feishuConversationKey(message),
    senderId: overrides.senderId ?? senderId ?? null,
    senderOpenId: overrides.senderOpenId ?? senderId ?? null,
    senderName: overrides.senderName ?? message?.sender_name ?? sender?.name ?? null,
    senderType: overrides.senderType ?? message?.sender_type ?? sender?.sender_type ?? sender?.type ?? "unknown",
    replyToMessageId: overrides.replyToMessageId ?? message?.reply_to ?? message?.parent_id ?? message?.reply_to_message_id ?? null,
    mentionOpenIds: overrides.mentionOpenIds ?? mentions.map(mentionId).filter(Boolean),
    mentionNames: overrides.mentionNames ?? mentions.map(mentionName).filter(Boolean),
    attachments: overrides.attachments ?? message?.attachments ?? [],
    deleted: overrides.deleted ?? message?.deleted ?? false,
    updated: overrides.updated ?? message?.updated ?? false,
    ...overrides,
  };
}
