import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase, openDatabaseReadOnly } from '../src/db.mjs';
import { emitContextChange } from '../src/context-graph.mjs';
import { acknowledgeEvidenceDelivery, appendChangeEvidence, changeCoverage, COMPLETE_EVIDENCE_POLICY,
  nextEvidencePage, recordEvidenceDelivery } from '../src/context-delivery.mjs';
import { bindTaskSession, nextAttentionSession, stableWorkSessionKey } from '../src/work-sessions.mjs';
import { sha256 } from '../src/utils.mjs';
import { dispatchInformation, ensureInformationDeliverySchema, getInformationTaskTargets,
  hasInformationDispatch } from '../src/information-delivery.mjs';

const NOW = '2026-10-23T08:00:00.000Z';
const SESSION = 'agent:main:shadow:conversation:information-test';
const OWNER = 'source-controller';
const KNOWLEDGE_SESSION = stableWorkSessionKey('workstream', 'shadow', 'knowledge-curation');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shadow-information-delivery-'));
  const file = path.join(root, 'isolated.sqlite');
  let store = openDatabase(file), next = 0;
  t.after(() => {
    store.close();
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() { return store; }, get db() { return store.db; }, file,
    restart() { store.close(); store = openDatabase(file); },
    evidence(content = 'Original evidence, not execution authorization.') {
      const source = store.upsertSource({ sourceKey: 'information-test', kind: 'test', uri: 'test:information' });
      return store.addEvidence({ sourceId: source.id, externalId: `item-${++next}`, kind: 'feishu_message',
        role: 'observation', content, title: 'Source observation', sourceLocator: `test:item:${next}`, occurredAt: NOW }).id;
    },
    source(ids, extra = {}) {
      const { seq } = emitContextChange(store.db, { eventKey: `source:${++next}`, kind: 'evidence_batch_ingested',
        sessionKey: SESSION, evidenceId: ids.at(-1), summary: 'Source input', occurredAt: NOW, notBefore: NOW,
        metadata: { deliveryPolicy: COMPLETE_EVIDENCE_POLICY, evidenceIds: ids.slice(-100) }, ...extra });
      appendChangeEvidence(store.db, seq, ids);
      store.db.prepare("UPDATE context_changes SET status='leased',lease_owner=?,lease_until='2099-01-01T00:00:00Z' WHERE seq=?").run(OWNER, seq);
      return seq;
    },
    task(taskId) { return bindTaskSession(store, { id: taskId }); },
  };
}

function input(seq, evidenceIds, overrides = {}) {
  return { sourceChangeSeq: seq, sessionKey: SESSION, leaseOwner: OWNER, evidenceIds, knowledge: true,
    tasks: [], rationale: 'Review these original observations.', now: NOW, ...overrides };
}

function rows(db, table) { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
function sourceRow(db, seq) { return db.prepare('SELECT * FROM context_changes WHERE seq=?').get(seq); }
function deliveryRows(db) { return rows(db, 'context_changes').filter(row => JSON.parse(row.metadata_json).informationDelivery); }
function tableExists(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name)); }
function page(db, seq, limit = 12) {
  const result = nextEvidencePage(db, seq, { limit });
  recordEvidenceDelivery(db, seq, OWNER, result);
  return result.map(item => item.id);
}
function consume(db, seq) {
  while (changeCoverage(db, seq).remaining) {
    page(db, seq);
    acknowledgeEvidenceDelivery(db, seq, OWNER);
  }
  db.prepare("UPDATE context_changes SET status='acknowledged',acknowledged_at=?,lease_owner=NULL,lease_until=NULL WHERE seq=?").run(NOW, seq);
}
function seedQueue(db, id, status, extra = {}) {
  const hash = sha256(db.prepare('SELECT content FROM evidence WHERE id=?').get(id).content);
  db.prepare(`INSERT INTO graph_enrichment_queue
    (evidence_id,content_hash,reason,status,queued_at,completed_at,lease_owner,lease_until,attempts,last_error)
    VALUES(?,?,'existing-review',?,?,?,?,?,3,'preserve diagnostic')`).run(id, extra.contentHash ?? hash,
      status, NOW, status === 'completed' ? NOW : null, extra.leaseOwner ?? null, extra.leaseUntil ?? null);
}

test('schema is explicit/lazy and both queries work read-only before and after initialization', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  assert.equal(tableExists(f.db, 'information_dispatches'), false);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  assert.deepEqual(getInformationTaskTargets(f.db, [id]), []);
  const read = () => {
    const reader = openDatabaseReadOnly(f.file);
    try {
      assert.equal(hasInformationDispatch(reader.db, seq), false);
      assert.deepEqual(getInformationTaskTargets(reader.db, [id]), []);
    } finally { reader.close(); }
  };
  read();
  assert.equal(tableExists(f.db, 'information_dispatches'), false);
  ensureInformationDeliverySchema(f.db);
  ensureInformationDeliverySchema(f.db);
  read();
  assert.equal(tableExists(f.db, 'information_deliveries'), true);
});

