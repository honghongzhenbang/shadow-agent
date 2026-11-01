import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../src/db.mjs';
import {
  ensureVoiceStorage, importVoiceTranscript, registerVoiceRecording,
  validateVoiceTranscript, voiceRecording,
} from '../../src/voice-input.mjs';

// Read a frozen model receipt; only a newly created isolated output directory is writable.
const [receiptPath, inputsPath, outputPath] = process.argv.slice(2);
if (!receiptPath || !inputsPath || !outputPath) {
  throw new Error('Usage: verify_moss_intake.mjs RECEIPT INPUTS NEW_OUTPUT_DIRECTORY');
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const root = path.resolve(outputPath);
if (fs.existsSync(root)) throw new Error('Output directory must not already exist');
fs.mkdirSync(root, { recursive: true });
const receipt = read(receiptPath);
const inputs = new Map(read(inputsPath).inputs.map(item => [item.id, item]));
const config = { projectRoot: root, voice: { runtimeRoot: 'voice', python: 'MUST-NOT-EXECUTE' } };
const databasePath = path.join(root, 'isolated.sqlite');
let store = openDatabase(databasePath);
const checks = [];
const count = table => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
try {
  ensureVoiceStorage(store);
  for (const row of receipt.rows) {
    const item = inputs.get(row.id);
    assert.ok(item, 'Receipt input must exist');
    assert.equal(hash(item.audio), row.sourceSha256);
    assert.equal(row.sourceSha256, item.sha256);
    validateVoiceTranscript(row.result);
    const factsBefore = count('graph_facts');
    const tasksBefore = count('tasks');
    const evidenceBefore = count('evidence');
    const eventsBefore = count('context_changes');
    const recording = await registerVoiceRecording(store, config, {
      audioPath: item.audio, sha256: row.sourceSha256, deviceId: 'isolated-moss-intake',
      recordingId: `${row.id}-${row.variant}`, conversationId: `${row.id}-${row.variant}`,
      // Synthetic test time, not claimed to be the original capture timestamp.
      recordedAt: '2026-10-25T00:00:00.000Z',
    });
    const envelopePath = path.join(root, `${recording.id}.json`);
    fs.writeFileSync(envelopePath, JSON.stringify({
      schemaVersion: 1, audioSha256: row.sourceSha256, result: row.result,
    }));
    const imported = await importVoiceTranscript(store, config, recording.id, envelopePath);
    const expected = row.result.segments.filter(segment => segment.text.trim());
    assert.equal(imported.evidenceIds.length, expected.length);
    assert.equal(count('evidence'), evidenceBefore + expected.length);
    assert.equal(count('graph_facts'), factsBefore);
    assert.equal(count('tasks'), tasksBefore);
    assert.equal(count('voice_speaker_samples'), 0, 'No automatic enrollment');
    for (const [index, evidenceId] of imported.evidenceIds.entries()) {
      const evidence = store.db.prepare('SELECT * FROM evidence WHERE id=?').get(evidenceId);
      const voice = JSON.parse(evidence.metadata_json).voice;
      assert.equal(voice.startMs, expected[index].startMs);
      assert.equal(voice.endMs, expected[index].endMs);
      assert.deepEqual(voice.sourceWindow, expected[index].sourceWindow);
      assert.equal(voice.contextOverlapMs, expected[index].contextOverlapMs);
      assert.equal(voice.identityStatus, 'unknown');
      assert.equal(voice.personId, null);
      assert.equal(new Date(evidence.occurred_at).getTime(), Date.parse('2026-10-25T00:00:00Z') + expected[index].startMs);
    }
    if (!expected.length) assert.equal(count('context_changes'), eventsBefore);
    const evidenceAfter = count('evidence');
    const eventsAfter = count('context_changes');
    store.close();
    store = openDatabase(databasePath);
    const saved = voiceRecording(store, recording.id);
    assert.deepEqual(read(saved.transcript_path), row.result);
    assert.equal((await importVoiceTranscript(store, config, recording.id, envelopePath)).duplicate, true);
    assert.equal(count('evidence'), evidenceAfter);
    assert.equal(count('context_changes'), eventsAfter);
    assert.equal(hash(item.audio), row.sourceSha256);
    checks.push({ id: row.id, variant: row.variant, evidence: expected.length,
      completion: imported.completion, reopenedAndIdempotent: true,
      embeddings: row.result.speakers.filter(speaker => speaker.embedding).length });
  }
  const split = receipt.rows.find(row => row.variant === 'parts');
  if (split) {
    const whole = receipt.rows.find(row => row.id === split.id && row.variant === 'single');
    assert.ok(whole);
    assert.deepEqual(split.result.segments, whole.result.segments);
    assert.deepEqual(split.result.speakers, whole.result.speakers);
    assert.deepEqual(split.attempts.filter(a => a.event === 'result').map(a => a.text),
      whole.attempts.filter(a => a.event === 'result').map(a => a.text));
  }
  const summary = { receiptSha256: hash(receiptPath), inputsSha256: hash(inputsPath),
    scriptSha256: hash(new URL(import.meta.url)), checks, splitEquivalent: Boolean(split),
    scope: 'Recorded model output through existing import and persistence; no capture, queue runner or model invocation.' };
  fs.writeFileSync(path.join(root, 'verification.private.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  store.close();
}
