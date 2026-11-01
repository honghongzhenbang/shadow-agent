import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { emitContextChange } from '../src/context-graph.mjs';
import { dispatchInformation } from '../src/information-delivery.mjs';
import { currentFactTrust, recomputeFactTrust } from '../src/graph-model.mjs';
import { bindTaskSession, routePendingContextChanges, nextAttentionSession, releaseAttentionLease } from '../src/work-sessions.mjs';
import { captureKnowledgeEpisode, captureResolutionKnowledgeDelta, completeKnowledgeAnnotation, leaseKnowledgeEnrichment, proposeKnowledge, reviseKnowledge } from '../openclaw/shadow-work/src/epistemic.js';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shadow-feedback-loop-'));
  const filename = path.join(root, 'isolated.sqlite');
  let store = openDatabase(filename);
  store.setSetting('contextGraph:version', 'epistemic-context-v4');
  t.after(() => {
    store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { get store() { return store; }, restart() { store.close(); store = openDatabase(filename); } };
}

function capture(store, overrides = {}) {
  return captureKnowledgeEpisode(store.db, {
    action: 'direct_next_step', targetType: 'workboard_task', targetId: 'task-one',
    content: 'This obligation has been handed to a colleague; stop reminding me to execute it.',
    externalId: 'feedback-one', ...overrides,
  });
}

function review(evidenceId, overrides = {}) {
  return { evidenceId, leaseOwner: 'curator', summary: 'The explicit task handoff does not establish any other outcome.',
    keywords: ['handoff', 'feedback', 'task'], retrievalCues: ['Who owns this outcome?', 'What was handed off?'],
    graphReview: { status: 'completed', outcome: 'no_durable_facts', rationale: 'This is a one-time task instruction.' },
    ...overrides };
}

function fact(store, evidenceId) {
  return proposeKnowledge(store.db, {
    entities: [{ canonicalKey: 'rule:feedback', type: 'Rule', name: 'Feedback rule' }],
    facts: [{ subjectCanonicalKey: 'rule:feedback', predicate: 'HAS_VALUE', objectValue: 'documented scope',
      sourceEvidenceIds: [evidenceId], evidenceProfile: { method: 'document_record', directness: 'direct' } }],
  }).facts[0].id;
}

function taskDelta(store, primaryId, key = 'task-candidate', overrides = {}) {
  return captureResolutionKnowledgeDelta(store.db, {
    idempotencyKey: key, question: 'Which documented scope applies to this task?',
    resolutionSummary: 'The task interpreted the original source and requests comparison with existing knowledge.',
    durableCandidates: ['The documented scope applies to this task.'], sourceEvidenceIds: [primaryId],
    keywords: ['source', 'scope', 'rule'], retrievalCues: ['Which scope applies?', 'Where is the original source?'],
    metadata: { taskId: 'task-one' }, ...overrides,
  });
}

function deliverSource(store, evidenceId, taskId, key = taskId) {
  const binding = bindTaskSession(store, { id: taskId });
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO context_changes(event_key, kind, evidence_id, session_key, status,
    occurred_at, created_at, summary, metadata_json) VALUES(?, 'task_progress_due', ?, ?, 'acknowledged', ?, ?, ?, ?)`)
    .run(`original-source:${key}`, evidenceId, binding.session_key, now, now, 'Original source delivery',
      JSON.stringify({ taskId, reason: 'information_delivery', evidenceIds: [evidenceId], purpose: 'task_information' }));
  return binding;
}

test('review notifies only the explicitly bound task, including one-time instructions', t => {
  const f = fixture(t), { store } = f;
  const owner = bindTaskSession(store, { id: 'task-one' });
  bindTaskSession(store, { id: 'unrelated-same-project' });
  const captured = capture(store);
  leaseKnowledgeEnrichment(store.db, { evidenceIds: [captured.evidenceId], leaseOwner: 'curator' });
  const completed = completeKnowledgeAnnotation(store.db, review(captured.evidenceId));
  const changes = store.db.prepare("SELECT * FROM context_changes WHERE kind='task_progress_due'").all();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].session_key, owner.session_key);
  const metadata = JSON.parse(changes[0].metadata_json);
  assert.equal(metadata.taskId, 'task-one');
  assert.equal(metadata.reason, 'knowledge_feedback_reviewed');
  assert.equal(metadata.grantsAuthorization, false);
  assert.equal(metadata.graphReview.outcome, 'no_durable_facts');
  assert.equal(completed.taskReviewChanges[0].seq, changes[0].seq);
  routePendingContextChanges(store);
  assert.equal(nextAttentionSession(store, { readyOnly: true }).session_key, owner.session_key);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM work_task_attention').get().n, 0);
});

test('review replay and process restart retain a single pending notification', t => {
  const f = fixture(t);
  bindTaskSession(f.store, { id: 'task-one' });
  const captured = capture(f.store);
  const first = completeKnowledgeAnnotation(f.store.db, review(captured.evidenceId));
  f.restart();
  const replay = completeKnowledgeAnnotation(f.store.db, review(captured.evidenceId));
  assert.equal(replay.taskReviewChanges[0].seq, first.taskReviewChanges[0].seq);
  f.store.db.prepare("UPDATE context_changes SET status='leased',lease_owner='offline' WHERE seq=?").run(first.taskReviewChanges[0].seq);
  releaseAttentionLease(f.store, 'offline');
  assert.equal(nextAttentionSession(f.store, { readyOnly: true }).session_key, first.taskReviewChanges[0].session_key);
  f.store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(first.taskReviewChanges[0].seq);
  completeKnowledgeAnnotation(f.store.db, review(captured.evidenceId, {
    summary: 'Same one-time instruction, rephrased without a new fact.',
    graphReview: { status: 'completed', outcome: 'no_durable_facts', rationale: 'Wording-only reprocessing.' },
  }));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE kind='task_progress_due'").get().n, 1);
  assert.equal(nextAttentionSession(f.store, { readyOnly: true }), null);
});

test('superseded feedback cannot be resurrected and its pending task notice is retired', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'task-one' });
  const captured = capture(store);
  const completed = completeKnowledgeAnnotation(store.db, review(captured.evidenceId));
  const revision = reviseKnowledge(store.db, {
    sourceType: 'note', title: 'Correction of task feedback', content: 'The previous handoff was incorrect; responsibility remains unconfirmed.',
    summary: 'A correction withdraws the old handoff; the next owner still requires evidence.',
    keywords: ['correction', 'handoff', 'task'], retrievalCues: ['Which feedback was withdrawn?', 'Who owns this task now?'],
    supersedesEvidenceIds: [captured.evidenceId], revisionReason: 'The user withdrew the previous instruction.',
  });
  assert.ok(revision.revisionEvidenceId);
  assert.throws(() => completeKnowledgeAnnotation(store.db, review(captured.evidenceId)), /was superseded/);
  assert.equal(store.db.prepare('SELECT status FROM graph_episode_annotations WHERE evidence_id=?').get(captured.evidenceId).status, 'superseded');
  assert.equal(store.db.prepare('SELECT status FROM context_changes WHERE seq=?').get(completed.taskReviewChanges[0].seq).status, 'acknowledged');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE kind='task_progress_due'").get().n, 1);
  const reviewed = completeKnowledgeAnnotation(store.db, review(revision.revisionEvidenceId));
  assert.equal(reviewed.taskReviewChanges.length, 1);
  assert.equal(reviewed.taskReviewChanges[0].session_key, completed.taskReviewChanges[0].session_key);
  assert.notEqual(reviewed.taskReviewChanges[0].seq, completed.taskReviewChanges[0].seq);
  const evidence = store.db.prepare('SELECT metadata_json FROM evidence WHERE id=?').get(revision.revisionEvidenceId);
  assert.equal(JSON.parse(evidence.metadata_json).humanFeedback, undefined);
});

test('unresolved review wakes the owning controller without fabricating a completed outcome', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'task-one' });
  const captured = capture(store);
  const result = completeKnowledgeAnnotation(store.db, review(captured.evidenceId, {
    graphReview: { status: 'needs_input', rationale: 'The recipient and scope of the correction remain ambiguous.' },
  }));
  assert.equal(result.queueStatus, 'review_needed');
  assert.equal(result.taskReviewChanges.length, 1);
  const metadata = JSON.parse(store.db.prepare('SELECT metadata_json FROM context_changes WHERE seq=?').get(result.taskReviewChanges[0].seq).metadata_json);
  assert.equal(metadata.graphReview.outcome, null);
  assert.equal(metadata.graphReview.status, 'needs_input');
});

test('generic knowledge and unbound targets do not broadcast to every task', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'unrelated' });
  for (const [id, targetType] of [['unbound', 'workboard_task'], ['generic', 'knowledge']]) {
    const captured = capture(store, { targetType, externalId: id });
    assert.deepEqual(completeKnowledgeAnnotation(store.db, review(captured.evidenceId)).taskReviewChanges, []);
  }
});

test('a task result does not feed its own review back into an endless task loop', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'task-one' });
  const captured = capture(store, { metadata: { knowledgeDelta: { idempotencyKey: 'completed-result' } } });
  assert.deepEqual(completeKnowledgeAnnotation(store.db, review(captured.evidenceId)).taskReviewChanges, []);
});

test('rejected outbound feedback follows the saved draft-to-task link, not the recipient name', t => {
  const { store } = fixture(t);
  const owner = bindTaskSession(store, { id: 'task-one' });
  bindTaskSession(store, { id: 'unrelated' });
  store.db.prepare(`INSERT INTO outbound_message_drafts
    (id,idempotency_key,recipient_name,task_id,content,status,created_at,updated_at)
    VALUES('draft-one','draft-one','Same Name','task-one','Unsent proposed reply','cancelled',?,?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  const captured = capture(store, { action: 'reject_outbound', targetType: 'outbound_message', targetId: 'draft-one' });
  const result = completeKnowledgeAnnotation(store.db, review(captured.evidenceId));
  assert.equal(result.taskReviewChanges[0].session_key, owner.session_key);
  assert.equal(store.db.prepare("SELECT status FROM outbound_message_drafts WHERE id='draft-one'").get().status, 'cancelled');
});

test('notification failure rolls back annotation and queue completion atomically', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'task-one' });
  const captured = capture(store);
  leaseKnowledgeEnrichment(store.db, { evidenceIds: [captured.evidenceId], leaseOwner: 'curator' });
  store.db.exec(`CREATE TRIGGER fail_feedback BEFORE INSERT ON context_changes
    WHEN NEW.kind='task_progress_due' BEGIN SELECT RAISE(ABORT, 'injected notification failure'); END;`);
  assert.throws(() => completeKnowledgeAnnotation(store.db, review(captured.evidenceId)), /injected notification failure/);
  assert.equal(store.db.prepare('SELECT review_status FROM graph_episode_annotations WHERE evidence_id=?').get(captured.evidenceId).review_status, 'pending');
  assert.equal(store.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(captured.evidenceId).status, 'leased');
  store.db.exec('DROP TRIGGER fail_feedback');
  assert.equal(completeKnowledgeAnnotation(store.db, review(captured.evidenceId)).taskReviewChanges.length, 1);
});

