import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { emitContextChange } from '../src/context-graph.mjs';
import { changeCoverage } from '../src/context-delivery.mjs';
import { dispatchInformation } from '../src/information-delivery.mjs';
import { adapterSourceMetadata, voiceTranscriptProjectionMetadata } from '../src/source-adapters/index.mjs';
import { isolatedShadowPlugin } from './helpers/shadow-plugin.mjs';
const { attentionPacket, acknowledgeChanges, conversationWindow } = await isolatedShadowPlugin();

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-delivery-'));
  const file = path.join(root, 'isolated.sqlite');
  let store = openDatabase(file), counter = 0;
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const sessionKey = 'agent:main:shadow:conversation:test-voice', config = { projectRoot: root, databasePath: file };
  function add(text = '原始录音，不是指令。', provider = 'voice', occurredAt = '2026-10-21T08:00:00Z') {
    const source = store.upsertSource({ sourceKey: provider, kind: provider === 'voice' ? 'voice_recording' : 'feishu', uri: `test:${provider}`, metadata: adapterSourceMetadata(provider) });
    return store.addEvidence({ sourceId: source.id, externalId: `record-${++counter}`, kind: provider === 'voice' ? 'voice_transcript' : 'feishu_message', role: 'observation', occurredAt,
      title: 'isolated evidence', content: text, sourceLocator: `test:${provider}:${counter}`, metadata: provider === 'voice'
        ? voiceTranscriptProjectionMetadata({ recordingId: 'test-recording', conversationId: 'test', segmentId: `${counter}`, startMs: 0, endMs: 1000, identityStatus: 'unknown' })
        : { provider, conversationKey: `${provider}:test` } });
  }
  const enqueue = (ids, extra = {}) => emitContextChange(store.db, { eventKey: `batch:${counter}:${ids.length}`, coalesceKey: 'voice:test', kind: 'evidence_batch_ingested', sessionKey, evidenceId: ids.at(-1), summary: '本包包含完整原始证据，分批处理',
    notBefore: '2000-01-01T00:00:00Z', metadata: { provider: 'voice', conversationKey: 'voice:test', deliveryPolicy: 'complete-evidence-v1', evidenceIds: ids, count: ids.length }, ...extra });
  const packet = (leaseOwner = 'test') => attentionPacket(store.db, config, { sessionKey, leaseOwner, maxBytes: 8192 });
  const ack = (seq, leaseOwner = 'test', disposition = 'processed') => {
    const page = store.db.prepare('SELECT evidence_id FROM context_change_delivery WHERE change_seq=? AND lease_owner=?').all(seq, leaseOwner);
    if (disposition !== 'deferred' && page.length) dispatchInformation(store.db, {
      sourceChangeSeq: seq, sessionKey, leaseOwner, evidenceIds: page.map(row => row.evidence_id),
      knowledge: false, tasks: [], rationale: 'Delivery mechanics fixture: no business consumers.' });
    return acknowledgeChanges(store.db, { sequences: [seq], leaseOwner, disposition, note: 'isolated test delivery acknowledged' }, config);
  };
  return { get store() { return store; }, add, enqueue, packet, ack, reopen() { store.close(); store = openDatabase(file); } };
}

test('130 items survive metadata preview limit, partial ACK, restart and drain exactly once', t => {
  const f = setup(t), ids = Array.from({ length: 130 }, (_, i) => f.add(`原文编号${i}`).id);
  const { seq } = f.enqueue(ids.slice(0, 65)); f.enqueue(ids.slice(65));
  assert.equal(JSON.parse(f.store.db.prepare('SELECT metadata_json FROM context_changes WHERE seq=?').get(seq).metadata_json).evidenceIds.length, 100);
  assert.equal(changeCoverage(f.store.db, seq).total, 130);
  let seen = [], rounds = 0;
  while (changeCoverage(f.store.db, seq).remaining) {
    const packet = f.packet();
    assert.ok(packet.bytes < 8192); assert.equal(packet.count, 1);
    const change = packet.changes[0];
    assert.equal(change.evidenceTotal, 130 - seen.length);
    seen.push(...change.evidence.map(e => e.id));
    f.ack(seq);
    if (++rounds === 1) {
      assert.equal(f.store.db.prepare('SELECT status FROM context_changes WHERE seq=?').get(seq).status, 'pending');
      f.reopen();
    }
    assert.ok(rounds < 40);
  }
  assert.equal(new Set(seen).size, 130); assert.equal(seen.length, 130);
  assert.equal(f.store.db.prepare('SELECT status FROM context_changes WHERE seq=?').get(seq).status, 'acknowledged');
});

