import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const tokenKeys = ["input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput", "total"];
const digest = value => createHash("sha256").update(value).digest("hex");
const time = value => typeof value === "number" && Number.isFinite(value) ? value
  : typeof value === "string" && value.trim() ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : NaN;
const textContent = message => typeof message?.content === "string" ? message.content
  : Array.isArray(message?.content) ? message.content.filter(part => part && (["text", "output_text"].includes(part.type)
    || message.role === "developer" && part.type === "input_text")).map(part => part.text ?? "").join("\n") : "";
const phaseOf = message => message.phase ?? message.channel
  ?? (message.__openclaw?.mirrorIdentity?.includes(":commentary:") ? "commentary" : undefined);
const isAssistant = message => message?.role === "assistant" && !["analysis", "reasoning"].includes(phaseOf(message));
const finalPhase = phase => ["final", "final_answer"].includes(phase);
const emptyUsage = () => Object.fromEntries([...tokenKeys.map(key => [key, 0]), ["responses", 0]]);
const addUsage = records => records.reduce((total, record) => {
  for (const key of tokenKeys) total[key] += record.usage[key];
  total.responses++;
  return total;
}, emptyUsage());

// Ordinals count nonempty lines, exactly like runner's StartLine/EndLine counters.
export function parseJsonl(text, file = "jsonl") {
  const records = [], diagnostics = [];
  let ordinal = 0;
  String(text).replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    ordinal++;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a record");
      records.push({ line: index + 1, ordinal, value });
    }
    catch { diagnostics.push({ file, line: index + 1, ordinal, code: "invalid_jsonl" }); }
  });
  return { records, diagnostics, lineCount: ordinal };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Cached input is a subset of input; reasoning is a subset of output.
  const input = raw.input_tokens ?? raw.input;
  const output = raw.output_tokens ?? raw.output;
  if (![input, output].every(n => Number.isFinite(n) && n >= 0)) return null;
  const result = {
    input, cachedInput: raw.cached_input_tokens ?? raw.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteInput: raw.cache_write_input_tokens ?? 0, output,
    reasoningOutput: raw.reasoning_output_tokens ?? raw.output_tokens_details?.reasoning_tokens ?? 0,
    total: input + output
  };
  return Object.values(result).every(n => Number.isFinite(n) && n >= 0) ? result : null;
}

function toolNames(tools = []) {
  return tools.flatMap(tool => tool.type === "namespace" ? toolNames(tool.tools) : typeof tool.name === "string" ? [tool.name] : []);
}

