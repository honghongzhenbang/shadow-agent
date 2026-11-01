import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db.mjs";
import { mainConversationPage, taskConversationPage } from "../src/pet-conversations.mjs";
import { mergeTaskConversationPage } from "../src/task-progress-presentation.mjs";
import { addReview, reviewMetadata } from "./task-progress-fixture.mjs";
import { recordAgentOperation, resolveTaskOwnerSession } from "../src/agent-operations.mjs";
import { DIRECT_INPUT_SESSION_KEY, enqueueDirectInputRequest } from "../src/direct-input.mjs";
import { emitContextChange } from "../src/context-graph.mjs";
import { nextAttentionSession, routePendingContextChanges } from "../src/work-sessions.mjs";

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-conversations-"));
  let store = openDatabase(path.join(root, "test.sqlite"));
  try { fn(store, () => { store.close(); store = openDatabase(path.join(root, "test.sqlite")); return store; }); }
  finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("main chat pages persisted user input, final reply and task links without task transcripts", () => fixture((store, restart) => {
  const source = store.upsertSource({ sourceKey: "main", kind: "manual", uri: "test://main" });
  for (let i = 0; i < 4; i += 1) {
    const evidence = store.addEvidence({ sourceId: source.id, kind: "manual_knowledge", content: `message ${i}`, title: "input", externalId: `input-${i}`, sourceLocator: `test://${i}` });
    const { receipt } = enqueueDirectInputRequest(store, { evidenceId: evidence.id });
    store.updateDirectInputReceipt(receipt.id, { status: i === 3 ? "retry" : "completed", responseText: i === 3 ? null : `answer ${i}`,
      metadata: { createdTasks: [{ id: `card-${i}`, title: `Task ${i}` }] } });
  }
  const page = mainConversationPage(store, { limit: 2 });
  assert.equal(page.hasMore, true);
  assert.equal(page.messages.length, 4);
  assert.equal(page.messages[0].text, "message 2");
  assert.equal(page.messages.at(-1).status, "retry");
  const old = mainConversationPage(restart(), { limit: 2, before: page.before });
  assert.equal(old.hasMore, false);
  assert.equal(old.messages[0].text, "message 0");
  assert.equal(old.messages[1].tasks[0].id, "card-0");
}));

test("task A/B keep distinct stable sessions, local messages and checkpoint replies after restart", () => fixture((store, restart) => {
  const cards = ["A", "B"].map((id) => ({ id, title: id, metadata: { comments: [] } }));
  const operations = cards.map((card) => recordAgentOperation(store, {
    operationId: `op-${card.id}`, action: "task_message", card, targetType: "workboard_task", targetId: card.id, taskId: card.id,
    metadata: { userText: `instruction-${card.id}` },
  }));
  assert.notEqual(operations[0].owner.sessionKey, operations[1].owner.sessionKey);
  assert.notEqual(operations[0].owner.sessionKey, DIRECT_INPUT_SESSION_KEY);
  const row = operations[0].change;
  const metadata = JSON.parse(row.metadata_json);
  store.db.prepare("UPDATE context_changes SET metadata_json=? WHERE seq=?").run(JSON.stringify({ ...metadata,
    taskCheckpoint: { resultSummary: "Only A result", recordedAt: new Date().toISOString() } }), row.seq);
  cards[0].metadata.comments.push({ id: "echo", createdAt: Date.now(), body: "用户在任务卡片中继续交代：\ninstruction-A\n\n[shadow-operation:op-A]" });
  const a = taskConversationPage(store, cards[0]);
  assert.equal(a.messages.filter((item) => item.role === "user").length, 1);
  assert.match(JSON.stringify(a), /Only A result/);
  assert.doesNotMatch(JSON.stringify(a), /instruction-B/);
  const reopened = restart();
  assert.equal(resolveTaskOwnerSession(reopened, cards[0]).sessionKey, operations[0].owner.sessionKey);
  assert.deepEqual(taskConversationPage(reopened, cards[0]), a);
}));

