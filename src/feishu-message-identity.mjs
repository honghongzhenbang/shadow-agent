import { sha256 } from "./utils.mjs";

export function feishuMessageIdentity(message) {
  const messageId = String(message?.message_id ?? message?.id ?? "").trim();
  if (!messageId) throw new Error("A Feishu message identity requires message_id or id.");
  const revision = message?.update_time ?? message?.create_time ?? "";
  return {
    messageId,
    fingerprint: sha256(`feishu-message:${messageId}:${revision}`),
  };
}