test('a resolved review after an intervening disagreement wakes the task again', t => {
  const f = fixture(t);
  bindTaskSession(f.store, { id: 'task-one' });
  const captured = capture(f.store);
  const sequences = [];
  for (const status of ['completed', 'needs_input', 'completed']) {
    const input = status === 'completed' ? review(captured.evidenceId) : review(captured.evidenceId, {
      graphReview: { status, rationale: 'New review found ambiguity in the handoff.' },
    });
    const result = completeKnowledgeAnnotation(f.store.db, input);
    sequences.push(result.taskReviewChanges[0].seq);
    f.store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(sequences.at(-1));
    f.restart();
  }
  assert.equal(new Set(sequences).size, 3);
  const replay = completeKnowledgeAnnotation(f.store.db, review(captured.evidenceId));
  assert.equal(replay.taskReviewChanges[0].seq, sequences.at(-1));
});

test('multi-step revision notifies only tasks explicitly linked by replaced feedback', t => {
  const { store } = fixture(t);
  for (const id of ['task-one', 'task-two', 'unrelated']) bindTaskSession(store, { id });
  const first = capture(store);
  const second = capture(store, { targetId: 'task-two', externalId: 'feedback-two', content: 'The second obligation is also awaiting a decision.' });
  const revisionInput = {
    sourceType: 'note', title: 'Feedback corrected', content: 'Both prior instructions were premature; review both linked tasks.',
    summary: 'Correction links two existing task instructions without assuming their outcomes.',
    keywords: ['correction', 'feedback', 'task'], retrievalCues: ['Which instructions were corrected?', 'Which tasks need review?'],
    revisionReason: 'The earlier instructions require a correction.',
  };
  const revision = reviseKnowledge(store.db, { ...revisionInput, supersedesEvidenceIds: [first.evidenceId, second.evidenceId] });
  const next = reviseKnowledge(store.db, { ...revisionInput,
    content: 'The correction remains pending verification for the same two tasks.',
    supersedesEvidenceIds: [revision.revisionEvidenceId] });
  const reviewed = completeKnowledgeAnnotation(store.db, review(next.revisionEvidenceId));
  assert.equal(reviewed.taskReviewChanges.length, 2);
  const taskIds = store.db.prepare("SELECT metadata_json FROM context_changes WHERE kind='task_progress_due'")
    .all().map(row => JSON.parse(row.metadata_json).taskId).sort();
  assert.deepEqual(taskIds, ['task-one', 'task-two']);
});