export function parseNativeRollout(text, file = "rollout.jsonl") {
  const parsed = parseJsonl(text, file);
  const output = { file, threadId: null, models: [], dynamicToolNames: [], baseInstructionChars: 0,
    developerMessages: [], turns: [], diagnostics: [...parsed.diagnostics] };
  let current = null, lastCumulative = null, latestDeveloper = null;
  let pendingIds = [], pendingUsage = [];
  const seenMessages = new Set(), seenCalls = new Set(), seenCumulative = new Set();
  const finish = () => {
    if (!current) return;
    current.usageRecords.push(...pendingUsage);
    if (pendingIds.length && !pendingUsage.length) current.unmeteredResponseSegments++;
    current.usage = addUsage(current.usageRecords);
    pendingIds = []; pendingUsage = [];
  };
  const start = (id, timestamp) => {
    if (current?.turnId === id && id != null) return;
    finish();
    current = { turnId: id, startedAt: timestamp, endedAt: null, model: null,
      developerMessages: [], latestDeveloperMessage: latestDeveloper,
      assistantResponses: [], toolCalls: [], usageRecords: [], unmeteredResponseSegments: 0 };
    output.turns.push(current);
  };
  for (const { line, value: item } of parsed.records) {
    const p = item.payload ?? {}, timestamp = time(item.timestamp);
    if (item.type === "session_meta") {
      output.threadId = p.id ?? p.session_id ?? null;
      output.dynamicToolNames = toolNames(p.dynamic_tools);
      output.baseInstructionChars = typeof p.base_instructions === "string" ? p.base_instructions.length : (p.base_instructions?.text?.length ?? 0);
    }
    // Native started_at/completed_at are Unix seconds; the envelope is ISO/ms.
    if (item.type === "event_msg" && p.type === "task_started") start(p.turn_id ?? null,
      Number.isFinite(timestamp) ? timestamp : typeof p.started_at === "number" ? p.started_at * 1000 : time(p.started_at));
    if (item.type === "turn_context") {
      start(p.turn_id ?? current?.turnId ?? null, timestamp);
      current.model = p.model ?? null;
      if (p.model && !output.models.includes(p.model)) output.models.push(p.model);
    }
    if (item.type === "response_item" && p.type === "message" && p.role === "developer") {
      const content = textContent(p);
      const measure = { file, line, chars: content.length, sha256: digest(content),
        frameworkIdentity: /personal agent running inside OpenClaw/.test(content),
        replacementCore: /A task is a business goal/.test(content) };
      output.developerMessages.push(measure);
      latestDeveloper = measure;
      if (current) { current.developerMessages.push(measure); current.latestDeveloperMessage = measure; }
    }
    if (item.type === "response_item" && (isAssistant(p) || ["function_call", "custom_tool_call"].includes(p.type))) {
      if (!current) start(null, timestamp);
      const id = p.id ?? p.call_id ?? `${file}:${line}`;
      if (p.type === "message" && isAssistant(p) && !seenMessages.has(id)) {
        seenMessages.add(id);
        const content = textContent(p);
        if (content) current.assistantResponses.push({ id, file, line, timestamp, phase: phaseOf(p) ?? "unspecified", text: content });
        pendingIds.push(id);
        const usage = normalizeUsage(p.usage);
        if (usage) pendingUsage.push({ file, line, timestamp, source: "assistant.usage", responseIds: [id], usage });
      }
      if (["function_call", "custom_tool_call"].includes(p.type) && !seenCalls.has(p.call_id ?? id)) {
        seenCalls.add(p.call_id ?? id);
        current.toolCalls.push({ file, line, timestamp, name: p.name, callId: p.call_id ?? id, type: p.type });
        pendingIds.push(id);
      }
    }
    if (item.type === "event_msg" && p.type === "token_count" && p.info) {
      const cumulative = normalizeUsage(p.info.total_token_usage);
      const cumulativeKey = cumulative && JSON.stringify(cumulative);
      if (cumulativeKey && seenCumulative.has(cumulativeKey)) continue;
      let usage = normalizeUsage(p.info.last_token_usage), source = "token_count.last_token_usage";
      if (!usage && cumulative && lastCumulative) {
        const delta = Object.fromEntries(tokenKeys.map(key => [key, cumulative[key] - lastCumulative[key]]));
        if (Object.values(delta).every(n => n >= 0)) { usage = delta; source = "token_count.cumulative_delta"; }
      }
      if (cumulativeKey) { seenCumulative.add(cumulativeKey); lastCumulative = cumulative; }
      if (!usage) { output.diagnostics.push({ file, line, code: "usage_without_per_response_measurement" }); continue; }
      if (!current) start(null, timestamp);
      current.usageRecords.push({ file, line, timestamp, source, responseIds: pendingIds, cumulativeKey, usage });
      pendingUsage = []; pendingIds = [];
    }
    if (item.type === "event_msg" && ["task_complete", "task_interrupted", "turn_aborted"].includes(p.type) && current) {
      current.endedAt = Number.isFinite(timestamp) ? timestamp : typeof p.completed_at === "number" ? p.completed_at * 1000 : time(p.completed_at);
      current.durationMs = p.duration_ms ?? null;
      current.nativeTerminal = p.type;
      finish();
    }
  }
  finish();
  output.usage = addUsage(output.turns.flatMap(turn => turn.usageRecords));
  return output;
}

function turnEnd(turn) {
  return Number.isFinite(time(turn.startedAt)) && Number.isFinite(turn.elapsedMs) ? time(turn.startedAt) + turn.elapsedMs : time(turn.terminal?.endedAt);
}

