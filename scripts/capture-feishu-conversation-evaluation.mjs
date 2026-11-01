import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { runLarkCommand } from "../src/collectors/feishu.mjs";
import {
  isHumanP2pChat,
  normalizeEvaluationConversation,
  privateAlias,
} from "../src/feishu-conversation-evaluation.mjs";
import { ensureDirectory, parseJsonLoose } from "../src/utils.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const result = {
    days: 45,
    maxChats: 60,
    maxMessages: 150,
    output: path.join(projectRoot, "runtime", "evaluations", "feishu-conversations", "capture.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--days") result.days = Number(argv[++index]);
    else if (argument === "--max-chats") result.maxChats = Number(argv[++index]);
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
const self = { openId: user.openId, name: user.userName };

const listStartedAt = performance.now();
const listResult = await runLarkCommand(config, [
  "im", "+chat-list",
  "--types", "p2p",
  "--sort", "active_time",
  "--page-size", "100",
  "--page-limit", "3",
  "--page-all",
  "--format", "json",
  "--as", "user",
]);
const listed = parseJsonLoose(listResult.stdout || listResult.stderr);
const chats = arraysNamed(listed, "chats")
  .filter((chat) => isHumanP2pChat(chat, self))
  .slice(0, Math.max(1, args.maxChats));
const listMs = elapsed(listStartedAt);

const start = new Date(Date.now() - Math.max(1, args.days) * 86_400_000).toISOString();
const pageLimit = Math.max(1, Math.ceil(Math.max(1, args.maxMessages) / 50));
const conversations = [];
const chatTimings = [];
for (const chat of chats) {
  const startedAt = performance.now();
  const result = await runLarkCommand(config, [
    "im", "+chat-messages-list",
    "--chat-id", chat.chat_id,
    "--start", start,
    "--order", "asc",
    "--page-size", "50",
    "--page-limit", String(pageLimit),
    "--page-all",
    "--no-reactions",
    "--format", "json",
    "--as", "user",
  ], { timeoutMs: 180_000 });
  const payload = parseJsonLoose(result.stdout || result.stderr);
  const messages = arraysNamed(payload, "messages").slice(-Math.max(1, args.maxMessages));
  conversations.push(normalizeEvaluationConversation(chat, messages, self));
  chatTimings.push({
    conversationKey: `eval:p2p:${privateAlias("chat", chat.chat_id)}`,
    fetchMs: elapsed(startedAt),
    messageCount: messages.length,
    responseBytes: Buffer.byteLength(result.stdout || "", "utf8"),
  });
}

const capture = {
  schema: "shadow-agent/feishu-p2p-evaluation-capture/v1",
  capturedAt: new Date().toISOString(),
  window: { start, end: new Date().toISOString(), days: args.days },
  identity: { name: user.userName ?? "当前用户" },
  safety: {
    private: true,
    gitIgnored: true,
    resourcesDownloaded: false,
    externalIdentifiersHashed: true,
    secretsRedactedBeforePersistence: true,
  },
  timings: {
    authMs: Math.round(listStartedAt - captureStartedAt),
    listMs,
    chats: chatTimings,
    totalMs: elapsed(captureStartedAt),
  },
  conversations,
};
ensureDirectory(path.dirname(args.output));
fs.writeFileSync(args.output, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: args.output,
  conversations: conversations.length,
  messages: conversations.reduce((sum, item) => sum + item.messages.length, 0),
  totalMs: capture.timings.totalMs,
  resourcesDownloaded: false,
  externalIdentifiersHashed: true,
}, null, 2)}\n`);