test('legacy metadata ignores compacted dangling evidence when checking dispatch coverage', t => {
  const f = fixture(t), id = f.evidence('Surviving legacy evidence');
  const { seq } = emitContextChange(f.db, {
    eventKey: 'legacy-source-with-dangling-member', kind: 'evidence_batch_ingested',
    sessionKey: SESSION, evidenceId: id, summary: 'Legacy source input', occurredAt: NOW, notBefore: NOW,
    metadata: { evidenceIds: [id, 'compacted-evidence-id'] },
  });
  f.db.prepare("UPDATE context_changes SET status='leased',lease_owner=?,lease_until='2099-01-01T00:00:00Z' WHERE seq=?")
    .run(OWNER, seq);
  dispatchInformation(f.db, input(seq, [id], { knowledge: false, rationale: 'No consumer.' }));
  assert.equal(hasInformationDispatch(f.db, seq), true);
});

test('fanout references original evidence with fresh independent cursors and never writes cards or facts', t => {
  const f = fixture(t), ids = [f.evidence('First original body'), f.evidence('Second original body')];
  const taskA = f.task('task-a'), taskB = f.task('task-b'); f.task('unrelated');
  const seq = f.source(ids);
  f.db.prepare('UPDATE context_change_evidence SET consumed_offset=3 WHERE change_seq=?').run(seq);
  const sourceBefore = sourceRow(f.db, seq), evidenceBefore = rows(f.db, 'evidence');
  const tasksBefore = rows(f.db, 'tasks'), bindingsBefore = rows(f.db, 'conversation_bindings');
  const result = dispatchInformation(f.db, input(seq, ids, {
    tasks: [{ taskId: 'task-b', reason: 'Second dependency' }, { taskId: 'task-a', reason: 'First dependency' }],
  }));
  assert.equal(result.replayed, false);
  assert.deepEqual(result.tasks.map(task => task.taskId), ['task-a', 'task-b']);
  assert.equal(result.deliveries.length, 3);
  assert.deepEqual(new Set(result.deliveries.map(row => row.sessionKey)), new Set([KNOWLEDGE_SESSION, taskA.session_key, taskB.session_key]));
  assert.deepEqual(sourceRow(f.db, seq), sourceBefore);
  assert.deepEqual(rows(f.db, 'evidence'), evidenceBefore);
  assert.deepEqual(rows(f.db, 'tasks'), tasksBefore);
  assert.deepEqual(rows(f.db, 'conversation_bindings').filter(row => row.session_kind === 'task'), bindingsBefore);
  assert.equal(rows(f.db, 'graph_facts').length, 0);
  assert.equal(rows(f.db, 'graph_episode_annotations').length, 0);
  assert.equal(rows(f.db, 'work_task_attention').length, 0);
  for (const delivery of result.deliveries) {
    const change = sourceRow(f.db, delivery.changeSeq), metadata = JSON.parse(change.metadata_json);
    assert.equal(change.status, 'pending'); assert.equal(change.coalesce_key, null);
    assert.equal(metadata.sourceChangeSeq, seq); assert.equal(metadata.grantsAuthorization, false);
    assert.deepEqual(metadata.evidenceIds, [...ids].sort());
    assert.ok(!JSON.stringify(change).includes('original body'));
    assert.deepEqual(f.db.prepare('SELECT consumed_offset,done FROM context_change_evidence WHERE change_seq=?').all(change.seq)
      .map(row => ({ ...row })), ids.map(() => ({ consumed_offset: 0, done: 0 })));
  }
  assert.equal(hasInformationDispatch(f.db, seq), true);
  assert.deepEqual(rows(f.db, 'graph_enrichment_queue').map(row => row.status), ['pending', 'pending']);
});

for (const firstPurpose of ['knowledge_review_due', 'task_progress_due']) {
  test(`${firstPurpose} ACK does not consume other recipients; sorted replay survives restart and source ACK`, t => {
    const f = fixture(t), ids = [f.evidence('One'), f.evidence('Two')];
    f.task('task-a'); f.task('task-b');
    const seq = f.source(ids), request = input(seq, ids, {
      tasks: [{ taskId: 'task-b', reason: 'B' }, { taskId: 'task-a', reason: 'A' }],
    });
    const result = dispatchInformation(f.db, request);
    const first = result.deliveries.find(row => row.purpose === firstPurpose);
    consume(f.db, first.changeSeq);
    consume(f.db, seq);
    const untouched = result.deliveries.filter(row => row.changeSeq !== first.changeSeq);
    f.restart();
    const replay = dispatchInformation(f.db, { ...request, evidenceIds: [...ids].reverse().concat(ids[0]),
      tasks: [...request.tasks].reverse(), leaseOwner: 'restarted-owner', now: '2100-01-01T00:00:00Z' });
    assert.equal(replay.replayed, true); assert.equal(replay.dispatchId, result.dispatchId);
    assert.deepEqual(replay.deliveries.map(row => row.changeSeq), result.deliveries.map(row => row.changeSeq));
    assert.equal(deliveryRows(f.db).length, 3);
    for (const item of untouched) {
      assert.equal(sourceRow(f.db, item.changeSeq).status, 'pending');
      assert.equal(changeCoverage(f.db, item.changeSeq).remaining, 2);
    }
    assert.equal(rows(f.db, 'information_dispatches').length, 1);
    assert.throws(() => dispatchInformation(f.db, { ...request, sessionKey: 'forged-session' }), /not owned/);
    assert.throws(() => dispatchInformation(f.db, { ...request, rationale: 'Changed decision' }), /active lease/);
  });
}