function historyForTurn(turn) {
  const runId = turn.accepted?.runId ?? turn.terminal?.runId;
  const seen = new Set();
  return (turn.history?.messages ?? []).filter(message => {
    const meta = message.__openclaw ?? {};
    const belongs = meta.runId && runId ? meta.runId === runId
      : time(message.timestamp) >= time(turn.startedAt) && time(message.timestamp) <= turnEnd(turn);
    if (!belongs) return false;
    const id = meta.id ?? message.id ?? message.idempotencyKey ?? meta.idempotencyKey;
    if (id && seen.has(id)) return false;
    if (id) seen.add(id);
    return true;
  });
}

function historyCalls(messages) {
  const seen = new Set(), calls = [];
  for (const message of messages.filter(isAssistant)) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!["toolCall", "tool_use", "function_call", "custom_tool_call"].includes(part.type)) continue;
      const id = part.id ?? part.call_id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      calls.push({ callId: id ?? null, name: part.name, timestamp: message.timestamp, args: part.arguments ?? part.input ?? null });
    }
  }
  return calls;
}

function nativeTurnIds(turn) {
  const ids = new Set([turn.terminal?.terminalReceipt?.turnId].filter(Boolean));
  for (const message of historyForTurn(turn)) {
    const mirror = message.__openclaw?.mirrorIdentity;
    if (typeof mirror === "string") ids.add(mirror.split(":")[0]);
  }
  return ids;
}

function selectAnswer(turn, nativeTurn, messages) {
  const nativeFinal = nativeTurn?.assistantResponses.filter(response => finalPhase(response.phase)).at(-1);
  if (nativeFinal) return { text: nativeFinal.text, source: "native_final", line: nativeFinal.line };
  const candidates = messages.filter(message => isAssistant(message) && textContent(message)
    && !["toolUse", "tool_calls"].includes(message.stopReason));
  const terminalMessage = candidates.filter(message => message.__openclaw?.runTerminal === true || finalPhase(phaseOf(message))).at(-1);
  if (terminalMessage) return { text: textContent(terminalMessage), source: "history_terminal" };
  const receipt = turn.terminal;
  if (typeof receipt?.terminalReply?.text === "string" && (!turn.accepted?.runId || receipt.runId === turn.accepted.runId)) {
    return { text: receipt.terminalReply.text, source: "terminal_reply" };
  }
  const final = candidates.filter(message => phaseOf(message) !== "commentary" && message.openclawStreamFallback !== true).at(-1);
  return final ? { text: textContent(final), source: "history_last_assistant_unlabelled" }
    : { text: "", source: "not_observed" };
}

function assignToolLogs(turns, parsed) {
  const assignments = turns.map(() => ({ method: "timestamp_fallback", calls: [], warnings: [] }));
  const ranges = turns.map((turn, index) => {
    if (turn.toolLogStartLine === undefined && turn.toolLogEndLine === undefined) return null;
    const { toolLogStartLine: start, toolLogEndLine: end } = turn;
    const valid = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= parsed.lineCount;
    assignments[index].method = valid ? "line_range_(start,end]" : "invalid_line_range";
    if (!valid) assignments[index].warnings.push("invalid_line_range_no_time_fallback");
    return { start, end, valid };
  });
  const unassigned = [];
  for (const record of parsed.records) {
    const candidates = turns.flatMap((turn, index) => {
      const range = ranges[index];
      const match = range ? range.valid && record.ordinal > range.start && record.ordinal <= range.end
        : time(record.value.at) >= time(turn.startedAt) && time(record.value.at) <= turnEnd(turn);
      return match ? [index] : [];
    });
    const exact = candidates.filter(index => ranges[index]?.valid);
    const matches = exact.length ? exact : candidates;
    const call = { ...record.value, line: record.line, ordinal: record.ordinal };
    if (matches.length === 1) assignments[matches[0]].calls.push(call);
    else {
      unassigned.push({ ...call, reason: matches.length ? "ambiguous_turn" : "outside_recorded_turns" });
      for (const index of matches) assignments[index].warnings.push(`ambiguous_tool_log:${record.line}`);
    }
  }
  for (const issue of parsed.diagnostics) {
    for (let index = 0; index < ranges.length; index++) {
      const range = ranges[index];
      if (!range || range.valid && issue.ordinal > range.start && issue.ordinal <= range.end) assignments[index].warnings.push(`invalid_tool_log:${issue.line}`);
    }
  }
  return { assignments, unassigned };
}

