import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));
await client.connect();

const created = await client.invokeTool("workboard_create", {
  title: "Manual confirmation bridge smoke",
  notes: "Verify a human-confirmed review card can receive proof and move to done.",
  status: "review",
  priority: "low",
  labels: ["test", "manual-confirmation"],
  agentId: "main",
  boardId: "shadow-migration",
  idempotencyKey: "manual-confirmation-bridge-smoke-v1",
});
const cardId = created?.output?.details?.card?.id;
if (!created?.ok || !cardId) throw new Error("Could not create the manual confirmation test card.");

let status = created.output.details.card.status;
if (status !== "done") {
  const proof = await client.invokeTool("workboard_proof", {
    id: cardId,
    status: "passed",
    label: "Human confirmation smoke",
    note: "Synthetic local validation; no real user task was changed.",
  });
  if (!proof?.ok) throw new Error("Could not add proof to the manual confirmation test card.");
  const moved = await client.request("workboard.cards.move", { id: cardId, status: "done" });
  status = moved?.card?.status;
}

const summary = {
  passed: status === "done",
  cardId,
  status,
  testedAt: new Date().toISOString(),
};
const evidencePath = path.join(
  projectRoot,
  "runtime",
  "openclaw-poc",
  "evidence",
  `manual-bridge-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`,
);
summary.evidencePath = evidencePath;
fs.writeFileSync(evidencePath, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
client.stop();
if (!summary.passed) process.exitCode = 1;

