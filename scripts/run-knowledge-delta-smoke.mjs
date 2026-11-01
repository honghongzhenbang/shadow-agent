import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runOpenClawTurn } from "../src/openclaw/cli.mjs";
import {
  loadOpenClawGatewaySettings,
  OpenClawGatewayClient,
} from "../src/openclaw/gateway-client.mjs";

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")));
const runKey = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const idempotencyKey = `knowledge-delta-smoke:${runKey}`;
const sessionKey = `agent:main:shadow:knowledge-delta-smoke-${runKey}`;
const outputDirectory = path.join(projectRoot, "runtime", "evaluations", "knowledge-delta-curation", runKey);
const databasePath = path.join(projectRoot, "runtime", "shadow-agent.sqlite");
fs.mkdirSync(outputDirectory, { recursive: true });

function compactQuery(result) {
  const details = result?.output?.details ?? {};
  return {
    selected: details.selected ?? {},
    verifiedFacts: details.verifiedFacts ?? [],
    reviewPending: details.reviewPending ?? [],
    retrievalRoutes: details.retrievalRoutes ?? [],
    bytes: details.bytes ?? null,
  };
}

function readDelta() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const evidence = database.prepare(`
      SELECT id, kind, role, external_id, title, source_locator, collected_at, metadata_json
      FROM evidence WHERE kind='shadow_agent_task_result' AND external_id=?
    `).get(`resolution-delta:${idempotencyKey}`) ?? null;
    const change = evidence ? database.prepare(`
      SELECT seq, event_key, kind, status, session_key, not_before, summary, metadata_json
      FROM context_changes
      WHERE evidence_id=? AND kind='knowledge_delta_due'
      ORDER BY seq DESC LIMIT 1
    `).get(evidence.id) ?? null : null;
    const queue = evidence ? database.prepare(`
      SELECT evidence_id, priority, reason, status, queued_at, completed_at, attempts, last_error
      FROM graph_enrichment_queue WHERE evidence_id=?
    `).get(evidence.id) ?? null : null;
    const annotation = evidence ? database.prepare(`
      SELECT status, summary, keywords_json, retrieval_cues_json, metadata_json
      FROM graph_episode_annotations WHERE evidence_id=?
    `).get(evidence.id) ?? null : null;
    return { evidence, change, queue, annotation };
  } finally {
    database.close();
  }
}

const client = new OpenClawGatewayClient({
  ...loadOpenClawGatewaySettings(projectRoot),
  scopes: ["operator.read", "operator.write", "operator.admin"],
});
await client.connect();

const query = "眼在手外 固定姿态 六点法 基点 刚体变换";
const baselineRaw = await client.invokeTool("shadow_context_query", { query, limit: 8, maxBytes: 16000 });
const baseline = compactQuery(baselineRaw);
if (baseline.verifiedFacts.length !== 0) {
  throw new Error("Smoke precondition failed: target durable facts already exist before the test.");
}

const prompt = [
  "这是一次生产链路知识差量冒烟，但不是只读评测。",
  "只处理下面一个技术问题。允许读取 Shadow 图谱、一级 Evidence、本机项目文档/源码和历史 Codex 证据；禁止修改文件、代码、任务、提醒、草稿、消息或外部系统。",
  "不要调用 shadow_context_capture、shadow_context_revise、shadow_context_propose 或 shadow_context_annotate。",
  "先按渐进式检索找到现有固定姿态六点标定的项目依据，区分项目实现、数学推导和仍需现场验证的部分。不要把本提示或本次会话当作技术证据。",
  "回答完成后，如果确实形成了可复用并有来源定位的结论，调用 shadow_knowledge_delta_capture 恰好一次。差量只写候选结论和来源，不直接写图谱；使用下面的幂等键。",
  `idempotencyKey: ${idempotencyKey}`,
  "问题：线激光传感器固定在工作平台、机器人持工件且全程保持一个姿态时，如何基于现有不变姿态六点法完成眼在手外标定？基点如何取得，数学上何时可解，哪些验证仍不能省？",
  "最终用中文给出简洁整体方案，并列出证据定位和未知边界。",
].join("\n");

const turn = await runOpenClawTurn(projectRoot, {
  sessionKey,
  message: prompt,
  runTimeoutSeconds: 0,
  waitSliceSeconds: 60,
  thinking: "medium",
  triggerKind: "knowledge_delta_smoke",
  budgets: {
    maxPromptBytes: 12_000,
    historyMessageLimit: 120,
    warnDurationMs: 600_000,
    warnInputTokens: 32_000,
    warnCacheReadTokens: 96_000,
    warnTotalTokens: 120_000,
    warnToolCalls: 16,
  },
});

const delta = readDelta();
const artifact = {
  schema: "shadow-agent/knowledge-delta-curation-smoke/v1",
  runKey,
  idempotencyKey,
  sessionKey,
  query,
  baseline,
  response: turn.text,
  metrics: turn.metrics,
  delta,
  captured: Boolean(delta.evidence),
  graphWrittenByOriginTurn: false,
};
fs.writeFileSync(path.join(outputDirectory, "result.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
client.stop();

if (!delta.evidence || delta.change?.kind !== "knowledge_delta_due" || delta.queue?.reason !== "resolution-knowledge-delta") {
  throw new Error(`Knowledge delta was not captured correctly. Evidence: ${JSON.stringify(delta)}`);
}
process.stdout.write(`${JSON.stringify({ outputDirectory, response: turn.text, metrics: turn.metrics, delta }, null, 2)}\n`);
