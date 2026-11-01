import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
  workboardCardsFromToolResult,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apply = process.argv.includes("--apply");
const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));
await client.connect();

try {
  const list = await client.invokeTool("workboard_list", { limit: 100, includeArchived: false });
  const active = workboardCardsFromToolResult(list).filter((card) =>
    card.boardId === "shadow-work" && ["ready", "todo", "review", "blocked"].includes(card.status));
  const legacy = [];
  for (const compact of active) {
    const detail = await client.invokeTool("workboard_read", { id: compact.id });
    const card = detail?.output?.details?.card;
    if (!card) continue;
    const isLegacy = String(card.notes ?? "").includes("## Migration source")
      || (card.labels ?? []).includes("shadow-task");
    if (isLegacy) legacy.push(card);
  }

  const evidenceDirectory = path.join(
    projectRoot,
    "runtime",
    "openclaw-poc",
    "evidence",
    `v2-cutover-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
  );
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(evidenceDirectory, "legacy-active-cards.json"), JSON.stringify(legacy, null, 2), "utf8");

  const moved = [];
  if (apply) {
    for (const card of legacy) {
      await client.invokeTool("workboard_comment", {
        id: card.id,
        body: "V2 底层切换：该卡来自旧本地规划器，已保留全部证据和处理记录并转入 backlog。后续只有新的 context_changes 才能重新激活或创建工作。",
      });
      const result = await client.request("workboard.cards.move", { id: card.id, status: "backlog" });
      if (result?.card?.status !== "backlog") throw new Error(`Card did not reach backlog: ${card.id}`);
      moved.push({ id: card.id, title: card.title, previousStatus: card.status });
    }
  }
  const summary = { apply, candidates: legacy.length, moved: moved.length, cards: moved, evidenceDirectory };
  fs.writeFileSync(path.join(evidenceDirectory, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  client.stop();
}
