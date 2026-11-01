import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonl, parseNativeRollout, parseRateLimitEvidence, summarizeExperiment } from "../scripts/experiments/runtime-boundary/summarize.mjs";

const jsonl = items => items.map(item => JSON.stringify(item)).join("\n");
const event = (type, payload, timestamp = 1100) => ({ type, timestamp, payload });
const message = (role, text, phase = "final_answer", extra = {}) => ({ type: "message", role,
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], phase, ...extra });
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 2, total_tokens: input + output });
const count = (last, total = last, timestamp = 1150) => event("event_msg", { type: "token_count", info: { last_token_usage: last, total_token_usage: total } }, timestamp);
const turn = (sample, index = 0, extra = {}) => ({ sample, index, sessionKey: `session-${sample}`, startedAt: 1000 + index * 1000, elapsedMs: 900,
  accepted: { runId: `run-${sample}-${index}` }, terminal: { runId: `run-${sample}-${index}`, status: "ok", terminalReceipt: { turnId: `${sample}-${index}` } },
  history: { messages: [] }, ...extra });
const log = (tool, args, result, at = 1200) => ({ at, tool, args, result });
const read = (key, result, at) => log("fixture_read", { key }, result, at);
const action = (name, result, args = {}, at) => log("fixture_action", { action: name, ...args }, result, at);
const rollout = (turns, thread = "thread-1") => jsonl([
  event("session_meta", { id: thread, base_instructions: { text: "base" }, dynamic_tools: [{ name: "fixture_read" }, { name: "fixture_action" }] }),
  ...turns.flatMap(({ id, start = 1100, content = "answer", extra = [] }) => [
    event("event_msg", { type: "task_started", turn_id: id }, start),
    event("response_item", message("developer", "developer rules"), start + 1),
    event("turn_context", { turn_id: id, model: "actual-model" }, start + 2),
    ...extra,
    event("response_item", message("assistant", content, "final_answer", { id: `answer-${id}` }), start + 20),
    count(usage(100, 60, 10), usage(100 + start, 60, 10 + start), start + 30),
    event("event_msg", { type: "task_complete", turn_id: id }, start + 40)
  ])
]);
const summarize = (turns, logs = [], extra = {}) => summarizeExperiment({ result: { group: "B", protocolVersion: "matched-workspace-v2", model: "configured-model", turns }, toolLogText: jsonl(logs), ...extra });

test("tool scope and cleanup proof remain distinct from prompt group and business quality", () => {
  assert.equal(summarize([]).toolScope, "broad-v1");
  const explicit = summarizeExperiment({ result: {
    group: "B", turns: [], toolScope: "explicit-requirements-v1",
    credentialStateRemoved: true, fixtureSourceSha256: "fixture-hash",
  } });
  assert.equal(explicit.toolScope, "explicit-requirements-v1");
  assert.equal(explicit.credentialStateRemoved, true);
  assert.equal(explicit.fixtureSourceSha256, "fixture-hash");
  assert.equal(explicit.qualityConclusion, "manual_review_required");
  assert.equal(summarizeExperiment({ result: { turns: [] } }).toolScope, null);
});

test("native usage sums every model response including tool-only responses, not cached input twice", () => {
  const last1 = usage(100, 40, 10), last2 = usage(120, 80, 20);
  const total = usage(220, 120, 30);
  const native = parseNativeRollout(jsonl([
    event("session_meta", { id: "thread" }), event("event_msg", { type: "task_started", turn_id: "S1-0" }),
    event("turn_context", { turn_id: "S1-0", model: "actual-model" }),
    event("response_item", { type: "custom_tool_call", id: "tool-1", call_id: "call-1", name: "exec" }),
    event("response_item", { type: "custom_tool_call_output", output: "not an answer", call_id: "call-1" }),
    count(last1), count(last1),
    event("response_item", message("assistant", "real final", "final_answer", { id: "a1", usage: last2 })),
    count(last2, total), count(last2, total),
    event("event_msg", { type: "task_complete", turn_id: "S1-0" })
  ]));
  assert.equal(native.usage.responses, 2);
  assert.equal(native.usage.input, 220);
  assert.equal(native.usage.cachedInput, 120);
  assert.equal(native.usage.output, 30);
  assert.equal(native.usage.reasoningOutput, 4);
  assert.equal(native.usage.total, 250);
  assert.equal(native.turns[0].toolCalls.length, 1);
  assert.deepEqual(native.turns[0].assistantResponses.map(r => r.text), ["real final"]);
  assert.equal(native.turns[0].unmeteredResponseSegments, 0);
});

