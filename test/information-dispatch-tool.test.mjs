import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { emitContextChange } from '../src/context-graph.mjs';
import { appendChangeEvidence, changeCoverage, COMPLETE_EVIDENCE_POLICY,
  nextEvidencePage, recordEvidenceDelivery } from '../src/context-delivery.mjs';
import { resolveTaskOwnerSession } from '../src/agent-operations.mjs';
import { stableWorkSessionKey } from '../src/work-sessions.mjs';
import { captureKnowledgeEpisode } from '../openclaw/shadow-work/src/epistemic.js';
import { DatabaseWorkerClient } from '../openclaw/shadow-work/src/database-worker-client.js';
import { CHECKPOINT_RUNTIME_CONTEXT } from '../openclaw/shadow-work/src/task-checkpoint-guard.mjs';
import { openV4TestDatabase } from '../openclaw/shadow-work/src/test-fixture.mjs';

const moduleUrl = new URL('../openclaw/shadow-work/src/index.js?information-dispatch-tool-test', import.meta.url).href;
const sdkUrl = new URL('../tools/openclaw-runtime/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === moduleUrl && specifier === 'openclaw/plugin-sdk/tool-plugin') {
    return { shortCircuit: true, url: sdkUrl };
  }
  if (context.parentURL === moduleUrl && specifier === 'openclaw/plugin-sdk/core') {
    return { shortCircuit: true,
      url: "data:text/javascript,export function delegateCompactionToRuntime(){throw new Error('Live runtime forbidden in isolated test');}" };
  }
  return next(specifier, context);
} });
let plugin;
try { plugin = await import(moduleUrl); } finally { hook.deregister(); }

const SESSION = 'agent:main:shadow:conversation:information-tool-test';
const OTHER_SESSION = 'agent:main:shadow:conversation:other-input';
const OWNER = 'source-controller';
const DISPATCH = 'shadow_information_dispatch';

