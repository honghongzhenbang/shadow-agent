import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { emitContextChange } from '../src/context-graph.mjs';
import { appendChangeEvidence, changeCoverage, COMPLETE_EVIDENCE_POLICY } from '../src/context-delivery.mjs';
import { dispatchInformation, hasInformationDispatch } from '../src/information-delivery.mjs';
import { resolveTaskOwnerSession } from '../src/agent-operations.mjs';
import { routePendingContextChanges, releaseAttentionLease } from '../src/work-sessions.mjs';
import { completeKnowledgeAnnotation, leaseKnowledgeEnrichment } from '../openclaw/shadow-work/src/epistemic.js';
import { isolatedShadowPlugin } from './helpers/shadow-plugin.mjs';

const { attentionPacket, acknowledgeChanges, recordTaskCheckpoint } = await isolatedShadowPlugin();
const SOURCE_SESSION = 'agent:main:shadow:conversation:integration';
const PAST = '2000-01-01T00:00:00.000Z';
const tempParent = fs.realpathSync(os.tmpdir());

function removeTemporary(root) {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), tempParent);
  assert.ok(path.basename(resolved).startsWith('shadow-information-integration-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

// Keep the real logger/Feishu/daemon modules, but relocate log files out of the checkout.
// SQLite, routing, enrichment, checkpoints and ACKs are never mocked.
const logRoot = fs.mkdtempSync(path.join(tempParent, 'shadow-information-integration-logs-'));
after(() => removeTemporary(logRoot));
const originalLoggerUrl = new URL('../src/logger.mjs', import.meta.url).href;
const loggerUrl = `${originalLoggerUrl}?information-integration`;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === loggerUrl && specifier === './paths.mjs') return {
    shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export const PROJECT_ROOT=${JSON.stringify(logRoot)};`)}`,
  };
  const resolved = next(specifier, context);
  return resolved.url === originalLoggerUrl ? { ...resolved, url: loggerUrl } : resolved;
} });
let FeishuEventBridge, routePersonalMessageChanges;
try {
  ({ FeishuEventBridge } = await import('../src/realtime/feishu-events.mjs?information-integration'));
  ({ routePersonalMessageChanges } = await import('../src/daemon.mjs?information-integration'));
} finally { hook.deregister(); }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tempParent, 'shadow-information-integration-'));
  const config = { projectRoot: root, databasePath: path.join(root, 'context.sqlite'),
    workboardDatabasePath: path.join(root, 'workboard.sqlite'), reuseConnections: false,
    collection: { maxEvidenceChars: 16000 }, contextGraph: {}, tracking: {},
    feishu: { realtime: { enabled: false }, outboundMessages: { mode: 'hitl', senderIdentity: 'bot' } } };
  let store = openDatabase(config.databasePath), serial = 0;
  store.setSetting('contextGraph:version', 'epistemic-context-v4');
  const board = new DatabaseSync(config.workboardDatabasePath);
  board.exec(`CREATE TABLE workboard_cards(id TEXT PRIMARY KEY,title TEXT,status TEXT,archived_at INTEGER,
    execution_status TEXT,execution_session_key TEXT,execution_run_id TEXT,automation_json TEXT,
    notes TEXT,priority TEXT,updated_at INTEGER);`);
  t.after(() => { board.close(); store.close(); removeTemporary(root); });
  return {
    get store() { return store; }, get db() { return store.db; }, board, config,
    restart() { store.close(); store = openDatabase(config.databasePath); },
    evidence(content = 'One-time observation; no new authorization.', metadata = {}) {
      const source = store.upsertSource({ sourceKey: 'integration-source', kind: 'feishu', uri: 'test:integration' });
      return store.addEvidence({ sourceId: source.id, kind: 'feishu_message', externalId: `message-${++serial}`,
        content, title: 'Integration observation', sourceLocator: `test:integration:${serial}`, metadata }).id;
    },
    source(ids) {
      return emitContextChange(store.db, { eventKey: `integration-source:${++serial}`, coalesceKey: 'integration-source',
        kind: 'evidence_batch_ingested', sessionKey: SOURCE_SESSION, notBefore: PAST, summary: 'Source evidence',
        evidenceId: ids.at(-1), metadata: { evidenceIds: ids, deliveryPolicy: COMPLETE_EVIDENCE_POLICY } }).seq;
    },
    task(id, status = 'running') {
      board.prepare("INSERT INTO workboard_cards VALUES(?,?,?,NULL,NULL,NULL,NULL,'{}','','normal',?)").run(id, id, status, Date.now());
      return resolveTaskOwnerSession(store, { id, title: id }).sessionKey;
    },
    packet(sessionKey, leaseOwner) { return attentionPacket(store.db, config, { sessionKey, leaseOwner, limit: 1, maxBytes: 16384 }); },
    ack(seq, leaseOwner, disposition = 'processed') {
      return acknowledgeChanges(store.db, { sequences: [seq], leaseOwner, disposition, note: 'Integration test consumed the delivered page.' }, config);
    },
    checkpoint(delivery, leaseOwner) {
      const current = store.db.prepare('SELECT * FROM work_task_attention WHERE card_id=?').get(delivery.taskId);
      return recordTaskCheckpoint(store.db, config, { taskId: delivery.taskId, changeSeq: delivery.changeSeq, leaseOwner,
        ownerSessionKey: delivery.sessionKey, expectedCheckpointRevision: current.checkpoint_revision,
        expectedBindingRevision: current.binding_revision, expectedExecution: { runId: null, sessionKey: null },
        resultState: 'unchanged', resultSummary: 'Checked the original evidence; acceptance remains unverified.',
        evidenceIds: delivery.evidenceIds,
        continuation: { kind: 'internal_review', summary: 'Recheck the same task against later acceptance evidence.',
          nextReviewAt: new Date(Date.now() + 3600000).toISOString() },
      }, { sessionKey: delivery.sessionKey });
    },
  };
}

