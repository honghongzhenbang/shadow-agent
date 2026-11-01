export function conversationKeyForMessage(message) {
  const chatId = message?.chatId ?? "unknown";
  return message?.chatType === "group"
    ? `im:${chatId}:thread:${message?.threadId ?? "main"}`
    : `im:${chatId}`;
}

export function groupFeishuMessages(messages = []) {
  const groups = new Map();
  for (const message of messages) {
    const key = message.conversationKey ?? conversationKeyForMessage(message);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return groups;
}
