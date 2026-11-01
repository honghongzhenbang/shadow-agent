import { loadConfig } from "../src/config.mjs";
import { openDatabaseReadOnly } from "../src/db.mjs";

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

const hours = Math.max(1, Math.min(24 * 90, Number(argument("hours", 24)) || 24));
const limit = Math.max(1, Math.min(2000, Number(argument("limit", 2000)) || 2000));
const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const config = loadConfig();
const store = openDatabaseReadOnly(config.paths.database);

try {
  let rows = [];
  let unavailableReason = null;
  try {
    rows = store.controllerTurnMetrics({ since, limit });
  } catch (error) {
    if (!/no such table: controller_turn_metrics/i.test(error.message)) throw error;
    unavailableReason = "metrics_table_not_initialized_restart_context_service";
  }
  const totals = rows.reduce((sum, row) => {
    sum.durationMs += Number(row.duration_ms) || 0;
    sum.inputTokens += Number(row.input_tokens) || 0;
    sum.outputTokens += Number(row.output_tokens) || 0;
    sum.cacheReadTokens += Number(row.cache_read_tokens) || 0;
    sum.totalTokens += Number(row.total_tokens) || 0;
    sum.toolCalls += Number(row.tool_calls) || 0;
    sum.warningTurns += row.budget_status === "warning" ? 1 : 0;
    sum.failedTurns += row.status === "failed" ? 1 : 0;
    for (const [name, count] of Object.entries(parseJson(row.tool_names_json, {}))) {
      sum.tools[name] = (sum.tools[name] ?? 0) + Number(count || 0);
    }
    return sum;
  }, {
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    warningTurns: 0,
    failedTurns: 0,
    tools: {},
  });
  const durations = rows.map((row) => Number(row.duration_ms) || 0);
  const report = {
    generatedAt: new Date().toISOString(),
    available: unavailableReason === null,
    unavailableReason,
    windowHours: hours,
    since,
    turns: rows.length,
    warnings: totals.warningTurns,
    failures: totals.failedTurns,
    durationMs: {
      total: totals.durationMs,
      average: rows.length ? Math.round(totals.durationMs / rows.length) : 0,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : 0,
    },
    tokens: {
      input: totals.inputTokens,
      output: totals.outputTokens,
      cacheRead: totals.cacheReadTokens,
      total: totals.totalTokens,
      averageTotalPerTurn: rows.length ? Math.round(totals.totalTokens / rows.length) : 0,
    },
    toolCalls: {
      total: totals.toolCalls,
      averagePerTurn: rows.length ? Number((totals.toolCalls / rows.length).toFixed(2)) : 0,
      byName: Object.fromEntries(Object.entries(totals.tools).sort((left, right) => right[1] - left[1])),
    },
    recentWarnings: rows
      .filter((row) => row.budget_status === "warning")
      .slice(0, 20)
      .map((row) => ({
        runId: row.run_id,
        triggerKind: row.trigger_kind,
        completedAt: row.completed_at,
        flags: parseJson(row.budget_flags_json, []),
      })),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