test("native cumulative-only data is a delta after a known baseline, never an invented first response", () => {
  const native = parseNativeRollout(jsonl([
    event("turn_context", { turn_id: "one" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: usage(100, 20, 10) } }),
    event("event_msg", { type: "token_count", info: { total_token_usage: usage(220, 80, 30) } })
  ]));
  assert.equal(native.usage.input, 120);
  assert.equal(native.usage.total, 140);
  assert.equal(native.diagnostics[0].code, "usage_without_per_response_measurement");
});

test("answers exclude user/tool/developer/reasoning content and prefer an explicit native final", () => {
  const nativeText = rollout([{ id: "S1-0", content: "actual answer", extra: [
    event("response_item", message("user", "USER says PASS")),
    event("response_item", message("tool", "TOOL says PASS")),
    event("response_item", message("assistant", "private reasoning", "analysis")),
    event("response_item", { type: "function_call_output", role: "assistant", content: "TOOL_OUTPUT" }),
    event("response_item", message("assistant", "working", "commentary", { id: "commentary" }))
  ] }]);
  const record = turn("S1", 0, { history: { messages: [
    { role: "user", timestamp: 1700, content: "false answer" },
    { role: "toolResult", timestamp: 1750, content: "false answer" }
  ] } });
  const result = summarize([record], [], { nativeRollouts: [{ file: "native.jsonl", text: nativeText }] });
  assert.equal(result.turns[0].finalText, "actual answer");
  assert.equal(result.turns[0].model, "actual-model");
  assert.equal(result.turns[0].exposedDynamicToolCount, 2);
  assert.equal(result.turns[0].developerPrompt.emittedChars, "developer rules".length);
  assert.doesNotMatch(JSON.stringify(result.native), /USER says|TOOL says|private reasoning|TOOL_OUTPUT/);
});

test("history is scoped by run identity before timestamps and tool call mirrors are counted once", () => {
  const meta = { runId: "run-S2-1", id: "call-message" };
  const call = { role: "assistant", timestamp: 2100, __openclaw: meta, stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "fixture_read", arguments: { key: "task" } }] };
  const record = turn("S2", 1, { history: { messages: [
    { role: "assistant", timestamp: 2500, __openclaw: { runId: "previous" }, content: "STALE" },
    call, call,
    { role: "assistant", timestamp: 2300, __openclaw: { runId: "run-S2-1", mirrorIdentity: "turn:commentary:message" }, content: "commentary" },
    { role: "assistant", timestamp: 2400, __openclaw: { runId: "run-S2-1", runTerminal: true }, content: "current answer", usage: { input: 999999 } },
    { role: "toolResult", timestamp: 2700, content: "not final" },
    { role: "user", timestamp: 2800, content: "not final either" }
  ] } });
  const result = summarize([record]);
  assert.equal(result.turns[0].finalText, "current answer");
  assert.equal(result.turns[0].historyToolCallCount, 1);
  assert.equal(result.turns[0].usage, null);
  assert.equal(result.totals.nativeUsage, null);
  assert.doesNotMatch(JSON.stringify(result.turns[0].assistantResponses), /STALE|not final/);
});

test("line offsets are nonempty-line counts with (start,end] semantics and exclude preflight", () => {
  const logs = [read("index", { preflight: true }), read("task", { id: "card" }), action("validate", { status: "verified" })];
  const result = summarize([turn("S1", 0, { toolLogStartLine: 1, toolLogEndLine: 2 }),
    turn("S2", 0, { toolLogStartLine: 2, toolLogEndLine: 3 })], [], { toolLogText: logs.map(JSON.stringify).join("\n\n") });
  assert.equal(result.turns[0].toolTrace[0].args.key, "task");
  assert.equal(result.turns[0].toolTrace[0].line, 3);
  assert.equal(result.turns[1].toolTrace[0].args.action, "validate");
  assert.equal(result.unassignedToolLogs.length, 1);
  assert.equal(result.totals.fixtureExecutionCount, 2);
});