test('page decisions cover 135 authoritative refs without ACKing later pages or new leased arrivals', t => {
  const f = fixture(t), ids = Array.from({ length: 135 }, (_, i) => f.evidence(`Observation ${i}`));
  const seq = f.source(ids);
  assert.equal(JSON.parse(sourceRow(f.db, seq).metadata_json).evidenceIds.length, 100);
  assert.equal(changeCoverage(f.db, seq).total, 135);
  const first = page(f.db, seq);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  dispatchInformation(f.db, input(seq, first, { knowledge: false, rationale: 'No consumers for this page.' }));
  assert.equal(hasInformationDispatch(f.db, seq), true);
  assert.equal(hasInformationDispatch(f.db, seq, ids), false);
  acknowledgeEvidenceDelivery(f.db, seq, OWNER);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  let dispatched = first.length;
  while (changeCoverage(f.db, seq).remaining) {
    const current = page(f.db, seq, 25);
    assert.equal(hasInformationDispatch(f.db, seq), false);
    dispatchInformation(f.db, input(seq, current, { knowledge: false }));
    assert.equal(hasInformationDispatch(f.db, seq), true);
    acknowledgeEvidenceDelivery(f.db, seq, OWNER);
    dispatched += current.length;
  }
  assert.equal(dispatched, 135); assert.equal(hasInformationDispatch(f.db, seq), true);
  const late = f.evidence('Arrived while original source was leased');
  appendChangeEvidence(f.db, seq, [late]);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  const current = page(f.db, seq);
  assert.deepEqual(current, [late]);
  f.restart();
  assert.equal(hasInformationDispatch(f.db, seq), false);
  dispatchInformation(f.db, input(seq, current, { knowledge: false }));
  assert.equal(hasInformationDispatch(f.db, seq), true);
  assert.equal(changeCoverage(f.db, seq).remaining, 1);
  assert.equal(deliveryRows(f.db).length, 0);
});

test('overlapping source rows deduplicate per original evidence revision, recipient and purpose', t => {
  const f = fixture(t), a = f.evidence('A'), b = f.evidence('B'); f.task('task-a'); f.task('task-b');
  const one = f.source([a]);
  const first = dispatchInformation(f.db, input(one, [a], { tasks: [{ taskId: 'task-a', reason: 'A matters' }] }));
  consume(f.db, first.deliveries.find(row => row.taskId).changeSeq);
  const two = f.source([a, b]);
  const second = dispatchInformation(f.db, input(two, [b, a], { tasks: [{ taskId: 'task-a', reason: 'Still matters' }] }));
  assert.equal(second.deliveries.length, 4);
  assert.equal(deliveryRows(f.db).length, 4);
  const fresh = second.deliveries.filter(row => !first.deliveries.some(prior => row.changeSeq === prior.changeSeq));
  assert.deepEqual(fresh.map(row => row.evidenceIds), [[b], [b]]);
  const three = f.source([a]);
  const third = dispatchInformation(f.db, input(three, [a], { tasks: [
    { taskId: 'task-a', reason: 'Same source' }, { taskId: 'task-b', reason: 'Also dependent' },
  ] }));
  assert.equal(deliveryRows(f.db).length, 5);
  assert.equal(third.deliveries.find(row => row.taskId === 'task-a').status, 'acknowledged');
  assert.equal(hasInformationDispatch(f.db, three, [a]), true);
  assert.equal(hasInformationDispatch(f.db, one, [b]), false);
  assert.equal(rows(f.db, 'evidence').length, 2);
});

