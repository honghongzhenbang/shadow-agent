import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { registerVoiceRecording, importVoiceTranscript, validateVoiceTranscript } from './voice-input.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = value => createHash('sha256').update(value).digest('hex');

function within(root, file) {
  const base = fs.realpathSync(root), full = fs.realpathSync(file), relative = path.relative(base, full);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Historical source leaves the selected capture root.');
  }
  if (!fs.statSync(full).isFile()) throw new Error('Historical source must be a file.');
  return full;
}

export function inspectHistoricalRecording(root, manifestPath) {
  const file = within(root, manifestPath);
  if (fs.statSync(file).size > 65536) throw new Error('Oversized capture manifest.');
  const manifest = readJson(file);
  if (manifest.testOnly !== false) throw new Error('Only explicitly non-test captures can enter historical import.');
  if (![undefined, 'voice-audio-file'].includes(manifest.kind)) throw new Error('Import complete recordings, not physical package parts.');
  for (const field of ['deviceId', 'recordingId', 'conversationId']) {
    if (typeof manifest[field] !== 'string' || !manifest[field] || manifest[field].length > 400) throw new Error(`Missing ${field}.`);
  }
  if (typeof manifest.recordedAt !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(manifest.recordedAt)
      || !Number.isFinite(Date.parse(manifest.recordedAt))) throw new Error('Missing original zoned recording time.');
  const audioPath = within(root, path.resolve(path.dirname(file), manifest.audioPath ?? manifest.audioFile));
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256 ?? '')) throw new Error('Missing audio checksum.');
  const transcriptPath = within(root, path.join(path.dirname(file), 'transcript.json'));
  if (fs.statSync(transcriptPath).size > 2 * 1024 ** 2) throw new Error('Oversized transcript.');
  const envelope = readJson(transcriptPath);
  if (envelope.schemaVersion !== 1 || envelope.audioSha256 !== manifest.sha256) throw new Error('Transcript/audio identity mismatch.');
  const transcript = validateVoiceTranscript(envelope.result);
  if (Math.abs(manifest.durationMs - transcript.durationMs) > 2 || !Number.isFinite(manifest.durationMs)) throw new Error('Capture duration mismatch.');
  for (const field of ['sampleRateHz', 'sampleCount', 'channels']) {
    if (manifest[field] !== transcript.audio?.[field]) throw new Error(`Capture ${field} mismatch.`);
  }
  return { manifest: { ...manifest, audioPath, source: 'historical_pc_capture',
    title: manifest.title ?? `录音 ${manifest.recordedAt.slice(0, 10)}` }, transcriptPath, transcript,
    manifestHash: hash(fs.readFileSync(file)), transcriptHash: hash(fs.readFileSync(transcriptPath)) };
}

// Copy only acoustic identities, never names, reviewed facts or a historical Agent database.
// Refuse replacement: a target containing new annotations needs a separate merge decision.
export async function copyHistoricalSpeakerIndex(source, destination) {
  if (fs.existsSync(destination)) throw new Error('Target acoustic index exists; refusing to overwrite.');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    if (JSON.stringify(tables) !== JSON.stringify(['links', 'voices'])) throw new Error('Not an acoustic-only speaker index.');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Acoustic index failed integrity check.');
    for (const r of db.prepare('SELECT result FROM links').iterate()) {
      const result = JSON.parse(r.result);
      if (result.identityConfirmed !== false || result.personId || result.personName) throw new Error('Acoustic index contains asserted identities.');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await backup(db, destination);
    return { voices: db.prepare('SELECT COUNT(*) n FROM voices').get().n, links: db.prepare('SELECT COUNT(*) n FROM links').get().n };
  } finally { db.close(); }
}

export async function importHistoricalRecording(store, config, root, manifestPath) {
  const inspected = inspectHistoricalRecording(root, manifestPath);
  const recording = await registerVoiceRecording(store, config, inspected.manifest);
  const result = await importVoiceTranscript(store, config, recording.id, inspected.transcriptPath);
  return { ...result, manifestHash: inspected.manifestHash, transcriptHash: inspected.transcriptHash };
}