test("old timestamp records are supported; ambiguous overlap is not silently assigned twice", () => {
  const result = summarize([turn("S1"), turn("S2", 0, { startedAt: 1800 })], [
    read("early", {}, 1200), read("overlap", {}, 1850), read("later", {}, 2000)
  ]);
  assert.equal(result.turns[0].toolTrace.length, 1);
  assert.equal(result.turns[1].toolTrace.length, 1);
  assert.equal(result.turns[0].toolAttribution, "timestamp_fallback");
  assert.equal(result.unassignedToolLogs[0].reason, "ambiguous_turn");
});

test("malformed JSONL retains boundary ordinals; invalid declared ranges do not fall back", () => {
  const text = `${JSON.stringify(read("first", {}))}\n\nnot-json\n${JSON.stringify(read("third", {}))}`;
  const parsed = parseJsonl(text);
  assert.equal(parsed.lineCount, 3);
  assert.equal(parsed.records[1].ordinal, 3);
  assert.equal(parsed.diagnostics[0].line, 3);
  const result = summarize([turn("S1", 0, { toolLogStartLine: 1, toolLogEndLine: 3 })], [], { toolLogText: text });
  assert.equal(result.turns[0].toolTrace.length, 1);
  assert.match(result.turns[0].warnings.join(), /invalid_tool_log/);
  const invalid = summarize([turn("S1", 0, { toolLogStartLine: 0, toolLogEndLine: 99 })], [read("index", {})]);
  assert.equal(invalid.turns[0].fixtureExecutionCount, 0);
  assert.equal(invalid.turns[0].toolAttribution, "invalid_line_range");
});

test("native turn IDs override timing, reuse is measured, S5 is S2 third turn without double charging", () => {
  const turns = [turn("S2"), turn("S2", 1), turn("S2", 2)];
  const text = rollout([{ id: "S2-0", start: 8100 }, { id: "S2-1", start: 9100 }, { id: "S2-2", start: 10100 }]);
  const result = summarize(turns, [], { nativeRollouts: [{ file: "rollout", text }, { file: "copy", text }] });
  assert.deepEqual(result.turns.map(t => t.nativeThreadReused), [null, true, true]);
  assert.equal(result.totals.nativeUsage.responses, 3);
  assert.equal(result.totals.nativeUsage.input, 300);
  assert.equal(result.samples.find(s => s.sample === "S5").mechanicalEvidence.nativeThreadReused.status, "observed");
  assert.deepEqual(result.samples.find(s => s.sample === "S5").turnRefs, [{ sample: "S2", index: 2 }]);
});

test("S1 requires successful authentication before the verified list receipt, never answer keywords", () => {
  const logs = [read("skill/remote-access", "procedure"),
    action("authenticate", { status: "authenticated", secretExposed: false }),
    action("dataset_list", { status: "verified", path: "/fixture", files: 12, proof: "list-001" })];
  const positive = summarize([turn("S1")], logs).samples[0];
  assert.equal(positive.mechanicalEvidence.authenticationThenListReceipt.status, "observed");
  assert.equal(positive.automaticPass, null);
  assert.equal(positive.qualityConclusion, "manual_review_required");
  const reversed = summarize([turn("S1")], [...logs].reverse()).samples[0];
  assert.equal(reversed.mechanicalEvidence.authenticationThenListReceipt.status, "not_observed");
  const claimed = summarize([turn("S1", 0, { history: { messages: [{ role: "assistant", timestamp: 1300, content: "authenticated verified all passed" }] } })]).samples[0];
  assert.equal(claimed.mechanicalEvidence.authenticationThenListReceipt.status, "not_observed");
});

test("S2 preserves initial missing validation, then validates and checkpoints the same card", () => {
  const records = [turn("S2", 0, { toolLogStartLine: 0, toolLogEndLine: 2 }),
    turn("S2", 1, { toolLogStartLine: 2, toolLogEndLine: 4 })];
  const logs = [read("execution/previous", { status: "succeeded", taskId: "card-1" }),
    read("validation", { ready: false }), action("validate", { status: "verified", proof: "v-2", covered: 6, requirements: 6 }),
    action("checkpoint", { status: "recorded", taskId: "card-1" }, { taskId: "card-1" })];
  const check = summarize(records, logs).samples[0].mechanicalEvidence;
  assert.equal(check.initialValidationUnavailable.status, "observed");
  assert.equal(check.initialUnavailableThenValidatedCheckpoint.status, "observed");
  logs[3].args.taskId = "different-card";
  assert.equal(summarize(records, logs).samples[0].mechanicalEvidence.laterValidationThenSameTaskCheckpoint.status, "not_observed");
});