test("legacy task rebinding moves pending work and watches without stealing an active lease", () => fixture((store) => {
  const now = new Date().toISOString();
  const old = "agent:main:shadow:user";
  for (const [key, taskId] of [["pending-A", "A"], ["leased-A", "A"], ["other-B", "B"]]) {
    emitContextChange(store.db, { eventKey: key, kind: "human_agent_operation", sessionKey: old,
      notBefore: now, metadata: { taskId }, summary: key });
  }
  const until = new Date(Date.now() + 600_000).toISOString();
  store.db.prepare("UPDATE context_changes SET status='leased',lease_until=?,lease_owner='old-run' WHERE event_key='leased-A'").run(until);
  const watch = store.createConditionWatch({ idempotencyKey: "watch-A", title: "A", conditionText: "result", taskId: "A", sessionKey: old });
  const owner = resolveTaskOwnerSession(store, { id: "A", title: "A" });
  assert.equal(store.db.prepare("SELECT session_key FROM context_changes WHERE event_key='pending-A'").get().session_key, owner.sessionKey);
  assert.equal(store.db.prepare("SELECT session_key FROM context_changes WHERE event_key='leased-A'").get().session_key, old);
  assert.equal(store.db.prepare("SELECT session_key FROM context_changes WHERE event_key='other-B'").get().session_key, old);
  assert.equal(store.conditionWatch(watch.id).session_key, owner.sessionKey);
  assert.notEqual(nextAttentionSession(store, { readyOnly: true })?.session_key, owner.sessionKey);
  store.db.prepare("UPDATE context_changes SET status='consumed' WHERE event_key IN ('leased-A','other-B')").run();
  assert.equal(nextAttentionSession(store, { readyOnly: true })?.session_key, owner.sessionKey);
}));

test("explicit task changes route independently but knowledge curation and source conversations do not", () => fixture((store) => {
  const now = new Date().toISOString();
  emitContextChange(store.db, { eventKey: "route-A", kind: "task_progress_due", sessionKey: DIRECT_INPUT_SESSION_KEY,
    notBefore: now, metadata: { taskId: "A" }, summary: "A" });
  emitContextChange(store.db, { eventKey: "route-knowledge", kind: "knowledge_delta_due", metadata: { taskId: "A" }, summary: "knowledge" });
  routePendingContextChanges(store);
  const a = store.db.prepare("SELECT * FROM context_changes WHERE event_key='route-A'").get();
  const knowledge = store.db.prepare("SELECT * FROM context_changes WHERE event_key='route-knowledge'").get();
  assert.equal(store.workSessionByKey(a.session_key).session_kind, "task");
  assert.equal(a.not_before, now);
  assert.notEqual(knowledge.session_key, a.session_key);
  assert.equal(store.workSessionByKey(knowledge.session_key).conversation_key, "knowledge-curation");
}));

test("large legacy comment histories are paginated rather than silently truncated", () => fixture((store) => {
  const card = { id: "old", metadata: { comments: Array.from({ length: 105 }, (_, i) => ({ id: String(i), body: `comment-${i}`, createdAt: i + 1 })) } };
  const first = taskConversationPage(store, card, { limit: 40 });
  card.metadata.comments.push({ id: "new", body: "new arrival", createdAt: Date.now() });
  const second = taskConversationPage(store, card, { limit: 40, before: first.before });
  const third = taskConversationPage(store, card, { limit: 40, before: second.before });
  assert.equal(first.messages.length, 40);
  assert.equal(second.messages.length, 40);
  assert.equal(third.messages.length, 25);
  assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.messages, ...second.messages, ...third.messages].map((m) => m.id)).size, 105);
  assert.ok(![...second.messages, ...third.messages].some((message) => message.text === "new arrival"));
}));

test("existing checkpoint fields aggregate ten reviews without a new snapshot or identical prose", () => fixture((store, restart) => {
  const card = { id: "aggregate", metadata: { comments: [] } };
  const sequences = Array.from({ length: 10 }, (_, i) => addReview(store, card.id, i, (m) => {
    if (i % 2) m.taskCheckpoint.evidenceIds.reverse();
    m.handlingReason = "Review reason " + i;
    m.taskCheckpoint.progressPlan.revision = i + 1;
    m.taskCheckpoint.progressPlan.updatedAt = m.requestedAt;
  }));
  const rows = store.db.prepare("SELECT * FROM context_changes ORDER BY seq").all();
  const writes = store.db.prepare("SELECT total_changes() AS count").get().count;
  const page = taskConversationPage(store, card);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].aggregation.count, 10);
  assert.deepEqual(page.messages[0].aggregation.sequences, sequences);
  assert.equal(page.rawMessages.length, 10);
  assert.equal(page.messages[0].aggregation.nextTrigger.nextReviewAt, reviewMetadata(card.id, 9).taskCheckpoint.continuation.nextReviewAt);
  assert.equal(taskConversationPage(store, card, { view: "timeline" }).messages.length, 10);
  assert.deepEqual(taskConversationPage(store, card, { view: "audit" }).audit, rows);
  assert.deepEqual(taskConversationPage(store, card, { view: "audit", sequences }).audit, rows);
  assert.equal(store.db.prepare("SELECT total_changes() AS count").get().count, writes);
  const reopened = restart();
  assert.deepEqual(taskConversationPage(reopened, card), page);
  addReview(reopened, card.id, 10, (m) => { m.taskCheckpoint.resultState = "progressed"; m.taskCheckpoint.resultSummary = "Repair verified"; });
  const changed = taskConversationPage(reopened, card);
  assert.equal(changed.messages.length, 2);
  assert.equal(changed.messages[0].aggregation.count, 10);
  assert.equal(changed.messages[1].text, "Repair verified");
}));

