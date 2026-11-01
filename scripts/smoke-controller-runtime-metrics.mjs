import { randomUUID } from "node:crypto";

import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";

const config = loadConfig();
const store = openDatabase(config.paths.database);
const nonce = randomUUID();
const runId = `runtime-metrics-smoke:${nonce}`;
const input = {
  sessionKey: `agent:main:shadow:smoke:runtime-metrics:${nonce}`,
  message: [
    "这是隔离的运行指标冒烟测试。",
    "不得调用任何工具，不得读取业务数据，不得创建或修改任务、提醒、知识、草稿或外部对象。",
    "只回复：RUNTIME_METRICS_OK",
  ].join("\n"),
  runTimeoutSeconds: 600,
  waitSliceSeconds: 60,
  thinking: "low",
  idempotencyKey: runId,
  triggerKind: "smoke_test",
  budgets: config.controllerBudgets,
};

try {
  let result;
  try {
    result = await runOpenClawTurn(config.projectRoot, input);
    store.recordControllerTurnMetric(result.metrics, {
      retentionRows: config.controllerBudgets?.retentionRows,
    });
  } catch (error) {
    if (error.turnMetrics) {
      store.recordControllerTurnMetric(error.turnMetrics, {
        retentionRows: config.controllerBudgets?.retentionRows,
      });
    }
    throw error;
  }
  if (result.text.trim() !== "RUNTIME_METRICS_OK") {
    throw new Error(`Unexpected smoke response: ${result.text.slice(0, 200)}`);
  }
  const row = store.db.prepare("SELECT * FROM controller_turn_metrics WHERE run_id=?").get(result.metrics.runId);
  if (!row) throw new Error("Controller turn metric was not persisted.");
  if (row.tool_calls !== 0) throw new Error(`Smoke turn unexpectedly called ${row.tool_calls} tools.`);
  console.log(JSON.stringify({
    ok: true,
    runId: row.run_id,
    status: row.status,
    durationMs: row.duration_ms,
    promptBytes: row.prompt_bytes,
    responseBytes: row.response_bytes,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalTokens: row.total_tokens,
    toolCalls: row.tool_calls,
    model: row.model,
    historyComplete: Boolean(row.history_complete),
    budgetStatus: row.budget_status,
    budgetFlags: JSON.parse(row.budget_flags_json),
  }, null, 2));
} finally {
  store.close();
}
