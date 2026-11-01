import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";

const [parentSessionKey, childSessionKey, firstMarker, secondMarker, evidencePath] = process.argv.slice(2);

if (![parentSessionKey, childSessionKey, firstMarker, secondMarker, evidencePath].every(Boolean)) {
  throw new Error(
    "Usage: verify-openclaw-codex-progression.mjs <parent-session-key> <child-session-key> <first-marker> <second-marker> <evidence-path>",
  );
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));

const messageText = (message) => {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((item) => item?.text ?? "").join("\n");
};

try {
  await client.connect();
  const deadline = Date.now() + 120_000;
  let history;
  let messages = [];
  let firstResultIndex = -1;
  let continuationIndex = -1;
  let secondResultIndex = -1;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    history = await client.request("tools.invoke", {
      name: "sessions_history",
      agentId: "main",
      sessionKey: parentSessionKey,
      args: {
        sessionKey: childSessionKey,
        limit: 20,
        includeTools: false,
      },
    }, 30_000);
    messages = history?.output?.details?.messages ?? [];
    firstResultIndex = messages.findIndex((message) => (
      message?.role === "assistant"
      && Array.isArray(message?.content)
      && messageText(message).trim() === firstMarker
    ));
    continuationIndex = messages.findIndex((message) => (
      message?.provenance?.sourceTool === "sessions_send"
      && messageText(message).includes(secondMarker)
    ));
    secondResultIndex = messages.findIndex((message) => (
      message?.role === "assistant"
      && Array.isArray(message?.content)
      && messageText(message).trim() === secondMarker
    ));
    if (history?.ok
      && firstResultIndex >= 0
      && continuationIndex > firstResultIndex
      && secondResultIndex > continuationIndex) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  fs.writeFileSync(evidencePath, JSON.stringify(history, null, 2), "utf8");
  const continuation = messages[continuationIndex];
  const assistantResults = messages.filter((message) => message?.role === "assistant" && Array.isArray(message?.content));
  if (!history?.ok
    || firstResultIndex < 0
    || continuationIndex <= firstResultIndex
    || secondResultIndex <= continuationIndex
    || !continuation) {
    throw new Error("Codex child history does not prove the ordered first result, continuation, and second result");
  }

  console.log(JSON.stringify({
    status: "passed",
    parentSessionKey,
    childSessionKey,
    firstMarker,
    secondMarker,
    continuationSource: continuation.provenance.sourceTool,
    model: assistantResults.at(-1)?.model ?? null,
    messageCount: messages.length,
    verificationAttempts: attempts,
  }));
} finally {
  client.stop();
}
