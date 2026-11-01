import { privateAlias, redactEvaluationValue } from "./feishu-conversation-evaluation.mjs";
import { redactSecrets, sha256 } from "./utils.mjs";

const CREDENTIAL_TEXT = /((?:密码|口令|passwd|password|pwd|secret|token|密钥|私钥)\s*(?:是|为|[:：=])?\s*)[^\s,，;；}\]]{4,}/gi;
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;
const FEISHU_ID = /\b(?:oc|ou|om|omt)_[A-Za-z0-9_-]+\b/g;
const SENSITIVE_QUERY_PARAMETER = /([?&](?:access_token|refresh_token|token|ticket|code|signature|hash)=)[^&#\s)\]"']+/gi;

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function redactPrivateText(value) {
  return redactSecrets(String(value ?? ""))
    .replace(SENSITIVE_QUERY_PARAMETER, "$1[REDACTED]")
    .replace(CREDENTIAL_TEXT, "$1[REDACTED]")
    .replace(PHONE, "[REDACTED_PHONE]")
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(FEISHU_ID, "[REDACTED_FEISHU_ID]")
    .replace(LONG_TOKEN, "[REDACTED_TOKEN]");
}

function redactPrivateValue(value, key = "") {
  const redacted = redactEvaluationValue(value, key);
  if (typeof redacted === "string") return redactPrivateText(redacted);
  if (Array.isArray(redacted)) return redacted.map((item) => redactPrivateValue(item));
  if (!redacted || typeof redacted !== "object") return redacted;
  return Object.fromEntries(Object.entries(redacted).map(([childKey, child]) => (
    [childKey, redactPrivateValue(child, childKey)]
  )));
}

function senderId(message) {
  return message?.sender?.id?.open_id
    ?? message?.sender?.id
    ?? message?.sender_id?.open_id
    ?? message?.sender_id
    ?? "unknown";
}

function mentionId(mention) {
  return mention?.id?.open_id ?? mention?.id ?? mention?.open_id ?? "unknown";
}

function messageId(message) {
  return message?.message_id ?? message?.id
    ?? `${senderId(message)}:${message?.create_time ?? message?.timestamp ?? ""}`;
}

function normalizedTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(milliseconds).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function isSelfMention(mention, self) {
  const id = mentionId(mention);
  return Boolean((self.openId && id === self.openId)
    || (self.name && String(mention?.name ?? "").trim() === self.name));
}

function isBotMention(mention, self) {
  const id = mentionId(mention);
  return Boolean(self.botOpenId && id === self.botOpenId);
}

export function normalizeDatasetMessage(message, self = {}) {
  const rawContent = parseJson(message?.content, message?.content ?? "");
  const rawSenderId = senderId(message);
  const rawMessageId = messageId(message);
  const mentions = (message?.mentions ?? []).map((mention) => ({
    personKey: privateAlias("mention", mentionId(mention)),
    name: redactPrivateText(String(mention?.name ?? "").trim()),
    isSelf: isSelfMention(mention, self),
    isBot: isBotMention(mention, self),
  }));
  const sentBySelf = Boolean((self.openId && rawSenderId === self.openId)
    || (self.name && String(message?.sender?.name ?? "").trim() === self.name));
  return {
    messageKey: privateAlias("message", rawMessageId),
    senderKey: privateAlias("sender", rawSenderId),
    senderName: redactPrivateText(String(message?.sender?.name ?? message?.sender_name ?? "未知发送者").trim()),
    senderType: String(message?.sender?.sender_type ?? message?.sender_type ?? "unknown"),
    sentBySelf,
    mentionsSelf: mentions.some((mention) => mention.isSelf),
    mentionsBot: mentions.some((mention) => mention.isBot),
    mentions,
    occurredAt: normalizedTimestamp(message?.create_time ?? message?.timestamp),
    updatedAt: normalizedTimestamp(message?.update_time),
    messageType: String(message?.msg_type ?? "text"),
    parentMessageKey: (message?.reply_to ?? message?.parent_id)
      ? privateAlias("message", message.reply_to ?? message.parent_id)
      : null,
    rootMessageKey: message?.root_id ? privateAlias("message", message.root_id) : null,
    threadKey: message?.thread_id ? privateAlias("thread", message.thread_id) : null,
    content: redactPrivateValue(rawContent),
    deleted: Boolean(message?.deleted),
    updated: Boolean(message?.updated || message?.update_time),
  };
}

export function normalizeDatasetConversation(chat, messages, self = {}) {
  const rawChatId = chat?.chat_id ?? chat?.p2p_target_id ?? chat?.name ?? "unknown";
  const chatMode = String(chat?.chat_mode ?? "p2p");
  const normalizedMessages = messages
    .map((message) => normalizeDatasetMessage(message, self))
    .sort((left, right) => String(left.occurredAt ?? "").localeCompare(String(right.occurredAt ?? "")));
  return {
    conversationKey: `eval:${chatMode}:${privateAlias("chat", rawChatId)}`,
    chatMode,
    title: redactPrivateText(String(chat?.name ?? "未命名会话").trim()),
    external: Boolean(chat?.external),
    participantKey: chat?.p2p_target_id ? privateAlias("person", chat.p2p_target_id) : null,
    participantType: chat?.p2p_target_type ? String(chat.p2p_target_type) : null,
    ownerKey: chat?.owner_id ? privateAlias("person", chat.owner_id) : null,
    messages: normalizedMessages,
  };
}

function streamKey(conversation, message, replyTargets = new Set()) {
  if (conversation.chatMode === "p2p") return conversation.conversationKey;
  const replyRoot = message.rootMessageKey
    ?? message.parentMessageKey
    ?? (replyTargets.has(message.messageKey) ? message.messageKey : null);
  return `${conversation.conversationKey}:${message.threadKey ?? replyRoot ?? "main"}`;
}

function authoredBySelf(messageByKey, key) {
  return Boolean(key && messageByKey.get(key)?.sentBySelf);
}

export function messageIngressModes(conversation, message, context = {}) {
  const modes = ["user_snapshot_backfill", "user_incremental_poll"];
  const messageByKey = context.messageByKey ?? new Map();
  if (["bot", "app"].includes(String(message.senderType ?? "").toLowerCase())) {
    modes.push("bot_or_app_message");
  }
  if (message.senderType === "system" || message.messageType === "system") modes.push("system_message");
  if (conversation.chatMode === "p2p") {
    modes.push(message.sentBySelf ? "p2p_outbound" : "p2p_inbound");
  } else if (message.sentBySelf) {
    modes.push("group_self_authored");
  } else if (message.mentionsSelf) {
    modes.push("group_mention_self");
  } else if (authoredBySelf(messageByKey, message.parentMessageKey)
    || authoredBySelf(messageByKey, message.rootMessageKey)) {
    modes.push("group_reply_to_self");
  } else {
    modes.push("group_background");
  }
  if (message.mentionsBot) modes.push("bot_realtime_event_eligible");
  if (message.threadKey || message.rootMessageKey || message.parentMessageKey) modes.push("thread_activity");
  if (message.updated) modes.push("message_edited");
  if (message.deleted) modes.push("message_deleted");
  if (!["text", "post", "system"].includes(message.messageType)) modes.push("attachment_reference");
  return [...new Set(modes)];
}

function messageBytes(message) {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function textualChars(message) {
  if (!["text", "post", "interactive"].includes(message?.messageType)) return 0;
  return JSON.stringify(message?.content ?? "")
    .replace(/\[(?:REDACTED|REDACTED_[A-Z_]+)\]/g, "")
    .length;
}

function humanInbound(message) {
  return !message?.sentBySelf
    && message?.messageType !== "system"
    && !["bot", "app", "system"].includes(String(message?.senderType ?? "unknown"));
}

function episodeId(stream, firstMessage, lastMessage) {
  return `episode_${sha256(`${stream}:${firstMessage.messageKey}:${lastMessage.messageKey}`).slice(0, 20)}`;
}

function finalizeEpisode(conversation, stream, messages) {
  const messageByKey = new Map(conversation.messages.map((message) => [message.messageKey, message]));
  const ingressModes = [...new Set(messages.flatMap((message) => (
    messageIngressModes(conversation, message, { messageByKey })
  )))].sort();
  const firstMessage = messages[0];
  const lastMessage = messages.at(-1);
  const inbound = messages.filter((message) => !message.sentBySelf).length;
  const outbound = messages.length - inbound;
  return {
    episodeId: episodeId(stream, firstMessage, lastMessage),
    conversationKey: conversation.conversationKey,
    streamKey: stream,
    chatMode: conversation.chatMode,
    title: conversation.title,
    startedAt: firstMessage.occurredAt,
    endedAt: lastMessage.occurredAt,
    messageCount: messages.length,
    inboundCount: inbound,
    outboundCount: outbound,
    bytes: messages.reduce((sum, message) => sum + messageBytes(message), 0),
    sourceConversationCapped: Boolean(conversation.captureLikelyCapped),
    ingressModes,
    messages,
  };
}

export function episodeSuitability(episode, options = {}) {
  const messages = episode?.messages ?? [];
  const maxBytes = Number(options.maxBytes ?? 12_000);
  const chars = messages.reduce((sum, message) => sum + textualChars(message), 0);
  const humanInboundCount = messages.filter(humanInbound).length;
  const selfAuthoredCount = messages.filter((message) => message.sentBySelf).length;
  const botOrAppCount = messages.filter((message) => (
    ["bot", "app"].includes(String(message?.senderType ?? "").toLowerCase())
  )).length;
  const humanMessageCount = messages.filter((message) => (
    !["bot", "app", "system"].includes(String(message?.senderType ?? "unknown").toLowerCase())
      && message?.messageType !== "system"
  )).length;
  const mixedHumanBotContext = botOrAppCount > 0 && humanMessageCount > 0;
  const lastMessage = messages.at(-1);
  const endsWithHumanInbound = humanInbound(lastMessage);
  const bothSides = humanInboundCount > 0 && selfAuthoredCount > 0;
  const systemOnly = messages.length > 0 && messages.every((message) => (
    message.messageType === "system" || message.senderType === "system"
  ));
  const negativeControl = episode?.chatMode === "group"
    && (episode?.ingressModes ?? []).includes("group_background")
    && !(episode?.ingressModes ?? []).includes("group_mention_self")
    && !(episode?.ingressModes ?? []).includes("group_reply_to_self");
  const issues = [];
  if (!messages.length) issues.push("empty");
  if (messages.some((message) => !message.occurredAt)) issues.push("missing_timestamp");
  if (messages.some((message) => message.senderName === "未知发送者")) issues.push("unknown_sender");
  if (systemOnly) issues.push("system_only");
  if (chars < 40) issues.push("insufficient_text");
  if (messages.length === 1) issues.push("singleton");
  if (!bothSides) issues.push("one_sided");
  if (Number(episode?.bytes ?? 0) > maxBytes) issues.push("oversized_single_message");
  if (episode?.captureBoundaryRisk) issues.push("capture_boundary_risk");

  const eligibility = {
    triggerRouting: messages.length > 0,
    ownershipAndTask: humanInboundCount > 0 && chars >= 40 && !systemOnly,
    replyDrafting: endsWithHumanInbound && messages.length >= 2 && chars >= 40 && !systemOnly,
    continuity: bothSides && messages.length >= 3 && chars >= 80,
    mixedHumanBotContext,
    negativeControl,
  };
  return {
    eligibility,
    issues,
    measurements: {
      textualChars: chars,
      humanInboundCount,
      selfAuthoredCount,
      botOrAppCount,
      humanMessageCount,
      mixedHumanBotContext,
      endsWithHumanInbound,
      bothSides,
    },
  };
}

export function segmentConversationEpisodes(conversation, options = {}) {
  const configuredGapHours = options.hardGapHours ?? (
    conversation.chatMode === "group"
      ? options.groupGapHours ?? 2
      : options.p2pGapHours ?? 4
  );
  const hardGapMs = Math.max(60_000, Number(configuredGapHours) * 3_600_000);
  const maxMessages = Math.max(2, Number(options.maxMessages ?? 30));
  const maxBytes = Math.max(2_048, Number(options.maxBytes ?? 12_000));
  const grouped = new Map();
  const replyTargets = new Set(conversation.messages
    .map((message) => message.parentMessageKey)
    .filter(Boolean));
  for (const message of conversation.messages) {
    const key = streamKey(conversation, message, replyTargets);
    const list = grouped.get(key) ?? [];
    list.push(message);
    grouped.set(key, list);
  }
  const episodes = [];
  for (const [stream, messages] of grouped) {
    let current = [];
    let currentBytes = 0;
    for (const message of messages) {
      const previous = current.at(-1);
      const gap = previous && message.occurredAt && previous.occurredAt
        ? Date.parse(message.occurredAt) - Date.parse(previous.occurredAt)
        : 0;
      const bytes = messageBytes(message);
      if (current.length && (gap > hardGapMs || current.length >= maxMessages || currentBytes + bytes > maxBytes)) {
        episodes.push(finalizeEpisode(conversation, stream, current));
        current = [];
        currentBytes = 0;
      }
      current.push(message);
      currentBytes += bytes;
    }
    if (current.length) episodes.push(finalizeEpisode(conversation, stream, current));
  }
  return episodes.sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
}

function splitForEpisode(episode) {
  const bucket = Number.parseInt(sha256(episode.episodeId).slice(0, 8), 16) % 100;
  if (bucket < 60) return "development";
  if (bucket < 80) return "validation";
  return "holdout";
}

export function buildEvaluationDataset(conversations, options = {}) {
  const boundaryMarked = new Set();
  const episodes = conversations.flatMap((conversation) => segmentConversationEpisodes(conversation, options))
    .map((episode) => {
      const captureBoundaryRisk = episode.sourceConversationCapped
        && !boundaryMarked.has(episode.conversationKey);
      if (captureBoundaryRisk) boundaryMarked.add(episode.conversationKey);
      return { ...episode, captureBoundaryRisk, split: splitForEpisode(episode) };
    });
  return {
    schema: "shadow-agent/feishu-evaluation-dataset/v2",
    generatedAt: new Date().toISOString(),
    safety: {
      private: true,
      gitIgnored: true,
      resourcesDownloaded: false,
      externalIdentifiersHashed: true,
      secretsRedactedBeforePersistence: true,
      syntheticBusinessContent: false,
    },
    options: {
      p2pGapHours: Number(options.hardGapHours ?? options.p2pGapHours ?? 4),
      groupGapHours: Number(options.hardGapHours ?? options.groupGapHours ?? 2),
      maxMessages: Number(options.maxMessages ?? 30),
      maxBytes: Number(options.maxBytes ?? 12_000),
    },
    episodes,
  };
}

export function auditEvaluationDataset(dataset) {
  const episodes = dataset?.episodes ?? [];
  const modes = {};
  const splits = {};
  for (const episode of episodes) {
    splits[episode.split] = (splits[episode.split] ?? 0) + 1;
    for (const mode of episode.ingressModes ?? []) modes[mode] = (modes[mode] ?? 0) + 1;
  }
  const messages = episodes.reduce((sum, episode) => sum + episode.messageCount, 0);
  const conversations = new Set(episodes.map((episode) => episode.conversationKey)).size;
  const suitability = episodes.map((episode) => episodeSuitability(episode, dataset?.options));
  const eligibility = Object.fromEntries([
    "triggerRouting",
    "ownershipAndTask",
    "replyDrafting",
    "continuity",
    "mixedHumanBotContext",
    "negativeControl",
  ].map((name) => [name, suitability.filter((item) => item.eligibility[name]).length]));
  const issueNames = [...new Set(suitability.flatMap((item) => item.issues))].sort();
  const issues = Object.fromEntries(issueNames.map((name) => [
    name,
    suitability.filter((item) => item.issues.includes(name)).length,
  ]));
  const requiredModes = [
    "p2p_inbound",
    "p2p_outbound",
    "group_mention_self",
    "group_reply_to_self",
    "group_self_authored",
    "group_background",
    "thread_activity",
    "message_edited",
    "message_deleted",
    "bot_realtime_event_eligible",
  ];
  return {
    conversations,
    episodes: episodes.length,
    messages,
    chatModes: {
      p2p: episodes.filter((episode) => episode.chatMode === "p2p").length,
      group: episodes.filter((episode) => episode.chatMode === "group").length,
    },
    ingressModes: Object.fromEntries(Object.entries(modes).sort((left, right) => right[1] - left[1])),
    splits,
    suitability: { eligibility, issues },
    coverageGaps: requiredModes.filter((mode) => !modes[mode]),
    labelability: {
      emptyEpisodes: episodes.filter((episode) => !episode.messages.length).length,
      oneSidedEpisodes: episodes.filter((episode) => !episode.inboundCount || !episode.outboundCount).length,
      attachmentEpisodes: episodes.filter((episode) => episode.ingressModes.includes("attachment_reference")).length,
      oversizedEpisodes: episodes.filter((episode) => episode.bytes > Number(dataset?.options?.maxBytes ?? 12_000)).length,
    },
  };
}

export const datasetInternals = { redactPrivateText, redactPrivateValue, normalizedTimestamp };