test('unchanged task candidates reuse primary support without another task wake or evidence copy', t => {
  const f = fixture(t);
  const primary = capture(f.store, { targetType: 'knowledge' });
  const factId = fact(f.store, primary.evidenceId);
  deliverSource(f.store, primary.evidenceId, 'task-one');
  for (const key of ['first-candidate', 'same-claim-rephrased', 'reaction-to-review']) {
    const delta = taskDelta(f.store, primary.evidenceId, key, key === 'reaction-to-review'
      ? { metadata: { taskId: 'task-one', reason: 'knowledge_feedback_reviewed' } } : {});
    const beforeEvidence = f.store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n;
    const input = review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
      rationale: 'This claim is already supported by the original source.', alreadyRepresentedFactIds: [factId] } });
    const first = completeKnowledgeAnnotation(f.store.db, input);
    assert.deepEqual(first.taskReviewChanges, []);
    f.restart();
    const replay = completeKnowledgeAnnotation(f.store.db, { ...input, summary: 'Same conclusion in other words.',
      graphReview: { ...input.graphReview, rationale: 'An editorial clarification only.' } });
    assert.equal(replay.reviewVersion, first.reviewVersion);
    assert.deepEqual(replay.taskReviewChanges, []);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, beforeEvidence);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM graph_evidence_assessments WHERE evidence_id=?').get(delta.evidenceId).n, 0);
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE json_extract(metadata_json,'$.reason')='knowledge_feedback_reviewed'").get().n, 0);
});

