import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { acceptVoiceTranscript } from '../src/voice-input.mjs';
import { discoverVoiceInbox, processVoiceInboxOnce, ensureVoiceInbox } from '../src/voice-inbox.mjs';
import { createVoiceEnrollmentService } from '../src/voice-enrollment.mjs';
import { isolatedShadowPlugin } from './helpers/shadow-plugin.mjs';
import { dispatchInformation } from '../src/information-delivery.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-inbox-')), incoming = path.join(root, 'incoming');
  fs.mkdirSync(incoming); let store = openDatabase(path.join(root, 'test.sqlite'));
  const config = { projectRoot: root, databasePath: path.join(root, 'test.sqlite'), voice: { runtimeRoot: 'voice', debounceSeconds: 1,
    intake: { sources: [{ path: incoming, since: '2000-01-01T00:00:00Z' }] } } };
  ensureVoiceInbox(store);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (index, finalPart, overrides = {}) => {
    const folder = path.join(incoming, 'device', `part-${index}`); fs.mkdirSync(folder, { recursive: true });
    const wav = Buffer.alloc(44 + 32000, index);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
    fs.writeFileSync(path.join(folder, 'audio.wav'), wav);
    const payload = { deviceId: 'phone', recordingId: `part-${index}`, conversationId: 'discussion',
      kind: 'voice-recording-package-part', packageId: 'package', partIndex: index, finalPart,
      previousRecordingId: index ? `part-${index - 1}` : null,
      recordedAt: new Date(Date.parse('2026-10-22T01:00:00Z') + index * 1000).toISOString(),
      sha256: createHash('sha256').update(wav).digest('hex'), audioPath: 'audio.wav', sampleRateHz: 16000, channels: 1,
      sampleCount: 16000, durationMs: 1000, testOnly: true, ...overrides };
    const file = path.join(folder, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(payload)); return { file, folder, payload };
  };
  const scan = () => discoverVoiceInbox(store, config, { isolated: true });
  const transcribe = async (s, c, id) => {
    const rec = s.db.prepare('SELECT * FROM voice_recordings WHERE id=?').get(id);
    const durationMs = JSON.parse(rec.metadata_json).capture.durationMs;
    return acceptVoiceTranscript(s, c, id, { schemaVersion: 1, durationMs, engine: 'test-only', model: 'synthetic',
      audio: { sampleRateHz: 16000, sampleCount: durationMs * 16, channels: 1 },
      speakers: [{ label: 'speaker_0', embedding: [1, 0, 0], embeddingModel: 'test' }],
      segments: [{ id: 's1', startMs: 0, endMs: durationMs, speakerLabel: 'speaker_0', text: '合成测试：接口已完成，先前归属需要复核。' }] });
  };
  return { root, incoming, config, get store() { return store; }, write, scan, transcribe,
    restart() { store.close(); store = openDatabase(config.databasePath); },
    job() { return store.db.prepare('SELECT * FROM voice_inbox_jobs').get(); },
    run(overrides = {}) { return processVoiceInboxOnce(store, config, { transcribe, ...overrides }); } };
}

test('phone parts wait for completion, assemble once, resume after restart and retain recording time', async t => {
  const f = fixture(t); f.write(2, true); f.scan();
  assert.equal(f.job().status, 'waiting'); assert.equal(await f.run(), null); assert.equal(f.job().attempts, 0);
  f.write(0, false); f.scan(); assert.equal(f.job().status, 'waiting');
  f.write(1, false); f.scan(); assert.equal(f.job().status, 'ready'); f.restart();
  const result = await f.run(); assert.equal(result.status, 'complete', result.error);
  const rec = f.store.db.prepare('SELECT * FROM voice_recordings').get();
  assert.equal(rec.duration_ms, 3000); assert.equal(rec.recorded_at, '2026-10-22T01:00:00.000Z');
  assert.equal(JSON.parse(rec.metadata_json).sourceParts.length, 3);
  const pcm = fs.readFileSync(rec.audio_path); assert.equal(pcm.length, 96044);
  assert.equal(pcm[44], 0); assert.equal(pcm[32044], 1); assert.equal(pcm[64044], 2);
  f.scan(); assert.equal(await f.run(), null); assert.equal(f.job().attempts, 1);
  assert.ok(fs.existsSync(path.join(f.incoming, 'device/part-0/audio.wav')));
});

test('a complete PC clip uses the same queue, failures back off and recovery does not duplicate evidence', async t => {
  const f = fixture(t); f.write(0, true, { deviceId: 'pc' }); f.scan();
  assert.equal((await f.run({ transcribe: async () => { throw new Error('offline ASR'); } })).status, 'failed');
  assert.equal(await f.run(), null);
  f.store.db.prepare("UPDATE voice_inbox_jobs SET next_attempt='2000-01-01T00:00:00Z'").run(); f.restart();
  assert.equal((await f.run()).status, 'complete');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM evidence WHERE kind='voice_transcript'").get().n, 1);
});