const action = (call, name) => call.tool === "fixture_action" && call.args?.action === name;
const read = (call, key) => call.tool === "fixture_read" && call.args?.key === key && call.result && !call.result.error;
const reference = call => ({ sample: call.sample, turn: call.turn, line: call.line, tool: call.tool,
  action: call.args?.action, key: call.args?.key });
const evidence = calls => ({ status: calls.length ? "observed" : "not_observed", refs: calls.map(reference) });

function mechanicalEvidence(sample, turns, finalFixture) {
  const calls = turns.flatMap(turn => turn.toolTrace.map(call => ({ ...call, sample: turn.sample, turn: turn.index })))
    .sort((a, b) => a.ordinal - b.ordinal);
  const checks = {};
  const domain = { S1: "dataset_access", S2: "requirements_validation", S3: "knowledge_revision",
    S4: "local_requirements_validation", S5: "progress_continuation" }[sample] ?? "unknown";
  const validationCalls = calls.filter(call => action(call, "validate")).map(call => ({ ...reference(call), domain,
    args: call.args, receipt: call.result, fixtureValidationSource: "sources.validation" }));
  const extraValidationCalls = ["S1", "S3", "S5"].includes(sample) ? validationCalls : [];
  if (sample === "S1") {
    checks.remoteProcedureRead = evidence(calls.filter(call => read(call, "skill/remote-access")));
    const auth = calls.find(call => action(call, "authenticate") && call.result?.status === "authenticated" && call.result.secretExposed === false);
    const listed = auth && calls.find(call => call.ordinal > auth.ordinal && action(call, "dataset_list")
      && call.result?.status === "verified" && typeof call.result.path === "string"
      && Number.isInteger(call.result.files) && call.result.files >= 0 && typeof call.result.proof === "string" && call.result.proof);
    checks.authenticationThenListReceipt = evidence(listed ? [auth, listed] : []);
    checks.listReceipt = listed?.result ?? null;
  }
  if (sample === "S2") {
    const unavailable = calls.find(call => call.turn === 0 && (read(call, "validation") && call.result.ready === false
      || action(call, "validate") && call.result?.status === "needs_input"));
    const validated = calls.find(call => call.turn > 0 && action(call, "validate") && call.result?.status === "verified" && call.result.proof);
    const ids = new Set(calls.flatMap(call => {
      if (read(call, "index")) return [call.result.task?.id].filter(Boolean);
      if (read(call, "task")) return [call.result.id].filter(Boolean);
      if (read(call, "execution/previous")) return [call.result.taskId].filter(Boolean);
      return [];
    }));
    if (finalFixture?.task?.id) ids.add(finalFixture.task.id);
    const taskId = ids.size === 1 ? [...ids][0] : null;
    const checkpoint = validated && calls.find(call => call.ordinal > validated.ordinal && action(call, "checkpoint")
      && taskId && call.args.taskId === taskId && call.result?.taskId === taskId && call.result.status === "recorded");
    checks.initialValidationUnavailable = evidence(unavailable ? [unavailable] : []);
    checks.laterValidationThenSameTaskCheckpoint = evidence(checkpoint ? [validated, checkpoint] : []);
    checks.initialUnavailableThenValidatedCheckpoint = evidence(unavailable && checkpoint && unavailable.ordinal < validated.ordinal ? [unavailable, validated, checkpoint] : []);
    checks.observedTaskIds = [...ids];
    checks.validationReceipt = validated?.result ?? null;
  }
  if (sample === "S3") {
    const old = calls.find(call => read(call, "knowledge/old"));
    const fresh = calls.find(call => read(call, "evidence/new"));
    const proposal = old && fresh && calls.find(call => call.ordinal > old.ordinal && call.ordinal > fresh.ordinal
      && action(call, "knowledge_propose") && call.result?.status === "proposal_recorded");
    checks.oldAndNewReadBeforeProposal = evidence(proposal ? [old, fresh, proposal] : []);
    checks.retainedEvidencePendingReview = evidence(proposal?.result.evidenceRetained === true && proposal.result.review === "pending" ? [proposal] : []);
  }
  if (sample === "S4") {
    checks.localScopeRead = evidence(calls.filter(call => read(call, "execution/scope")));
    checks.artifactRead = evidence(calls.filter(call => read(call, "artifact/requirements-draft.md")));
    const partial = calls.find(call => action(call, "validate") && call.result?.status === "verified"
      && Number.isFinite(call.result.covered) && Number.isFinite(call.result.requirements)
      && call.result.covered < call.result.requirements && Array.isArray(call.result.missing) && call.result.missing.length > 0);
    checks.partialCoverageReceipt = evidence(partial ? [partial] : []);
    checks.coverage = partial ? { covered: partial.result.covered, requirements: partial.result.requirements, missing: partial.result.missing, proof: partial.result.proof } : null;
    checks.finalFixtureTaskStatus = finalFixture?.task?.status ?? null;
    checks.finalFixtureTaskNotClosed = { status: finalFixture?.task?.status == null ? "unknown"
      : ["running", "pending", "review", "blocked", "waiting"].includes(finalFixture.task.status) ? "observed" : "not_observed",
      evidence: "final fixture task status only; answer and checkpoint semantics require human review" };
  }
  if (sample === "S5") {
    checks.source = { sample: "S2", turn: 2 };
    checks.continuationTurnRecorded = { status: turns.length ? "observed" : "not_observed" };
    checks.nativeThreadReused = { status: turns[0]?.nativeThreadReused === true ? "observed"
      : turns[0]?.nativeThreadReused === false ? "not_observed" : "unknown" };
  }
  return { sample, qualityConclusion: "manual_review_required", automaticPass: null, mechanicalEvidence: checks,
    mechanicalSignals: { domain, validationCalls, extraValidationCalls,
      interpretation: extraValidationCalls.length ? "Generic validate used outside the requirements-validation scenarios. Review tool-domain ambiguity and the answer's claimed blockage separately from prompt policy; root cause is not inferred." : null },
    usage: turns.some(turn => turn.usageRecords.length) ? addUsage(turns.flatMap(turn => turn.usageRecords)) : null,
    fixtureExecutionCount: turns.reduce((sum, turn) => sum + turn.fixtureExecutionCount, 0),
    models: [...new Set(turns.map(turn => turn.model).filter(Boolean))],
    nativeThreadIds: [...new Set(turns.map(turn => turn.nativeThreadId).filter(Boolean))],
    turnRefs: turns.map(turn => ({ sample: turn.sample, index: turn.index })),
    reviewRequired: ["Check whether the answer is supported by the cited fixture receipts.",
      "Do not equate native/run termination or fixture status with business acceptance.",
      "Observed mechanical evidence is not a quality pass; absence may reflect incomplete recording."] };
}

