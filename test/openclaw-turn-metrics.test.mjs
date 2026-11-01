import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import {
  assertPromptBudget,
  controllerSessionHash,
  summarizeOpenClawTurn,
} from "../src/openclaw/turn-metrics.mjs";

test("controller turn metrics retain bounded counts without storing the session key", () => {
  const startedAt = Date.parse("2026-08-31T01:00:00.000Z");
  const sessionKey = "agent:main:shadow:im:private-chat-id";
  const metrics = summarizeOpenClawTurn({
    runId: "run-1",
    sessionKey,
    triggerKind: "attention",
    prompt: "inspect one bounded change",
    responseText: "done",
    startedAt,
    completedAt: startedAt + 5_000,
    terminal: { status: "ok" },
    budgets: {
      warnDurationMs: 10_000,
      warnInputTokens: 10_000,
      warnCacheReadTokens: 40_000,
      warnTotalTokens: 50_000,
      warnToolCalls: 1,
      historyMessageLimit: 80,
    },
    messages: [
      {
        role: "user",
        timestamp: startedAt,
        content: [{ type: "text", text: "inspect" }],
      },
      {
        role: "assistant",
        timestamp: startedAt + 1_000,
        model: "gpt-test",
        content: [
          { type: "toolCall", name: "shadow_attention_packet" },
          { type: "toolCall", name: "shadow_context_ack" },
        ],
        usage: { input: 1200, output: 80, cacheRead: 46_000, totalTokens: 47_280 },
      },
    ],
  });

  assert.equal(metrics.sessionHash, controllerSessionHash(sessionKey));
  assert.doesNotMatch(JSON.stringify(metrics), /private-chat-id/);
  assert.equal(metrics.toolCalls, 2);
  assert.deepEqual(metrics.toolNames, { shadow_attention_packet: 1, shadow_context_ack: 1 });
  assert.equal(metrics.totalTokens, 47_280);
  assert.equal(metrics.budgetStatus, "warning");
  assert.deepEqual(metrics.budgetFlags.map((flag) => flag.name), ["cache_read_tokens", "tool_calls"]);
});

test("prompt byte budget is UTF-8 aware and fails before dispatch", () => {
  assert.equal(assertPromptBudget("中文", { maxPromptBytes: 6 }), 6);
  assert.throws(
    () => assertPromptBudget("中文A", { maxPromptBytes: 6 }),
    (error) => error.code === "OPENCLAW_PROMPT_BUDGET_EXCEEDED"
      && error.promptBytes === 7
      && error.promptLimitBytes === 6,
  );
});

test("history completeness only warns when the returned window reaches its limit", () => {
  const startedAt = Date.parse("2026-08-31T01:00:00.000Z");
  const sparse = summarizeOpenClawTurn({
    runId: "run-sparse",
    sessionKey: "agent:main:test",
    prompt: "small turn",
    startedAt,
    budgets: { historyMessageLimit: 80 },
    messages: [{
      role: "assistant",
      timestamp: startedAt + 30_000,
      content: [{ type: "text", text: "done" }],
    }],
  });
  assert.equal(sparse.historyComplete, true);
  assert.equal(sparse.budgetFlags.some((flag) => flag.name === "history_window_truncated"), false);

  const bounded = summarizeOpenClawTurn({
    runId: "run-bounded",
    sessionKey: "agent:main:test",
    prompt: "bounded turn",
    startedAt,
    budgets: { historyMessageLimit: 2 },
    messages: [
      { role: "assistant", timestamp: startedAt + 30_000, content: [] },
      { role: "assistant", timestamp: startedAt + 31_000, content: [] },
    ],
  });
  assert.equal(bounded.historyComplete, false);
  assert.deepEqual(
    bounded.budgetFlags.find((flag) => flag.name === "history_window_truncated"),
    { name: "history_window_truncated", actual: 2, limit: 2 },
  );
});

test("controller turn metrics are idempotent observability records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-turn-metrics-"));
  const store = openDatabase(path.join(root, "shadow.sqlite"));
  try {
    const base = {
      id: "run-1",
      runId: "run-1",
      sessionHash: controllerSessionHash("agent:main:test"),
      triggerKind: "direct_input",
      status: "completed",
      startedAt: "2026-08-31T01:00:00.000Z",
      completedAt: "2026-08-31T01:00:01.000Z",
      durationMs: 1000,
      promptBytes: 100,
      responseBytes: 20,
      assistantCalls: 1,
      toolCalls: 0,
      toolNames: {},
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      totalTokens: 1220,
      model: "gpt-test",
      historyComplete: true,
      budgetStatus: "within_budget",
      budgetFlags: [],
      error: null,
    };
    store.recordControllerTurnMetric(base);
    store.recordControllerTurnMetric({
      ...base,
      completedAt: "2026-08-31T01:00:02.000Z",
      durationMs: 2000,
      outputTokens: 30,
      totalTokens: 1230,
    });
    const rows = store.controllerTurnMetrics();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].duration_ms, 2000);
    assert.equal(rows[0].output_tokens, 30);
    assert.equal(rows[0].session_hash, base.sessionHash);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