test("S3 requires both actual source reads before a recorded knowledge proposal", () => {
  const logs = [read("knowledge/old", { id: "old" }), read("evidence/new", { id: "new" }),
    action("knowledge_propose", { status: "proposal_recorded", evidenceRetained: true, review: "pending" })];
  const check = summarize([turn("S3")], logs).samples[0].mechanicalEvidence;
  assert.equal(check.oldAndNewReadBeforeProposal.status, "observed");
  assert.equal(check.retainedEvidencePendingReview.status, "observed");
  assert.equal(summarize([turn("S3")], [logs[2], logs[0], logs[1]]).samples[0].mechanicalEvidence.oldAndNewReadBeforeProposal.status, "not_observed");
});

test("S4 reports 5/6 and R6 as partial evidence; run success cannot close the business task", () => {
  const logs = [read("execution/scope", { taskId: "card-1" }), read("artifact/requirements-draft.md", "fixture draft"),
    action("validate", { status: "verified", covered: 5, requirements: 6, missing: ["R6 actionable failure"], proof: "v-2" })];
  const result = summarize([turn("S4")], logs, { fixtureFinals: { S4: { task: { id: "card-1", status: "running" } } } });
  const check = result.samples[0].mechanicalEvidence;
  assert.deepEqual(check.coverage, { covered: 5, requirements: 6, missing: ["R6 actionable failure"], proof: "v-2" });
  assert.equal(check.partialCoverageReceipt.status, "observed");
  assert.equal(check.finalFixtureTaskNotClosed.status, "observed");
  assert.equal(result.turns[0].terminal.status, "ok");
  assert.equal(result.turns[0].businessConclusion, "manual_review_required");
  assert.equal(summarize([turn("S4")], logs).samples[0].mechanicalEvidence.finalFixtureTaskNotClosed.status, "unknown");
});

test("incomplete/error runs and unmatched native activity remain explicit, never auto-pass", () => {
  const result = summarize([turn("S1", 0, { terminal: { status: "error", error: "synthetic 429" } })], [], {
    finalized: false, nativeRollouts: [{ file: "unmatched", text: rollout([{ id: "other", start: 10000 }]) }]
  });
  assert.equal(result.finalized, false);
  assert.equal(result.unassignedNativeTurns.length, 1);
  assert.equal(result.turns[0].usage, null);
  assert.equal(result.totals.nativeUsage.input, 100);
  assert.equal(result.turns[0].finalText, "");
  assert.equal(result.qualityConclusion, "manual_review_required");
});

test("native assistant usage without token_count remains per response and input includes cached", () => {
  const native = parseNativeRollout(jsonl([
    event("turn_context", { turn_id: "one" }),
    event("response_item", message("assistant", "one", "commentary", { id: "one", usage: usage(100, 80, 10) })),
    event("response_item", message("assistant", "two", "final_answer", { id: "two", usage: usage(120, 90, 20) }))
  ]));
  assert.equal(native.usage.responses, 2);
  assert.equal(native.usage.total, 250);
  assert.equal(native.usage.cachedInput, 170);
});

test("a precise line range takes precedence over an overlapping legacy timestamp window", () => {
  const result = summarize([turn("S1"), turn("S2", 0, { toolLogStartLine: 0, toolLogEndLine: 1 })], [read("task", {})]);
  assert.equal(result.turns[0].fixtureExecutionCount, 0);
  assert.equal(result.turns[1].fixtureExecutionCount, 1);
  assert.equal(result.unassignedToolLogs.length, 0);
});

test("valid JSON scalars and null are malformed records, not executable parsing input", () => {
  const parsed = parseJsonl('null\n42\n[]\n{"type":"session_meta","payload":{"id":"ok"}}');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].ordinal, 4);
  assert.equal(parseNativeRollout('null\n42\n[]').diagnostics.length, 3);
});

