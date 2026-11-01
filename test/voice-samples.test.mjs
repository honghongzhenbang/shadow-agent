import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { listVoiceSamples, forgetVoiceSample } from '../src/voice-samples.mjs';
import { voiceSamplesFixture } from './helpers/voice-samples-fixture.mjs';

async function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'voice-samples-test-'));
  const f = await voiceSamplesFixture(root);
  t.after(() => {
    f.store.close(); assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.ok(path.basename(root).startsWith('voice-samples-test-')); fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
const tables = ['evidence', 'evidence_links', 'voice_recordings', 'voice_segments', 'graph_facts', 'context_changes', 'context_change_evidence'];
const snapshot = db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const request = row => ({ sampleId: row.id, revisionToken: row.revisionToken });

test('sample inventory includes retained old and current groups, exact filters and bounded pages without vectors or paths', async t => {
  const f = await fixture(t), all = f.service.samples();
  assert.equal(all.pagination.total, 2);
  assert.equal(all.samples.find(s => s.id === f.old.id).sourceVersion, 'historical');
  assert.equal(all.samples.find(s => s.id === f.current.id).sourceVersion, 'current');
  assert.equal(f.service.samples({ personId: f.alice.id }).samples[0].id, f.old.id);
  assert.equal(f.service.samples({ recordingId: f.recording.id }).pagination.total, 2);
  assert.equal(f.service.samples({ query: 'Historical fixture' }).samples[0].id, f.old.id);
  assert.equal(f.service.samples({ query: 'independent-recording' }).pagination.total, 0);
  assert.equal(f.service.samples({ query: 'old and new' }).pagination.total, 2);
  assert.equal(f.service.samples({ query: "%' OR 1=1--" }).pagination.total, 0);
  const one = f.service.samples({ pageSize: 1 }), two = f.service.samples({ pageSize: 1, page: 2 });
  assert.equal(one.pagination.hasNext, true); assert.equal(two.pagination.hasPrevious, true);
  assert.notEqual(one.samples[0].id, two.samples[0].id);
  assert.equal(f.service.samples({ page: 100 }).pagination.page, 1);
  const serialized = JSON.stringify(all);
  for (const secret of ['embedding_json', '[1,0]', f.root, 'audio_path', 'metadata_json']) assert.ok(!serialized.includes(secret), secret);
  for (const input of [{ page: 0 }, { pageSize: 101 }, { status: 'enabled' }, { personId: {} }, { query: 2 }]) {
    assert.throws(() => f.service.samples(input), { code: 'INVALID_INPUT' });
  }
});

test('removing exactly one old template preserves labels, facts, notifications and source files; replay and raw readback are stable', async t => {
  const f = await fixture(t), before = snapshot(f.store.db), row = f.service.samples({ personId: f.alice.id }).samples[0];
  const recording = f.store.db.prepare('SELECT * FROM voice_recordings WHERE id=?').get(f.recording.id);
  const files = [recording.audio_path, recording.transcript_path,
    ...JSON.parse(recording.metadata_json).previousTranscripts.map(item => item.archivePath)];
  const hashes = () => files.map(p => createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  const beforeFiles = hashes();
  assert.equal(f.service.forgetSample(request(row)).removed, 1);
  assert.equal(f.service.forgetSample(request(row)).removed, 0);
  assert.equal(f.service.samples().pagination.total, 1);
  assert.equal(f.service.samples().samples[0].id, f.current.id);
  assert.deepEqual(snapshot(f.store.db), before); assert.deepEqual(hashes(), beforeFiles);
  assert.equal(f.service.timeline({ recordingId: f.recording.id, historyIndex: 0 }).segments[0].personId, f.alice.id);
  assert.equal(f.service.timeline({ recordingId: f.recording.id }).segments[0].personId, f.bob.id);
  const raw = new DatabaseSync(f.database, { readOnly: true });
  try { assert.deepEqual(snapshot(raw), before); assert.equal(raw.prepare('SELECT COUNT(*) n FROM voice_speaker_samples').get().n, 1); }
  finally { raw.close(); }
});

test('a changed sample cannot be removed or played through a stale UI request; refresh and explicit choice still work', async t => {
  const f = await fixture(t), row = f.service.samples({ personId: f.alice.id }).samples[0];
  const other = new DatabaseSync(f.database);
  try { other.prepare('UPDATE voice_speaker_samples SET active=0 WHERE id=?').run(row.id); }
  finally { other.close(); }
  assert.throws(() => f.service.forgetSample(request(row)), { code: 'STALE_SAMPLE' });
  assert.throws(() => f.service.sampleAudio(request(row)), { code: 'STALE_SAMPLE' });
  const updated = f.service.samples({ status: 'inactive' }).samples[0];
  assert.equal(updated.id, row.id); assert.notEqual(updated.revisionToken, row.revisionToken);
  assert.equal(f.service.forgetSample(request(updated)).removed, 1);
});

test('old source audio remains bounded and seekable beyond 8 seconds independent of the current label', async t => {
  const f = await fixture(t), row = f.service.samples({ personId: f.alice.id }).samples[0], before = snapshot(f.store.db);
  const start = f.service.sampleAudio(request(row));
  assert.equal(start.durationMs, 45000); assert.equal(start.nextOffsetMs, 30000);
  const next = f.service.sampleAudio({ ...request(row), offsetMs: 30000 });
  assert.equal(next.durationMs, 45000); assert.equal(next.nextOffsetMs, null); assert.equal(next.offsetMs, 30000);
  assert.ok(Buffer.from(start.dataUrl.split(',')[1], 'base64').length <= 2 * 1024 * 1024);
  assert.deepEqual(snapshot(f.store.db), before);
  const saved = f.store.db.prepare('SELECT audio_path FROM voice_recordings WHERE id=?').get(f.recording.id);
  f.store.db.prepare('UPDATE voice_recordings SET audio_path=? WHERE id=?').run(path.join(f.root, 'missing.wav'), f.recording.id);
  assert.equal(f.service.sampleAudio(request(row)).unavailable, true);
  f.store.db.prepare('UPDATE voice_recordings SET audio_path=? WHERE id=?').run(saved.audio_path, f.recording.id);
  assert.throws(() => f.service.sampleAudio({ ...request(row), offsetMs: -1 }), { code: 'INVALID_INPUT' });
});

test('service requires a checked revision but shared CLI removal keeps explicit-ID semantics and validates input', async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.forgetSample({ sampleId: f.old.id }), { code: 'INVALID_INPUT' });
  assert.throws(() => forgetVoiceSample(f.store, { sampleId: {} }), { code: 'INVALID_INPUT' });
  assert.throws(() => forgetVoiceSample(f.store, { sampleId: f.old.id, revisionToken: '' }), { code: 'INVALID_INPUT' });
  assert.equal(forgetVoiceSample(f.store, { sampleId: f.old.id }).removed, 1);
  assert.equal(forgetVoiceSample(f.store, { sampleId: f.old.id }).removed, 0);
  assert.equal(listVoiceSamples(f.store).samples[0].id, f.current.id);
});

test('pagination reaches samples beyond the former 100-row limit and retains disabled or archived-person templates', async t => {
  const f = await fixture(t);
  const columns = ['id','person_id','recording_id','speaker_label','embedding_model','embedding_json','evidence_id','created_at','active'];
  const insert = f.store.db.prepare(`INSERT INTO voice_speaker_samples (${columns.join(',')}) VALUES(?,?,?,?,?,?,?,?,?)`);
  f.store.transaction(() => {
    for (let i = 0; i < 105; i++) insert.run(...columns.map(k => k === 'id' ? `synthetic-page-${i}` : f.old[k]));
    f.store.db.prepare("UPDATE graph_entities SET status='archived' WHERE id=?").run(f.alice.id);
    f.store.db.prepare('UPDATE voice_speaker_samples SET active=0 WHERE id=?').run(f.old.id);
  });
  const first = f.service.samples({ pageSize: 100 }), last = f.service.samples({ pageSize: 100, page: 2 });
  assert.equal(first.samples.length, 100); assert.equal(last.samples.length, 7);
  assert.equal(new Set([...first.samples, ...last.samples].map(s => s.id)).size, 107);
  assert.equal(last.pagination.hasNext, false);
  assert.equal(f.service.samples({ status: 'inactive', personId: f.alice.id }).samples[0].id, f.old.id);
});