function row(f, seq) { return f.db.prepare('SELECT * FROM context_changes WHERE seq=?').get(seq); }
function request(seq, ids, tasks = [], owner = 'source-owner') {
  return { sourceChangeSeq: seq, sessionKey: SOURCE_SESSION, leaseOwner: owner, evidenceIds: ids,
    knowledge: true, tasks: tasks.map(taskId => ({ taskId, reason: 'Explicit dependency on these observations.' })),
    rationale: 'Knowledge and existing tasks independently need the original evidence.' };
}
function review(f, id, owner) {
  return completeKnowledgeAnnotation(f.db, { evidenceId: id, leaseOwner: owner,
    summary: 'A one-time observation, not evidence of durable completion.',
    keywords: ['observation', 'acceptance', 'scope'], retrievalCues: ['What was observed?', 'Was acceptance verified?'],
    graphReview: { status: 'completed', outcome: 'no_durable_facts', rationale: 'No enduring assertion is supported.' } });
}

for (const first of ['curator', 'task']) test(`real ${first}-first consumption leaves other leases and source ACK independent across restart`, t => {
  const f = fixture(t), ids = [f.evidence('First observation.'), f.evidence('Second observation.')];
  f.task('task-a'); f.task('task-b', 'blocked');
  const cards = f.board.prepare('SELECT * FROM workboard_cards ORDER BY id').all();
  const seq = f.source(ids);
  assert.equal(f.packet(SOURCE_SESSION, 'source-owner').changes[0].seq, seq);
  assert.throws(() => f.ack(seq, 'source-owner'), /shadow_information_dispatch/);
  const input = request(seq, ids, ['task-a', 'task-b']), sent = dispatchInformation(f.db, input);
  const curator = sent.deliveries.find(item => item.purpose === 'knowledge_review_due');
  const taskA = sent.deliveries.find(item => item.taskId === 'task-a');
  const taskB = sent.deliveries.find(item => item.taskId === 'task-b');
  routePendingContextChanges(f.store);
  for (const [delivery, owner] of [[curator, 'curator-owner'], [taskA, 'task-owner-a'], [taskB, 'task-owner-b']]) {
    const packet = f.packet(delivery.sessionKey, owner);
    assert.equal(packet.changes[0].seq, delivery.changeSeq);
    assert.deepEqual(new Set(packet.changes[0].evidence.map(item => item.id)), new Set(ids));
  }
  assert.throws(() => f.ack(taskA.changeSeq, 'task-owner-a'), /shadow_task_checkpoint/);
  const consumeCurator = () => {
    assert.equal(leaseKnowledgeEnrichment(f.db, { evidenceIds: ids, leaseOwner: 'curator-owner' }).count, 2);
    for (const id of ids) assert.equal(review(f, id, 'curator-owner').queueStatus, 'completed');
    assert.equal(f.ack(curator.changeSeq, 'curator-owner').updated, 1);
  };
  const consumeTask = () => {
    assert.equal(f.checkpoint(taskA, 'task-owner-a').applied, true);
    assert.equal(f.ack(taskA.changeSeq, 'task-owner-a').updated, 1);
  };
  (first === 'curator' ? consumeCurator : consumeTask)();
  const other = first === 'curator' ? taskA : curator;
  assert.equal(row(f, other.changeSeq).status, 'leased');
  assert.equal(row(f, taskB.changeSeq).status, 'leased');
  assert.equal(row(f, seq).status, 'leased');
  assert.equal(changeCoverage(f.db, other.changeSeq).remaining, 2);
  f.restart();
  const replay = dispatchInformation(f.db, { ...input, evidenceIds: [...ids].reverse(), tasks: [...input.tasks].reverse() });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.deliveries.map(item => item.changeSeq), sent.deliveries.map(item => item.changeSeq));
  (first === 'curator' ? consumeTask : consumeCurator)();
  assert.equal(f.ack(seq, 'source-owner').updated, 1);
  assert.equal(row(f, taskB.changeSeq).status, 'leased');
  assert.equal(f.checkpoint(taskB, 'task-owner-b').applied, true);
  assert.equal(f.ack(taskB.changeSeq, 'task-owner-b').updated, 1);
  assert.equal(f.ack(taskB.changeSeq, 'task-owner-b').updated, 0);
  assert.deepEqual(f.board.prepare('SELECT * FROM workboard_cards ORDER BY id').all(), cards);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM graph_facts').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM context_changes').get().n, 4);
  assert.equal(f.packet(curator.sessionKey, 'later-curator').count, 0);
});

