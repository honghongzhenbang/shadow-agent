import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.mjs';
import { recordTaskClosure, taskClosureView } from '../src/task-closure.mjs';
import { applyWorkboardOperation } from '../src/workboard-operations.mjs';
import { markAgentOperationEffectApplied, resolveTaskOwnerSession } from '../src/agent-operations.mjs';
import { processControllerOutbox } from '../src/controller-outbox.mjs';
import { completeKnowledgeAnnotation, leaseKnowledgeEnrichment, proposeKnowledge } from '../openclaw/shadow-work/src/epistemic.js';
import { r as WorkboardStore } from '../tools/openclaw-runtime/node_modules/openclaw/dist/runtime-api--LRiT5PH.js';
import { t as createStores } from '../tools/openclaw-runtime/node_modules/openclaw/dist/sqlite-store-CNGeQXFV.js';

async function fixture(t, { execution } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-task-closure-'));
  const store = openDatabase(path.join(root, 'shadow.sqlite'));
  store.setSetting('contextGraph:version', 'epistemic-context-v4');
  const native = createStores({ dbPath: path.join(root, 'workboard.sqlite') });
  const board = new WorkboardStore(native.cards, { boards: native.boards,
    subscriptions: native.subscriptions, attachments: native.attachments, dataVersion: native.dataVersion });
  const card = await board.createDirect({ title: 'Isolated closure task', status: 'todo', ...(execution ? { execution } : {}) });
  const calls = [];
  const client = {
    async invokeTool(name, args) {
      calls.push({ name, args });
      if (name === 'workboard_read') return { output: { details: { card: await board.get(args.id) } } };
      if (name === 'workboard_comment') { await board.addComment(args.id, args); return { ok: true }; }
      if (name === 'workboard_proof') { await board.addProof(args.id, args); return { ok: true }; }
      throw new Error(`Unexpected tool: ${name}`);
    },
    async request(method, args) {
      calls.push({ method, args });
      if (method === 'workboard.cards.move') return { card: await board.move(args.id, args.status) };
      if (method === 'workboard.cards.archive') return { card: await board.archive(args.id, args.archived) };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
  t.after(() => { store.close(); native.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const apply = async operation => {
    const result = await applyWorkboardOperation(client, JSON.parse(operation.action.payload_json));
    markAgentOperationEffectApplied(store, operation, result);
    return result;
  };
  return { store, root, board, card, client, calls, apply };
}

for (const outcome of ['done', 'cancelled']) for (const note of ['', '保留试验记录；不外发资料。']) {
  test(`native closure ${outcome}, ${note ? 'with' : 'without'} optional note keeps evidence and review independent`, async t => {
    const f = await fixture(t);
    const input = { outcome, note, operationId: 'human-close' };
    const op = recordTaskClosure(f.store, f.card, input);
    const evidence = f.store.db.prepare('SELECT * FROM evidence WHERE id=?').get(op.knowledge.evidenceId);
    assert.ok(evidence.content.includes(note));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM graph_facts').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(evidence.id).status, 'pending');
    const knowledgeEvent = f.store.db.prepare("SELECT * FROM context_changes WHERE evidence_id=? AND kind='knowledge_review_due'").get(evidence.id);
    assert.ok(knowledgeEvent);
    await f.apply(op);
    const card = await f.board.get(f.card.id);
    if (outcome === 'done') {
      assert.equal(card.status, 'done');
      assert.equal(card.metadata.proof.filter(p => p.label === '人工确认' && p.status === 'passed').length, 1);
    } else {
      assert.ok(card.metadata.archivedAt);
      assert.notEqual(card.status, 'done');
      assert.equal(card.metadata.proof?.length ?? 0, 0);
      assert.match(card.metadata.comments[0].body, /不代表目标完成/);
      assert.match(evidence.content, /不表示目标已完成/);
    }
    assert.equal(taskClosureView(f.store.db, card.id).closure.status, 'applied');
    assert.equal(taskClosureView(f.store.db, card.id).executionStop.status, 'not_running');
    assert.equal(f.store.db.prepare('SELECT status FROM context_changes WHERE seq=?').get(knowledgeEvent.seq).status, 'pending');
    const duplicate = recordTaskClosure(f.store, card, input);
    assert.equal(duplicate.duplicate, true);
    await f.apply(duplicate);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE external_id='agent-operation:human-close'").get().n, 1);
    assert.throws(() => recordTaskClosure(f.store, card, { ...input, note: 'different' }), /其他结束请求/);
    assert.throws(() => recordTaskClosure(f.store, card, { ...input, operationId: 'new-id' }), /已经结束/);
    const reviewed = completeKnowledgeAnnotation(f.store.db, { evidenceId: evidence.id,
      summary: 'This is a task-specific human outcome, not a general preference.',
      graphReview: { status: 'completed', outcome: 'no_durable_facts', rationale: 'No general rule inferred from one task closure.' } });
    assert.ok(reviewed);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM graph_facts').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT content FROM evidence WHERE id=?').get(evidence.id).content, evidence.content);
    const persisted = new DatabaseSync(path.join(f.root, 'shadow.sqlite'), { readOnly: true });
    try {
      assert.equal(taskClosureView(persisted, card.id).closure.outcome, outcome);
      assert.equal(persisted.prepare('SELECT content FROM evidence WHERE id=?').get(evidence.id).content, evidence.content);
    } finally { persisted.close(); }
  });
}

test('native termination rejects unsupported status; production uses archive, and terminal decisions cannot flip', async t => {
  const f = await fixture(t);
  await assert.rejects(f.board.move(f.card.id, 'cancelled'));
  const op = recordTaskClosure(f.store, f.card, { outcome: 'cancelled', operationId: 'cancel-once' });
  await f.apply(op);
  await assert.rejects(applyWorkboardOperation(f.client, { cardId: f.card.id, operationId: 'late-done', effect: 'confirm_done' }), /terminal/);
  assert.ok((await f.board.get(f.card.id)).metadata.archivedAt);
  assert.ok(!f.calls.some(c => c.args?.status === 'cancelled'));
});

for (const outcome of ['done', 'cancelled']) test(`${outcome}: curator can retain a scoped reason without reviving the closed task`, async t => {
  const f = await fixture(t);
  const note = '本次实验记录保留在项目文档中；本次不对外发送。';
  const op = recordTaskClosure(f.store, f.card, { outcome, note, operationId: 'curated-close', projectKey: 'isolated-project' });
  await f.apply(op);
  const lease = leaseKnowledgeEnrichment(f.store.db, { evidenceIds: [op.knowledge.evidenceId], leaseOwner: 'curator-test' });
  assert.equal(lease.episodes.length, 1);
  assert.ok(lease.episodes[0].content.includes(note));
  assert.equal(lease.episodes[0].project_key, 'isolated-project');
  const proposal = { entities: [{ canonicalKey: 'task:closure-fixture', type: 'Task', name: 'Closure fixture' }],
    facts: [{ subjectCanonicalKey: 'task:closure-fixture', predicate: 'HAS_SCOPE', objectValue: '本次不对外发送',
      sourceEvidenceIds: [op.knowledge.evidenceId], evidenceProfile: { method: 'document_record', directness: 'direct' } }] };
  const fact = proposeKnowledge(f.store.db, proposal).facts[0];
  assert.equal(proposeKnowledge(f.store.db, proposal).facts[0].id, fact.id);
  const input = { evidenceId: op.knowledge.evidenceId, leaseOwner: lease.leaseOwner,
    summary: '本次任务的资料保留和外发范围；不是用户的全局偏好。',
    graphReview: { status: 'completed', outcome: 'facts_recorded', factIds: [fact.id], rationale: 'Retain only the scoped statement.' } };
  const nativeReader = new DatabaseSync(path.join(f.root, 'workboard.sqlite'), { readOnly: true });
  try {
    const options = { isTaskActive: id => {
      const row = nativeReader.prepare('SELECT status,archived_at FROM workboard_cards WHERE id=?').get(id);
      return Boolean(row && row.archived_at == null && !['done', 'cancelled'].includes(row.status));
    } };
    const review = completeKnowledgeAnnotation(f.store.db, input, options);
    assert.deepEqual(review.taskReviewChanges, []);
    assert.equal(completeKnowledgeAnnotation(f.store.db, input, options).reviewVersion, review.reviewVersion);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM graph_fact_evidence WHERE fact_id=? AND evidence_id=?')
      .get(fact.id, op.knowledge.evidenceId).n, 1);
    assert.equal(f.store.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(op.knowledge.evidenceId).status, 'completed');
    assert.equal(taskClosureView(f.store.db, f.card.id).closure.outcome, outcome);
  } finally { nativeReader.close(); }
});

test('closing retires only this task future work; knowledge, unrelated watches and sending operations survive', async t => {
  const f = await fixture(t);
  const op = recordTaskClosure(f.store, f.card, { outcome: 'cancelled', operationId: 'retire' });
  const watch = f.store.createConditionWatch({ idempotencyKey: 'owned', title: 'Owned', conditionText: 'Wait', taskId: f.card.id,
    selector: { kinds: ['test'] }, sessionKey: op.owner.sessionKey });
  const unrelated = f.store.createConditionWatch({ idempotencyKey: 'other', title: 'Other', conditionText: 'Wait', taskId: 'other', selector: { kinds: ['test'] } });
  f.store.db.prepare("UPDATE work_task_attention SET continuation_kind='condition_watch',continuation_reference_id=?,next_review_at=? WHERE card_id=?")
    .run(watch.id, new Date().toISOString(), f.card.id);
  const wake = f.store.enqueueControllerAction({ idempotencyKey: 'wake-owned', actionType: 'wake_condition', payload: { watchId: watch.id } });
  f.store.claimControllerAction(wake.id);
  const bind = f.store.enqueueControllerAction({ idempotencyKey: 'bind-owned', actionType: 'bind_workboard_execution', payload: { taskId: f.card.id } });
  const reminder = f.store.createReminder({ idempotencyKey: 'owned-reminder', title: 'Owned reminder', message: 'Check', taskId: f.card.id,
    dueAt: new Date(Date.now() + 3600000).toISOString(), status: 'scheduled', cronJobId: 'isolated-cron' });
  const draft = (id, taskId) => f.store.createOutboundDraft({ idempotencyKey: id, taskId,
    recipientName: 'Synthetic recipient', recipientOpenId: 'synthetic-recipient-id', content: 'Isolated draft',
    sessionKey: op.owner.sessionKey });
  const waitingDraft = draft('waiting-draft', f.card.id), sendingDraft = draft('sending-draft', f.card.id);
  const otherDraft = draft('other-draft', 'other');
  f.store.db.prepare("UPDATE outbound_message_drafts SET status='sending' WHERE id=?").run(sendingDraft.id);
  await f.apply(op);
  assert.equal(f.store.conditionWatch(watch.id).status, 'cancelled');
  assert.equal(f.store.conditionWatch(unrelated.id).status, 'active');
  assert.equal(f.store.reminder(reminder.id).status, 'cancelled');
  assert.equal(f.store.outboundDraft(waitingDraft.id).status, 'cancelled');
  assert.equal(f.store.outboundDraft(sendingDraft.id).status, 'sending');
  assert.equal(f.store.outboundDraft(otherDraft.id).status, 'pending_confirmation');
  for (const action of [wake, bind]) assert.equal(f.store.db.prepare('SELECT status FROM controller_outbox WHERE id=?').get(action.id).status, 'cancelled');
  f.store.finishControllerAction(wake.id, { status: 'completed' });
  f.store.finishControllerAction(wake.id, { status: 'retry', error: 'late failure' });
  assert.equal(f.store.db.prepare('SELECT status FROM controller_outbox WHERE id=?').get(wake.id).status, 'cancelled');
  const attention = f.store.db.prepare('SELECT * FROM work_task_attention WHERE card_id=?').get(f.card.id);
  assert.equal(attention.continuation_kind, null);
  assert.equal(attention.next_review_at, null);
  assert.equal(f.store.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(op.knowledge.evidenceId).status, 'pending');
});

test('archive ACK loss retries the same native decision without duplicate comment or knowledge', async t => {
  const f = await fixture(t);
  const op = recordTaskClosure(f.store, f.card, { outcome: 'cancelled', note: 'Stop', operationId: 'lost-ack' });
  const request = f.client.request.bind(f.client);
  let lose = true;
  f.client.request = async (...args) => { const result = await request(...args); if (lose) { lose = false; throw new Error('ACK lost'); } return result; };
  await assert.rejects(f.apply(op), /ACK lost/);
  await f.apply(op);
  assert.equal((await f.board.get(f.card.id)).metadata.comments.length, 1);
  assert.equal(taskClosureView(f.store.db, f.card.id).closure.status, 'applied');
});

test('stop failure remains visible and retries the exact durable execution, never the whole session', async t => {
  const f = await fixture(t, { execution: { id: 'bound', sessionKey: 'agent:main:subagent:owned', runId: 'original-run', status: 'running' } });
  const op = recordTaskClosure(f.store, f.card, { outcome: 'cancelled', operationId: 'stop-retry' });
  await f.apply(op);
  const dependencies = { scheduleAttention() {}, stopTaskExecutions: async () => { throw new Error('offline'); } };
  await processControllerOutbox(f.store, { projectRoot: f.root }, { dependencies });
  assert.equal(taskClosureView(f.store.db, f.card.id).closure.status, 'applied');
  assert.equal(taskClosureView(f.store.db, f.card.id).executionStop.status, 'unconfirmed');
  const action = f.store.db.prepare("SELECT * FROM controller_outbox WHERE action_type='stop_task_execution'").get();
  assert.equal(action.status, 'retry');
  f.store.db.prepare('UPDATE controller_outbox SET next_attempt_at=? WHERE id=?').run(new Date(0).toISOString(), action.id);
  dependencies.stopTaskExecutions = async payload => {
    assert.equal(payload.targets[0].runId, 'original-run');
    return { status: 'unconfirmed', error: 'Abort acknowledged; physical cleanup is not yet confirmed.' };
  };
  await processControllerOutbox(f.store, { projectRoot: f.root }, { dependencies });
  assert.equal(taskClosureView(f.store.db, f.card.id).executionStop.status, 'unconfirmed');
  assert.equal(f.store.db.prepare('SELECT status FROM controller_outbox WHERE id=?').get(action.id).status, 'completed');
});

test('invalid closure input produces no knowledge or task effects', async t => {
  const f = await fixture(t);
  for (const input of [{ outcome: 'paused' }, { outcome: 'done', note: 'x'.repeat(4001) }, { outcome: 'done', note: {} }]) {
    assert.throws(() => recordTaskClosure(f.store, f.card, input));
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, 0);
});

for (const broken of [null, 'receipt', 'corrupt', 'owner', 'version']) test(`pending execution closure preserves exact checkpoint identity (${broken ?? 'valid'})`, async t => {
  const f = await fixture(t);
  const owner = resolveTaskOwnerSession(f.store, f.card);
  const runId = 'pending-run', sessionKey = 'agent:main:subagent:pending';
  const expectedExecution = { runId: null, sessionKey: null };
  const checkpointKey = 'task-checkpoint:pending-fixture';
  f.store.db.prepare(`UPDATE work_task_attention SET continuation_kind='codex_run', continuation_reference_id=?,
    checkpoint_revision=1 WHERE card_id=?`).run(runId, f.card.id);
  if (broken !== 'receipt') f.store.setSetting(checkpointKey, broken === 'corrupt' ? 'invalid JSON' : JSON.stringify({ checkpoint: {
    taskId: f.card.id, applied: true, checkpointRevision: 1, execution: expectedExecution,
    continuation: { kind: 'codex_run', referenceId: runId, sessionKey, model: 'fixture/model' },
  } }));
  const binding = f.store.enqueueControllerAction({ idempotencyKey: 'pending-bind', actionType: 'bind_workboard_execution', payload: {
    taskId: f.card.id, checkpointRevision: broken === 'version' ? 0 : 1, bindingRevision: 1,
    ownerSessionKey: broken === 'owner' ? 'agent:main:shadow:task:wrong' : owner.sessionKey,
    checkpointKey, runId, sessionKey, model: 'fixture/model', expectedExecution,
  } });
  const op = recordTaskClosure(f.store, f.card, { outcome: 'cancelled', operationId: 'close-pending' });
  await f.apply(op);
  assert.equal(f.store.db.prepare('SELECT status FROM controller_outbox WHERE id=?').get(binding.id).status, 'cancelled');
  assert.equal(f.store.db.prepare('SELECT continuation_kind FROM work_task_attention WHERE card_id=?').get(f.card.id).continuation_kind, null);
  const stop = f.store.db.prepare("SELECT * FROM controller_outbox WHERE action_type='stop_task_execution'").get();
  if (broken) {
    assert.equal(stop, undefined);
    assert.equal(taskClosureView(f.store.db, f.card.id).executionStop.status, 'unconfirmed');
  } else {
    assert.deepEqual(JSON.parse(stop.payload_json).targets, [{ role: 'pending_execution', runId, sessionKey }]);
    let attempts = 0;
    await processControllerOutbox(f.store, { projectRoot: f.root }, { dependencies: {
      scheduleAttention() {}, stopTaskExecutions: async payload => {
        attempts += 1;
        assert.equal(payload.targets[0].runId, runId);
        return { status: 'unconfirmed', error: 'Exact stop requested; cleanup receipt unavailable.' };
      },
    } });
    assert.equal(attempts, 1);
  }
});

test('active execution projection with no usable identity remains unconfirmed, never not_running', async t => {
  const f = await fixture(t);
  const op = recordTaskClosure(f.store, { ...f.card, execution: { status: 'running' } }, { outcome: 'cancelled', operationId: 'missing-run' });
  await f.apply(op);
  assert.equal(taskClosureView(f.store.db, f.card.id).executionStop.status, 'unconfirmed');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM controller_outbox WHERE action_type='stop_task_execution'").get().n, 0);
});

test('stop retry exhaustion changes pending to an explicit unconfirmed failure', async t => {
  const f = await fixture(t, { execution: { sessionKey: 'agent:main:subagent:waiting', runId: 'waiting-run', status: 'running' } });
  await f.apply(recordTaskClosure(f.store, f.card, { outcome: 'cancelled', operationId: 'stop-exhaustion' }));
  f.store.db.prepare("UPDATE controller_outbox SET attempts=9 WHERE action_type='stop_task_execution'").run();
  await processControllerOutbox(f.store, { projectRoot: f.root }, { dependencies: { scheduleAttention() {},
    stopTaskExecutions: async () => ({ status: 'pending', targets: [], error: 'Still active' }) } });
  assert.equal(f.store.db.prepare("SELECT status FROM controller_outbox WHERE action_type='stop_task_execution'").get().status, 'failed');
  const result = taskClosureView(f.store.db, f.card.id).executionStop;
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.error, /重试已耗尽/);
});

test('outbox cannot replace the execution frozen by the user closure receipt', async t => {
  const f = await fixture(t, { execution: { sessionKey: 'agent:main:subagent:owned', runId: 'owned-run', status: 'running' } });
  await f.apply(recordTaskClosure(f.store, f.card, { outcome: 'cancelled', operationId: 'forged-stop' }));
  f.store.db.prepare(`UPDATE controller_outbox SET payload_json=json_set(payload_json,'$.targets[0].runId','unrelated-run')
    WHERE action_type='stop_task_execution'`).run();
  let calls = 0;
  await processControllerOutbox(f.store, { projectRoot: f.root }, { dependencies: { scheduleAttention() {},
    stopTaskExecutions: async () => { calls += 1; return { status: 'not_running' }; } } });
  assert.equal(calls, 0);
  const action = f.store.db.prepare("SELECT status,last_error FROM controller_outbox WHERE action_type='stop_task_execution'").get();
  assert.equal(action.status, 'retry');
  assert.match(action.last_error, /identity differs/);
});