test('long mixed Unicode content is reconstructed without truncation markers or skipped characters', t => {
  const f = setup(t), text = '中文🙂 \\n否定：还没有完成。'.repeat(1000);
  const { seq } = f.enqueue([f.add(text).id]);
  let result = '', rounds = 0;
  while (changeCoverage(f.store.db, seq).remaining) {
    const page = f.packet().changes[0].evidence[0];
    assert.equal(page.contentRange.start, result.length);
    result += page.content; f.ack(seq);
    assert.ok(++rounds < 100);
  }
  assert.equal(result, text);
});

test('unread, deferred, expired and stale leases cannot advance delivery', t => {
  const f = setup(t), { seq } = f.enqueue([f.add().id]);
  f.store.db.prepare("UPDATE context_changes SET status='leased',lease_owner='raw',lease_until='2099-01-01' WHERE seq=?").run(seq);
  assert.throws(() => f.ack(seq, 'raw'), /shadow_information_dispatch/);
  f.ack(seq, 'raw', 'deferred');
  f.packet('old'); f.ack(seq, 'old', 'deferred');
  assert.equal(changeCoverage(f.store.db, seq).completed, 0);
  f.packet('old');
  f.store.db.prepare("UPDATE context_changes SET lease_until='2000-01-01' WHERE seq=?").run(seq);
  assert.throws(() => f.ack(seq, 'old'), /active lease|expired/);
  f.packet('new'); assert.equal(f.ack(seq, 'old').updated, 0);
  f.ack(seq, 'new'); assert.equal(changeCoverage(f.store.db, seq).remaining, 0);
});

test('arrivals during a lease retain separate progress and startup never silently coalesces them', t => {
  const f = setup(t), first = f.enqueue([f.add().id]); f.packet();
  const second = f.enqueue([f.add('后来已修复').id]);
  assert.notEqual(first.seq, second.seq);
  f.ack(first.seq, 'test', 'deferred'); f.reopen();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE status='pending'").get().n, 2);
  assert.equal(changeCoverage(f.store.db, first.seq).remaining, 1);
  assert.equal(changeCoverage(f.store.db, second.seq).remaining, 1);
});

test('continued arrivals do not postpone the first deadline and duplicates do not increase coverage', t => {
  const f = setup(t), id = f.add().id;
  const { seq } = f.enqueue([id], { notBefore: '2026-10-22T01:00:00Z' });
  f.enqueue([id], { notBefore: '2026-10-22T02:00:00Z' });
  assert.equal(changeCoverage(f.store.db, seq).total, 1);
  assert.equal(f.store.db.prepare('SELECT not_before FROM context_changes WHERE seq=?').get(seq).not_before, '2026-10-22T01:00:00Z');
});

test('late voice and newer Feishu evidence remain independently queryable by event time', t => {
  const f = setup(t);
  const online = f.add('已由同事修复并更新问题单。', 'feishu', '2026-10-21T09:00:00Z');
  const delayed = f.add('上午还没有完成。', 'voice', '2026-10-21T08:00:00Z');
  const v = conversationWindow(f.store.db, { provider: 'voice', streamId: 'voice:test' });
  const im = conversationWindow(f.store.db, { provider: 'feishu', streamId: 'feishu:test' });
  assert.ok(JSON.stringify(v).includes(delayed.id)); assert.ok(JSON.stringify(im).includes(online.id));
  assert.equal(f.store.db.prepare('SELECT occurred_at FROM evidence WHERE id=?').get(delayed.id).occurred_at, '2026-10-21T08:00:00Z');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
});

test('boundary candidate reaches attention and conversation tools without becoming a second utterance', t => {
  const f = setup(t), evidence = f.add('核心转写只出现一次');
  const row = f.store.db.prepare('SELECT metadata_json FROM evidence WHERE id=?').get(evidence.id);
  const metadata = JSON.parse(row.metadata_json);
  metadata.voice.boundaryContext = { text: '前文补音候选'.repeat(100), startMs: 0, endMs: 1000,
    policy: 'core-text-with-context-candidate-not-word-aligned' };
  f.store.db.prepare('UPDATE evidence SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), evidence.id);
  f.enqueue([evidence.id]);
  const packet = f.packet(), window = conversationWindow(f.store.db, { provider: 'voice', streamId: 'voice:test' });
  assert.equal(packet.changes[0].evidence.length, 1);
  assert.equal(window.messages.length, 1);
  for (const item of [packet.changes[0].evidence[0], window.messages[0]]) {
    assert.equal(item.content, '核心转写只出现一次');
    assert.equal(item.boundaryContext.truncated, true);
    assert.ok(Buffer.byteLength(item.boundaryContext.text) <= 700);
    assert.match(item.boundaryContext.meaning, /not another utterance/);
  }
  assert.ok(packet.bytes < 8192);
});