test('long evidence requires a decision for each read range while recipients get only one full-body delivery', t => {
  const f = fixture(t), id = f.evidence('Long original observation. '.repeat(200)), seq = f.source([id]);
  f.task('task-a');
  const request = input(seq, [id], { tasks: [{ taskId: 'task-a', reason: 'Inspect entire observation' }] });
  let rounds = 0, first;
  while (changeCoverage(f.db, seq).remaining) {
    assert.deepEqual(page(f.db, seq), [id]);
    assert.equal(hasInformationDispatch(f.db, seq), false);
    assert.equal(hasInformationDispatch(f.db, seq, [id]), false);
    const result = dispatchInformation(f.db, request);
    first ??= result;
    assert.equal(result.replayed, false);
    assert.equal(dispatchInformation(f.db, request).replayed, true);
    assert.deepEqual(result.deliveries.map(row => row.changeSeq), first.deliveries.map(row => row.changeSeq));
    assert.equal(hasInformationDispatch(f.db, seq), true);
    acknowledgeEvidenceDelivery(f.db, seq, OWNER);
    f.restart();
    assert.ok(++rounds < 10);
  }
  assert.ok(rounds > 1);
  assert.equal(rows(f.db, 'information_dispatches').length, rounds);
  assert.equal(rows(f.db, 'information_deliveries').length, 2);
  assert.equal(deliveryRows(f.db).length, 2);
  assert.equal(hasInformationDispatch(f.db, seq), true);
  consume(f.db, seq);
  assert.equal(dispatchInformation(f.db, request).replayed, true);
  for (const row of first.deliveries) {
    const cursor = f.db.prepare('SELECT consumed_offset,done FROM context_change_evidence WHERE change_seq=?').get(row.changeSeq);
    assert.equal(cursor.consumed_offset, 0); assert.equal(cursor.done, 0);
    assert.equal(nextEvidencePage(f.db, row.changeSeq)[0].contentRange.start, 0);
    assert.ok(!sourceRow(f.db, row.changeSeq).metadata_json.includes('contentRange'));
  }
});

test('complete-delivery requests cannot include unseen members outside the current source page', t => {
  const f = fixture(t), ids = [f.evidence('Read first'), f.evidence('Not read yet')], seq = f.source(ids);
  const current = page(f.db, seq, 1), unseen = ids.find(id => !current.includes(id));
  for (const requested of [ids, [unseen]]) {
    assert.throws(() => dispatchInformation(f.db, input(seq, requested, { knowledge: false })), /current source page/);
    assert.equal(hasInformationDispatch(f.db, seq), false);
    assert.equal(hasInformationDispatch(f.db, seq, [unseen]), false);
    assert.equal(deliveryRows(f.db).length, 0);
  }
  dispatchInformation(f.db, input(seq, current, { knowledge: false }));
  assert.equal(hasInformationDispatch(f.db, seq), true);
  assert.equal(hasInformationDispatch(f.db, seq, [unseen]), false);
  acknowledgeEvidenceDelivery(f.db, seq, OWNER);
  assert.deepEqual(page(f.db, seq), [unseen]);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  dispatchInformation(f.db, input(seq, [unseen], { knowledge: false }));
  assert.equal(hasInformationDispatch(f.db, seq), true);
});

test('transport dedup records later-page impact decisions but does not re-wake the same acknowledged task', t => {
  const f = fixture(t), id = f.evidence('Source observation with more detail. '.repeat(160)), seq = f.source([id]);
  f.task('task-a');
  const request = input(seq, [id], { knowledge: false, tasks: [{ taskId: 'task-a', reason: 'Initial impact' }] });
  page(f.db, seq);
  const first = dispatchInformation(f.db, request);
  consume(f.db, first.deliveries[0].changeSeq);
  acknowledgeEvidenceDelivery(f.db, seq, OWNER);
  page(f.db, seq);
  const later = dispatchInformation(f.db, { ...request, tasks: [{ taskId: 'task-a', reason: 'Later passage changes the interpretation' }] });
  assert.notEqual(later.dispatchId, first.dispatchId);
  assert.equal(later.deliveries[0].changeSeq, first.deliveries[0].changeSeq);
  assert.equal(later.deliveries[0].status, 'acknowledged');
  assert.equal(deliveryRows(f.db).length, 1);
  assert.equal(rows(f.db, 'information_dispatches').length, 2);
  assert.equal(hasInformationDispatch(f.db, seq), true);
});

test('knowledge-only, task-only, and explicit no-consumer decisions are all durable', t => {
  const f = fixture(t); f.task('task-a');
  for (const choice of [
    { knowledge: true, tasks: [] },
    { knowledge: false, tasks: [{ taskId: 'task-a', reason: 'One-time task input' }] },
    { knowledge: false, tasks: [] },
  ]) {
    const id = f.evidence(), seq = f.source([id]);
    const result = dispatchInformation(f.db, input(seq, [id], choice));
    assert.equal(result.deliveries.length, Number(choice.knowledge) + choice.tasks.length);
    assert.equal(hasInformationDispatch(f.db, seq, [id]), true);
    assert.equal(Boolean(f.db.prepare('SELECT 1 FROM graph_enrichment_queue WHERE evidence_id=?').get(id)), choice.knowledge);
  }
  const empty = f.source([]);
  assert.equal(dispatchInformation(f.db, input(empty, [], { knowledge: false })).deliveries.length, 0);
  assert.equal(hasInformationDispatch(f.db, empty), true);
});

