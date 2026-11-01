import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { captureKnowledgeEpisode } from "../openclaw/shadow-work/src/epistemic.js";
import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import {
  DIRECT_INPUT_SESSION_KEY,
  enqueueDirectInputRequest,
} from "../src/direct-input.mjs";
import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")));
const marker = `v4.14-unified-input-smoke-${randomUUID()}`;
const title = `[V4.14 smoke] 统一输入任务建卡 ${marker.slice(-8)}`;
const config = loadConfig(projectRoot);
const store = openDatabase(config.paths.database);
let evidenceId;
let receiptId;
let actionId;
let cleanupCompleted = false;
function cleanupSmokeEvidence() {
  if (cleanupCompleted || !evidenceId) return false;
  const cleanupStore = openDatabase(config.paths.database);
  try {
    const row = cleanupStore.db.prepare(`
      SELECT e.id FROM evidence e
      JOIN graph_episode_annotations a ON a.evidence_id=e.id
      WHERE e.id=? AND e.kind='manual_knowledge'
        AND a.generated_by='unified-direct-input-smoke'
        AND e.title='V4.14 统一输入任务建卡冒烟测试'
        AND e.source_locator LIKE 'shadow-agent://smoke/%'
    `).get(evidenceId);
    if (!row) return false;
    if (actionId) cleanupStore.db.prepare("DELETE FROM controller_outbox WHERE id=?").run(actionId);
    if (receiptId) cleanupStore.db.prepare("DELETE FROM direct_input_receipts WHERE id=?").run(receiptId);
    cleanupStore.db.prepare("DELETE FROM context_changes WHERE evidence_id=?").run(evidenceId);
    cleanupStore.db.prepare("DELETE FROM evidence WHERE id=?").run(evidenceId);
    cleanupCompleted = true;
    return true;
  } finally {
    cleanupStore.close();
  }
}
process.once("exit", () => {
  try { cleanupSmokeEvidence(); } catch {}
});
try {
  store.transaction(() => {
    evidenceId = captureKnowledgeEpisode(store.db, {
      sourceType: "dialogue",
      title: "V4.14 统一输入任务建卡冒烟测试",
      content: `请完成一次无外部副作用的系统自检：创建一张标题为“${title}”的 Workboard 卡，卡片必须引用本条 Evidence。不要修改代码、发送消息或创建子任务。创建后把卡片 ID 告诉我。测试标识：${marker}`,
      sourceLocator: `shadow-agent://smoke/${marker}`,
      externalId: marker,
      threadId: DIRECT_INPUT_SESSION_KEY,
      scope: { sessionKey: DIRECT_INPUT_SESSION_KEY },
      keywords: ["统一输入", "任务建卡", "冒烟测试"],
      retrievalCues: ["统一输入是否能创建 Workboard 卡？"],
      generatedBy: "unified-direct-input-smoke",
    }, { transaction: false }).evidenceId;
    const queued = enqueueDirectInputRequest(store, {
      evidenceId,
      sessionKey: DIRECT_INPUT_SESSION_KEY,
      source: "integration-smoke",
    });
    receiptId = queued.receipt.id;
    actionId = queued.action.id;
  });
} finally {
  store.close();
}

const deadline = Date.now() + 240_000;
let receipt = null;
while (Date.now() < deadline) {
  const pollStore = openDatabase(config.paths.database);
  try { receipt = pollStore.directInputReceipt(receiptId); } finally { pollStore.close(); }
  if (receipt?.status === "completed") break;
  if (receipt?.status === "failed") throw new Error(`Durable direct input failed: ${receipt.last_error || "unknown error"}`);
  await delay(500);
}
if (receipt?.status !== "completed") {
  throw new Error(`Durable direct input did not complete before timeout; last status: ${receipt?.status || "missing"}.`);
}

const client = new OpenClawGatewayClient({
  ...loadOpenClawGatewaySettings(projectRoot),
  autoReconnect: false,
});
let card;
let archived;
try {
  await client.connect();
  const result = await client.request("workboard.cards.list", {});
  card = (result?.cards ?? []).find((item) => JSON.stringify(item).includes(evidenceId));
  if (!card) throw new Error(`Unified direct input did not create a card for Evidence ${evidenceId}.`);
  const bindingStore = openDatabase(config.paths.database);
  try {
    const owner = bindingStore.db.prepare("SELECT * FROM work_task_attention WHERE card_id=?").get(card.id);
    if (owner?.owner_session_key !== DIRECT_INPUT_SESSION_KEY || owner?.binding_reason !== "direct_user_input") {
      throw new Error(`Smoke card ${card.id} was not bound to the direct user session.`);
    }
  } finally {
    bindingStore.close();
  }
  archived = await client.request("workboard.cards.archive", { id: card.id, archived: true });
  if (!archived?.card?.archived && !archived?.card?.archivedAt && !archived?.card?.metadata?.archivedAt) {
    throw new Error(`Smoke card ${card.id} was not archived.`);
  }
} finally {
  client.stop();
}

const evidenceRoot = path.join(projectRoot, "runtime", "openclaw-poc", "evidence", `unified-input-${Date.now()}`);
fs.mkdirSync(evidenceRoot, { recursive: true });
const smokeEvidenceRemoved = cleanupSmokeEvidence();
const report = {
  ok: true,
  marker,
  evidenceId,
  receiptId,
  runId: receipt.run_id,
  sessionKey: DIRECT_INPUT_SESSION_KEY,
  card: { id: card.id, title: card.title, status: card.status },
  archived: true,
  smokeEvidenceRemoved,
  response: receipt.response_text,
};
fs.writeFileSync(path.join(evidenceRoot, "result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, evidenceRoot }, null, 2)}\n`);