export function parseRateLimitEvidence(text, turns = []) {
  const evidence = [];
  const pattern = /\b(?:status(?:\s*code)?[:=\s]+|HTTP(?:\/[\d.]+)?\s+)429\b|\b429\s+Too Many Requests\b|\bToo Many Requests\b/i;
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!pattern.test(line)) continue;
    const timestamp = time(line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)?.[0]);
    const runIds = turns.map(turn => turn.accepted?.runId ?? turn.terminal?.runId).filter(id => id && line.includes(id));
    // Retain provenance and the observed status, never copy arbitrary log text.
    evidence.push({ source: "gateway.log", line: index + 1, timestamp: Number.isFinite(timestamp) ? timestamp : null,
      status: 429, marker: /Too Many Requests/i.test(line) ? "Too Many Requests" : "status 429", runIds });
  }
  return evidence;
}

function responseTiming(nativeTurn) {
  let previous = nativeTurn?.startedAt;
  const intervals = (nativeTurn?.usageRecords ?? []).map(record => {
    const gap = Number.isFinite(previous) && Number.isFinite(record.timestamp) && record.timestamp >= previous ? record.timestamp - previous : null;
    const interval = { file: record.file, line: record.line, timestamp: record.timestamp, intervalMs: gap,
      outputTokens: record.usage.output, inputTokens: record.usage.input, cachedInputTokens: record.usage.cachedInput };
    previous = record.timestamp;
    return interval;
  });
  const gaps = intervals.map(item => item.intervalMs).filter(Number.isFinite);
  return { responseIntervals: intervals, maxResponseIntervalMs: gaps.length ? Math.max(...gaps) : null,
    timeToFirstUsageMs: intervals[0]?.intervalMs ?? null,
    outputTokens: nativeTurn?.usage.responses ? nativeTurn.usage.output : null,
    interpretation: "Intervals between native usage events (first from native turn start); include model, tools, retries and host delays. Not a prompt-causality verdict." };
}