test('source authority requires trusted session, actual lease owner and strictly unexpired valid lease', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  const valid = sourceRow(f.db, seq);
  const variants = [
    { sessionKey: 'forged', pattern: /not owned/ }, { leaseOwner: 'wrong', pattern: /active lease/ },
    { status: 'pending' }, { status: 'acknowledged' }, { until: NOW },
    { until: '2000-01-01' }, { until: null }, { until: 'invalid date' },
  ];
  for (const variant of variants) {
    f.db.prepare('UPDATE context_changes SET status=?,lease_until=? WHERE seq=?')
      .run(variant.status ?? valid.status, Object.hasOwn(variant, 'until') ? variant.until : valid.lease_until, seq);
    assert.throws(() => dispatchInformation(f.db, input(seq, [id], {
      sessionKey: variant.sessionKey ?? SESSION, leaseOwner: variant.leaseOwner ?? OWNER,
    })), variant.pattern ?? /active lease/);
    assert.equal(tableExists(f.db, 'information_dispatches'), false);
    assert.equal(deliveryRows(f.db).length, 0);
  }
  assert.throws(() => dispatchInformation(f.db, input(999999, [id])), /Unknown source/);
});

test('only authoritative source members can be sent, even if capped metadata asserts another ID', t => {
  const f = fixture(t), id = f.evidence(), foreign = f.evidence('Unrelated');
  const seq = f.source([id]);
  f.db.prepare('UPDATE context_changes SET metadata_json=? WHERE seq=?')
    .run(JSON.stringify({ evidenceIds: [foreign, 'invented'], deliveryPolicy: COMPLETE_EVIDENCE_POLICY }), seq);
  for (const candidate of [foreign, 'invented']) {
    assert.throws(() => dispatchInformation(f.db, input(seq, [candidate])), /not bound/);
  }
  assert.equal(deliveryRows(f.db).length, 0);
  assert.equal(dispatchInformation(f.db, input(seq, [id])).deliveries.length, 1);
});

test('legacy sources may bind evidence by evidence_id or stored metadata before cursor adoption', t => {
  const f = fixture(t), a = f.evidence(), b = f.evidence('Another');
  const seq = f.source([a, b], { metadata: { evidenceIds: [b] }, evidenceId: a });
  f.db.prepare('DELETE FROM context_change_evidence WHERE change_seq=?').run(seq);
  assert.equal(dispatchInformation(f.db, input(seq, [a, b])).deliveries.length, 1);
  assert.equal(hasInformationDispatch(f.db, seq, [a, b]), true);
});

test('validate every target before publish; unknown and inactive targets create no fallback sessions', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  f.task('task-a'); f.task('inactive');
  f.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE task_id='inactive'").run();
  const before = rows(f.db, 'conversation_bindings');
  for (const taskId of ['unknown', 'inactive']) {
    assert.throws(() => dispatchInformation(f.db, input(seq, [id], {
      tasks: [{ taskId: 'task-a', reason: 'Valid' }, { taskId, reason: 'Invalid' }],
    })), /No active bound task session/);
    assert.deepEqual(rows(f.db, 'conversation_bindings'), before);
    assert.equal(rows(f.db, 'graph_enrichment_queue').length, 0);
    assert.equal(deliveryRows(f.db).length, 0);
    assert.equal(hasInformationDispatch(f.db, seq), false);
  }
});

test('failure after knowledge and first task publication rolls back the entire fanout and cold promotion', t => {
  const f = fixture(t), a = f.evidence(), b = f.evidence('New raw input'), seq = f.source([a, b]);
  f.task('task-a'); f.task('task-b'); seedQueue(f.db, a, 'cold');
  ensureInformationDeliverySchema(f.db);
  const before = Object.fromEntries(['context_changes', 'context_change_evidence', 'conversation_bindings', 'graph_enrichment_queue']
    .map(table => [table, rows(f.db, table)]));
  f.db.exec(`CREATE TRIGGER fail_second_task BEFORE INSERT ON context_changes
    WHEN NEW.kind='task_progress_due' AND json_extract(NEW.metadata_json,'$.taskId')='task-b'
    BEGIN SELECT RAISE(ABORT,'injected second recipient failure'); END;`);
  const request = input(seq, [a, b], { tasks: [{ taskId: 'task-a', reason: 'A' }, { taskId: 'task-b', reason: 'B' }] });
  assert.throws(() => dispatchInformation(f.db, request), /injected second recipient failure/);
  for (const [table, content] of Object.entries(before)) assert.deepEqual(rows(f.db, table), content);
  assert.equal(rows(f.db, 'information_dispatches').length, 0);
  assert.equal(rows(f.db, 'information_deliveries').length, 0);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  f.db.exec('DROP TRIGGER fail_second_task');
  f.restart();
  assert.equal(dispatchInformation(f.db, request).deliveries.length, 3);
});