test('actual source defer/reclaim replays dispatch without duplicate publication or stale-owner ACK', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]); f.task('task-a');
  f.packet(SOURCE_SESSION, 'source-owner');
  const input = request(seq, [id], ['task-a']), first = dispatchInformation(f.db, input);
  assert.equal(f.ack(seq, 'source-owner', 'deferred').updated, 1);
  assert.equal(changeCoverage(f.db, seq).completed, 0);
  f.restart();
  f.packet(SOURCE_SESSION, 'replacement-owner');
  assert.throws(() => dispatchInformation(f.db, { ...input, rationale: 'A different decision from the obsolete owner.' }), /active lease/);
  const replay = dispatchInformation(f.db, { ...input, leaseOwner: 'replacement-owner' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.deliveries.map(item => item.changeSeq), first.deliveries.map(item => item.changeSeq));
  assert.equal(f.ack(seq, 'source-owner').updated, 0);
  assert.equal(f.ack(seq, 'replacement-owner').updated, 1);
  for (const delivery of first.deliveries) assert.equal(row(f, delivery.changeSeq).status, 'pending');
});

test('expired curator event and enrichment leases recover independently without stealing the task lease', t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]); f.task('task-a');
  f.packet(SOURCE_SESSION, 'source-owner');
  const sent = dispatchInformation(f.db, request(seq, [id], ['task-a'])); f.ack(seq, 'source-owner');
  const curator = sent.deliveries.find(item => !item.taskId), task = sent.deliveries.find(item => item.taskId);
  f.packet(curator.sessionKey, 'old-curator'); f.packet(task.sessionKey, 'task-owner');
  leaseKnowledgeEnrichment(f.db, { evidenceIds: [id], leaseOwner: 'old-curator' });
  f.db.prepare('UPDATE context_changes SET lease_until=? WHERE seq=?').run(PAST, curator.changeSeq);
  f.db.prepare('UPDATE graph_enrichment_queue SET lease_until=? WHERE evidence_id=?').run(PAST, id);
  assert.throws(() => f.ack(curator.changeSeq, 'old-curator'), /expired/);
  f.restart();
  assert.equal(f.packet(curator.sessionKey, 'new-curator').changes[0].seq, curator.changeSeq);
  assert.equal(leaseKnowledgeEnrichment(f.db, { evidenceIds: [id], leaseOwner: 'new-curator' }).count, 1);
  assert.throws(() => review(f, id, 'old-curator'), /leased by new-curator/);
  assert.equal(f.ack(curator.changeSeq, 'old-curator').updated, 0);
  assert.equal(review(f, id, 'new-curator').queueStatus, 'completed');
  assert.equal(f.ack(curator.changeSeq, 'new-curator').updated, 1);
  assert.equal(row(f, task.changeSeq).lease_owner, 'task-owner');
  assert.equal(changeCoverage(f.db, task.changeSeq).remaining, 1);
  assert.equal(releaseAttentionLease(f.store, 'task-owner'), 1);
  assert.equal(f.packet(task.sessionKey, 'new-task-owner').changes[0].seq, task.changeSeq);
  assert.equal(f.checkpoint(task, 'new-task-owner').applied, true);
  assert.equal(f.ack(task.changeSeq, 'new-task-owner').updated, 1);
});