function rows(db, table) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return null;
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'shadow-information-tool-')));
  const config = { databasePath: path.join(root, 'shadow.sqlite'),
    workboardDatabasePath: path.join(root, 'workboard.sqlite'), reuseConnections: false };
  const store = openV4TestDatabase(config.databasePath), db = store.db;
  const board = new DatabaseSync(config.workboardDatabasePath);
  board.exec(`CREATE TABLE workboard_cards(id TEXT PRIMARY KEY, title TEXT, status TEXT,
    archived_at INTEGER, execution_status TEXT, execution_session_key TEXT, execution_run_id TEXT, automation_json TEXT)`);
  t.after(() => {
    board.close(); store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('shadow-information-tool-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const workerTools = new Map(), registrations = new Map(), calls = [];
  plugin.registerShadowTools({ pluginConfig: config, registerTool: tool => workerTools.set(tool.name, tool) });
  plugin.default.register({ pluginConfig: config, registerContextEngine: () => {},
    registerTool: (definition, options) => registrations.set(options?.name ?? definition.name, definition) });
  let beforeExecute = () => {}, afterExecute = () => {}, sequence = 0;
  // Preserve the serialization boundary while running only registered handlers on temporary DBs.
  t.mock.method(DatabaseWorkerClient.prototype, 'call', async (operation, params) => {
    const message = structuredClone(params);
    calls.push({ operation, params: message });
    beforeExecute(operation, message);
    const result = structuredClone(await workerTools.get(operation).execute('isolated-worker-call', message));
    afterExecute(operation, result);
    return result;
  });
  const f = {
    db, store, board, calls, registrations, workerTools,
    beforeExecute(callback) { beforeExecute = callback; },
    afterExecute(callback) { afterExecute = callback; },
    tool(name, context = { sessionKey: SESSION }) {
      const definition = registrations.get(name);
      assert.ok(definition, `Tool is registered: ${name}`);
      return typeof definition === 'function' ? definition(context) : definition;
    },
    async invoke(name, params, context) {
      const result = await f.tool(name, context).execute('runtime-tool-call', params);
      assert.ok(result.details, 'The real SDK returns a wrapped tool result');
      return result.details;
    },
    card(id, status = 'ready', archivedAt = null) {
      board.prepare("INSERT INTO workboard_cards VALUES(?,?,?,?,NULL,NULL,NULL,'{}')").run(id, `Card ${id}`, status, archivedAt);
      return { id, title: `Card ${id}` };
    },
    evidence(content = 'Original observation requiring task and knowledge review.') {
      const source = store.upsertSource({ sourceKey: 'dispatch-tool-test', kind: 'test', uri: 'test:dispatch-tool' });
      return store.addEvidence({ sourceId: source.id, externalId: `source-${++sequence}`,
        kind: 'project_document', role: 'observation', content, title: 'Original source',
        sourceLocator: `test:dispatch-tool:${sequence}`, occurredAt: new Date().toISOString() }).id;
    },
    read(seq, limit = 12) {
      db.prepare("UPDATE context_changes SET status='leased',lease_owner=?,lease_until='2099-01-01T00:00:00Z' WHERE seq=?").run(OWNER, seq);
      const page = nextEvidencePage(db, seq, { limit });
      recordEvidenceDelivery(db, seq, OWNER, page);
      return page.map(item => item.id);
    },
    source(ids, limit = 12) {
      const now = new Date().toISOString();
      const { seq } = emitContextChange(db, { eventKey: `source:${++sequence}`, kind: 'evidence_batch_ingested',
        sessionKey: SESSION, evidenceId: ids[0], summary: 'Input source', occurredAt: now, notBefore: now,
        metadata: { deliveryPolicy: COMPLETE_EVIDENCE_POLICY, evidenceIds: ids } });
      appendChangeEvidence(db, seq, ids);
      return { sourceChangeSeq: seq, leaseOwner: OWNER, evidenceIds: f.read(seq, limit),
        knowledge: true, tasks: [], rationale: 'Review this original source for durable knowledge.' };
    },
    snapshot() {
      return { cards: rows(board, 'workboard_cards'), ...Object.fromEntries([
        'work_task_attention', 'conversation_bindings', 'evidence', 'evidence_links', 'context_changes',
        'context_change_evidence', 'context_change_delivery', 'controller_outbox', 'settings',
        'graph_enrichment_queue', 'graph_episode_annotations', 'graph_facts', 'graph_evidence_assessments',
        'information_dispatches', 'information_deliveries',
      ].map(table => [table, rows(db, table)])) };
    },
  };
  return f;
}

function task(taskId) { return { taskId, reason: 'This source changes the task dependency.' }; }
function change(db, seq) { return db.prepare('SELECT * FROM context_changes WHERE seq=?').get(seq); }
function review(evidenceId, overrides = {}) {
  return { evidenceId, leaseOwner: 'curator', summary: 'The original source has been reviewed against current task dependencies.',
    keywords: ['source', 'dependency', 'review'], retrievalCues: ['Which dependency changed?', 'Where is the source?'],
    graphReview: { status: 'completed', outcome: 'no_durable_facts', rationale: 'A one-time task instruction.' }, ...overrides };
}

test('dispatch factory authenticates trusted context and rejects caller identity spoofing before the worker', async t => {
  const f = fixture(t), input = f.source([f.evidence()]);
  assert.equal(typeof f.registrations.get(DISPATCH), 'function');
  const before = f.snapshot();
  for (const [context, params] of [
    [{}, input],
    [{ sessionKey: ' ' }, { ...input, [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey: SESSION } }],
    [{ sessionKey: SESSION }, { ...input, sessionKey: OTHER_SESSION }],
    [{ sessionKey: SESSION }, { ...input, ownerSessionKey: OTHER_SESSION }],
  ]) {
    await assert.rejects(() => f.invoke(DISPATCH, params, context), /trusted runtime/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.snapshot(), before);
  }
  await assert.rejects(() => f.workerTools.get(DISPATCH).execute('untrusted', input), /trusted runtime identity/);
  await assert.rejects(() => f.invoke(DISPATCH, {
    ...input, [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey: SESSION },
  }, { sessionKey: OTHER_SESSION }), /not owned by this session/);
  assert.equal(f.calls[0].params[CHECKPOINT_RUNTIME_CONTEXT].sessionKey, OTHER_SESSION);
  assert.deepEqual(f.snapshot(), before);

  const context = { sessionKey: SESSION }, tool = f.tool(DISPATCH, context);
  context.sessionKey = OTHER_SESSION;
  const result = await tool.execute('captured-context', { ...input,
    [CHECKPOINT_RUNTIME_CONTEXT]: { sessionKey: OTHER_SESSION, administrator: true } });
  assert.equal(result.details.sessionKey, SESSION);
  assert.deepEqual(f.calls.at(-1).params[CHECKPOINT_RUNTIME_CONTEXT], { sessionKey: SESSION });
  assert.equal(f.calls.at(-1).params.ownerSessionKey, SESSION);
});

test('registered dispatch creates canonical ownership for new valid cards without changing cards or source cursors', async t => {
  const f = fixture(t), ids = [f.evidence('First original observation.'), f.evidence('Second original observation.')];
  f.card('new-card');
  const existing = resolveTaskOwnerSession(f.store, f.card('existing-card', 'running'));
  const input = { ...f.source(ids), tasks: [task('new-card'), task('existing-card')] };
  const before = f.snapshot(), sourceBefore = change(f.db, input.sourceChangeSeq);
  const result = await f.invoke(DISPATCH, input);
  const expected = stableWorkSessionKey('task', 'shadow-task', 'new-card');
  const owner = f.db.prepare("SELECT * FROM work_task_attention WHERE card_id='new-card'").get();
  const binding = f.db.prepare("SELECT * FROM conversation_bindings WHERE task_id='new-card'").get();
  assert.equal(owner.owner_session_key, expected);
  assert.equal(binding.session_key, expected);
  assert.equal(binding.session_kind, 'task');
  assert.equal(binding.status, 'active');
  assert.equal(result.deliveries.length, 3);
  assert.equal(result.deliveries.find(row => row.taskId === 'new-card').sessionKey, expected);
  assert.equal(result.deliveries.find(row => row.taskId === 'existing-card').sessionKey, existing.sessionKey);
  assert.deepEqual(rows(f.board, 'workboard_cards'), before.cards);
  assert.deepEqual(rows(f.db, 'evidence'), before.evidence);
  assert.deepEqual(rows(f.db, 'graph_facts'), before.graph_facts);
  assert.deepEqual(rows(f.db, 'controller_outbox'), before.controller_outbox);
  assert.deepEqual(change(f.db, input.sourceChangeSeq), sourceBefore);
  assert.deepEqual(rows(f.db, 'context_change_evidence').filter(row => row.change_seq === input.sourceChangeSeq), before.context_change_evidence);
  for (const delivery of result.deliveries) {
    const row = change(f.db, delivery.changeSeq);
    assert.equal(row.status, 'pending');
    assert.equal(JSON.parse(row.metadata_json).grantsAuthorization, false);
    assert.deepEqual(delivery.evidenceIds, [...ids].sort());
    assert.equal(changeCoverage(f.db, delivery.changeSeq).remaining, 2);
  }
  const after = f.snapshot();
  const replay = await f.invoke(DISPATCH, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.dispatchId, result.dispatchId);
  assert.deepEqual(f.snapshot(), after);
});

for (const state of ['done', 'cancelled', 'archived', 'deleted']) {
  test(`factory recovers a lost committed reply after target becomes ${state} without reopening or republishing`, async t => {
    const f = fixture(t);
    f.card('target');
    const input = { ...f.source([f.evidence()]), tasks: [task('target')] };
    let committed;
    f.afterExecute((operation, result) => {
      if (operation === DISPATCH) {
        committed = result.details;
        throw new Error('Committed worker reply was lost');
      }
    });
    await assert.rejects(() => f.invoke(DISPATCH, input), /worker reply was lost/);
    f.afterExecute(() => {});
    assert.equal(rows(f.db, 'information_dispatches').length, 1);
    if (state === 'deleted') f.board.prepare("DELETE FROM workboard_cards WHERE id='target'").run();
    else if (state === 'archived') f.board.prepare("UPDATE workboard_cards SET archived_at=1 WHERE id='target'").run();
    else f.board.prepare("UPDATE workboard_cards SET status=? WHERE id='target'").run(state);
    f.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE task_id='target'").run();
    f.db.prepare("UPDATE context_changes SET status='acknowledged' WHERE seq=?").run(committed.deliveries.find(row => row.taskId).changeSeq);
    f.db.prepare("UPDATE context_changes SET lease_until='2000-01-01T00:00:00Z' WHERE seq=?").run(input.sourceChangeSeq);
    const before = f.snapshot();
    const retry = { ...input, leaseOwner: 'recovered-controller' };
    const replay = await f.invoke(DISPATCH, retry);
    assert.equal(replay.replayed, true);
    assert.equal(replay.dispatchId, committed.dispatchId);
    assert.deepEqual(replay.deliveries.map(row => row.changeSeq), committed.deliveries.map(row => row.changeSeq));
    assert.equal(replay.deliveries.find(row => row.taskId).status, 'acknowledged');
    assert.deepEqual(f.snapshot(), before);
    await assert.rejects(() => f.invoke(DISPATCH, retry, { sessionKey: OTHER_SESSION }), /not owned by this session/);
    assert.deepEqual(f.snapshot(), before);

    f.read(input.sourceChangeSeq);
    const ack = { sequences: [input.sourceChangeSeq], leaseOwner: OWNER, disposition: 'processed', note: 'Recovered dispatch receipt.' };
    await f.invoke('shadow_context_ack', ack);
    const acknowledged = f.snapshot();
    assert.equal((await f.invoke(DISPATCH, retry)).dispatchId, committed.dispatchId);
    assert.deepEqual(f.snapshot(), acknowledged);

    // A changed decision or a new source is not a committed receipt replay.
    f.read(input.sourceChangeSeq);
    const liveSource = f.snapshot();
    await assert.rejects(() => f.invoke(DISPATCH, { ...input, rationale: 'A different routing decision.' }), /missing or terminal/);
    assert.deepEqual(f.snapshot(), liveSource);
    const newInput = { ...f.source([f.evidence('Another original source.')]), tasks: input.tasks };
    const newSource = f.snapshot();
    await assert.rejects(() => f.invoke(DISPATCH, newInput), /missing or terminal/);
    assert.deepEqual(f.snapshot(), newSource);
  });
}

test('factory rolls back prepared owners when later dispatch publication fails', async t => {
  const f = fixture(t);
  f.card('new-target');
  const input = { ...f.source([f.evidence()]), tasks: [task('new-target')] };
  f.db.exec(`CREATE TRIGGER fail_information_publication BEFORE INSERT ON context_changes
    WHEN json_extract(NEW.metadata_json,'$.informationDelivery')=1
    BEGIN SELECT RAISE(ABORT, 'isolated-dispatch-publication-failure'); END`);
  const before = f.snapshot();
  await assert.rejects(() => f.invoke(DISPATCH, input), /isolated-dispatch-publication-failure/);
  assert.deepEqual(f.snapshot(), before);
});

for (const [label, status, archivedAt] of [
  ['unknown', null, null], ['completed', 'done', null], ['cancelled', 'cancelled', null], ['archived', 'ready', 1],
]) {
  test(`registered dispatch rejects ${label} cards even with stale active bindings and preserves all writes`, async t => {
    const f = fixture(t);
    f.card('valid-first');
    if (status) resolveTaskOwnerSession(f.store, f.card('invalid-target', status, archivedAt));
    const input = { ...f.source([f.evidence()]), tasks: [task('valid-first'), task('invalid-target')] };
    const before = f.snapshot();
    await assert.rejects(() => f.invoke(DISPATCH, input), /missing or terminal/);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.calls.length, 1);
  });
}

test('worker validates source authority and membership and rolls back provisional new-task ownership', async t => {
  const f = fixture(t);
  f.card('new-card');
  const foreign = f.evidence('Evidence outside the leased input.');
  const input = { ...f.source([f.evidence()]), tasks: [task('new-card')] };
  const before = f.snapshot();
  for (const [overrides, error] of [
    [{ leaseOwner: 'not-the-lease-owner' }, /active lease/],
    [{ evidenceIds: [foreign] }, /not bound to source change/],
    [{ sourceChangeSeq: 999999 }, /Unknown source change/],
  ]) {
    await assert.rejects(() => f.invoke(DISPATCH, { ...input, ...overrides }), error);
    assert.deepEqual(f.snapshot(), before);
  }
  f.beforeExecute(() => {
    f.db.prepare('UPDATE context_changes SET session_key=? WHERE seq=?').run(OTHER_SESSION, input.sourceChangeSeq);
  });
  await assert.rejects(() => f.invoke(DISPATCH, input), /not owned by this session/);
  f.db.prepare('UPDATE context_changes SET session_key=? WHERE seq=?').run(SESSION, input.sourceChangeSeq);
  assert.deepEqual(f.snapshot(), before);
});

test('worker rechecks card liveness after dispatch crosses the factory boundary', async t => {
  const f = fixture(t);
  f.card('new-card');
  const input = { ...f.source([f.evidence()]), tasks: [task('new-card')] };
  f.beforeExecute(() => f.board.prepare("UPDATE workboard_cards SET status='done' WHERE id='new-card'").run());
  await assert.rejects(() => f.invoke(DISPATCH, input), /missing or terminal/);
  assert.equal(rows(f.db, 'work_task_attention').length, 0);
  assert.equal(rows(f.db, 'conversation_bindings').length, 0);
  assert.equal(rows(f.db, 'information_dispatches'), null);
  assert.equal(change(f.db, input.sourceChangeSeq).status, 'leased');
  assert.equal(rows(f.board, 'workboard_cards')[0].status, 'done');
});

test('registered source ACK requires a decision for each read page without consuming recipient deliveries', async t => {
  const f = fixture(t), ids = [f.evidence('Page one.'), f.evidence('Page two.')];
  f.card('target');
  const input = { ...f.source(ids, 1), tasks: [task('target')] };
  const ack = { sequences: [input.sourceChangeSeq], leaseOwner: OWNER, disposition: 'processed', note: 'Read source page.' };
  const before = f.snapshot();
  for (const disposition of ['processed', 'ignored']) {
    await assert.rejects(() => f.invoke('shadow_context_ack', { ...ack, disposition }), /requires shadow_information_dispatch/);
    assert.deepEqual(f.snapshot(), before);
  }
  const dispatch = await f.invoke(DISPATCH, input);
  assert.equal((await f.invoke('shadow_context_ack', ack)).updated, 1);
  assert.equal(change(f.db, input.sourceChangeSeq).status, 'pending');
  assert.equal(changeCoverage(f.db, input.sourceChangeSeq).remaining, 1);
  const remaining = f.read(input.sourceChangeSeq, 1);
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0], input.evidenceIds[0]);
  await assert.rejects(() => f.invoke('shadow_context_ack', ack), /requires shadow_information_dispatch/);
  const noConsumers = await f.invoke(DISPATCH, { ...input, evidenceIds: remaining, knowledge: false,
    tasks: [], rationale: 'This page is background only; neither consumer needs it.' });
  assert.deepEqual(noConsumers.deliveries, []);
  assert.equal((await f.invoke('shadow_context_ack', ack)).updated, 1);
  assert.equal(change(f.db, input.sourceChangeSeq).status, 'acknowledged');
  assert.equal(changeCoverage(f.db, input.sourceChangeSeq).remaining, 0);
  for (const delivery of dispatch.deliveries) {
    assert.equal(change(f.db, delivery.changeSeq).status, 'pending');
    assert.equal(changeCoverage(f.db, delivery.changeSeq).remaining, 1);
  }
});