test("material evidence, result, binding, scope, execution and next-action differences remain separate", () => fixture((store) => {
  const changes = {
    result: m => { m.taskCheckpoint.resultState = "progressed"; },
    evidence: m => { m.taskCheckpoint.evidenceIds.push("new"); },
    owner: m => { m.taskCheckpoint.ownerSessionKey = "other"; },
    binding: m => { m.taskCheckpoint.bindingRevision++; },
    execution: m => { m.taskCheckpoint.execution.runId = "new-run"; },
    scope: m => { m.taskCheckpoint.progressPlan.authorizedScope = "Write production"; },
    action: m => { m.taskCheckpoint.progressPlan.nextAction = "Read different receipt"; },
    acceptance: m => { m.taskCheckpoint.progressPlan.successCriteria = "New acceptance criteria"; },
    reference: m => { m.taskCheckpoint.continuation.referenceId = "another-build"; },
    continuation: m => { m.taskCheckpoint.continuation.summary = "Deploy the build to production"; },
    status: m => { m.taskCheckpoint.cardStatus = "blocked"; },
    gap: m => { m.taskCheckpoint.checkpointRevision += 10; },
  };
  for (const [name, edit] of Object.entries(changes)) {
    const card = { id: name };
    addReview(store, card.id, 0);
    addReview(store, card.id, 1, edit);
    assert.equal(taskConversationPage(store, card).messages.length, 2, name);
  }
}));