test('actual attention pagination requires each source range while late arrivals and recipient cursors stay independent', t => {
  const f = fixture(t), id = f.evidence('Long source passage. '.repeat(240)), seq = f.source([id]); f.task('task-a');
  f.packet(SOURCE_SESSION, 'source-owner');
  const sent = dispatchInformation(f.db, request(seq, [id], ['task-a']));
  const lateId = f.evidence('Arrived during the first source lease.'), lateSeq = f.source([lateId]);
  assert.notEqual(lateSeq, seq);
  assert.equal(f.ack(seq, 'source-owner').updated, 1);
  assert.equal(row(f, seq).status, 'pending');
  f.restart();
  let pages = 1;
  while (row(f, seq).status !== 'acknowledged') {
    const current = f.packet(SOURCE_SESSION, 'source-owner').changes[0];
    assert.equal(current.seq, seq);
    assert.throws(() => f.ack(seq, 'source-owner'), /shadow_information_dispatch/);
    dispatchInformation(f.db, request(seq, current.evidence.map(item => item.id), ['task-a']));
    f.ack(seq, 'source-owner');
    assert.ok(++pages < 10);
  }
  assert.equal(hasInformationDispatch(f.db, lateSeq), false);
  assert.equal(row(f, lateSeq).status, 'pending');
  for (const delivery of sent.deliveries) {
    assert.equal(changeCoverage(f.db, delivery.changeSeq).completed, 0);
    const cursor = f.db.prepare('SELECT consumed_offset FROM context_change_evidence WHERE change_seq=?').get(delivery.changeSeq);
    assert.equal(cursor.consumed_offset, 0);
  }
  assert.equal(f.packet(SOURCE_SESSION, 'late-owner').changes[0].seq, lateSeq);
  dispatchInformation(f.db, request(lateSeq, [lateId], ['task-a'], 'late-owner'));
  assert.equal(f.ack(lateSeq, 'late-owner').updated, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM information_deliveries').get().n, 4);
});

for (const schedulerFails of [false, true]) test(`dedicated IM draft keeps source pending when review scheduling ${schedulerFails ? 'fails' : 'succeeds'}`, async t => {
  const f = fixture(t);
  f.evidence('Another observation in the same conversation.', { conversationKey: 'im:oc_integration', chatId: 'oc_integration' });
  let before;
  const scheduled = [];
  const bridge = new FeishuEventBridge({ store: f.store, config: f.config,
    scheduleAttention: async input => {
      scheduled.push(input);
      if (schedulerFails) throw new Error('Test-only post-draft scheduling failure');
      return { queued: true };
    },
    runAgent: async () => {
      before = f.db.prepare("SELECT * FROM context_changes WHERE kind='evidence_batch_ingested' AND json_extract(metadata_json,'$.conversationKey')='im:oc_integration'").get();
      assert.ok(before); assert.equal(before.status, 'pending');
      assert.equal(hasInformationDispatch(f.db, before.seq), false);
      return { text: 'Deterministic test reply, not a real model call.' };
    } });
  const result = await bridge.handle({ key: 'im.message.receive_v1', identity: 'bot' }, {
    type: 'im.message.receive_v1', message_id: 'om_integration', chat_id: 'oc_integration', chat_type: 'p2p',
    sender_id: 'ou_integration', sender_type: 'user', content: 'New source input relevant to existing work.',
    create_time: String(Date.now()), mentions: [],
  });
  assert.equal(result.status, 'processed');
  assert.equal(f.db.prepare('SELECT status FROM outbound_message_drafts').get().status, 'pending_confirmation');
  assert.equal(hasInformationDispatch(f.db, before.seq), false);
  assert.equal(JSON.parse(before.metadata_json).evidenceIds.length, 2);
  assert.equal(row(f, before.seq).status, 'pending', 'Creating a reply draft must not consume either undispatched source observation.');
  assert.equal(row(f, before.seq).acknowledged_at, null);
  assert.equal(scheduled.filter(item => item.reason === 'feishu-reply-source-review').length, 1);
  f.restart();
  assert.equal(row(f, before.seq).status, 'pending');
});

test('background retention cannot clear a leased complete batch or reuse the removed generic evidence ACK', t => {
  const f = fixture(t), ids = [f.evidence('One message'), f.evidence('Another message')], seq = f.source(ids);
  f.packet(SOURCE_SESSION, 'source-owner');
  const before = row(f, seq);
  assert.equal(typeof f.store.acknowledgeContextChangesForEvidence, 'undefined');
  assert.equal(f.store.retainInactiveSourceBackground(ids), 0);
  assert.equal(hasInformationDispatch(f.db, seq), false);
  assert.equal(changeCoverage(f.db, seq).remaining, 2);
  assert.deepEqual(row(f, seq), before);
});

test('inactive daemon group routing retains the whole group with explicit non-agent policy proof', t => {
  const f = fixture(t), ids = [f.evidence('First group message'), f.evidence('Second group message')], seq = f.source(ids);
  const scheduled = [];
  routePersonalMessageChanges(f.store, f.config, ids.map((id, index) => ({ conversationKey: 'im:oc_inactive', evidenceId: id,
    externalId: `om_background_${index}`, occurredAt: new Date().toISOString(), signal: 'unassigned_group', immediate: false,
  })), input => scheduled.push(input));
  assert.deepEqual(scheduled, []);
  assert.equal(row(f, seq).status, 'acknowledged');
  const proof = JSON.parse(row(f, seq).metadata_json).sourceDisposition;
  assert.equal(proof.kind, 'background_policy');
  assert.equal(proof.reason, 'inactive_feishu_group');
  assert.equal(proof.agentReviewed, false);
  assert.deepEqual(new Set(proof.evidenceIds), new Set(ids));
  assert.match(row(f, seq).ack_note, /not semantically reviewed/);
  assert.equal(hasInformationDispatch(f.db, seq), false, 'Pre-agent background policy is intentionally not semantic dispatch.');
  assert.equal(changeCoverage(f.db, seq).completed, 0);
  assert.equal(changeCoverage(f.db, seq).remaining, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, 2);
  f.restart();
  assert.deepEqual(JSON.parse(row(f, seq).metadata_json).sourceDisposition, proof);
  assert.equal(f.store.retainInactiveSourceBackground(ids), 0);
});

test('background retention requires every authoritative member, including IDs outside capped metadata', t => {
  const f = fixture(t), ids = Array.from({ length: 101 }, (_, index) => f.evidence(`Group observation ${index}`));
  const seq = f.source(ids);
  appendChangeEvidence(f.db, seq, ids);
  const metadata = JSON.parse(row(f, seq).metadata_json);
  metadata.evidenceIds = ids.slice(0, 100);
  f.db.prepare('UPDATE context_changes SET metadata_json=? WHERE seq=?').run(JSON.stringify(metadata), seq);
  const before = row(f, seq);
  assert.equal(f.store.retainInactiveSourceBackground(ids.slice(0, 100)), 0);
  assert.deepEqual(row(f, seq), before);
  assert.equal(f.store.retainInactiveSourceBackground([...ids, ids[0]]), 1);
  const proof = JSON.parse(row(f, seq).metadata_json).sourceDisposition;
  assert.equal(proof.agentReviewed, false);
  assert.deepEqual(new Set(proof.evidenceIds), new Set(ids));
  assert.equal(changeCoverage(f.db, seq).remaining, 101);
});

test('separately inactive groups cannot suppress a mixed-membership source batch', t => {
  const f = fixture(t), ids = [f.evidence('Group A message'), f.evidence('Group B message')], seq = f.source(ids);
  const before = row(f, seq), scheduled = [];
  routePersonalMessageChanges(f.store, f.config, ids.map((id, index) => ({ conversationKey: `im:oc_group_${index}`, evidenceId: id,
    externalId: `om_group_${index}`, occurredAt: new Date().toISOString(), signal: 'unassigned_group', immediate: false,
  })), input => scheduled.push(input));
  assert.deepEqual(scheduled, []);
  assert.deepEqual(row(f, seq), before);
  assert.equal(f.store.retainInactiveSourceBackground([]), 0);
  assert.equal(f.store.retainInactiveSourceBackground(['unknown-evidence']), 0);
});

for (const publish of [true, false]) test(`background policy cannot consume a pending source after ${publish ? 'recipient publication' : 'explicit no-consumer dispatch'}`, t => {
  const f = fixture(t), id = f.evidence(), seq = f.source([id]); f.task('task-a');
  f.packet(SOURCE_SESSION, 'source-owner');
  const input = request(seq, [id], publish ? ['task-a'] : []);
  input.knowledge = publish;
  const sent = dispatchInformation(f.db, input);
  f.ack(seq, 'source-owner', 'deferred');
  assert.equal(row(f, seq).status, 'pending');
  const source = row(f, seq), recipients = sent.deliveries.map(delivery => row(f, delivery.changeSeq));
  f.restart();
  assert.equal(f.store.retainInactiveSourceBackground([id]), 0);
  assert.deepEqual(row(f, seq), source);
  assert.deepEqual(sent.deliveries.map(delivery => row(f, delivery.changeSeq)), recipients);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM information_dispatches WHERE source_change_seq=?').get(seq).n, 1);
});

test('background retention ignores non-source delivery events even with matching evidence membership', t => {
  const f = fixture(t), id = f.evidence();
  const { seq } = emitContextChange(f.db, { eventKey: 'recipient-only', kind: 'task_progress_due',
    sessionKey: SOURCE_SESSION, evidenceId: id, summary: 'Recipient work', metadata: { evidenceIds: [id] } });
  const before = row(f, seq);
  assert.equal(f.store.retainInactiveSourceBackground([id]), 0);
  assert.deepEqual(row(f, seq), before);
});