test('registered dispatch cannot recursively fan out a received delivery', async t => {
  const f = fixture(t), input = f.source([f.evidence()]);
  const result = await f.invoke(DISPATCH, input), delivery = result.deliveries[0];
  f.read(delivery.changeSeq);
  const before = f.snapshot();
  await assert.rejects(() => f.invoke(DISPATCH, { ...input, sourceChangeSeq: delivery.changeSeq },
    { sessionKey: delivery.sessionKey }), /cannot be dispatched again/);
  assert.deepEqual(f.snapshot(), before);
});

test('registered curator schema exposes bounded taskImpacts on annotation', t => {
  const f = fixture(t), schema = f.tool('shadow_context_annotate').parameters;
  assert.ok(schema.properties.taskImpacts, 'Curator taskImpacts must be accepted by shadow_context_annotate');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.taskImpacts.maxItems, 20);
  assert.deepEqual(schema.properties.taskImpacts.items.required, ['taskId', 'reason']);
});

test('registered curator callback suppresses completed source-linked and explicit targets without mutating cards', async t => {
  const f = fixture(t);
  f.card('still-active'); f.card('completed-after-dispatch');
  resolveTaskOwnerSession(f.store, f.card('completed-explicit'));
  const evidenceId = f.evidence();
  await f.invoke(DISPATCH, { ...f.source([evidenceId]), tasks: [task('still-active'), task('completed-after-dispatch')] });
  await f.invoke('shadow_context_enrichment', { evidenceIds: [evidenceId], leaseOwner: 'curator' });
  const proposal = await f.invoke('shadow_context_propose', {
    rationale: 'Record a source-backed dependency.',
    entities: [{ canonicalKey: 'rule:dispatch-tool', type: 'Rule', name: 'Source dependency' }],
    facts: [{ subjectCanonicalKey: 'rule:dispatch-tool', predicate: 'HAS_VALUE', objectValue: 'documented dependency',
      sourceEvidenceIds: [evidenceId], evidenceProfile: { method: 'document_record', directness: 'direct' } }],
  });
  f.board.prepare("UPDATE workboard_cards SET status='done' WHERE id IN ('completed-after-dispatch','completed-explicit')").run();
  const before = f.snapshot();
  assert.equal(before.conversation_bindings.filter(row => row.task_id?.startsWith('completed') && row.status === 'active').length, 2);
  const result = await f.invoke('shadow_context_annotate', review(evidenceId, {
    graphReview: { status: 'completed', outcome: 'facts_recorded', rationale: 'Verified the source dependency.', factIds: [proposal.facts[0].id] },
    taskImpacts: [task('completed-explicit')],
  }));
  assert.equal(result.taskReviewChanges.length, 1);
  const feedback = rows(f.db, 'context_changes').filter(row => JSON.parse(row.metadata_json).reason === 'knowledge_feedback_reviewed');
  assert.deepEqual(feedback.map(row => JSON.parse(row.metadata_json).taskId), ['still-active']);
  assert.equal(result.queueStatus, 'completed');
  assert.deepEqual(rows(f.board, 'workboard_cards'), before.cards);
  for (const table of ['work_task_attention', 'conversation_bindings', 'evidence', 'graph_evidence_assessments', 'controller_outbox']) {
    assert.deepEqual(rows(f.db, table), before[table]);
  }
});

test('registered curator callback also suppresses human feedback targeting an already completed card', async t => {
  const f = fixture(t);
  resolveTaskOwnerSession(f.store, f.card('completed', 'done'));
  const captured = captureKnowledgeEpisode(f.db, { action: 'direct_next_step', targetType: 'workboard_task',
    targetId: 'completed', externalId: 'completed-feedback', content: 'A new instruction must not reopen this completed card.' });
  const before = f.snapshot();
  const result = await f.invoke('shadow_context_annotate', review(captured.evidenceId));
  assert.deepEqual(result.taskReviewChanges, []);
  assert.equal(result.queueStatus, 'completed');
  assert.deepEqual(rows(f.db, 'context_changes'), before.context_changes);
  assert.deepEqual(rows(f.board, 'workboard_cards'), before.cards);
  assert.deepEqual(rows(f.db, 'work_task_attention'), before.work_task_attention);
  assert.deepEqual(rows(f.db, 'evidence'), before.evidence);
});
