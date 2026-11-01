import { runLarkCommand } from "./collectors/feishu.mjs";
import { adapterSourceMetadata } from "./source-adapters/index.mjs";
import { nowIso, parseJsonLoose, sha256 } from "./utils.mjs";

function findValue(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findValue(child, keys);
    if (found) return found;
  }
  return null;
}

function parseOutput(result) {
  try { return parseJsonLoose(result.stdout || result.stderr || "{}"); }
  catch { return {}; }
}

function sendArguments(draft) {
  const content = String(draft.approved_content ?? "").trim();
  if (!content) throw new Error("Approved outbound content is missing.");
  const idempotencyKey = sha256(`shadow-outbound:${draft.id}:r${draft.revision}`).slice(0, 40);
  const common = [
    `--text=${content}`,
    `--idempotency-key=${idempotencyKey}`,
    "--format=json",
    `--as=${draft.sender_identity === "bot" ? "bot" : "user"}`,
  ];
  if (draft.reply_to_message_id) {
    const args = ["im", "+messages-reply", `--message-id=${draft.reply_to_message_id}`, ...common];
    if (draft.reply_in_thread) args.push("--reply-in-thread");
    return args;
  }
  if (draft.recipient_open_id) {
    return ["im", "+messages-send", `--user-id=${draft.recipient_open_id}`, ...common];
  }
  if (draft.chat_id) {
    return ["im", "+messages-send", `--chat-id=${draft.chat_id}`, ...common];
  }
  throw new Error("Approved outbound draft has no Feishu target.");
}

function recordOutboundEvidence(store, draft, receipt) {
  const source = store.upsertSource({
    sourceKey: "shadow:outbound:feishu",
    kind: "feishu_outbound",
    uri: "feishu://outbound",
    metadata: adapterSourceMetadata("feishu", { identity: draft.sender_identity, role: "outbound" }),
  });
  const messageId = receipt.messageId ?? `draft:${draft.id}:r${draft.revision}`;
  return store.addEvidence({
    sourceId: source.id,
    kind: "feishu_outbound_message",
    occurredAt: receipt.sentAt,
    title: `已向 ${draft.recipient_name} 发送飞书消息`,
    content: draft.approved_content,
    sourceLocator: receipt.messageId ? `feishu://message/${receipt.messageId}` : `feishu://outbound/${draft.id}`,
    externalId: messageId,
    fingerprint: sha256(`feishu-outbound:${draft.id}:r${draft.revision}`),
    metadata: {
      draftId: draft.id,
      revision: draft.revision,
      conversationKey: receipt.conversationKey,
      chatId: receipt.chatId,
      recipientOpenId: draft.recipient_open_id,
      recipientName: draft.recipient_name,
      senderIdentity: draft.sender_identity,
      sentBySelf: draft.sender_identity !== "bot",
      hitlApproved: draft.approval_mode !== "automatic",
      approvalMode: draft.approval_mode,
    },
  });
}

function bindTaskReplyWatch(store, draft, watch, timestamp) {
  if (!draft.task_id || !watch) return;
  store.db.prepare(`
    INSERT INTO work_task_attention(
      card_id, owner_session_key, continuation_kind, continuation_reference_id,
      continuation_summary, continuation_recorded_at, continuation_evidence_ids_json,
      next_review_at, updated_by, updated_at
    ) VALUES(?, ?, 'condition_watch', ?, ?, ?, ?, ?, 'feishu-outbound', ?)
    ON CONFLICT(card_id) DO UPDATE SET
      owner_session_key=COALESCE(work_task_attention.owner_session_key, excluded.owner_session_key),
      continuation_kind='condition_watch',
      continuation_reference_id=excluded.continuation_reference_id,
      continuation_summary=excluded.continuation_summary,
      continuation_user_action_json=NULL,
      continuation_recorded_at=excluded.continuation_recorded_at,
      continuation_evidence_ids_json=excluded.continuation_evidence_ids_json,
      next_review_at=excluded.next_review_at,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(
    draft.task_id,
    draft.session_key ?? null,
    watch.id,
    `等待${draft.recipient_name}回复已发送消息`,
    timestamp,
    watch.source_evidence_ids_json ?? "[]",
    watch.timeout_at,
    timestamp,
  );
}

export async function sendApprovedOutboundMessage(store, config, draftId, revision, options = {}) {
  const draft = store.markOutboundDraftSending(draftId, revision);
  if (draft.status === "sent") return draft;
  const send = options.send ?? runLarkCommand;
  try {
    const result = await send(config, sendArguments(draft), { timeoutMs: 60000 });
    const payload = parseOutput(result);
    const messageId = findValue(payload, ["message_id", "messageId"]);
    const chatId = findValue(payload, ["chat_id", "chatId"]) ?? draft.chat_id ?? null;
    const conversationKey = draft.conversation_key ?? (chatId ? `im:${chatId}` : null);
    const sentAt = nowIso();
    const evidence = recordOutboundEvidence(store, draft, { messageId, chatId, conversationKey, sentAt });
    if (conversationKey) {
      const binding = store.bindConversation({
        provider: "feishu",
        conversationKey,
        lastMessageId: messageId,
        eventAt: sentAt,
        metadata: {
          chatId,
          recipientOpenId: draft.recipient_open_id,
          recipientName: draft.recipient_name,
          outboundDraftId: draft.id,
        },
      });
      if (draft.track_reply) {
        const reviewMinutes = Math.max(15, Number(config.taskSupervision?.defaultReviewMinutes) || 120);
        const watch = store.createConditionWatch({
          idempotencyKey: `outbound-reply:${draft.id}:r${draft.revision}`,
          title: `等待 ${draft.recipient_name} 回复`,
          conditionText: `${draft.recipient_name} 对已发送的飞书消息作出回复`,
          selector: { kinds: ["feishu_message"], conversationKeys: [conversationKey] },
          conversationProvider: "feishu",
          conversationKey,
          sessionKey: draft.session_key ?? binding.session_key,
          taskId: draft.task_id ?? null,
          evidenceIds: [evidence.id],
          timeoutAt: new Date(Date.parse(sentAt) + reviewMinutes * 60_000).toISOString(),
          metadata: { outboundDraftId: draft.id, sentMessageId: messageId },
        });
        bindTaskReplyWatch(store, draft, watch, sentAt);
      }
    }
    return store.markOutboundDraftSent(draft.id, revision, { messageId, chatId, sentAt });
  } catch (error) {
    store.markOutboundDraftFailed(draft.id, revision, error.message);
    throw error;
  }
}

export const outboundMessageInternals = { sendArguments, findValue, bindTaskReplyWatch };