test('an explicit curator correction reaches the task without changing task state or inventing evidence', t => {
  const { store } = fixture(t);
  const owner = bindTaskSession(store, { id: 'task-one' });
  const primary = capture(store, { targetType: 'knowledge' });
  const delta = taskDelta(store, primary.evidenceId);
  store.db.prepare(`INSERT INTO work_task_attention(card_id, last_result_state, last_result_summary, updated_by, updated_at)
    VALUES('task-one', 'done', 'Retain the finished result until the owner evaluates the correction', 'test', ?)`)
    .run(new Date().toISOString());
  const beforeTask = store.db.prepare('SELECT * FROM work_task_attention').all();
  const beforeEvidence = store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n;
  const input = review(delta.evidenceId, { taskImpacts: [{ taskId: 'task-one', reason: 'The task interpreted this as completion; the source only establishes scope.' }] });
  const result = completeKnowledgeAnnotation(store.db, input);
  assert.equal(result.taskReviewChanges.length, 1);
  assert.equal(result.taskReviewChanges[0].session_key, owner.session_key);
  const metadata = JSON.parse(store.db.prepare('SELECT metadata_json FROM context_changes WHERE seq=?').get(result.taskReviewChanges[0].seq).metadata_json);
  assert.deepEqual(metadata.sourceEvidenceIds, [primary.evidenceId]);
  assert.equal(metadata.impactReason, input.taskImpacts[0].reason);
  assert.equal(metadata.mayReopenTask, false);
  assert.equal(metadata.grantsAuthorization, false);
  assert.equal(metadata.reviewVersion, result.reviewVersion);
  store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(result.taskReviewChanges[0].seq);
  const retry = completeKnowledgeAnnotation(store.db, { ...input,
    taskImpacts: [{ taskId: 'task-one', reason: 'Same correction rephrased; no additional change.' }] });
  assert.equal(retry.taskReviewChanges[0].seq, result.taskReviewChanges[0].seq);
  assert.deepEqual(store.db.prepare('SELECT * FROM work_task_attention').all(), beforeTask);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, beforeEvidence);
});

test('material delta review follows every existing original-source route, not only its originating task', t => {
  const { store } = fixture(t);
  const primary = capture(store, { targetType: 'knowledge' });
  const other = capture(store, { targetType: 'knowledge', externalId: 'unrelated-document', content: 'An unrelated document concerns a different task.' });
  deliverSource(store, primary.evidenceId, 'task-one');
  deliverSource(store, primary.evidenceId, 'task-two');
  deliverSource(store, other.evidenceId, 'unrelated');
  const closed = deliverSource(store, primary.evidenceId, 'inactive');
  store.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE session_key=?").run(closed.session_key);
  const delta = taskDelta(store, primary.evidenceId);
  const factId = fact(store, delta.evidenceId);
  const result = completeKnowledgeAnnotation(store.db, review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'The candidate revealed a new scoped fact.', factIds: [factId] } }));
  assert.equal(result.taskReviewChanges.length, 2);
  const taskIds = result.taskReviewChanges.map((change) => JSON.parse(store.db.prepare('SELECT metadata_json FROM context_changes WHERE seq=?').get(change.seq).metadata_json).taskId).sort();
  assert.deepEqual(taskIds, ['task-one', 'task-two']);
});

