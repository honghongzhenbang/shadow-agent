import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../src/db.mjs';
import { createVoiceEnrollmentService } from '../../src/voice-enrollment.mjs';
import { registerVoiceRecording, acceptVoiceTranscript, voiceTranscriptRevisionToken } from '../../src/voice-input.mjs';

export async function voiceSamplesFixture(root) {
  fs.mkdirSync(root, { recursive: true });
  const database = path.join(root, 'preview.sqlite'), store = openDatabase(database);
  const config = { projectRoot: root, voice: { runtimeRoot: root } };
  try {
    const audio = Buffer.alloc(44 + 45 * 16000 * 2);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
    const audioPath = path.join(root, 'synthetic.wav'); fs.writeFileSync(audioPath, audio);
    const recording = await registerVoiceRecording(store, config, { audioPath, deviceId: 'test', recordingId: 'old-sample-fixture',
      title: 'Isolated old and new speaker samples', recordedAt: '2026-10-20T01:20:00Z', testOnly: true });
    const result = (label, vector, text) => ({ schemaVersion: 1, engine: 'synthetic', durationMs: 45000,
      segments: [{ id: label, speakerLabel: label, startMs: 1000, endMs: 12000, text }],
      speakers: [{ label, embedding: vector, embeddingModel: 'synthetic-sample-test' }] });
    const service = createVoiceEnrollmentService(store, config, { isolated: true });
    const alice = service.createPerson({ name: 'Historical fixture person' });
    const bob = service.createPerson({ name: 'Current fixture person' });
    acceptVoiceTranscript(store, config, recording.id, result('old', [1, 0], 'Archived original identity.'));
    service.confirm({ ...service.group({ recordingId: recording.id, speakerLabel: 'old' }), personId: alice.id, enroll: true });
    const old = store.db.prepare('SELECT * FROM voice_speaker_samples').get();
    acceptVoiceTranscript(store, config, recording.id, result('new', [0, 1], 'Current independent identity.'), {
      replacement: { expectedToken: voiceTranscriptRevisionToken(store, recording.id), audioSha256: recording.content_hash } });
    const label = service.timeline({ recordingId: recording.id }).speakers[0].speakerLabel;
    service.confirm({ ...service.group({ recordingId: recording.id, speakerLabel: label }), personId: bob.id, enroll: true });
    const current = store.db.prepare('SELECT * FROM voice_speaker_samples WHERE id<>?').get(old.id);
    return { root, database, store, config, service, recording, alice, bob, old, current };
  } catch (e) { store.close(); throw e; }
}