test("a near-twenty-minute successful turn remains ok and exposes response gaps and output tokens", () => {
  const text = jsonl([
    event("session_meta", { id: "thread" }), event("event_msg", { type: "task_started", turn_id: "S2-0" }, 1000),
    event("turn_context", { turn_id: "S2-0", model: "actual" }, 1001),
    event("response_item", { type: "function_call", name: "fixture_read", call_id: "one" }, 2000),
    count(usage(100, 50, 10), usage(100, 50, 10), 2000),
    event("response_item", message("assistant", "done", "final_answer", { id: "final" }), 1187000),
    count(usage(110, 60, 1000), usage(210, 110, 1010), 1187001),
    event("event_msg", { type: "task_complete", turn_id: "S2-0" }, 1187002)
  ]);
  const summary = summarize([turn("S2", 0, { elapsedMs: 1186376 })], [], { nativeRollouts: [{ file: "slow", text }] });
  const result = summary.turns[0];
  assert.equal(result.terminal.status, "ok");
  assert.equal(result.performance.maxResponseIntervalMs, 1185001);
  assert.equal(result.performance.outputTokens, 1010);
  assert.equal(result.performance.rateLimitEvidence.length, 0);
  assert.equal(result.businessConclusion, "manual_review_required");
});

test("429 evidence retains line/status, not secret-bearing log prose; run ID takes precedence", () => {
  const logs = '2026-10-20T01:00:00.000Z run-S1-0 last status: 429 Too Many Requests SYNTHETIC_SECRET\noutput_tokens=429\nstatusCode:429';
  const parsed = parseRateLimitEvidence(logs, [turn("S1")]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(item => item.line), [1, 3]);
  assert.doesNotMatch(JSON.stringify(parsed), /SYNTHETIC_SECRET/);
  const summary = summarize([turn("S1"), turn("S2")], [], { gatewayLogText: logs });
  assert.equal(summary.turns[0].performance.rateLimitEvidence.length, 1);
  assert.equal(summary.turns[1].performance.rateLimitEvidence.length, 0);
});

test("native Unix-second started_at never contaminates millisecond timing or error-turn attribution", () => {
  const startedAt = 1792463749000;
  const text = jsonl([
    event("session_meta", { id: "thread" }),
    event("event_msg", { type: "task_started", turn_id: "failed", started_at: 1792463749 }, "2026-10-20T02:35:49.334Z"),
    event("turn_context", { turn_id: "failed", model: "actual" }, startedAt + 400),
    event("event_msg", { type: "task_complete", turn_id: "failed", completed_at: 1792463750 }, startedAt + 1000)
  ]);
  const result = summarize([turn("S2", 2, { startedAt, elapsedMs: 2000,
    terminal: { status: "error", error: "429 Too Many Requests" } })], [], { nativeRollouts: [{ file: "seconds", text }] });
  assert.equal(result.native[0].turns[0].startedAt, startedAt + 334);
  assert.equal(result.turns[0].nativeAttribution, "timestamp_fallback");
  assert.equal(result.turns[0].nativeThreadId, "thread");
  assert.equal(result.turns[0].usage, null);
  assert.equal(result.turns[0].performance.maxResponseIntervalMs, null);
  assert.equal(result.turns[0].terminal.status, "error");
});

test("S1/S3 extra generic validation remains visible despite an observed evidence/proposal chain", () => {
  const logs = [read("knowledge/old", { id: "old" }), read("evidence/new", { id: "new" }),
    action("validate", { status: "needs_input", missing: "approved validation source", proof: "validation-001" }),
    action("knowledge_propose", { status: "proposal_recorded", evidenceRetained: true, review: "pending" })];
  const summary = summarize([turn("S3")], logs);
  const result = summary.samples[0];
  assert.equal(result.mechanicalEvidence.oldAndNewReadBeforeProposal.status, "observed");
  assert.equal(result.mechanicalSignals.domain, "knowledge_revision");
  assert.equal(result.mechanicalSignals.extraValidationCalls.length, 1);
  assert.equal(result.mechanicalSignals.extraValidationCalls[0].receipt.missing, "approved validation source");
  assert.equal(result.qualityConclusion, "manual_review_required");
  assert.equal(result.automaticPass, null);
  const dataset = summarize([turn("S1")], [logs[2]]).samples[0];
  assert.equal(dataset.mechanicalSignals.domain, "dataset_access");
  assert.equal(dataset.mechanicalSignals.extraValidationCalls.length, 1);
  const requirements = summarize([turn("S2")], [logs[2]]).samples[0];
  assert.equal(requirements.mechanicalSignals.validationCalls.length, 1);
  assert.equal(requirements.mechanicalSignals.extraValidationCalls.length, 0);
});