test('review uses durable dispatch membership for all targets after source deliveries were acknowledged', t => {
  const f = fixture(t);
  const primary = capture(f.store, { targetType: 'knowledge' });
  const first = capture(f.store, { targetType: 'knowledge', externalId: 'dispatch-first', content: 'Another primary source in the same input batch.' });
  for (const id of ['task-one', 'task-two', 'unrelated']) bindTaskSession(f.store, { id });
  const ids = [first.evidenceId, primary.evidenceId];
  const { seq } = emitContextChange(f.store.db, { eventKey: 'source-input-dispatch', kind: 'evidence_batch_ingested',
    evidenceId: first.evidenceId, sessionKey: 'source-session', summary: 'Original source batch.', metadata: { evidenceIds: ids } });
  f.store.db.prepare("UPDATE context_changes SET status='leased', lease_owner='source-owner', lease_until='2099-01-01T00:00:00Z' WHERE seq=?").run(seq);
  dispatchInformation(f.store.db, { sourceChangeSeq: seq, sessionKey: 'source-session', leaseOwner: 'source-owner',
    evidenceIds: ids, knowledge: true, tasks: ['task-one', 'task-two'].map(taskId => ({ taskId, reason: 'The source changes this task scope.' })),
    rationale: 'Source scope requires independent knowledge and task review.' });
  // The event preview is not the durable delivery membership authority.
  f.store.db.prepare(`UPDATE context_changes SET status='acknowledged', evidence_id=?,
    metadata_json=json_set(metadata_json,'$.evidenceIds',json(?))
    WHERE json_extract(metadata_json,'$.informationDelivery')=1`).run(first.evidenceId, JSON.stringify([first.evidenceId]));
  f.restart();
  const delta = taskDelta(f.store, primary.evidenceId);
  const factId = fact(f.store, delta.evidenceId);
  const result = completeKnowledgeAnnotation(f.store.db, review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'A new scoped conclusion affects both dispatched tasks.', factIds: [factId] } }));
  const taskIds = result.taskReviewChanges.map(change => JSON.parse(f.store.db.prepare('SELECT metadata_json FROM context_changes WHERE seq=?').get(change.seq).metadata_json).taskId);
  assert.deepEqual(taskIds.sort(), ['task-one', 'task-two']);
  const beforeVersion = result.reviewVersion;
  const beforeCount = f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE json_extract(metadata_json,'$.reason')='knowledge_feedback_reviewed'").get().n;
  f.store.db.exec(`CREATE TRIGGER fail_second_target BEFORE INSERT ON context_changes
    WHEN json_extract(NEW.metadata_json,'$.taskId')='task-two' AND json_extract(NEW.metadata_json,'$.reason')='knowledge_feedback_reviewed'
    BEGIN SELECT RAISE(ABORT, 'second target failed'); END;`);
  f.store.db.prepare("UPDATE graph_evidence_assessments SET stance='contradicts' WHERE fact_id=?").run(factId);
  assert.throws(() => completeKnowledgeAnnotation(f.store.db, review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'The scope is disputed.', factIds: [factId] } })), /second target failed/);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?').get(delta.evidenceId).metadata_json).graphReview.reviewVersion, beforeVersion);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE json_extract(metadata_json,'$.reason')='knowledge_feedback_reviewed'").get().n, beforeCount);
});

