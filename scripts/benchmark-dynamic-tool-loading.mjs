import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { runOpenClawTurn } from "../src/openclaw/cli.mjs";

const config = loadConfig();
const runtimeConfigPath = path.join(
  config.projectRoot,
  "runtime",
  "openclaw-poc",
  "state",
  "openclaw.json",
);
const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
const mode = runtimeConfig.plugins?.entries?.codex?.config?.codexDynamicToolsLoading ?? "unknown";
const store = openDatabase(config.paths.database);

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const timeoutSeconds = Math.max(60, Number(optionValue("--timeout-seconds", 600)) || 600);
const thinking = String(optionValue("--thinking", "medium"));
const repeat = Math.max(1, Math.min(20, Number(optionValue("--repeat", 1)) || 1));

const cases = [
  {
    id: "status_exact",
    expectedTool: "shadow_context_status",
    marker: "BENCH_STATUS_EXACT_OK",
    request: "请明确调用且只调用一次 shadow_context_status，确认控制器状态接口可读。",
  },
  {
    id: "status_natural",
    expectedTool: "shadow_context_status",
    marker: "BENCH_STATUS_NATURAL_OK",
    request: "请只读确认 Shadow Agent 当前控制器运行模式是否可以正常获取。不要根据提示词猜测结果。",
  },
  {
    id: "focus_natural",
    expectedTool: "shadow_context_focus",
    marker: "BENCH_FOCUS_OK",
    request: "请只读确认长期工作简况和当前工作雷达是否可以正常获取。不要展开业务内容。",
  },
  {
    id: "reminders_natural",
    expectedTool: "shadow_reminder_list",
    marker: "BENCH_REMINDERS_OK",
    request: "请只读确认用户提醒列表接口是否可访问，无论列表是否为空都不要创建或修改提醒。",
  },
  {
    id: "conditions_natural",
    expectedTool: "shadow_condition_list",
    marker: "BENCH_CONDITIONS_OK",
    request: "请只读确认持续追踪列表接口是否可访问，不要解析或更改任何追踪条件。",
  },
  {
    id: "workboard_natural",
    expectedTool: "workboard_list",
    marker: "BENCH_WORKBOARD_OK",
    request: "请只读确认 Workboard 当前卡片列表接口是否可访问，不要读取单卡详情或修改卡片。",
  },
  {
    id: "vocabulary_long_tail",
    expectedTool: "shadow_context_vocabulary",
    marker: "BENCH_VOCABULARY_OK",
    request: "请明确调用且只调用一次 shadow_context_vocabulary，查询‘软件版本’相关图谱词汇，确认长尾知识工具可发现。",
  },
];

const caseArgumentIndex = process.argv.indexOf("--case");
const requestedCaseIds = caseArgumentIndex >= 0
  ? new Set(String(process.argv[caseArgumentIndex + 1] ?? "").split(",").filter(Boolean))
  : null;
const selectedCaseDefinitions = requestedCaseIds
  ? cases.filter((testCase) => requestedCaseIds.has(testCase.id))
  : cases;
if (requestedCaseIds && selectedCaseDefinitions.length !== requestedCaseIds.size) {
  const known = new Set(cases.map((testCase) => testCase.id));
  const unknown = [...requestedCaseIds].filter((id) => !known.has(id));
  throw new Error(`Unknown benchmark case: ${unknown.join(", ")}`);
}
const selectedCases = Array.from({ length: repeat }, (_, iteration) => selectedCaseDefinitions.map((testCase) => ({
  ...testCase,
  iteration: iteration + 1,
}))).flat();