test('receipt linkage failure rolls back events and savepoint does not roll back caller work', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  ensureInformationDeliverySchema(f.db);
  f.db.exec(`CREATE TRIGGER fail_link BEFORE INSERT ON information_deliveries
    BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.db.prepare("UPDATE context_changes SET ack_note='caller-owned edit' WHERE seq=?").run(seq);
    assert.throws(() => dispatchInformation(f.db, input(seq, [id])), /injected receipt failure/);
    assert.equal(sourceRow(f.db, seq).ack_note, 'caller-owned edit');
    assert.equal(deliveryRows(f.db).length, 0);
    assert.equal(rows(f.db, 'information_dispatches').length, 0);
    f.db.exec('COMMIT');
  } catch (error) { f.db.exec('ROLLBACK'); throw error; }
});

test('caller rollback also removes a successful dispatch', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  f.db.exec('BEGIN IMMEDIATE');
  dispatchInformation(f.db, input(seq, [id]));
  assert.equal(hasInformationDispatch(f.db, seq), true);
  f.db.exec('ROLLBACK');
  assert.equal(hasInformationDispatch(f.db, seq), false);
  assert.equal(deliveryRows(f.db).length, 0);
});

test('raw evidence queues without cloning annotations; completed reviews and leases remain byte-identical', t => {
  const f = fixture(t), ids = Array.from({ length: 6 }, (_, i) => f.evidence(`Review state ${i}`));
  seedQueue(f.db, ids[0], 'completed');
  seedQueue(f.db, ids[1], 'leased', { leaseOwner: 'curator', leaseUntil: '2099-01-01' });
  seedQueue(f.db, ids[2], 'cold');
  seedQueue(f.db, ids[3], 'cold', { leaseOwner: 'reserved', leaseUntil: '2099-01-01' });
  const hash = sha256(f.db.prepare('SELECT content FROM evidence WHERE id=?').get(ids[4]).content);
  f.db.prepare(`INSERT INTO graph_episode_annotations
    (evidence_id,content_hash,review_status,status,summary,updated_at) VALUES(?,?,'completed','ready','Preserve reviewed meaning',?)`)
    .run(ids[4], hash, NOW);
  const existing = rows(f.db, 'graph_enrichment_queue'), annotations = rows(f.db, 'graph_episode_annotations');
  dispatchInformation(f.db, input(f.source(ids), ids));
  const queues = rows(f.db, 'graph_enrichment_queue');
  for (const index of [0, 1, 3]) assert.deepEqual(queues.find(row => row.evidence_id === ids[index]), existing.find(row => row.evidence_id === ids[index]));
  assert.equal(queues.find(row => row.evidence_id === ids[2]).status, 'pending');
  assert.equal(queues.find(row => row.evidence_id === ids[4]).status, 'completed');
  assert.equal(queues.find(row => row.evidence_id === ids[5]).status, 'pending');
  assert.deepEqual(rows(f.db, 'graph_episode_annotations'), annotations);
});

test('completed same-content knowledge has a satisfied proof receipt with no review wakeup, including replay', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  seedQueue(f.db, id, 'completed');
  const queue = rows(f.db, 'graph_enrichment_queue');
  const first = dispatchInformation(f.db, input(seq, [id]));
  assert.equal(first.deliveries.length, 1);
  const receipt = first.deliveries[0];
  assert.equal(receipt.status, 'acknowledged');
  assert.equal(receipt.satisfied, true);
  assert.deepEqual(receipt.reviewProofs, [{ evidenceId: id, contentHash: queue[0].content_hash,
    table: 'graph_enrichment_queue', status: 'completed', completedAt: NOW }]);
  const event = sourceRow(f.db, receipt.changeSeq);
  assert.equal(event.acknowledged_at, NOW);
  assert.match(event.ack_note, /existing review/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM context_change_evidence WHERE change_seq=?').get(event.seq).n, 0);
  assert.equal(nextAttentionSession(f.store, { readyOnly: true, now: NOW }), null);
  assert.deepEqual(rows(f.db, 'graph_enrichment_queue'), queue);
  assert.equal(hasInformationDispatch(f.db, seq), true);
  assert.equal(rows(f.db, 'information_deliveries')[0].change_seq, event.seq);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  consume(f.db, seq);
  f.restart();
  const replay = dispatchInformation(f.db, input(seq, [id]));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.deliveries, first.deliveries);
  const duplicate = dispatchInformation(f.db, input(f.source([id]), [id]));
  assert.deepEqual(duplicate.deliveries, first.deliveries);
  assert.equal(deliveryRows(f.db).length, 1);
  assert.equal(nextAttentionSession(f.store, { readyOnly: true, now: NOW }), null);
});

test('mixed knowledge fanout partitions completed proofs from pending review while tasks receive all evidence', t => {
  const f = fixture(t), completed = f.evidence('Reviewed'), annotated = f.evidence('Reviewed without queue'), raw = f.evidence('Not reviewed');
  const ids = [raw, completed, annotated]; f.task('task-a');
  seedQueue(f.db, completed, 'completed');
  const hash = sha256(f.db.prepare('SELECT content FROM evidence WHERE id=?').get(annotated).content);
  f.db.prepare(`INSERT INTO graph_episode_annotations
    (evidence_id,content_hash,review_status,status,annotation_version,summary,updated_at)
    VALUES(?,?,'completed','ready',4,'Existing reviewed meaning',?)`).run(annotated, hash, NOW);
  const annotationsBefore = rows(f.db, 'graph_episode_annotations');
  const completedBefore = rows(f.db, 'graph_enrichment_queue');
  const result = dispatchInformation(f.db, input(f.source(ids), ids, { tasks: [{ taskId: 'task-a', reason: 'Task relevance is independent' }] }));
  const knowledge = result.deliveries.filter(row => row.purpose === 'knowledge_review_due');
  assert.equal(knowledge.length, 2);
  const satisfied = knowledge.find(row => row.satisfied), pending = knowledge.find(row => !row.satisfied);
  assert.deepEqual(satisfied.evidenceIds, [completed, annotated].sort());
  assert.equal(satisfied.status, 'acknowledged');
  assert.deepEqual(satisfied.reviewProofs.find(proof => proof.evidenceId === annotated), {
    evidenceId: annotated, contentHash: hash, table: 'graph_episode_annotations', status: 'completed',
    annotationVersion: 4, updatedAt: NOW,
  });
  assert.deepEqual(pending.evidenceIds, [raw]); assert.equal(pending.status, 'pending');
  assert.deepEqual(nextEvidencePage(f.db, pending.changeSeq).map(row => row.id), [raw]);
  const task = result.deliveries.find(row => row.taskId === 'task-a');
  assert.deepEqual(task.evidenceIds, ids.sort()); assert.equal(task.status, 'pending');
  assert.deepEqual(rows(f.db, 'graph_episode_annotations'), annotationsBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM graph_enrichment_queue WHERE evidence_id=?').get(completed), completedBefore[0]);
  assert.equal(f.db.prepare('SELECT status FROM graph_enrichment_queue WHERE evidence_id=?').get(annotated).status, 'completed');
  assert.equal(rows(f.db, 'evidence').length, 3);
  assert.equal(rows(f.db, 'graph_facts').length, 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('stale knowledge queue hashes fail atomically without stealing completed reviews or leases', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  seedQueue(f.db, id, 'leased', { contentHash: 'old-hash', leaseOwner: 'curator', leaseUntil: '2099-01-01' });
  const before = rows(f.db, 'graph_enrichment_queue');
  assert.throws(() => dispatchInformation(f.db, input(seq, [id])), /revision mismatch/);
  assert.deepEqual(rows(f.db, 'graph_enrichment_queue'), before);
  assert.equal(deliveryRows(f.db).length, 0);
});

test('knowledge delivery preserves an existing stable curator binding and rejects inactive bindings', t => {
  const f = fixture(t), id = f.evidence();
  const binding = f.store.bindWorkSession({ provider: 'shadow', routeKey: 'knowledge-curation', kind: 'workstream',
    sessionKey: 'agent:main:shadow:workstream:existing-curator', metadata: { keep: 'existing session metadata' } });
  const result = dispatchInformation(f.db, input(f.source([id]), [id]));
  assert.equal(result.deliveries[0].sessionKey, binding.session_key);
  assert.deepEqual(f.db.prepare('SELECT * FROM conversation_bindings WHERE id=?').get(binding.id), binding);
  f.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE id=?").run(binding.id);
  const next = f.source([id]);
  assert.throws(() => dispatchInformation(f.db, input(next, [id])), /Knowledge-curation session is not active/);
  assert.equal(hasInformationDispatch(f.db, next), false);
});

test('exact committed replay remains valid after recipient closure without reopening or republishing it', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]); f.task('task-a');
  const request = input(seq, [id], { knowledge: false, tasks: [{ taskId: 'task-a', reason: 'Explicit dependency' }] });
  const first = dispatchInformation(f.db, request);
  consume(f.db, first.deliveries[0].changeSeq); consume(f.db, seq);
  f.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE task_id='task-a'").run();
  const bindings = rows(f.db, 'conversation_bindings');
  f.restart();
  const replay = dispatchInformation(f.db, { ...request, leaseOwner: 'restarted-controller' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.deliveries[0].status, 'acknowledged');
  assert.equal(replay.dispatchId, first.dispatchId);
  assert.deepEqual(rows(f.db, 'conversation_bindings'), bindings);
  assert.equal(deliveryRows(f.db).length, 1);
});

test('new evidence identity or content revision is not mistaken for a delivered version', t => {
  const f = fixture(t), a = f.evidence('Same text'), b = f.evidence('Same text'); f.task('task-a');
  const seq = f.source([a, b]);
  const request = input(seq, [a, b], { knowledge: false, tasks: [{ taskId: 'task-a', reason: 'Check current version' }] });
  dispatchInformation(f.db, request);
  assert.equal(rows(f.db, 'information_deliveries').length, 2);
  // Simulate a corrupt/legacy mutable source to prove revision fencing, not a supported write path.
  f.db.prepare("UPDATE evidence SET content='Changed source body' WHERE id=?").run(a);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  assert.equal(hasInformationDispatch(f.db, seq, [b]), true);
  assert.deepEqual(getInformationTaskTargets(f.db, [a]), []);
  f.db.prepare("UPDATE context_changes SET lease_until='2000-01-01' WHERE seq=?").run(seq);
  assert.throws(() => dispatchInformation(f.db, request), /active lease/);
  f.db.prepare("UPDATE context_changes SET lease_until='2099-01-01' WHERE seq=?").run(seq);
  const revised = dispatchInformation(f.db, request);
  assert.equal(revised.replayed, false);
  assert.equal(rows(f.db, 'information_deliveries').length, 3);
  assert.equal(hasInformationDispatch(f.db, seq), true);
});

test('curator lookup returns only explicit active task targets, including after independent ACK and restart', t => {
  const f = fixture(t), a = f.evidence('A'), b = f.evidence('B');
  f.task('task-a'); f.task('task-b'); f.task('unrelated');
  const result = dispatchInformation(f.db, input(f.source([a, b]), [a, b], { tasks: [
    { taskId: 'task-b', reason: 'B dependency' }, { taskId: 'task-a', reason: 'A dependency' },
  ] }));
  for (const delivery of result.deliveries) consume(f.db, delivery.changeSeq);
  f.restart();
  const reader = openDatabaseReadOnly(f.file);
  try {
    const targets = getInformationTaskTargets(reader.db, [b, a, a]);
    assert.deepEqual(targets.map(row => row.taskId), ['task-a', 'task-b']);
    assert.deepEqual(targets[0].evidenceIds, [a, b].sort());
    assert.deepEqual(targets[0].reasons, ['A dependency']);
    assert.equal(targets[0].deliveryChangeSeqs.length, 1);
    assert.equal(hasInformationDispatch(reader.db, result.sourceChangeSeq, [a, b]), true);
  } finally { reader.close(); }
  f.db.prepare("UPDATE conversation_bindings SET status='closed' WHERE task_id='task-a'").run();
  assert.deepEqual(getInformationTaskTargets(f.db, a).map(row => row.taskId), ['task-b']);
  assert.deepEqual(getInformationTaskTargets(f.db, 'invented'), []);
});

test('delivered wakeups cannot feed fanout even after metadata or kind is stripped', t => {
  const f = fixture(t), id = f.evidence(); f.task('task-a');
  const result = dispatchInformation(f.db, input(f.source([id]), [id], { tasks: [{ taskId: 'task-a', reason: 'Dependency' }] }));
  for (const delivery of result.deliveries) {
    f.db.prepare("UPDATE context_changes SET status='leased',lease_owner=?,lease_until='2099-01-01' WHERE seq=?").run(OWNER, delivery.changeSeq);
    const request = input(delivery.changeSeq, [id], { sessionKey: delivery.sessionKey });
    assert.throws(() => dispatchInformation(f.db, request), /Delivered events/);
    f.db.prepare("UPDATE context_changes SET kind='evidence_batch_ingested',metadata_json='{}' WHERE seq=?").run(delivery.changeSeq);
    assert.throws(() => dispatchInformation(f.db, request), /Delivered events/);
  }
  assert.equal(rows(f.db, 'information_dispatches').length, 1);
  for (const kind of ['knowledge_review_due', 'knowledge_delta_due', 'task_progress_due']) {
    const seq = f.source([id], { kind });
    assert.throws(() => dispatchInformation(f.db, input(seq, [id])), /Delivered events/);
  }
});

test('invalid request shapes and ambiguous task reasons never persist a decision', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]);
  const invalid = [
    { sourceChangeSeq: 0 }, { sourceChangeSeq: '1' }, { sessionKey: '' }, { leaseOwner: '' },
    { evidenceIds: [null] }, { evidenceIds: 'id' }, { evidenceIds: [] }, { knowledge: 'false' },
    { tasks: null }, { tasks: [{ taskId: 'task', reason: '' }] },
    { tasks: [{ taskId: 'task', reason: 'One' }, { taskId: 'task', reason: 'Two' }] },
    { rationale: ' ' }, { now: 'not a timestamp' },
  ];
  for (const override of invalid) assert.throws(() => dispatchInformation(f.db, input(seq, [id], override)));
  assert.equal(tableExists(f.db, 'information_dispatches'), false);
  assert.equal(deliveryRows(f.db).length, 0);
});