test('stable fact IDs notify once per semantic state, including A to B to A after restart', t => {
  const f = fixture(t);
  bindTaskSession(f.store, { id: 'task-one' });
  const primary = capture(f.store);
  const factId = fact(f.store, primary.evidenceId);
  const input = review(primary.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'The source supports this scoped fact.', factIds: [factId] } });
  const first = completeKnowledgeAnnotation(f.store.db, input);
  f.store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(first.taskReviewChanges[0].seq);
  f.store.db.prepare("UPDATE graph_facts SET updated_at='2099-01-01', metadata_json=? WHERE id=?").run(JSON.stringify({ rationale: 'Changed wording only' }), factId);
  f.store.db.prepare("UPDATE graph_evidence_assessments SET notes='Editorial wording', assessed_at='2099-01-01' WHERE fact_id=?").run(factId);
  assert.equal(completeKnowledgeAnnotation(f.store.db, input).reviewVersion, first.reviewVersion);
  const states = [
    ["UPDATE graph_evidence_assessments SET stance='contradicts' WHERE fact_id=?", factId],
    ["UPDATE graph_evidence_assessments SET stance='supports' WHERE fact_id=?", factId],
    ["UPDATE graph_evidence_assessments SET level=4 WHERE fact_id=?", factId],
    ["UPDATE graph_evidence_assessments SET stance='contradicts' WHERE fact_id=?", factId],
    ["UPDATE graph_facts SET status='superseded' WHERE id=?", factId],
    ["UPDATE graph_facts SET valid_to='2000-01-01T00:00:00Z' WHERE id=?", factId],
  ];
  let prior = first;
  for (const [sql, id] of states) {
    f.store.db.prepare(sql).run(id);
    const result = completeKnowledgeAnnotation(f.store.db, input);
    assert.equal(result.reviewVersion, prior.reviewVersion + 1);
    assert.notEqual(result.taskReviewChanges[0].seq, prior.taskReviewChanges[0].seq);
    f.store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(result.taskReviewChanges[0].seq);
    f.restart();
    const retry = completeKnowledgeAnnotation(f.store.db, input);
    assert.equal(retry.reviewHash, result.reviewHash);
    assert.equal(retry.reviewVersion, result.reviewVersion);
    assert.equal(retry.taskReviewChanges[0].seq, result.taskReviewChanges[0].seq);
    prior = result;
  }
});

test('represented primary facts changed since candidate capture still notify the task once', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'task-one' });
  const primary = capture(store, { targetType: 'knowledge' });
  const factId = fact(store, primary.evidenceId);
  const delta = taskDelta(store, primary.evidenceId);
  store.db.prepare("UPDATE graph_evidence_assessments SET level=4 WHERE fact_id=?").run(factId);
  const input = review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'The primary fact now has stronger evidence.', alreadyRepresentedFactIds: [factId] } });
  const first = completeKnowledgeAnnotation(store.db, input);
  assert.equal(first.taskReviewChanges.length, 1);
  assert.equal(completeKnowledgeAnnotation(store.db, input).taskReviewChanges[0].seq, first.taskReviewChanges[0].seq);
});

test('explicit task impacts reject invalid or inactive bindings without completing the review', t => {
  const { store } = fixture(t);
  const primary = capture(store);
  bindTaskSession(store, { id: 'active' });
  const inactive = bindTaskSession(store, { id: 'inactive' });
  store.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE session_key=?").run(inactive.session_key);
  const valid = { taskId: 'active', reason: 'A material correction affects this task.' };
  for (const impacts of [null, {}, [null], [{ ...valid, reason: '' }], [{ taskId: 'missing', reason: valid.reason }],
    [{ taskId: 'inactive', reason: valid.reason }], [valid, valid], Array(21).fill(valid)]) {
    assert.throws(() => completeKnowledgeAnnotation(store.db, review(primary.evidenceId, { taskImpacts: impacts })), /taskImpacts/);
    assert.equal(store.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(primary.evidenceId).status, 'pending');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE kind='task_progress_due'").get().n, 0);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM conversation_bindings').get().n, 2);
});

test('refreshing stale cached trust neither advances semantic review nor wakes a task', t => {
  const { store } = fixture(t);
  bindTaskSession(store, { id: 'task-one' });
  const primary = capture(store, { targetType: 'knowledge' });
  const factId = fact(store, primary.evidenceId);
  store.db.prepare('UPDATE graph_evidence_assessments SET level=1 WHERE fact_id=?').run(factId);
  assert.equal(currentFactTrust(store.db, factId), 'proposed');
  assert.equal(store.db.prepare('SELECT epistemic_status FROM graph_facts WHERE id=?').get(factId).epistemic_status, 'supported');
  const delta = taskDelta(store, primary.evidenceId);
  const input = review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'Only the primary-source claim is represented.', alreadyRepresentedFactIds: [factId] } });
  const first = completeKnowledgeAnnotation(store.db, input);
  assert.deepEqual(first.taskReviewChanges, []);
  recomputeFactTrust(store.db, factId);
  const refreshed = completeKnowledgeAnnotation(store.db, input);
  assert.equal(refreshed.reviewVersion, first.reviewVersion);
  assert.equal(refreshed.reviewHash, first.reviewHash);
  assert.deepEqual(refreshed.taskReviewChanges, []);
  store.db.prepare('UPDATE graph_evidence_assessments SET level=2 WHERE fact_id=?').run(factId);
  assert.equal(currentFactTrust(store.db, factId), 'supported');
  const changed = completeKnowledgeAnnotation(store.db, input);
  assert.equal(changed.reviewVersion, first.reviewVersion + 1);
  assert.equal(changed.taskReviewChanges.length, 1);
  recomputeFactTrust(store.db, factId);
  const cachedAgain = completeKnowledgeAnnotation(store.db, input);
  assert.equal(cachedAgain.reviewVersion, changed.reviewVersion);
  assert.equal(cachedAgain.taskReviewChanges[0].seq, changed.taskReviewChanges[0].seq);
});

