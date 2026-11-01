import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
  workboardCardsFromToolResult,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidenceDirectory = path.join(
  projectRoot,
  "runtime",
  "openclaw-poc",
  "evidence",
  `v2-workboard-archive-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
);
fs.mkdirSync(evidenceDirectory, { recursive: true });

const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));
await client.connect();
try {
  const listed = workboardCardsFromToolResult(await client.invokeTool("workboard_list", {
    limit: 200,
    includeArchived: false,
  }));
  const candidates = [];
  for (const card of listed) {
    const response = await client.invokeTool("workboard_read", { id: card.id });
    const detail = response?.output?.details?.card ?? card;
    const migratedBacklog = detail.status === "backlog"
      && detail.labels?.includes("shadow-task")
      && String(detail.notes ?? "").includes("## Migration source");
    const smokeTest = detail.labels?.includes("test") && /smoke/i.test(detail.title ?? "");
    if (migratedBacklog || smokeTest) {
      candidates.push(detail);
    }
  }

  fs.writeFileSync(path.join(evidenceDirectory, "before.json"), JSON.stringify(candidates, null, 2), "utf8");
  const archived = [];
  for (const card of candidates) {
    const result = await client.request("workboard.cards.archive", { id: card.id, archived: true });
    archived.push({ id: card.id, title: card.title, archivedAt: result?.card?.metadata?.archivedAt ?? null });
  }

  const remaining = workboardCardsFromToolResult(await client.invokeTool("workboard_list", {
    limit: 200,
    includeArchived: false,
  }));
  const archivedIds = new Set(archived.map((item) => item.id));
  const stillVisible = remaining.filter((card) => archivedIds.has(card.id));
  const summary = {
    passed: stillVisible.length === 0,
    archivedCount: archived.length,
    remainingVisibleCount: remaining.length,
    stillVisible,
    evidenceDirectory,
  };
  fs.writeFileSync(path.join(evidenceDirectory, "archived.json"), JSON.stringify(archived, null, 2), "utf8");
  fs.writeFileSync(path.join(evidenceDirectory, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
} finally {
  client.stop();
}
