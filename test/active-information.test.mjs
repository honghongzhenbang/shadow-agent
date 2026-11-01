import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase, openDatabaseReadOnly } from '../src/db.mjs';
import { emitContextChange } from '../src/context-graph.mjs';
import { bindWorkSession } from '../src/work-sessions.mjs';
import { createActiveInformationNotifier, readActiveInformation } from '../src/active-information.mjs';

const NOW = '2026-10-23T08:00:00.000Z';
const PAST = '2026-10-23T07:00:00.000Z';
const FUTURE = '2026-10-23T09:00:00.000Z';
const SECRET = 'raw-body-and-summary-must-not-enter-the-notice';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shadow-active-information-'));
  const file = path.join(root, 'isolated.sqlite');
  let store = openDatabase(file), serial = 0;
  t.after(() => {
    store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('shadow-active-information-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  function bind(kind = 'task', routeKey = 'task-a', extra = {}) {
    return bindWorkSession(store, { kind, provider: 'shadow', routeKey,
      ...(kind === 'task' ? { taskId: routeKey } : {}), ...extra });
  }
  const binding = bind();
  const ctx = { sessionKey: binding.session_key, runId: 'native-run-1' };
  return {
    get store() { return store; }, get db() { return store.db; }, file, bind, ctx,
    restart() { store.close(); store = openDatabase(file); },
    read(input = {}) { return readActiveInformation(store.db, { ...ctx, now: NOW, ...input }); },
    event({ sessionKey = ctx.sessionKey, kind = 'task_progress_due', status = 'pending',
      notBefore = PAST, owner = null, until = null, ...extra } = {}) {
      const { seq } = emitContextChange(store.db, { eventKey: `active-input:${++serial}`, kind,
        sessionKey, notBefore, occurredAt: PAST, summary: SECRET, metadata: { private: SECRET }, ...extra });
      store.db.prepare('UPDATE context_changes SET status=?,lease_owner=?,lease_until=? WHERE seq=?')
        .run(status, owner, until, seq);
      return seq;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(f, overrides = {}) {
  const calls = { read: [], resolve: [], queue: [], receipts: [], warnings: [] };
  const notifier = createActiveInformationNotifier({
    read: async input => { calls.read.push(input); return f.read(input); },
    resolveActiveSession: async key => { calls.resolve.push(key); return 'native-session-1'; },
    queue: async (...args) => { calls.queue.push(args); return { accepted: true }; },
    logger: { warn: (...args) => calls.warnings.push(args) },
    onReceipt: async receipt => { calls.receipts.push(receipt); },
    ...overrides,
  });
  return { ...notifier, calls, fire: (ctx = f.ctx, event = {}) => notifier.afterTool(event, ctx) };
}

test('read-only SQLite projection returns newest four due rows without raw content, ACK or cursor writes', t => {
  const f = fixture(t);
  const source = f.store.upsertSource({ sourceKey: 'active-source', kind: 'test', uri: 'test:active' });
  const evidence = f.store.addEvidence({ sourceId: source.id, externalId: 'original', kind: 'test', content: SECRET,
    title: SECRET, sourceLocator: 'test:active:original' });
  const due = Array.from({ length: 7 }, () => f.event({ evidenceId: evidence.id }));
  f.event({ notBefore: FUTURE });
  f.event({ status: 'acknowledged' });
  f.event({ status: 'leased', owner: 'current-controller', until: FUTURE });
  f.event({ status: 'leased', owner: 'expired-controller', until: PAST });
  const other = f.bind('task', 'other');
  f.event({ sessionKey: other.session_key });
  const before = f.db.prepare('SELECT * FROM context_changes ORDER BY seq').all();
  const reader = openDatabaseReadOnly(f.file);
  let snapshot;
  try {
    snapshot = readActiveInformation(reader.db, { ...f.ctx, now: NOW });
    assert.throws(() => reader.db.exec('CREATE TABLE forbidden_write(x)'), /readonly/i);
  } finally { reader.close(); }
  assert.deepEqual(snapshot.events.map(event => event.seq), due.slice(-4).reverse());
  assert.equal(snapshot.latestSeq, due.at(-1));
  assert.equal(snapshot.leaseOwner, 'current-controller');
  assert.equal(snapshot.leaseConflict, false);
  assert.equal(snapshot.binding.taskId, 'task-a');
  assert.deepEqual(Object.keys(snapshot.events[0]).sort(), ['kind', 'seq']);
  assert.ok(!JSON.stringify(snapshot).includes(SECRET));
  assert.deepEqual(f.db.prepare('SELECT * FROM context_changes ORDER BY seq').all(), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM context_change_delivery').get().n, 0);
  f.restart();
  assert.deepEqual(f.read(), snapshot);
});

test('unknown, unrelated, inactive, terminal and mismatched bindings have no notice projection', t => {
  const f = fixture(t);
  for (const status of ['closed', 'inactive', 'completed', 'cancelled', 'archived']) {
    const binding = f.bind('task', status, { status });
    f.event({ sessionKey: binding.session_key });
    assert.equal(f.read({ sessionKey: binding.session_key }), null);
  }
  for (const sessionKey of [null, '', 'agent:main:main', 'agent:main:shadow:task:',
    'agent:main:shadow:task:missing', 'agent:main:shadow:task:bad\nkey']) assert.equal(f.read({ sessionKey }), null);
  f.db.prepare("UPDATE conversation_bindings SET session_kind='conversation' WHERE session_key=?").run(f.ctx.sessionKey);
  assert.equal(f.read(), null);
});

test('future, expired-leased and acknowledged rows alone are not pending notices; timestamp boundary is due', t => {
  const f = fixture(t);
  f.event({ notBefore: FUTURE });
  f.event({ status: 'leased', owner: 'expired', until: NOW });
  f.event({ status: 'acknowledged' });
  assert.deepEqual(f.read().events, []);
  assert.equal(f.read().latestSeq, null);
  assert.equal(f.read().leaseOwner, null);
  const seq = f.event({ notBefore: NOW });
  assert.equal(f.read().latestSeq, seq);
  assert.throws(() => f.read({ now: 'invalid-time' }), RangeError);
});

test('conflicting live session leases fail closed instead of choosing or stealing an owner', async t => {
  const f = fixture(t); f.event();
  f.event({ status: 'leased', owner: 'owner-a', until: FUTURE });
  const second = f.event({ status: 'leased', owner: 'owner-b', until: FUTURE });
  const h = harness(f);
  assert.equal(f.read().leaseConflict, true);
  assert.equal((await h.fire()).status, 'no_notice');
  assert.equal(h.calls.resolve.length, 0);
  f.db.prepare('UPDATE context_changes SET lease_owner=? WHERE seq=?').run('owner-a', second);
  assert.equal((await h.fire()).leaseOwner, 'owner-a');
});

test('runtime session/run identity is required; untrusted tool arguments never select a target', async t => {
  const f = fixture(t); f.event();
  const h = harness(f);
  for (const ctx of [undefined, {}, { sessionKey: f.ctx.sessionKey }, { runId: f.ctx.runId },
    { ...f.ctx, sessionKey: 'agent:main:main' }, { ...f.ctx, runId: 'bad\nrun' }]) {
    assert.equal((await h.afterTool({ params: f.ctx }, ctx)).status, 'ignored');
  }
  assert.equal(h.calls.read.length, 0);
  const result = await h.fire(f.ctx, { params: { sessionKey: 'another-session', runId: 'forged', leaseOwner: 'forged' } });
  assert.equal(result.accepted, true);
  assert.deepEqual(h.calls.resolve, [f.ctx.sessionKey]);
  assert.equal(result.runId, f.ctx.runId);
  assert.ok(!h.calls.queue[0][1].includes('forged'));
});

test('captured native session must match resolution when present; mismatch stays retryable without ACK', async t => {
  const f = fixture(t); f.event();
  const before = f.db.prepare('SELECT * FROM context_changes ORDER BY seq').all();
  for (const sessionId of [undefined, null, '', 'native-session-1']) {
    const h = harness(f);
    const receipt = await h.fire({ ...f.ctx, sessionId }, { params: { sessionId: 'forged-native-session' } });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.adopted, false);
    assert.equal(h.calls.queue[0][0], 'native-session-1');
    assert.ok(h.calls.queue[0][1].includes('no new permission'));
  }
  const h = harness(f);
  const mismatch = await h.fire({ ...f.ctx, sessionId: 'previous-native-session' },
    { params: { sessionId: 'native-session-1' } });
  assert.deepEqual(mismatch, { status: 'no_active_run', accepted: false, adopted: false });
  assert.equal(h.calls.queue.length, 0);
  assert.equal(h.calls.receipts.length, 0);
  assert.equal((await h.fire({ ...f.ctx, sessionId: 'native-session-1' })).accepted, true);
  const unavailable = harness(f, { resolveActiveSession: async () => null });
  assert.equal((await unavailable.fire({ ...f.ctx, sessionId: 'native-session-1' })).status, 'no_active_run');
  assert.equal(unavailable.calls.queue.length, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM context_changes ORDER BY seq').all(), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM context_change_delivery').get().n, 0);
});

test('no due input or authoritative terminal-task read never resolves or queues SDK work', async t => {
  const f = fixture(t), h = harness(f);
  assert.equal((await h.fire()).status, 'no_notice');
  f.event();
  const terminal = harness(f, { read: async () => null });
  assert.equal((await terminal.fire()).status, 'no_notice');
  assert.equal(h.calls.resolve.length + terminal.calls.resolve.length, 0);
  assert.equal(h.calls.queue.length + terminal.calls.queue.length, 0);
});

test('async adapters resolve the stable session and queue a bounded task notice with its existing lease', async t => {
  const f = fixture(t); const latest = f.event();
  f.event({ status: 'leased', owner: 'existing-attention-owner', until: FUTURE });
  const gate = deferred(), entered = deferred();
  const h = harness(f, { resolveActiveSession: async key => {
    assert.equal(key, f.ctx.sessionKey); entered.resolve(); await gate.promise; return 'actual-native-session';
  } });
  const pending = h.fire(); await entered.promise;
  assert.equal(h.calls.queue.length, 0);
  gate.resolve();
  const receipt = await pending;
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.adopted, false);
  assert.equal(receipt.latestSeq, latest);
  assert.equal(receipt.leaseOwner, 'existing-attention-owner');
  const [id, text, options] = h.calls.queue[0];
  assert.equal(id, 'actual-native-session');
  assert.ok(text.length < 2000);
  assert.ok(text.includes('shadow_attention_packet'));
  assert.ok(text.includes('shadow_task_checkpoint'));
  assert.ok(text.includes('existing-attention-owner'));
  assert.ok(text.includes('"limit":4'));
  assert.ok(text.includes('no new permission'));
  assert.ok(!text.includes(SECRET));
  assert.equal(options.queueIdentity, receipt.queueIdentity);
  assert.ok(options.queueIdentity.includes(f.ctx.runId));
  assert.ok(options.queueIdentity.endsWith(`:${latest}`));
  assert.equal(h.calls.receipts[0].adopted, false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE status='pending'").get().n, 1);
});

for (const kind of ['inbox', 'conversation', 'workstream']) test(`${kind} notice uses source routing/curator flow without raw input`, async t => {
  const f = fixture(t), binding = f.bind(kind, `${kind}-route`);
  const ctx = { ...f.ctx, sessionKey: binding.session_key };
  f.event({ sessionKey: ctx.sessionKey, kind: 'evidence_batch_ingested' });
  const h = harness(f), receipt = await h.fire(ctx);
  assert.equal(receipt.accepted, true);
  assert.ok(h.calls.queue[0][1].includes('shadow_information_dispatch'));
  assert.ok(h.calls.queue[0][1].includes('existing knowledge review flow'));
  assert.ok(receipt.leaseOwner.startsWith('active-information:'));
});

test('accepted notices deduplicate per native run, coalesce backlog and notify a newer due sequence', async t => {
  const f = fixture(t);
  const seqs = Array.from({ length: 8 }, () => f.event());
  const h = harness(f), first = await h.fire();
  assert.deepEqual(first.sequences, seqs.slice(-4).reverse());
  assert.equal((await h.fire()).status, 'duplicate');
  assert.equal(h.calls.queue.length, 1);
  const later = f.event();
  const next = await h.fire();
  assert.equal(next.latestSeq, later);
  assert.notEqual(next.queueIdentity, first.queueIdentity);
  assert.equal(next.leaseOwner, first.leaseOwner);
  assert.equal((await h.fire({ ...f.ctx, runId: 'native-run-2' })).accepted, true);
  assert.equal(h.calls.queue.length, 3);
});

test('accepted=false and unavailable active sessions keep the same identity eligible for later retry', async t => {
  const f = fixture(t); f.event();
  let available = false, accept = false;
  const attempts = [];
  const h = harness(f, {
    resolveActiveSession: async () => available ? 'native-session' : null,
    queue: async (...args) => { attempts.push(args); return { accepted: accept }; },
  });
  assert.equal((await h.fire()).status, 'no_active_run');
  assert.equal(attempts.length, 0);
  available = true;
  const declined = await h.fire();
  assert.equal(declined.status, 'not_accepted');
  assert.equal(declined.adopted, false);
  accept = true;
  const accepted = await h.fire();
  assert.equal(accepted.queueIdentity, declined.queueIdentity);
  assert.equal(accepted.leaseOwner, declined.leaseOwner);
  assert.equal((await h.fire()).status, 'duplicate');
  assert.equal(attempts.length, 2);
});

test('concurrent tool hooks share one awaited queue attempt; subsequent arrivals remain discoverable', async t => {
  const f = fixture(t); f.event();
  const entered = deferred(), gate = deferred(); let count = 0;
  const h = harness(f, { queue: async () => { count++; entered.resolve(); await gate.promise; return { accepted: true }; } });
  const first = h.fire(); await entered.promise;
  const second = h.fire();
  const later = f.event();
  gate.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(count, 1);
  assert.equal((await h.fire()).latestSeq, later);
  assert.equal(count, 2);
});

for (const stage of ['read', 'resolve']) test(`agent_end clear during ${stage} cancels the notice and forgets only that native run`, async t => {
  const f = fixture(t); f.event();
  const entered = deferred(), gate = deferred();
  const h = harness(f, { [stage === 'read' ? 'read' : 'resolveActiveSession']: async input => {
    entered.resolve(); await gate.promise; return stage === 'read' ? f.read(input) : 'native-session';
  } });
  const pending = h.fire(); await entered.promise;
  assert.equal(h.clear(f.ctx), true);
  gate.resolve();
  assert.deepEqual(await pending, { status: 'cleared', accepted: false, adopted: false });
  assert.equal(h.calls.queue.length, 0);
  assert.equal(h.calls.receipts.length, 0);
  if (stage === 'read') assert.equal(h.calls.resolve.length, 0);
  const first = await h.fire();
  const other = { ...f.ctx, runId: 'native-run-other' };
  await h.fire(other);
  assert.equal(h.clear(f.ctx), true);
  assert.equal((await h.fire(other)).status, 'duplicate');
  assert.equal((await h.fire()).queueIdentity, first.queueIdentity);
  assert.equal(h.clear({}), false);
});

test('clear after queue entry cannot cancel that notice or disturb replacement inflight state', async t => {
  const f = fixture(t); f.event();
  const entered = [deferred(), deferred()], gates = [deferred(), deferred()]; let calls = 0;
  const h = harness(f, { queue: async () => {
    const attempt = calls++;
    if (entered[attempt]) { entered[attempt].resolve(); await gates[attempt].promise; }
    return true;
  } });
  try {
    const pending = h.fire(); await entered[0].promise;
    assert.equal(h.clear(f.ctx), true);
    const latest = f.event();
    const before = f.db.prepare('SELECT * FROM context_changes ORDER BY seq').all();
    const replacement = h.fire(); await entered[1].promise;
    gates[0].resolve();
    const oldReceipt = await pending;
    assert.equal(oldReceipt.accepted, true);
    assert.equal(oldReceipt.adopted, false);
    const shared = h.fire();
    assert.equal(h.calls.read.length, 2);
    gates[1].resolve();
    const receipt = await replacement;
    assert.deepEqual(await shared, receipt);
    assert.equal(receipt.latestSeq, latest);
    assert.equal(receipt.adopted, false);
    assert.equal((await h.fire()).status, 'duplicate');
    assert.equal(calls, 2);
    assert.deepEqual(f.db.prepare('SELECT * FROM context_changes ORDER BY seq').all(), before);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM context_change_delivery').get().n, 0);
  } finally { for (const gate of gates) gate.resolve(); }
});

test('read/resolve/queue failures are retryable; receipt/logger failures cannot cause a duplicate accepted notice', async t => {
  const f = fixture(t); f.event();
  for (const stage of ['read', 'resolve', 'queue']) {
    let fail = true;
    const name = { read: 'read', resolve: 'resolveActiveSession', queue: 'queue' }[stage];
    const h = harness(f, { [name]: async input => {
      if (fail) throw new Error(SECRET);
      return stage === 'read' ? f.read(input) : stage === 'resolve' ? 'native-session' : { accepted: true };
    } });
    assert.deepEqual(await h.fire(), { status: 'error', accepted: false, adopted: false, stage });
    assert.ok(!JSON.stringify(h.calls.warnings).includes(SECRET));
    fail = false;
    assert.equal((await h.fire()).accepted, true);
  }
  const h = harness(f, { onReceipt: async () => { throw new Error('hook failed'); },
    logger: { warn() { throw new Error('logger failed'); } } });
  assert.equal((await h.fire()).accepted, true);
  assert.equal((await h.fire()).status, 'duplicate');
  assert.equal(h.calls.queue.length, 1);
});

test('bounded idle-run cache evicts LRU with stable replay identity and never starts a replacement turn', async t => {
  const f = fixture(t); f.event();
  const h = harness(f), first = await h.fire();
  for (let i = 0; i < 128; i++) assert.equal((await h.fire({ ...f.ctx, runId: `bounded-${i}` })).accepted, true);
  assert.equal((await h.fire({ ...f.ctx, runId: 'bounded-127' })).status, 'duplicate');
  const replay = await h.fire();
  assert.equal(replay.queueIdentity, first.queueIdentity);
  assert.equal(replay.adopted, false);
  assert.equal(h.calls.queue.length, 130);
});

test('128 in-flight attempts bound memory without evicting active dedup state; a later hook may retry', async t => {
  const f = fixture(t); f.event();
  const entered = deferred(), gate = deferred(); let queued = 0;
  const h = harness(f, { queue: async () => {
    if (++queued === 128) entered.resolve();
    await gate.promise;
    return { accepted: true };
  } });
  const pending = Array.from({ length: 128 }, (_, index) => h.fire({ ...f.ctx, runId: `in-flight-${index}` }));
  try {
    assert.equal((await h.fire()).status, 'capacity');
    await entered.promise;
    assert.equal(queued, 128);
    assert.equal(h.calls.read.length, 128);
  } finally { gate.resolve(); }
  for (const attempt of pending) assert.equal((await attempt).accepted, true);
  assert.equal((await h.fire({ ...f.ctx, runId: 'in-flight-0' })).status, 'duplicate');
  assert.equal((await h.fire()).accepted, true);
  assert.equal(queued, 129);
});

test('runtime identity is captured before asynchronous work and wrong-session read results are rejected', async t => {
  const f = fixture(t); f.event();
  const h = harness(f), ctx = { ...f.ctx, sessionId: 'native-session-1' }, pending = h.fire(ctx);
  ctx.sessionKey = 'agent:main:main'; ctx.runId = 'changed'; ctx.sessionId = 'changed-native-session';
  const receipt = await pending;
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.runId, f.ctx.runId);
  assert.equal(receipt.sessionId, 'native-session-1');
  const mismatched = { ...f.ctx, sessionId: 'previous-native-session' }, rejected = harness(f).fire(mismatched);
  mismatched.sessionId = 'native-session-1';
  assert.equal((await rejected).status, 'no_active_run');
  const bad = harness(f, { read: async () => ({ ...f.read(), sessionKey: 'agent:main:main' }) });
  assert.equal((await bad.fire()).status, 'no_notice');
  assert.equal(bad.calls.resolve.length, 0);
  assert.throws(() => createActiveInformationNotifier({}), /read must be a function/);
});