test('equivalent queued candidates share semantic versions and one task receipt across restart and A to B to A', t => {
  const f = fixture(t);
  bindTaskSession(f.store, { id: 'task-one' });
  const primary = capture(f.store, { targetType: 'knowledge' });
  const factId = fact(f.store, primary.evidenceId);
  const firstDelta = taskDelta(f.store, primary.evidenceId, 'queued-first');
  const secondDelta = taskDelta(f.store, primary.evidenceId, 'queued-second', {
    resolutionSummary: 'Another task description of the exact same primary-source scoped claim.',
  });
  const input = evidenceId => review(evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'This is the same primary-supported scoped claim.', alreadyRepresentedFactIds: [factId] } });
  f.store.db.prepare('UPDATE graph_evidence_assessments SET level=4 WHERE fact_id=?').run(factId);
  const first = completeKnowledgeAnnotation(f.store.db, input(firstDelta.evidenceId));
  assert.equal(first.taskReviewChanges.length, 1);
  f.store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(first.taskReviewChanges[0].seq);
  f.restart();
  const second = completeKnowledgeAnnotation(f.store.db, input(secondDelta.evidenceId));
  assert.equal(second.reviewHash, first.reviewHash);
  assert.equal(second.reviewVersion, first.reviewVersion);
  assert.equal(second.taskReviewChanges[0].seq, first.taskReviewChanges[0].seq);
  assert.equal(second.taskReviewChanges[0].status, 'acknowledged');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE json_extract(metadata_json,'$.reason')='knowledge_feedback_reviewed'").get().n, 1);
  let previous = second;
  for (const level of [2, 4]) {
    f.store.db.prepare('UPDATE graph_evidence_assessments SET level=? WHERE fact_id=?').run(level, factId);
    const delta = taskDelta(f.store, primary.evidenceId, `new-state-${level}`);
    const changed = completeKnowledgeAnnotation(f.store.db, input(delta.evidenceId));
    assert.equal(changed.reviewVersion, previous.reviewVersion + 1);
    assert.notEqual(changed.taskReviewChanges[0].seq, previous.taskReviewChanges[0].seq);
    f.store.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(changed.taskReviewChanges[0].seq);
    f.restart();
    previous = changed;
  }
  assert.equal(previous.reviewHash, first.reviewHash);
  const oldCandidateReplay = completeKnowledgeAnnotation(f.store.db, input(firstDelta.evidenceId));
  assert.equal(oldCandidateReplay.reviewVersion, previous.reviewVersion);
  assert.equal(oldCandidateReplay.taskReviewChanges[0].seq, previous.taskReviewChanges[0].seq);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE json_extract(metadata_json,'$.reason')='knowledge_feedback_reviewed'").get().n, 3);
});

test('a task echo after primary-source review shares its version without waking a new recipient', t => {
  const { store } = fixture(t);
  const primary = capture(store, { targetType: 'knowledge' });
  const factId = fact(store, primary.evidenceId);
  const original = completeKnowledgeAnnotation(store.db, review(primary.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'The primary source establishes the scoped claim.', factIds: [factId] } }));
  assert.deepEqual(original.taskReviewChanges, []);
  bindTaskSession(store, { id: 'task-one' });
  const delta = taskDelta(store, primary.evidenceId);
  const echo = completeKnowledgeAnnotation(store.db, review(delta.evidenceId, { graphReview: { status: 'completed', outcome: 'facts_recorded',
    rationale: 'The task repeats the reviewed primary-source claim.', alreadyRepresentedFactIds: [factId] } }));
  assert.equal(echo.reviewVersion, original.reviewVersion);
  assert.equal(echo.reviewHash, original.reviewHash);
  assert.deepEqual(echo.taskReviewChanges, []);
});

