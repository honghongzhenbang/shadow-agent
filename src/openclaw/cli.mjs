import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { runCommand } from "../process.mjs";
import { parseJsonLoose, sha256 } from "../utils.mjs";
import { loadOpenClawGatewaySettings, OpenClawGatewayClient } from "./gateway-client.mjs";
import { assertPromptBudget, summarizeOpenClawTurn } from "./turn-metrics.mjs";
import { readNativeTerminal, nativeRunAbsent } from "./native-terminal.mjs";

export function openClawRuntime(projectRoot) {
  const stateRoot = path.join(projectRoot, "runtime", "openclaw-poc", "state");
  const nodeExecutable = path.join(projectRoot, "tools", "node-v24.19.0-win-x64", "node.exe");
  const entry = path.join(projectRoot, "tools", "openclaw-runtime", "node_modules", "openclaw", "openclaw.mjs");
  if (!fs.existsSync(nodeExecutable)) throw new Error(`Portable Node not found: ${nodeExecutable}`);
  if (!fs.existsSync(entry)) throw new Error(`OpenClaw entry not found: ${entry}`);
  return {
    nodeExecutable,
    entry,
    env: {
      OPENCLAW_STATE_DIR: stateRoot,
      OPENCLAW_CONFIG_PATH: path.join(stateRoot, "openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: path.join(projectRoot, "runtime", "openclaw-poc", "workspace"),
      OPENCLAW_GATEWAY_PORT: "19011",
      PATH: `${path.dirname(nodeExecutable)};${process.env.PATH ?? ""}`,
    },
  };
}

export async function runOpenClawCli(projectRoot, args, options = {}) {
  const runtime = openClawRuntime(projectRoot);
  const result = await runCommand(runtime.nodeExecutable, [runtime.entry, ...args], {
    cwd: projectRoot,
    env: runtime.env,
    timeoutMs: options.timeoutMs ?? 240000,
    maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
    check: options.check,
  });
  let payload = null;
  try { payload = parseJsonLoose(result.stdout || result.stderr); } catch { /* callers may only need completion */ }
  return { ...result, payload };
}

export function assistantTextFromResult(payload) {
  const direct = payload?.result?.meta?.finalAssistantVisibleText
    ?? payload?.result?.payloads?.find((item) => typeof item?.text === "string")?.text
    ?? payload?.meta?.finalAssistantVisibleText;
  return typeof direct === "string" ? direct.trim() : "";
}

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function assistantTextAfter(messages, startedAt, { finalOnly = false, endedAt = Infinity } = {}) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role !== "assistant") continue;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > endedAt) continue;
    if (finalOnly && (!["stop", "end_turn"].includes(message.stopReason)
      || (Array.isArray(message.content) && message.content.some((item) => ["toolCall", "tool_use", "toolUse"].includes(item?.type))))) continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return "";
}