test("unknown, failed, learning and human records are not classified and interrupt runs", () => fixture((store) => {
  const edits = {
    legacy: m => { delete m.taskCheckpoint.bindingRevision; },
    unknown: m => { m.taskCheckpoint.resultState = "unknown"; },
    blocked: m => { m.taskCheckpoint.resultState = "blocked"; },
    error: m => { m.taskCheckpoint.error = "failed"; },
    observation: m => { m.executionObservation = { error: "failed" }; },
    learning: m => { m.taskCheckpoint.learning = { inserted: true }; },
    human: m => { m.userText = "Repeat this"; m.operationId = m.requestedAt; },
    terminal: m => { m.taskCheckpoint.terminal = true; },
    unapplied: m => { m.taskCheckpoint.applied = false; },
    snapshot: m => { m.taskCheckpoint.presentationState = { version: 1 }; },
    invalidEvidence: m => { m.taskCheckpoint.evidenceIds = [1]; },
    invalidPlan: m => { m.taskCheckpoint.progressPlan = { nextAction: "Unknown remainder" }; },
    userAction: m => { m.taskCheckpoint.continuation.userAction = { request: "Approve" }; },
    oversized: m => { m.taskCheckpoint.progressPlan.nextAction = "x".repeat(13000); },
    silent: m => { delete m.taskCheckpoint; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const card = { id: name };
    addReview(store, card.id, 0);
    addReview(store, card.id, 1, edit);
    addReview(store, card.id, 2, edit);
    addReview(store, card.id, 3);
    const page = taskConversationPage(store, card);
    assert.ok(page.messages.every(m => !m.aggregation), name);
    assert.equal(taskConversationPage(store, card, { view: "audit" }).audit.length, 4);
  }
  for (const options of [{ kind: "human_agent_operation" }, { kind: "unknown" }, { status: "pending" }, { status: "leased" }, { status: "failed" }]) {
    const card = { id: JSON.stringify(options) };
    addReview(store, card.id, 0, undefined, options);
    addReview(store, card.id, 1, undefined, options);
    assert.equal(taskConversationPage(store, card).messages.length, 2);
  }
}));

test("changes to the next-action description cannot be assumed cosmetic", () => fixture((store) => {
  const card = { id: "no-plan" };
  for (let i = 0; i < 2; i++) addReview(store, card.id, i, m => {
    m.taskCheckpoint.progressPlan = null;
    m.taskCheckpoint.continuation.summary = "Next check wording " + i;
  });
  assert.equal(taskConversationPage(store, card).messages.length, 2);
  const same = { id: "same-next-action" };
  for (let i = 0; i < 10; i++) addReview(store, same.id, i, m => {
    m.taskCheckpoint.progressPlan = null;
    m.taskCheckpoint.continuation.summary = "Read the same receipt";
  });
  assert.equal(taskConversationPage(store, same).messages[0].aggregation.count, 10);
}));

function legacyReview(store, taskId, index, edit = () => {}) {
  const seq = addReview(store, taskId, index, metadata => {
    for (const field of ["checkpointRevision", "bindingRevision", "ownerSessionKey", "execution", "applied", "reason", "progressPlan"]) delete metadata.taskCheckpoint[field];
    Object.assign(metadata, { taskTitle: taskId, taskStatus: "todo", taskPriority: "high", handlingReason: "condition_missing",
      executionStatus: null, executionRunId: null, executionSessionKey: null, nextReviewAt: metadata.requestedAt });
    Object.assign(metadata.taskCheckpoint.continuation, { kind: "condition_watch", referenceId: "fixed-watch" });
    edit(metadata);
  });
  store.db.prepare("UPDATE context_changes SET event_key=?,coalesce_key=?,session_key=? WHERE seq=?")
    .run(`task-progress-due:${taskId}:${index + 1}`, `task-progress:${taskId}`, "original-owner-session", seq);
  return seq;
}

test("known pre-guard watch receipts use original scheduler identity without inventing absent state", () => fixture(store => {
  const card = { id: "old-writer" };
  const ids = Array.from({ length: 10 }, (_, i) => legacyReview(store, card.id, i));
  const page = taskConversationPage(store, card);
  assert.equal(page.messages.length, 1);
  assert.deepEqual(page.messages[0].aggregation.sequences, ids);
  const other = legacyReview(store, card.id, 10, m => { m.taskCheckpoint.resultState = "progressed"; });
  assert.equal(taskConversationPage(store, card).messages.length, 2);
  assert.equal(taskConversationPage(store, card, { view: "audit", sequences: [...ids, other] }).audit.length, 11);
  const cases = {
    partialGuard: m => { m.taskCheckpoint.applied = true; },
    missingReference: m => { m.taskCheckpoint.continuation.referenceId = null; },
    differentReference: m => { m.taskCheckpoint.continuation.referenceId = "another-watch"; },
    action: m => { m.taskCheckpoint.continuation.summary = "A changed action"; },
    execution: m => { m.executionStatus = "running"; },
    unknown: m => { m.taskCheckpoint.extra = 1; },
    missingTaskState: m => { delete m.taskStatus; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    legacyReview(store, name, 0);
    legacyReview(store, name, 1, edit);
    assert.equal(taskConversationPage(store, { id: name }).messages.length, 2, name);
  }
  legacyReview(store, "gap", 0);
  legacyReview(store, "gap", 2);
  assert.equal(taskConversationPage(store, { id: "gap" }).messages.length, 2);
  legacyReview(store, "unrecognized-identity", 0);
  const unknown = legacyReview(store, "unrecognized-identity", 1);
  store.db.prepare("UPDATE context_changes SET event_key='unknown-event' WHERE seq=?").run(unknown);
  assert.equal(taskConversationPage(store, { id: "unrecognized-identity" }).messages.length, 2);
}));

test("comments and Workboard state events, including those outside a comment page, stop aggregation", () => fixture((store) => {
  const card = { id: "comments", metadata: { comments: [
    { id: "user", body: "用户在任务卡片中继续交代：\nReview wording 0", createdAt: Date.UTC(2026, 9, 22, 0, 0, 30) },
    { id: "legacy", body: "Review wording 0", createdAt: Date.UTC(2026, 9, 22, 0, 2) },
    { id: "new", body: "Newer", createdAt: Date.UTC(2026, 9, 22, 0, 3) },
  ] } };
  addReview(store, card.id, 0);
  addReview(store, card.id, 1);
  const page = taskConversationPage(store, card, { limit: 2 });
  assert.equal(page.messages.length, 4);
  assert.ok(page.messages.every(m => !m.aggregation));
  card.metadata.comments = [];
  card.events = [{ at: Date.UTC(2026, 9, 22, 0, 0, 30), kind: "owner_changed" }];
  assert.equal(taskConversationPage(store, card).messages.length, 2);
}));

test("raw event cache recomputes across pages, refreshes and newly changed records without ghosts", () => fixture((store) => {
  const card = { id: "paging" };
  const ids = Array.from({ length: 105 }, (_, i) => addReview(store, card.id, i));
  let state;
  do {
    state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 40, before: state?.before }), { older: !!state });
  } while (state.hasMore);
  assert.equal(state.rawMessages.size, 105);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0].aggregation.sequences, ids);
  state = mergeTaskConversationPage(state, taskConversationPage(store, card));
  assert.equal(state.messages[0].aggregation.count, 105);
  addReview(store, card.id, 105, m => { m.taskCheckpoint.resultState = "progressed"; });
  state = mergeTaskConversationPage(state, taskConversationPage(store, card));
  assert.equal(state.messages.length, 2);
  const latest = ids.at(-1);
  const row = store.db.prepare("SELECT metadata_json FROM context_changes WHERE seq=?").get(latest);
  const metadata = JSON.parse(row.metadata_json);
  metadata.taskCheckpoint.resultState = "blocked";
  store.db.prepare("UPDATE context_changes SET metadata_json=? WHERE seq=?").run(JSON.stringify(metadata), latest);
  state = mergeTaskConversationPage(state, taskConversationPage(store, card));
  assert.equal(state.messages[0].aggregation.count, 104);
  assert.equal(state.messages.length, 3);
  assert.equal(new Set(state.messages.flatMap(m => m.aggregation?.sequences ?? [m.eventSeq])).size, 106);
}));