test('authoritative task callback gates human, legacy, dispatch, origin and explicit targets without task writes', t => {
  const { store } = fixture(t);
  const primary = capture(store, { targetId: 'human-target' });
  for (const id of ['human-target', 'task-one', 'explicit-target', 'dispatched-target']) bindTaskSession(store, { id });
  deliverSource(store, primary.evidenceId, 'legacy-target');
  deliverSource(store, primary.evidenceId, 'active-target');
  const { seq } = emitContextChange(store.db, { eventKey: 'callback-source', kind: 'evidence_batch_ingested',
    evidenceId: primary.evidenceId, sessionKey: 'source-session', summary: 'Original source.', metadata: { evidenceIds: [primary.evidenceId] } });
  store.db.prepare("UPDATE context_changes SET status='leased',lease_owner='source-owner',lease_until='2099-01-01T00:00:00Z' WHERE seq=?").run(seq);
  dispatchInformation(store.db, { sourceChangeSeq: seq, sessionKey: 'source-session', leaseOwner: 'source-owner', evidenceIds: [primary.evidenceId],
    knowledge: false, tasks: [{ taskId: 'dispatched-target', reason: 'This source affects the dispatched task.' }], rationale: 'Task needs this source.' });
  const delta = taskDelta(store, primary.evidenceId);
  const factId = fact(store, delta.evidenceId);
  const tasksBefore = store.db.prepare('SELECT * FROM work_task_attention').all();
  const bindingsBefore = store.db.prepare('SELECT * FROM conversation_bindings ORDER BY id').all();
  const input = review(delta.evidenceId, { taskImpacts: [{ taskId: 'explicit-target', reason: 'The curator identified another affected task.' }],
    graphReview: { status: 'completed', outcome: 'facts_recorded', rationale: 'A material new claim affects these targets.', factIds: [factId] } });
  const checked = [];
  const result = completeKnowledgeAnnotation(store.db, input, { isTaskActive(taskId) { checked.push(taskId); return taskId === 'active-target'; } });
  assert.deepEqual(checked.sort(), ['active-target', 'dispatched-target', 'explicit-target', 'human-target', 'legacy-target', 'task-one']);
  assert.equal(result.taskReviewChanges.length, 1);
  const notification = JSON.parse(store.db.prepare('SELECT metadata_json FROM context_changes WHERE seq=?').get(result.taskReviewChanges[0].seq).metadata_json);
  assert.equal(notification.taskId, 'active-target');
  assert.deepEqual(store.db.prepare('SELECT * FROM work_task_attention').all(), tasksBefore);
  assert.deepEqual(store.db.prepare('SELECT * FROM conversation_bindings ORDER BY id').all(), bindingsBefore);
  assert.deepEqual(completeKnowledgeAnnotation(store.db, input, { isTaskActive: () => false }).taskReviewChanges, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE json_extract(metadata_json,'$.reason')='knowledge_feedback_reviewed'").get().n, 1);
});

test('task callback errors and non-boolean results roll back review and earlier target publication', t => {
  const { store } = fixture(t);
  const primary = capture(store, { targetType: 'knowledge' });
  for (const id of ['a-target', 'z-target']) bindTaskSession(store, { id });
  const input = review(primary.evidenceId, { taskImpacts: ['a-target', 'z-target'].map(taskId => ({ taskId, reason: 'The correction affects this task.' })) });
  for (const result of [undefined, 1, 'true', Promise.resolve(true), new Error('Workboard unavailable')]) {
    assert.throws(() => completeKnowledgeAnnotation(store.db, input, { isTaskActive(taskId) {
      if (taskId === 'a-target') return true;
      if (result instanceof Error) throw result;
      return result;
    } }), /isTaskActive|Workboard unavailable/);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE kind='task_progress_due'").get().n, 0);
    assert.equal(store.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(primary.evidenceId).status, 'pending');
    assert.equal(JSON.parse(store.db.prepare('SELECT metadata_json FROM graph_episode_annotations WHERE evidence_id=?').get(primary.evidenceId).metadata_json).graphReview.reviewVersion, undefined);
  }
  assert.throws(() => completeKnowledgeAnnotation(store.db, input, { isTaskActive: true }), /isTaskActive must be a function/);
  assert.equal(completeKnowledgeAnnotation(store.db, input).taskReviewChanges.length, 2);
});