export function isNonTerminalOpenClawWait(result) {
  if (result?.status === "pending") return true;
  if (result?.status !== "timeout" || result?.endedAt != null) return false;
  return result?.timeoutPhase === "queue" || result?.timeoutPhase === "gateway_draining";
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

export function pendingOpenClawTurn(store, sessionKey) {
  if (!store) return null;
  const active = store.getSetting(`controller:turn-active:${sha256(sessionKey)}`);
  if (!active) return null;
  const value = store.getSetting(JSON.parse(active).receiptKey);
  if (!value) throw new Error("Active OpenClaw turn is missing its durable receipt.");
  return JSON.parse(value);
}

export function openClawTurnReceipt(store, sessionKey, requestId) {
  const value = store?.getSetting(turnStateKey(sessionKey, requestId));
  return value ? JSON.parse(value) : null;
}

function turnStateKey(sessionKey, requestId) {
  return `controller:turn:${sha256(`${sessionKey}:${requestId}`)}`;
}

function persistTurnState(store, sessionKey, checkpoint) {
  if (!store) return;
  const receiptKey = turnStateKey(sessionKey, checkpoint.requestId);
  const activeKey = `controller:turn-active:${sha256(sessionKey)}`;
  store.transaction(() => {
    const active = pendingOpenClawTurn(store, sessionKey);
    if (["submitting", "running", "unconfirmed"].includes(checkpoint.state) && active && active.requestId !== checkpoint.requestId) {
      const error = new Error(`Session has an unconfirmed run ${active.runId}.`);
      error.code = "OPENCLAW_SESSION_RECONCILIATION_REQUIRED";
      throw error;
    }
    store.setSetting(receiptKey, JSON.stringify(checkpoint));
    if (["submitting", "running", "unconfirmed"].includes(checkpoint.state)) {
      store.setSetting(activeKey, JSON.stringify({
        receiptKey, sessionKey, requestId: checkpoint.requestId, triggerKind: checkpoint.triggerKind,
        dueAt: checkpoint.retryAt ?? checkpoint.updatedAt,
      }));
    } else if (active?.requestId === checkpoint.requestId) {
      store.db.prepare("DELETE FROM settings WHERE key=?").run(activeKey);
    }
  });
}

export function nextPendingAttentionTurn(store, { readyOnly = false, now = new Date().toISOString() } = {}) {
  const row = store.db.prepare(`
    SELECT receipt.value FROM settings active
    JOIN settings receipt ON receipt.key=json_extract(active.value, '$.receiptKey')
    WHERE active.key LIKE 'controller:turn-active:%'
      AND json_extract(active.value, '$.triggerKind')='attention'
      ${readyOnly ? "AND json_extract(active.value, '$.dueAt')<=?" : ""}
    ORDER BY json_extract(active.value, '$.dueAt') LIMIT 1
  `).get(...(readyOnly ? [now] : []));
  return row ? JSON.parse(row.value) : null;
}

export function deferPendingOpenClawTurn(store, sessionKey, retryAt) {
  const turn = pendingOpenClawTurn(store, sessionKey);
  if (!turn) return false;
  persistTurnState(store, sessionKey, { ...turn, retryAt });
  return true;
}

export async function waitForOpenClawRun(client, runId, {
  waitSliceSeconds = 60,
  pendingBackoffMs = 250,
  observeOnce = false,
} = {}) {
  const sliceSeconds = Math.max(1, nonNegativeInteger(waitSliceSeconds, 60));
  const backoffMs = nonNegativeInteger(pendingBackoffMs, 250);
  const sliceMs = sliceSeconds * 1000;
  while (true) {
    const observationStartedAt = Date.now();
    const result = await client.request("agent.wait", {
      runId,
      timeoutMs: sliceMs,
    }, sliceMs + 15_000);
    if (!isNonTerminalOpenClawWait(result) || observeOnce) return result;

    // A pending observation is not a failed run. Avoid a hot loop if a blocked
    // provider returns the nonterminal state immediately.
    const elapsedMs = Date.now() - observationStartedAt;
    if (backoffMs > 0 && elapsedMs < backoffMs) await delay(backoffMs - elapsedMs);
  }
}

export async function runOpenClawTurn(projectRoot, {
  sessionKey,
  message,
  runTimeoutSeconds = 0,
  waitSliceSeconds = 60,
  thinking = "medium",
  idempotencyKey = null,
  historySinceAt = null,
  triggerKind = "unknown",
  budgets = {},
  stateStore = null,
  resumePending = false,
  allowSilent = false,
  observeOnce = false,
  attentionBatch = null,
}, dependencies = {}) {
  const parsedHistorySince = Date.parse(historySinceAt ?? "");
  let replySinceAt = Number.isFinite(parsedHistorySince) ? parsedHistorySince : Date.now();
  let executionStartedAt = Date.now();
  const runId = String(idempotencyKey ?? randomUUID());
  const client = dependencies.client ?? new OpenClawGatewayClient({
    ...loadOpenClawGatewaySettings(projectRoot),
    autoReconnect: false,
    requestTimeoutMs: 30_000,
    // Controller-originated turns act on behalf of the local owner. OpenClaw
    // 2026.8.1 hides Codex supervision tools from non-owner run contexts.
    scopes: ["operator.read", "operator.write", "operator.admin"],
  });
  let accepted = null;
  let acceptedRunId = runId;
  let terminal = null;
  let history = null;
  let text = "";
  const previous = stateStore?.getSetting(turnStateKey(sessionKey, runId));
  let checkpoint = previous ? JSON.parse(previous) : pendingOpenClawTurn(stateStore, sessionKey);
  const sameRequest = checkpoint?.requestId === runId;
  const unresolved = checkpoint && ["submitting", "running", "unconfirmed"].includes(checkpoint.state);
  const persist = (changes) => {
    checkpoint = { ...checkpoint, ...changes, updatedAt: new Date().toISOString() };
    persistTurnState(stateStore, sessionKey, checkpoint);
  };
  try {
    assertPromptBudget(message, budgets);
    if (unresolved && !sameRequest && !resumePending) {
      const error = new Error(`Session has an unconfirmed run ${checkpoint.runId}; reconcile it before starting another turn.`);
      error.code = "OPENCLAW_SESSION_RECONCILIATION_REQUIRED";
      error.runId = checkpoint.runId;
      throw error;
    }
    if (sameRequest && !(unresolved && resumePending) && checkpoint.messageHash !== sha256(message)) {
      throw new Error("OpenClaw idempotency key was reused with a different message.");
    }
    // A confirmed result survives Gateway restarts; do not turn it back into
    // an unresolved run merely because the transport or history is unavailable.
    if (sameRequest && checkpoint.state === "completed" && checkpoint.result) {
      return { ...checkpoint.result, payload: { ...checkpoint.result.payload, replayed: true } };
    }
    const normalizedRunTimeoutSeconds = nonNegativeInteger(runTimeoutSeconds, 0);
    const nativeTerminal = (sameRequest || (unresolved && resumePending)) && !checkpoint.terminal
      ? (dependencies.readNativeTerminal ?? readNativeTerminal)(projectRoot, sessionKey, checkpoint.runId) : null;
    if (nativeTerminal) persist({ terminal: nativeTerminal });
    const durableTerminal = checkpoint?.terminal;
    if (!durableTerminal) await client.connect();
    if (sameRequest || (unresolved && resumePending)) {
      acceptedRunId = checkpoint.runId;
      replySinceAt = checkpoint.startedAt;
      executionStartedAt = checkpoint.executionStartedAt ?? checkpoint.startedAt;
      accepted = { runId: acceptedRunId, resumed: true };
    } else {
      checkpoint = { requestId: runId, runId, sessionKey, triggerKind, messageHash: sha256(message),
        startedAt: replySinceAt, executionStartedAt, promptBytes: Buffer.byteLength(message, "utf8"), allowSilent, attentionBatch };
      // Persist before submission: a disconnected acknowledgement is not permission to submit again.
      persist({ state: "submitting" });
      accepted = await client.request("agent", {
        message,
        agentId: "main",
        sessionKey,
        thinking,
        timeout: normalizedRunTimeoutSeconds,
        deliver: false,
        idempotencyKey: runId,
      }, 45_000);
      acceptedRunId = accepted?.runId ?? runId;
      persist({ state: "running", runId: acceptedRunId });
    }
    let waitError = null;
    try {
      terminal = checkpoint.terminal
        ? checkpoint.terminal
        : await waitForOpenClawRun(client, acceptedRunId, { waitSliceSeconds, observeOnce });
    } catch (error) {
      waitError = error;
    }
    if (unresolved && terminal?.runKnown === false && checkpoint.triggerKind === "attention"
      && (dependencies.nativeRunAbsent ?? nativeRunAbsent)(projectRoot, sessionKey, acceptedRunId)) {
      // Release only the lost execution, not its business obligation. A fresh
      // semantic review must inspect existing effects before proposing any work.
      const error = new Error("Gateway no longer owns this run and no native queue/trajectory/worker claim exists; reconcile its business outcome");
      error.code = "OPENCLAW_RUN_LOST";
      error.runId = acceptedRunId;
      error.sessionKey = sessionKey;
      error.requiresReconciliation = true;
      persist({ state: "failed", outcome: "unknown", terminal: { status: "error", error: error.message, runKnown: false } });
      throw error;
    }
    if (isNonTerminalOpenClawWait(terminal)) {
      persist({ state: "running", runId: acceptedRunId });
      const error = new Error("OpenClaw run is still active; continue observing the same run.");
      error.code = "OPENCLAW_RUN_PENDING";
      error.runId = acceptedRunId;
      throw error;
    }
    if (terminal?.status === "ok") persist({ terminal });
    let historyError = null;
    try {
      history = durableTerminal ? null : await client.request("chat.history", {
        sessionKey,
        limit: Math.max(20, Math.min(200, Number(budgets.historyMessageLimit) || 80)),
        maxChars: 256_000,
      }, 30_000);
    } catch (error) { historyError = error; }
    const partialText = assistantTextAfter(history?.messages, replySinceAt, { endedAt: terminal?.endedAt ?? Infinity });
    text = terminal?.terminalReply
      ? terminal.terminalReply.disposition === "visible" ? String(terminal.terminalReply.text ?? "").trim() : ""
      : assistantTextAfter(history?.messages, replySinceAt, { finalOnly: true, endedAt: terminal?.endedAt ?? Infinity });
    const metrics = summarizeOpenClawTurn({
      runId: acceptedRunId,
      sessionKey,
      triggerKind,
      prompt: message,
      responseText: text,
      messages: history?.messages,
      startedAt: executionStartedAt,
      completedAt: terminal?.endedAt ?? Date.now(),
      terminal,
      budgets,
    });
    metrics.promptBytes = checkpoint.promptBytes;
    if (terminal?.nativeMetrics) Object.assign(metrics, terminal.nativeMetrics);
    if (nativeTerminal) metrics.historyComplete = false;
    if (historyError) metrics.historyComplete = false;
    const silentSuccess = (checkpoint.allowSilent ?? allowSilent) && terminal?.terminalReply?.disposition === "silent";
    if (waitError || terminal?.status !== "ok" || (!text && !silentSuccess)) {
      const confirmedFailure = terminal && ["error", "timeout"].includes(terminal.status)
        && (terminal.status === "error" || terminal.endedAt != null);
      const error = new Error(waitError?.message ?? terminal?.error ?? historyError?.message
        ?? `OpenClaw run ${acceptedRunId} has no confirmed successful final reply.`);
      error.code = confirmedFailure ? "OPENCLAW_RUN_FAILED"
        : terminal?.status === "ok" ? "OPENCLAW_REPLY_UNCONFIRMED" : "OPENCLAW_RUN_UNCONFIRMED";
      error.runId = acceptedRunId;
      error.partialText = partialText;
      error.terminal = terminal;
      if (nativeTerminal?.status === "error" && checkpoint.triggerKind === "attention") error.requiresReconciliation = true;
      persist({ state: confirmedFailure ? "failed" : "unconfirmed", runId: acceptedRunId,
        terminal: confirmedFailure ? { status: terminal.status, endedAt: terminal.endedAt, error: String(terminal.error ?? "").slice(0, 1000), nativeProof: terminal.nativeProof } : terminal?.status === "ok" ? terminal : null });
      error.turnMetrics = { ...metrics, status: "failed", error: error.message };
      throw error;
    }
    const result = {
      text,
      payload: { accepted, terminal, historySessionId: history?.sessionId ?? null,
        attentionBatch: checkpoint.attentionBatch,
        resumedEarlierTurn: accepted.resumed === true && !sameRequest },
      metrics,
    };
    persist({ state: "completed", runId: acceptedRunId, terminal, result });
    return result;
  } catch (error) {
    if (!error.code && checkpoint && ["submitting", "running", "unconfirmed"].includes(checkpoint.state)) {
      const rejected = checkpoint.state === "submitting" && error.rpcCode === "INVALID_REQUEST";
      error.code = rejected ? "OPENCLAW_REQUEST_REJECTED" : "OPENCLAW_RUN_UNCONFIRMED";
      error.runId = checkpoint.runId;
      acceptedRunId = checkpoint.runId;
      persist({ state: rejected ? "failed" : "unconfirmed",
        terminal: rejected ? { status: "error", error: error.message.slice(0, 1000) } : null });
    }
    if (!error.turnMetrics && error.code !== "OPENCLAW_RUN_PENDING") {
      error.turnMetrics = summarizeOpenClawTurn({
        runId: acceptedRunId,
        sessionKey,
        triggerKind,
        prompt: message,
        responseText: text,
        messages: history?.messages,
        startedAt: executionStartedAt,
        completedAt: Date.now(),
        terminal,
        budgets,
        error,
      });
    }
    throw error;
  } finally {
    client.stop();
  }
}

export async function runOpenClawConversation(projectRoot, options) {
  const result = await runOpenClawTurn(projectRoot, options);
  const text = result.text;
  if (!text) throw new Error("OpenClaw returned no visible reply text.");
  return result;
}

export async function wakeOpenClaw(projectRoot, text, sessionKey = "agent:main:shadow-events", options = {}) {
  return runOpenClawTurn(projectRoot, { allowSilent: true, ...options, sessionKey, message: text, triggerKind: options.triggerKind ?? "controller_outbox" });
}
