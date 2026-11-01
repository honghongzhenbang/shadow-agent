import { createHash } from "node:crypto";

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function timestampMs(message) {
  const value = message?.timestamp ?? message?.createdAt ?? message?.created_at;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageOf(message) {
  return message?.usage ?? message?.message?.usage ?? null;
}

function contentOf(message) {
  const content = message?.content ?? message?.message?.content;
  return Array.isArray(content) ? content : [];
}

function roleOf(message) {
  return message?.role ?? message?.message?.role ?? "";
}

function addFlag(flags, actual, limit, name) {
  const normalizedLimit = nonNegativeNumber(limit);
  if (normalizedLimit > 0 && actual > normalizedLimit) {
    flags.push({ name, actual, limit: normalizedLimit });
  }
}

export function controllerSessionHash(sessionKey) {
  return createHash("sha256").update(String(sessionKey ?? "unknown")).digest("hex").slice(0, 24);
}

export function summarizeOpenClawTurn({
  runId,
  sessionKey,
  triggerKind = "unknown",
  prompt,
  responseText = "",
  messages = [],
  startedAt,
  completedAt = Date.now(),
  terminal = null,
  budgets = {},
  error = null,
}) {
  const startMs = Number(startedAt) || completedAt;
  const endMs = Number(completedAt) || Date.now();
  const relevant = (messages ?? []).filter((message) => timestampMs(message) >= startMs - 2_000);
  const assistant = relevant.filter((message) => roleOf(message) === "assistant");
  const usage = assistant.reduce((sum, message) => {
    const current = usageOf(message);
    if (!current) return sum;
    sum.input += nonNegativeNumber(current.input ?? current.inputTokens ?? current.input_tokens);
    sum.output += nonNegativeNumber(current.output ?? current.outputTokens ?? current.output_tokens);
    sum.cacheRead += nonNegativeNumber(current.cacheRead ?? current.cache_read ?? current.cacheReadTokens);
    sum.cacheWrite += nonNegativeNumber(current.cacheWrite ?? current.cache_write ?? current.cacheWriteTokens);
    sum.total += nonNegativeNumber(current.totalTokens ?? current.total_tokens);
    return sum;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  if (!usage.total) usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

  const toolNames = {};
  for (const message of assistant) {
    for (const item of contentOf(message)) {
      if (!["toolCall", "tool_use", "toolUse"].includes(item?.type)) continue;
      const name = String(item.name ?? item.toolName ?? "unknown");
      toolNames[name] = (toolNames[name] ?? 0) + 1;
    }
  }
  const toolCalls = Object.values(toolNames).reduce((sum, count) => sum + count, 0);
  const promptBytes = Buffer.byteLength(String(prompt ?? ""), "utf8");
  const responseBytes = Buffer.byteLength(String(responseText ?? ""), "utf8");
  const durationMs = Math.max(0, endMs - startMs);
  const earliest = relevant.length ? Math.min(...relevant.map(timestampMs).filter(Boolean)) : 0;
  const historyMessageLimit = Math.max(1, Math.floor(nonNegativeNumber(budgets.historyMessageLimit) || 80));
  const historyWindowFilled = (messages ?? []).length >= historyMessageLimit;
  const historyComplete = !historyWindowFilled || (earliest > 0 && earliest <= startMs + 2_000);
  const modelMessage = [...assistant].reverse().find((message) => message?.model ?? message?.message?.model);
  const model = modelMessage?.model ?? modelMessage?.message?.model ?? null;

  const flags = [];
  addFlag(flags, promptBytes, budgets.maxPromptBytes, "prompt_bytes");
  addFlag(flags, durationMs, budgets.warnDurationMs, "duration_ms");
  addFlag(flags, usage.input, budgets.warnInputTokens, "input_tokens");
  addFlag(flags, usage.cacheRead, budgets.warnCacheReadTokens, "cache_read_tokens");
  addFlag(flags, usage.total, budgets.warnTotalTokens, "total_tokens");
  addFlag(flags, toolCalls, budgets.warnToolCalls, "tool_calls");
  if (!historyComplete) {
    flags.push({
      name: "history_window_truncated",
      actual: (messages ?? []).length,
      limit: historyMessageLimit,
    });
  }

  return {
    id: String(runId ?? "unknown"),
    runId: String(runId ?? "unknown"),
    sessionHash: controllerSessionHash(sessionKey),
    triggerKind: String(triggerKind ?? "unknown"),
    status: error ? "failed" : String(terminal?.status ?? "completed"),
    startedAt: new Date(startMs).toISOString(),
    completedAt: new Date(endMs).toISOString(),
    durationMs,
    promptBytes,
    responseBytes,
    assistantCalls: assistant.length,
    toolCalls,
    toolNames,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.total,
    model,
    historyComplete,
    budgetStatus: flags.length ? "warning" : "within_budget",
    budgetFlags: flags,
    error: error ? String(error.message ?? error).slice(0, 1000) : null,
  };
}

export function assertPromptBudget(message, budgets = {}) {
  const limit = nonNegativeNumber(budgets.maxPromptBytes);
  const actual = Buffer.byteLength(String(message ?? ""), "utf8");
  if (limit > 0 && actual > limit) {
    const error = new Error(`OpenClaw prompt exceeds ${limit} bytes (${actual}).`);
    error.code = "OPENCLAW_PROMPT_BUDGET_EXCEEDED";
    error.promptBytes = actual;
    error.promptLimitBytes = limit;
    throw error;
  }
  return actual;
}
