function identityId(value) {
  return String(value?.id ?? value?.open_id ?? value?.openId ?? value ?? "").trim();
}

function identityName(value) {
  return String(value?.name ?? value?.user_name ?? value?.userName ?? value ?? "").trim();
}

export function classifyFeishuMessageOwnership(message, self = {}) {
  const selfOpenId = identityId(self.openId ?? self.open_id ?? self.id);
  const selfName = identityName(self.name ?? self.userName ?? self.user_name);
  const senderOpenId = identityId(message?.sender ?? message?.sender_id);
  const senderName = identityName(message?.sender ?? message?.sender_name);
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  const mentionOpenIds = [...new Set(mentions.map(identityId).filter(Boolean))];
  const mentionNames = [...new Set(mentions.map(identityName).filter(Boolean))];
  const messageText = typeof message?.content === "string"
    ? message.content
    : JSON.stringify(message?.content ?? "");
  const chatType = String(message?.chat_type ?? message?.chatType ?? "unknown").toLowerCase();
  const sentBySelf = Boolean(selfOpenId && senderOpenId === selfOpenId);
  const mentionsSelf = Boolean(
    (selfOpenId && mentionOpenIds.includes(selfOpenId))
    || (selfName && mentionNames.includes(selfName))
    || (selfName && messageText.includes(selfName)),
  );
  const mentionsOthers = mentionOpenIds.some((id) => id !== selfOpenId)
    || mentionNames.some((name) => name !== selfName);

  let signal = "unassigned_group";
  let immediate = false;
  if (chatType === "p2p") {
    signal = sentBySelf ? "self_authored" : "direct_message";
    immediate = true;
  } else if (sentBySelf) {
    signal = "self_authored";
    immediate = true;
  } else if (message?.reply_to_self === true || message?.replyToSelf === true) {
    signal = "reply_to_self";
    immediate = true;
  } else if (mentionsSelf) {
    signal = "explicit_self_mention";
    immediate = true;
  } else if (mentionsOthers) {
    signal = "explicit_other_mention";
  }

  return {
    signal,
    immediate,
    chatType,
    selfOpenId: selfOpenId || null,
    selfName: selfName || null,
    senderOpenId: senderOpenId || null,
    senderName: senderName || null,
    sentBySelf,
    mentionsSelf,
    mentionOpenIds,
    mentionNames,
  };
}

export function ownershipSignalText(signal) {
  return {
    direct_message: "单聊直接发给当前用户",
    explicit_self_mention: "群聊明确提及当前用户",
    reply_to_self: "群聊回复当前用户本人消息",
    self_authored: "当前用户本人发言，需判断是否形成承诺",
    explicit_other_mention: "群聊明确提及他人，未提及当前用户",
    unassigned_group: "群聊未明确责任人",
  }[signal] ?? "任务归属未知";
}

export function permitsImmediatePersonalWake(ownership, existingBinding = null) {
  if (ownership?.immediate) return true;
  if (!existingBinding) return false;
  try {
    const metadata = JSON.parse(existingBinding.metadata_json || "{}");
    return Date.parse(metadata.ownershipActivatedUntil ?? "") > Date.now();
  } catch {
    return false;
  }
}

export function planPersonalMessageBatch(changes = [], existingBinding = null, options = {}) {
  const ttlHours = Math.max(1, Number(options.activationHours ?? 24));
  const fallbackNow = Number(options.now ?? Date.now());
  const latestEventMs = changes.reduce((latest, change) => {
    const timestamp = Date.parse(change?.occurredAt ?? "");
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, Number.NEGATIVE_INFINITY);
  const eventMs = Number.isFinite(latestEventMs) ? latestEventMs : fallbackNow;
  let existingMetadata = {};
  try { existingMetadata = JSON.parse(existingBinding?.metadata_json ?? "{}"); } catch { /* invalid legacy metadata */ }
  const existingUntilMs = Date.parse(existingMetadata.ownershipActivatedUntil ?? "");
  const immediate = changes.some((change) => change?.immediate === true);
  const continued = !immediate && Number.isFinite(existingUntilMs) && existingUntilMs > eventMs;
  const activatedUntilMs = immediate
    ? Math.max(Number.isFinite(existingUntilMs) ? existingUntilMs : 0, eventMs + ttlHours * 3_600_000)
    : Number.isFinite(existingUntilMs) ? existingUntilMs : 0;
  return {
    shouldWake: immediate || continued,
    reason: immediate ? "explicit_personal_signal" : continued ? "active_group_continuation" : "background_evidence_only",
    ownershipActivated: activatedUntilMs > eventMs,
    ownershipActivatedUntil: activatedUntilMs > 0 ? new Date(activatedUntilMs).toISOString() : null,
  };
}