test("new head bursts larger than a page retain a cursor for the missing middle", () => fixture((store) => {
  const card = { id: "burst" };
  for (let i = 0; i < 4; i++) addReview(store, card.id, i);
  let state = mergeTaskConversationPage(undefined, taskConversationPage(store, card, { limit: 2 }));
  for (let i = 4; i < 12; i++) addReview(store, card.id, i);
  state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2 }));
  assert.equal(state.messages.length, 2);
  while (state.hasMore) state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2, before: state.before }), { older: true });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].aggregation.count, 12);
}));

test("first comment burst and new historical Workboard boundaries refresh the loaded cache", () => fixture(store => {
  const card = { id: "comment-burst", metadata: { comments: [] }, events: [] };
  for (let i = 0; i < 6; i++) addReview(store, card.id, i);
  let state;
  do {
    state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2, before: state?.before }), { older: !!state });
  } while (state.hasMore);
  card.events.push({ at: Date.UTC(2026, 9, 22, 0, 0, 30), kind: "owner_changed" });
  state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2 }));
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].aggregation.count, 5);
  card.metadata.comments = Array.from({ length: 7 }, (_, i) => ({ id: String(i), body: "Independent repeated text",
    createdAt: Date.UTC(2026, 9, 22, 1, i) }));
  state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2 }));
  assert.equal(state.hasMore, true);
  while (state.hasMore) state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2, before: state.before }), { older: true });
  assert.equal(state.rawMessages.size, 13);
  assert.equal(state.messages.filter(message => message.commentCursor).length, 7);
  state = mergeTaskConversationPage(state, taskConversationPage(store, card, { limit: 2 }));
  assert.equal(state.messages.length, 9);
}));

test("same timestamps use event sequence and audit-by-ID is bounded, task-scoped and complete", () => fixture((store) => {
  const card = { id: "ties" };
  const ids = Array.from({ length: 12 }, (_, i) => addReview(store, card.id, i, m => { m.taskCheckpoint.recordedAt = "2026-10-22T00:00:00.000Z"; }));
  const other = addReview(store, "other", 0);
  assert.deepEqual(taskConversationPage(store, card).messages[0].aggregation.sequences, ids);
  const audit = taskConversationPage(store, card, { view: "audit", sequences: [...ids, other] });
  assert.equal(audit.audit.length, 12);
  assert.deepEqual(audit.missingSequences, [other]);
  assert.throws(() => taskConversationPage(store, card, { view: "audit", sequences: Array(101).fill(1) }), /1-100/);
  assert.throws(() => taskConversationPage(store, card, { view: "audit", sequences: ["1"] }), /1-100/);
}));

test("explicit user echoes do not deduplicate independent repeated user messages or edited copies", () => fixture((store) => {
  const card = { id: "echo", metadata: { comments: [] } };
  for (let i = 0; i < 2; i++) {
    recordAgentOperation(store, { operationId: "echo-" + i, action: "task_message", card, taskId: card.id,
      targetType: "workboard_task", targetId: card.id, metadata: { userText: "Repeat this" } });
    card.metadata.comments.push({ id: "echo-" + i, createdAt: Date.now(),
      body: "用户在任务卡片中继续交代：\nRepeat this\n\n[shadow-operation:echo-" + i + "]" });
  }
  card.metadata.comments.push({ id: "edited", createdAt: Date.now(),
    body: "用户在任务卡片中继续交代：\nEdited content\n\n[shadow-operation:echo-0]" });
  const page = taskConversationPage(store, card, { view: "audit" });
  assert.equal(page.messages.filter(m => m.role === "user").length, 3);
  assert.equal(page.auditComments.length, 3);
}));
