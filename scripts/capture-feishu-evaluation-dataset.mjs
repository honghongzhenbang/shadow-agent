import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { runLarkCommand } from "../src/collectors/feishu.mjs";
import { privateAlias } from "../src/feishu-conversation-evaluation.mjs";
import {
  datasetInternals,
  normalizeDatasetConversation,
} from "../src/feishu-evaluation-dataset.mjs";
import { ensureDirectory, parseJsonLoose, redactSecrets } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const result = {
    days: 90,
    maxP2pChats: 50,
    maxGroupChats: 50,
    maxMessages: 300,
    output: path.join(projectRoot, "runtime", "evaluations", "feishu-dataset-v2", `capture-${stamp}.private.json`),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--days") result.days = Number(argv[++index]);
    else if (argument === "--max-p2p-chats") result.maxP2pChats = Number(argv[++index]);
    else if (argument === "--max-group-chats") result.maxGroupChats = Number(argv[++index]);
    else if (argument === "--max-messages") result.maxMessages = Number(argv[++index]);
    else if (argument === "--output") result.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function arraysNamed(value, key, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value[key])) output.push(...value[key]);
  for (const child of Object.values(value)) arraysNamed(child, key, output);
  return output;
}

function uniqueMessages(messages) {
  const result = new Map();
  for (const message of messages) {
    const key = message?.message_id ?? message?.id ?? JSON.stringify(message);
    result.set(key, message);
  }
  return [...result.values()];
}

function isEligibleChat(chat, self) {
  if (!chat?.chat_id || String(chat.chat_status ?? "normal") !== "normal") return false;
  if (chat.chat_mode === "group") return true;
  if (chat.chat_mode !== "p2p" || chat.p2p_target_type !== "user") return false;
  return !self.openId || chat.p2p_target_id !== self.openId;
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

const args = argumentsFrom(process.argv.slice(2));
const config = loadConfig();
const captureStartedAt = performance.now();
const healthResult = await runLarkCommand(config, ["auth", "status", "--json", "--verify"], { timeoutMs: 30_000 });
const health = parseJsonLoose(healthResult.stdout || healthResult.stderr);
const user = health?.identities?.user ?? {};
if (user.status !== "ready" || user.verified === false) throw new Error("Feishu user identity is not ready.");
const self = {
  openId: user.openId,
  name: user.userName,
  botOpenId: health?.identities?.bot?.openId ?? null,
};

const listStartedAt = performance.now();
const listResult = await runLarkCommand(config, [
  "im", "+chat-list",
  "--types", "p2p,group",
  "--sort", "active_time",
  "--page-size", "100",
  "--page-limit", "10",
  "--page-all",
  "--format", "json",
  "--as", "user",
], { timeoutMs: 180_000 });
const listed = parseJsonLoose(listResult.stdout || listResult.stderr);
const allChats = arraysNamed(listed, "chats").filter((chat) => isEligibleChat(chat, self));
const p2pChats = allChats.filter((chat) => chat.chat_mode === "p2p").slice(0, Math.max(0, args.maxP2pChats));
const groupChats = allChats.filter((chat) => chat.chat_mode === "group").slice(0, Math.max(0, args.maxGroupChats));
const chats = [...p2pChats, ...groupChats];
const listMs = elapsed(listStartedAt);

const start = new Date(Date.now() - Math.max(1, args.days) * 86_400_000).toISOString();
const end = new Date().toISOString();
const pageLimit = Math.max(1, Math.ceil(Math.max(1, args.maxMessages) / 50));
const conversations = [];
const chatTimings = [];
const failures = [];
for (const chat of chats) {
  const startedAt = performance.now();
  try {
    const result = await runLarkCommand(config, [
      "im", "+chat-messages-list",
      "--chat-id", chat.chat_id,
      "--start", start,
      "--end", end,
      "--order", "desc",
      "--page-size", "50",
      "--page-limit", String(pageLimit),
      "--page-all",
      "--no-reactions",
      "--format", "json",
      "--as", "user",
    ], { timeoutMs: 240_000 });
    const payload = parseJsonLoose(result.stdout || result.stderr);
    const messages = uniqueMessages(arraysNamed(payload, "messages")).slice(-Math.max(1, args.maxMessages));
    conversations.push(normalizeDatasetConversation(chat, messages, self));
    chatTimings.push({
      conversationKey: conversations.at(-1).conversationKey,
      chatMode: chat.chat_mode,
      fetchMs: elapsed(startedAt),
      messageCount: messages.length,
      responseBytes: Buffer.byteLength(result.stdout || "", "utf8"),
    });
  } catch (error) {
    failures.push({
      chatMode: String(chat.chat_mode ?? "unknown"),
      chatKey: `failed_${privateAlias("chat", chat.chat_id ?? "unknown")}`,
      error: datasetInternals.redactPrivateText(redactSecrets(error.message)),
    });
  }
}

const capture = {
  schema: "shadow-agent/feishu-evaluation-capture/v2",
  capturedAt: new Date().toISOString(),
  window: { start, end, days: args.days },
  identity: { name: user.userName ?? "当前用户" },
  safety: {
    private: true,
    gitIgnored: true,
    resourcesDownloaded: false,
    externalIdentifiersHashed: true,
    secretsRedactedBeforePersistence: true,
  },
  limits: {
    maxP2pChats: args.maxP2pChats,
    maxGroupChats: args.maxGroupChats,
    maxMessagesPerChat: args.maxMessages,
  },
  timings: {
    authMs: Math.round(listStartedAt - captureStartedAt),
    listMs,
    chats: chatTimings,
    totalMs: elapsed(captureStartedAt),
  },
  failures,
  conversations,
};
ensureDirectory(path.dirname(args.output));
fs.writeFileSync(args.output, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: args.output,
  conversations: conversations.length,
  p2p: conversations.filter((item) => item.chatMode === "p2p").length,
  groups: conversations.filter((item) => item.chatMode === "group").length,
  messages: conversations.reduce((sum, item) => sum + item.messages.length, 0),
  failures: failures.length,
  totalMs: capture.timings.totalMs,
}, null, 2)}\n`);