test('partial intake is saved and visible after restart without automatic re-recognition', async t => {
  const f=fixture(t); f.write(0,true); f.scan();
  const partialResults=[{startMs:0,endMs:1000,text:'未完成',purpose:'core',
    stopReason:'audio_duration_deadline',budgetSeconds:2,budgetFactor:2}];
  const result=await f.run({transcribe:async(s,c,id)=>acceptVoiceTranscript(s,c,id,{
    schemaVersion:1,durationMs:1000,engine:'test',model:'test',completion:'partial',partialResults,
    audio:{sampleRateHz:16000,sampleCount:16000,channels:1},speakers:[],segments:[]})});
  assert.equal(result.status,'complete'); // Queue receipt, not complete speech recognition.
  f.restart(); f.scan();
  assert.equal(await f.run({transcribe:()=>{throw new Error('must not retry');}}),null);
  const rec=f.store.db.prepare('SELECT * FROM voice_recordings').get();
  assert.equal(JSON.parse(rec.metadata_json).completion,'partial');
  assert.deepEqual(JSON.parse(fs.readFileSync(rec.transcript_path,'utf8')).partialResults,partialResults);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n,0);
  assert.equal(f.job().attempts,1);
});

test('hash errors, timestamp gaps, test-only files and wrong predecessor never publish', async t => {
  for (const kind of ['hash', 'gap', 'testOnly', 'chain']) await t.test(kind, async t => {
    const f = fixture(t); const a = f.write(0, false);
    f.write(1, true, kind === 'gap' ? { recordedAt: '2026-10-22T01:00:09Z' } : kind === 'chain' ? { previousRecordingId: 'other' } : {});
    if (kind === 'hash') fs.appendFileSync(path.join(a.folder, 'audio.wav'), 'x');
    if (kind === 'testOnly') discoverVoiceInbox(f.store, f.config); else f.scan();
    const result = await f.run();
    assert.ok(f.job().status === 'invalid' || result?.status === 'failed');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, 0);
  });
});

test('old files stay out until a new part of that package arrives; source missing is visible', async t => {
  const f = fixture(t); const a = f.write(0, false);
  fs.utimesSync(a.file, new Date('2001-01-01'), new Date('2001-01-01'));
  f.config.voice.intake.sources[0].since = '2026-01-01T00:00:00Z'; f.scan(); assert.equal(f.job(), undefined);
  f.write(1, true); f.scan(); assert.equal(f.job().status, 'ready');
  f.config.voice.intake.sources.push({ path: path.join(f.root, 'missing'), since: '2026-01-01T00:00:00Z' });
  assert.ok(f.scan().errors.length);
});

test('corrected manifest semantics retry before publication, while a part after final is invalid', async t => {
  const f = fixture(t); f.write(0, false); const last = f.write(1, true, { conversationId: 'wrong' });
  f.scan(); assert.equal(f.job().status, 'invalid');
  const m = JSON.parse(fs.readFileSync(last.file, 'utf8'));
  const first = JSON.parse(fs.readFileSync(path.join(f.incoming, 'device/part-0/manifest.json'), 'utf8'));
  m.conversationId = first.conversationId;
  fs.writeFileSync(last.file, JSON.stringify(m, null, 2));
  f.scan(); assert.equal(f.job().status, 'ready');
  f.write(2, false); f.scan(); assert.equal(f.job().status, 'invalid');
  assert.match(f.job().last_error, /after final/);
});

test('publication and identity revoke reach the real controller packet and ACK path after restart', async t => {
  const f = fixture(t); f.write(0, true); f.scan(); const receipt = await f.run();
  assert.equal(receipt.status, 'complete');
  const { attentionPacket, acknowledgeChanges } = await isolatedShadowPlugin();
  const consume = () => {
    f.store.db.prepare("UPDATE context_changes SET not_before='2000-01-01T00:00:00Z'").run();
    const row = f.store.db.prepare("SELECT * FROM context_changes WHERE status='pending' AND json_extract(metadata_json,'$.provider')='voice' ORDER BY seq LIMIT 1").get();
    const packet = attentionPacket(f.store.db, f.config, { sessionKey: row.session_key, leaseOwner: 'voice-closure-test', maxBytes: 12288 });
    for (const change of packet.changes) {
      dispatchInformation(f.store.db, { sourceChangeSeq: change.seq, sessionKey: row.session_key,
        leaseOwner: 'voice-closure-test', evidenceIds: change.evidence.map(item => item.id), knowledge: false, tasks: [],
        rationale: 'Protocol-only voice identity fixture; no semantic knowledge or task assertion.' });
      acknowledgeChanges(f.store.db, { sequences: [change.seq], leaseOwner: 'voice-closure-test', disposition: 'processed', note: 'Deterministic protocol test, not model semantic acceptance.' }, f.config);
    }
    return packet;
  };
  assert.equal(consume().count, 1);
  let ui = createVoiceEnrollmentService(f.store, f.config, { isolated: true });
  const alice = ui.createPerson({ name: '合成人物' }); let group = ui.snapshot().groups[0];
  ui.confirm({ ...group, personId: alice.id, enroll: true }); consume();
  group = ui.snapshot().groups[0]; ui.revoke(group);
  assert.equal(ui.snapshot().people[0].sampleCount, 0);
  f.restart();
  const pending = f.store.db.prepare("SELECT metadata_json FROM context_changes WHERE status='pending'").get();
  assert.equal(JSON.parse(pending.metadata_json).requiresResponsibilityRecheck, true);
  assert.equal(consume().count, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM context_changes WHERE status='pending'").get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM graph_facts').get().n, 0);
});