export function summarizeExperiment({ result = {}, toolLogText = "", gatewayLogText = "", nativeRollouts = [], fixtureFinals = {}, finalized = true }) {
  const records = result.turns ?? [];
  const diagnostics = [];
  const hashes = new Set();
  const native = nativeRollouts.flatMap(({ text, file }) => {
    const hash = digest(text);
    if (hashes.has(hash)) { diagnostics.push({ file, code: "duplicate_rollout_ignored" }); return []; }
    hashes.add(hash);
    return [parseNativeRollout(text, file)];
  });
  diagnostics.push(...native.flatMap(session => session.diagnostics));
  const log = parseJsonl(toolLogText, "fixture-tools.jsonl");
  diagnostics.push(...log.diagnostics);
  const tools = assignToolLogs(records, log);
  const rateLimitEvidence = parseRateLimitEvidence(gatewayLogText, records);
  const identifiers = records.map(nativeTurnIds);
  const matches = records.map(() => []);
  const unassignedNativeTurns = [];
  for (const session of native) {
    for (const turn of session.turns) {
      const exact = records.flatMap((_, index) => turn.turnId && identifiers[index].has(turn.turnId) ? [index] : []);
      const candidates = exact.length ? exact : records.flatMap((record, index) => !identifiers[index].size
        && turn.startedAt >= time(record.startedAt) && turn.startedAt <= turnEnd(record) ? [index] : []);
      if (candidates.length === 1) matches[candidates[0]].push({ session, turn, method: exact.length ? "native_turn_id" : "timestamp_fallback" });
      else unassignedNativeTurns.push({ file: session.file, threadId: session.threadId, turnId: turn.turnId,
        reason: candidates.length ? "ambiguous_turn" : "no_matching_runner_turn", usage: turn.usage });
    }
  }
  const previousBySample = new Map();
  const turns = records.map((record, index) => {
    const matched = matches[index].length === 1 ? matches[index][0] : null;
    const messages = historyForTurn(record);
    const answer = selectAnswer(record, matched?.turn, messages);
    const historyToolCalls = historyCalls(messages);
    const previous = previousBySample.get(record.sample);
    const threadId = matched?.session.threadId ?? null;
    const sessionKey = record.sessionKey ?? record.accepted?.sessionKey ?? record.history?.sessionKey ?? null;
    const warnings = [...tools.assignments[index].warnings];
    if (!matched) warnings.push(matches[index].length ? "multiple_native_turns_not_attributed" : "native_turn_not_attributed");
    else if (!matched.turn.usageRecords.length) warnings.push("no_native_response_usage_observed");
    if (record.history?.hasMore) warnings.push("history_truncated");
    const developerMessages = matched?.turn.developerMessages ?? [];
    const summary = {
      sample: record.sample, index: record.index, role: record.role, sessionKey,
      startedAt: record.startedAt, elapsedMs: record.elapsedMs,
      terminal: record.terminal ?? null, businessConclusion: "manual_review_required",
      model: matched?.turn.model ?? record.terminal?.terminalReceipt?.effective?.responseModel
        ?? record.terminal?.terminalReceipt?.effective?.model ?? null,
      configuredModel: result.model ?? null,
      nativeThreadId: threadId, nativeTurnId: matched?.turn.turnId ?? null,
      nativeAttribution: matched?.method ?? "unknown",
      sessionReused: previous?.sessionKey && sessionKey ? previous.sessionKey.toLowerCase() === sessionKey.toLowerCase() : null,
      nativeThreadReused: previous?.nativeThreadId && threadId ? previous.nativeThreadId === threadId : null,
      exposedDynamicToolNames: matched?.session.dynamicToolNames ?? null,
      exposedDynamicToolCount: matched?.session.dynamicToolNames.length ?? null,
      developerPrompt: { emittedMessages: developerMessages.length,
        emittedChars: developerMessages.reduce((sum, message) => sum + message.chars, 0),
        lastObservedMessageChars: matched?.turn.latestDeveloperMessage?.chars ?? null,
        lastObservedMessageSha256: matched?.turn.latestDeveloperMessage?.sha256 ?? null,
        measurements: developerMessages, unit: "characters_not_tokens", includesNativeBaseInstructions: false },
      answer, finalText: answer.text,
      assistantResponses: matched?.turn.assistantResponses ?? messages.filter(isAssistant).filter(message => textContent(message))
        .map(message => ({ phase: phaseOf(message) ?? "unspecified", text: textContent(message), source: "history" })),
      usage: matched?.turn.usage.responses ? matched.turn.usage : null,
      usageRecords: matched?.turn.usageRecords ?? [],
      unmeteredResponseSegments: matched?.turn.unmeteredResponseSegments ?? null,
      performance: { ...responseTiming(matched?.turn), runnerElapsedMs: record.elapsedMs,
        terminalRateLimitObserved: /\b429\b|Too Many Requests/i.test(record.terminal?.error ?? ""),
        rateLimitEvidence: rateLimitEvidence.filter(item => item.runIds.length
          ? item.runIds.includes(record.accepted?.runId ?? record.terminal?.runId)
          : item.timestamp !== null && item.timestamp >= time(record.startedAt) && item.timestamp <= turnEnd(record)) },
      toolTrace: tools.assignments[index].calls,
      toolAttribution: tools.assignments[index].method,
      fixtureExecutionCount: tools.assignments[index].calls.length,
      historyToolCalls, historyToolCallCount: historyToolCalls.length,
      nativeToolCalls: matched?.turn.toolCalls ?? [],
      nativeToolCallCount: matched?.turn.toolCalls.length ?? null,
      warnings
    };
    previousBySample.set(record.sample, summary);
    return summary;
  });
  const seenUsage = new Set(), allUsage = [];
  for (const session of native) for (const turn of session.turns) for (const record of turn.usageRecords) {
    const key = JSON.stringify([session.threadId ?? session.file, turn.turnId,
      record.cumulativeKey ?? (record.responseIds.length ? record.responseIds : [record.file, record.line])]);
    if (seenUsage.has(key)) { diagnostics.push({ file: record.file, line: record.line, code: "duplicate_usage_ignored" }); continue; }
    seenUsage.add(key);
    allUsage.push(record);
  }
  const samples = [...new Set(turns.map(turn => turn.sample))].map(sample =>
    mechanicalEvidence(sample, turns.filter(turn => turn.sample === sample), fixtureFinals[sample]));
  if (turns.some(turn => turn.sample === "S2")) samples.push(mechanicalEvidence("S5", turns.filter(turn => turn.sample === "S2" && turn.index === 2)));
  return {
    schemaVersion: 2, group: result.group ?? null, protocolVersion: result.protocolVersion ?? null,
    toolScope: result.toolScope ?? (result.protocolVersion === "matched-workspace-v2" ? "broad-v1" : null),
    fixtureSourceSha256: result.fixtureSourceSha256 ?? null,
    workspaceFiles: result.workspaceFiles ?? [], model: result.model ?? null, thinking: result.thinking ?? null,
    error: result.error ?? null, finalized, productionConfigUnchanged: result.productionConfigUnchanged ?? null,
    credentialStateRemoved: result.credentialStateRemoved ?? null,
    fixtureEvidenceOnly: true, qualityConclusion: "manual_review_required",
    interpretationLimitations: ["fixture_action validate reads sources.validation without a domain selector. A needs_input receipt in S1/S3 is not proof that dataset access or knowledge revision requires an approved requirements-validation source.",
      "Reading old/new and recording knowledge_propose establishes an execution chain only, not correct reasoning, justified blockage or overall quality. Tool ambiguity and prompt-policy effects require separate human review."],
    accounting: {
      usage: "Sum native per-response last_token_usage (including tool-only responses), not the last turn or cumulative snapshots. Cached input is already in input; total = input + output. History usage is not added.",
      tools: "Fixture executions, history call mirrors and native wrapper calls are separate views; do not add their counts.",
      developerPrompt: "Observed developer-message characters, not billing tokens or a guarantee of the complete effective native prompt.",
      s5: "S2 index 2 (third turn); an alias, never an extra usage charge."
    },
    totals: { nativeUsage: allUsage.length ? addUsage(allUsage) : null,
      assignedNativeUsage: turns.some(turn => turn.usageRecords.length) ? addUsage(turns.flatMap(turn => turn.usageRecords)) : null,
      fixtureExecutionCount: turns.reduce((sum, turn) => sum + turn.fixtureExecutionCount, 0),
      observedModels: [...new Set(native.flatMap(session => session.models))],
      nativeThreadCount: new Set(native.map(session => session.threadId).filter(Boolean)).size },
    turns, samples, native, rateLimitEvidence, unassignedNativeTurns, unassignedToolLogs: tools.unassigned, diagnostics
  };
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }

