import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";

const config = loadConfig();
const runtimeConfig = JSON.parse(fs.readFileSync(path.join(
  config.projectRoot,
  "runtime",
  "openclaw-poc",
  "state",
  "openclaw.json",
), "utf8"));
const loadingMode = runtimeConfig.plugins?.entries?.codex?.config?.codexDynamicToolsLoading;
if (loadingMode !== "searchable") {
  throw new Error(`Searchable tool smoke requires searchable mode; current mode is ${loadingMode ?? "unknown"}.`);
}
const store = openDatabase(config.paths.database);
const nonce = randomUUID();
const runId = `searchable-tools-smoke:${nonce}`;
const input = {
  sessionKey: `agent:main:shadow:smoke:searchable-tools:${nonce}`,
  message: [
    "这是隔离的动态工具搜索冒烟测试。",
    "请通过原生工具搜索找到并调用且只调用一次只读工具 shadow_context_status。",
    "不得使用 shell，不得创建或修改任务、提醒、知识、草稿、文件或外部对象。",
    "确认工具返回了控制器状态后，只回复：SEARCHABLE_TOOLS_OK",
    "如果工具不可用，只回复：SEARCHABLE_TOOLS_UNAVAILABLE",
  ].join("\n"),
  runTimeoutSeconds: 600,
  waitSliceSeconds: 60,
  thinking: "low",
  idempotencyKey: runId,
  triggerKind: "searchable_tools_smoke",
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

  if (result.text.trim() !== "SEARCHABLE_TOOLS_OK") {
    throw new Error(`Unexpected searchable tool response: ${result.text.slice(0, 300)}`);
  }
  if ((result.metrics.toolNames.shadow_context_status ?? 0) !== 1) {
    throw new Error(`Expected one shadow_context_status call, got ${JSON.stringify(result.metrics.toolNames)}.`);
  }

  console.log(JSON.stringify({
    ok: true,
    runId: result.metrics.runId,
    durationMs: result.metrics.durationMs,
    inputTokens: result.metrics.inputTokens,
    outputTokens: result.metrics.outputTokens,
    cacheReadTokens: result.metrics.cacheReadTokens,
    totalTokens: result.metrics.totalTokens,
    toolCalls: result.metrics.toolCalls,
    toolNames: result.metrics.toolNames,
    model: result.metrics.model,
    historyComplete: result.metrics.historyComplete,
    budgetStatus: result.metrics.budgetStatus,
    budgetFlags: result.metrics.budgetFlags,
  }, null, 2));
} finally {
  store.close();
}
