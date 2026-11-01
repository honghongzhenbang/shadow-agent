import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apply = process.argv.includes("--apply");
const databasePath = path.join(projectRoot, "runtime", "shadow-agent.sqlite");
const outputDirectory = path.join(projectRoot, "runtime", "openclaw-poc", "evidence");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const outputPath = path.join(outputDirectory, `task-sync-${timestamp}.json`);
const mapPath = path.join(projectRoot, "runtime", "openclaw-poc", "task-map.json");

const statusMap = {
  new: "ready",
  planned: "ready",
  running: "ready",
  waiting_user: "review",
  blocked: "blocked",
  failed: "blocked",
};
const priorityMap = {
  critical: "urgent",
  high: "high",
  normal: "normal",
  low: "low",
};

const database = new DatabaseSync(databasePath, { readOnly: true });
database.exec("PRAGMA query_only=ON");
const rows = database.prepare(`
  SELECT tasks.id, tasks.title, tasks.description, tasks.status, tasks.priority,
    tasks.risk_level, tasks.action_type, tasks.domain, tasks.project_key,
    tasks.source_evidence_ids_json, tasks.created_at, tasks.updated_at,
    tasks.next_review_at, tasks.attempts, tasks.last_error, tasks.result,
    projects.name AS project_name
  FROM tasks
  LEFT JOIN projects ON projects.project_key=tasks.project_key
  WHERE tasks.domain='user_work'
    AND tasks.status NOT IN ('done', 'cancelled')
  ORDER BY
    CASE tasks.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
    tasks.updated_at DESC
`).all();
database.close();

const plannedCards = rows.map((task) => {
  const evidenceIds = JSON.parse(task.source_evidence_ids_json || "[]");
  const status = statusMap[task.status] ?? "backlog";
  const notes = [
    task.description,
    "",
    "## Migration source",
    `- Shadow task: ${task.id}`,
    `- Original status: ${task.status}`,
    `- Project: ${task.project_name || task.project_key || "Unassigned"}`,
    `- Risk: ${task.risk_level}`,
    `- Action: ${task.action_type}`,
    `- Evidence ids: ${evidenceIds.join(", ") || "none"}`,
    task.last_error ? `- Last error: ${task.last_error}` : null,
  ].filter((value) => value !== null).join("\n").slice(0, 12_000);

  return {
    shadowTaskId: task.id,
    originalStatus: task.status,
    projectName: task.project_name ?? null,
    args: {
      title: task.title,
      notes,
      status,
      priority: priorityMap[task.priority] ?? "normal",
      labels: ["shadow-task", `risk:${task.risk_level}`, `action:${task.action_type}`]
        .map((label) => label.slice(0, 40)),
      agentId: "main",
      boardId: "shadow-work",
      idempotencyKey: `shadow-task:${task.id}`,
    },
  };
});

const summary = {
  mode: apply ? "apply" : "dry-run",
  generatedAt: new Date().toISOString(),
  sourceDatabase: databasePath,
  count: plannedCards.length,
  statusCounts: plannedCards.reduce((counts, item) => {
    counts[item.args.status] = (counts[item.args.status] ?? 0) + 1;
    return counts;
  }, {}),
  cards: plannedCards,
  results: [],
};

let client = null;
if (apply) {
  client = new OpenClawGatewayClient(loadOpenClawGatewaySettings(projectRoot));
  await client.connect();
  for (const planned of plannedCards) {
    const result = await client.invokeTool("workboard_create", planned.args);
    if (!result?.ok || !result?.output?.details?.card?.id) {
      throw new Error(`Failed to sync Shadow task ${planned.shadowTaskId}: ${JSON.stringify(result)}`);
    }
    summary.results.push({
      shadowTaskId: planned.shadowTaskId,
      workboardCardId: result.output.details.card.id,
      status: result.output.details.card.status,
    });
  }
  client.stop();
  const existingMap = fs.existsSync(mapPath)
    ? JSON.parse(fs.readFileSync(mapPath, "utf8").replace(/^\uFEFF/, ""))
    : { version: 1, tasks: {} };
  for (const result of summary.results) {
    existingMap.tasks[result.shadowTaskId] = {
      workboardCardId: result.workboardCardId,
      boardId: "shadow-work",
      syncedAt: new Date().toISOString(),
    };
  }
  existingMap.version = 1;
  existingMap.updatedAt = new Date().toISOString();
  fs.writeFileSync(mapPath, JSON.stringify(existingMap, null, 2), "utf8");
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify({
  mode: summary.mode,
  count: summary.count,
  statusCounts: summary.statusCounts,
  createdOrMatched: summary.results.length,
  mapPath: apply ? mapPath : null,
  outputPath,
}, null, 2));