const results = [];
try {
  for (const testCase of selectedCases) {
    const nonce = randomUUID();
    const runId = `dynamic-tools-benchmark:${mode}:${testCase.id}:${testCase.iteration}:${nonce}`;
    const input = {
      sessionKey: `agent:main:shadow:benchmark:dynamic-tools:${mode}:${testCase.id}:${testCase.iteration}:${nonce}`,
      message: [
        "这是隔离的动态工具只读基准测试。",
        "不得使用 shell，不得创建或修改任务、提醒、知识、草稿、文件或外部对象。",
        "只完成下面一个检查，不得调用其他业务工具。",
        testCase.request,
        `成功调用并读取目标工具后，只回复：${testCase.marker}`,
        "如果找不到合适工具，只回复：BENCH_TOOL_UNAVAILABLE",
      ].join("\n"),
      runTimeoutSeconds: timeoutSeconds,
      waitSliceSeconds: Math.min(60, timeoutSeconds),
      thinking,
      idempotencyKey: runId,
      triggerKind: `dynamic_tools_benchmark_${mode}`,
      budgets: config.controllerBudgets,
    };

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
      results.push({
        id: testCase.id,
        iteration: testCase.iteration,
        expectedTool: testCase.expectedTool,
        passed: false,
        outcome: "turn_timeout_or_error",
        error: String(error.message ?? error),
        metrics: error.turnMetrics ?? null,
      });
      continue;
    }

    const actualTools = Object.keys(result.metrics.toolNames);
    const unexpectedTools = actualTools.filter((name) => name !== testCase.expectedTool);
    const expectedCalls = result.metrics.toolNames[testCase.expectedTool] ?? 0;
    results.push({
      id: testCase.id,
      iteration: testCase.iteration,
      expectedTool: testCase.expectedTool,
      passed: result.text.trim() === testCase.marker && expectedCalls === 1 && unexpectedTools.length === 0,
      outcome: result.text.trim() === testCase.marker && expectedCalls === 1 && unexpectedTools.length === 0
        ? "passed"
        : result.text.trim() === "BENCH_TOOL_UNAVAILABLE"
          ? "tool_unavailable"
          : unexpectedTools.length > 0
            ? "wrong_tool"
            : "missing_or_bad_reply",
      markerMatched: result.text.trim() === testCase.marker,
      visibleReply: result.text.trim().slice(0, 200),
      expectedCalls,
      actualTools,
      unexpectedTools,
      durationMs: result.metrics.durationMs,
      inputTokens: result.metrics.inputTokens,
      outputTokens: result.metrics.outputTokens,
      cacheReadTokens: result.metrics.cacheReadTokens,
      totalTokens: result.metrics.totalTokens,
      historyComplete: result.metrics.historyComplete,
      budgetStatus: result.metrics.budgetStatus,
      budgetFlags: result.metrics.budgetFlags,
      model: result.metrics.model,
      runId: result.metrics.runId,
    });
  }

  const completed = results.filter((item) => Number.isFinite(item.durationMs));
  const sortedDurations = completed.map((item) => item.durationMs).sort((a, b) => a - b);
  const percentile = (ratio) => sortedDurations.length
    ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * ratio))]
    : null;
  const summary = {
    generatedAt: new Date().toISOString(),
    mode,
    thinking,
    timeoutSeconds,
    repeat,
    model: completed.find((item) => item.model)?.model ?? null,
    cases: results.length,
    selectedCaseIds: selectedCaseDefinitions.map((testCase) => testCase.id),
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    toolUnavailable: results.filter((item) => item.outcome === "tool_unavailable").length,
    turnTimeoutOrError: results.filter((item) => item.outcome === "turn_timeout_or_error").length,
    wrongToolSelections: results.filter((item) => (item.unexpectedTools?.length ?? 0) > 0).length,
    missingExpectedTools: results.filter((item) => Number(item.expectedCalls ?? 0) !== 1).length,
    durationMs: {
      average: completed.length
        ? Math.round(completed.reduce((sum, item) => sum + item.durationMs, 0) / completed.length)
        : null,
      p50: percentile(0.5),
      p95: percentile(0.95),
      min: sortedDurations[0] ?? null,
      max: sortedDurations.at(-1) ?? null,
    },
    tokens: {
      input: completed.reduce((sum, item) => sum + item.inputTokens, 0),
      output: completed.reduce((sum, item) => sum + item.outputTokens, 0),
      cacheRead: completed.reduce((sum, item) => sum + item.cacheReadTokens, 0),
      total: completed.reduce((sum, item) => sum + item.totalTokens, 0),
    },
    results,
  };

  const outputDirectory = path.join(config.projectRoot, "runtime", "evaluations", "dynamic-tool-loading");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${mode}.json`,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...summary, outputPath }, null, 2));
  if (summary.failed > 0) process.exitCode = 2;
} finally {
  store.close();
}