function nativeFiles(directory) {
  if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isSymbolicLink() ? []
    : item.isDirectory() ? nativeFiles(path.join(directory, item.name))
      : item.isFile() && item.name.endsWith(".jsonl") ? [path.join(directory, item.name)] : []);
}

// Read only explicitly named experiment artifacts; never traverse state/auth or workspace.
export function summarizeDirectory(directory) {
  const root = fs.realpathSync.native(path.resolve(directory));
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runtime/experiments/runtime-boundary");
  const relative = path.relative(base, root);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Expected experiment root");
  const resultPath = path.join(root, "result.json");
  const finalized = fs.existsSync(resultPath);
  const result = finalized ? readJson(resultPath) : {
    error: "Runner finalization incomplete; raw turns are evidence only, not a scored group",
    turns: fs.readdirSync(root).filter(name => /^S\d+-\d+\.json$/.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map(name => readJson(path.join(root, name)))
  };
  const fixtureFinals = {};
  for (const sample of new Set((result.turns ?? []).map(turn => turn.sample))) {
    if (!/^S\d+$/.test(sample)) continue;
    const file = path.join(root, `${sample}-fixture-final.json`);
    if (fs.existsSync(file)) fixtureFinals[sample] = readJson(file);
  }
  const toolFile = path.join(root, "fixture-tools.jsonl");
  const gatewayLog = path.join(root, "gateway.log");
  return summarizeExperiment({ result, finalized, fixtureFinals,
    toolLogText: fs.existsSync(toolFile) ? fs.readFileSync(toolFile, "utf8") : "",
    gatewayLogText: fs.existsSync(gatewayLog) ? fs.readFileSync(gatewayLog, "utf8") : "",
    nativeRollouts: nativeFiles(path.join(root, "native-sessions")).sort().map(file => ({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8") })) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), stdoutOnly = args.includes("--stdout");
  const positional = args.filter(arg => arg !== "--stdout");
  if (positional.length !== 1) throw new Error("Usage: node summarize.mjs <experiment-root> [--stdout]");
  const summary = summarizeDirectory(positional[0]);
  if (!stdoutOnly) {
    if (!summary.finalized) throw new Error("Runner not finalized; use --stdout for read-only inspection");
    fs.writeFileSync(path.join(path.resolve(positional[0]), "summary.json"), JSON.stringify(summary, null, 2));
  }
  console.log(JSON.stringify(summary, null, 2));
}
