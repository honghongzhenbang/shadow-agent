import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { registerVoiceRecording, transcribeVoiceRecording, voiceSettings } from './voice-input.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const stamp = () => new Date().toISOString();
const zoned = (s) => typeof s === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s));
const id = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f]/.test(s);

export function ensureVoiceInbox(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS voice_inbox_files (
      path TEXT PRIMARY KEY, signature TEXT NOT NULL, payload TEXT, error TEXT, received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_inbox_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt TEXT, lease_until TEXT, lease_owner TEXT,
      recording_id TEXT, last_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS voice_inbox_due ON voice_inbox_jobs(status,next_attempt);
  `);
}

function localFile(root, file) {
  const base = fs.realpathSync(root), resolved = fs.realpathSync(file);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)
      || /^[\\/]{2}/.test(resolved)) throw new Error('Inbox file must stay within its configured local source.');
  if (!fs.statSync(resolved).isFile()) throw new Error('Expected an inbox file.');
  return resolved;
}

function* manifests(root, limit = 20000) {
  const pending = [{ directory: root, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++count > limit) throw new Error('Inbox scan limit exceeded; configure a narrower capture directory.');
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) pending.push({ directory: file, depth: depth + 1 });
      else if (entry.isFile() && ['manifest.json', 'audio.wav.manifest.json'].includes(entry.name)) yield file;
    }
  }
}

function parsePart(file, source) {
  if (fs.statSync(file).size > 65536) throw new Error('Oversized capture manifest.');
  const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!id(m.deviceId) || !id(m.recordingId) || !zoned(m.recordedAt) || !/^[a-f0-9]{64}$/i.test(m.sha256 ?? '')) {
    throw new Error('Capture manifest needs stable identity, zoned recording time and SHA256.');
  }
  const packaged = m.kind === 'voice-recording-package-part';
  if (m.kind != null && !packaged && m.kind !== 'voice-audio-file') throw new Error('Unsupported recording package kind.');
  if (packaged && (!id(m.packageId) || !Number.isSafeInteger(m.partIndex) || m.partIndex < 0 || m.partIndex > 10000
      || typeof m.finalPart !== 'boolean' || (m.partIndex === 0 ? m.previousRecordingId != null : !id(m.previousRecordingId)))) {
    throw new Error('Invalid recording package chain.');
  }
  if (m.sampleRateHz !== 16000 || m.channels !== 1 || !Number.isSafeInteger(m.sampleCount) || m.sampleCount < 1) {
    throw new Error('Capture package must describe PCM16 mono 16000 Hz sample counts.');
  }
  const audio = path.resolve(path.dirname(file), m.audioPath ?? 'audio.wav');
  const relative = path.relative(path.resolve(source.path), audio);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Capture audio leaves source directory.');
  return { ...m, audioPath: audio, sourceRoot: path.resolve(source.path),
    packageId: packaged ? m.packageId : m.recordingId,
    partIndex: packaged ? m.partIndex : 0, finalPart: packaged ? m.finalPart : true,
    previousRecordingId: packaged ? m.previousRecordingId : null,
    conversationId: m.conversationId ?? m.packageId ?? m.recordingId };
}

function plan(parts) {
  const unique = new Map();
  for (const part of parts) {
    const key = part.partIndex;
    const old = unique.get(key);
    if (old && ['sha256', 'recordingId', 'recordedAt', 'finalPart', 'previousRecordingId', 'sampleCount',
      'sampleRateHz', 'channels', 'conversationId', 'testOnly'].some(field => old[field] !== part[field])) {
      throw new Error('Conflicting package part.');
    }
    unique.set(key, part);
  }
  const ordered = [...unique.values()].sort((a, b) => a.partIndex - b.partIndex);
  const finals = ordered.filter(p => p.finalPart);
  if (finals.length > 1) throw new Error('Multiple final package parts.');
  if (finals.length && ordered.at(-1).partIndex > finals[0].partIndex) throw new Error('Part after final package part.');
  if (!finals.length || ordered[0].partIndex !== 0 || ordered.length !== finals[0].partIndex + 1) return null;
  if (ordered.at(-1) !== finals[0]) throw new Error('Part after final package part.');
  let samples = 0;
  for (let index = 0; index < ordered.length; index++) {
    const p = ordered[index];
    if (p.partIndex !== index) return null;
    if (p.previousRecordingId !== (index ? ordered[index - 1].recordingId : null)
        || p.conversationId !== ordered[0].conversationId || p.testOnly !== ordered[0].testOnly) throw new Error('Inconsistent package identity or predecessor.');
    // Discontinuities belong to distinct packages, never hide gaps by concatenation.
    if (Math.abs(Date.parse(p.recordedAt) - Date.parse(ordered[0].recordedAt) - samples / 16) > 2) {
      throw new Error('Non-contiguous capture timestamps; retain parts for review.');
    }
    samples += p.sampleCount;
  }
  if (samples / 16 > 43200000 || samples * 2 + 44 > 2 * 1024 ** 3) throw new Error('Capture package exceeds the 12-hour/2-GiB limit.');
  return ordered;
}

export function discoverVoiceInbox(store, config, { now = stamp(), isolated = false } = {}) {
  ensureVoiceInbox(store);
  const errors = [], paths = new Set(), sourceRules = new Map();
  for (const source of config.voice?.intake?.sources ?? []) {
    if (!source.path || !zoned(source.since)) throw new Error('Every voice source needs a local path and explicit since timestamp.');
    const root = path.resolve(source.path);
    if (/^[\\/]{2}/.test(root)) throw new Error('Voice sources must be local.');
    try {
      for (const file of manifests(root)) {
        localFile(root, file);
        paths.add(file); sourceRules.set(file, source);
        const stat = fs.statSync(file), signature = `${stat.size}:${stat.mtimeMs}`;
        if (store.db.prepare('SELECT signature FROM voice_inbox_files WHERE path=?').get(file)?.signature === signature) continue;
        let payload = null, error = null;
        try { payload = JSON.stringify(parsePart(file, source)); } catch (e) { error = e.message; errors.push({ file, error }); }
        store.db.prepare(`INSERT INTO voice_inbox_files VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
          signature=excluded.signature,payload=excluded.payload,error=excluded.error,received_at=excluded.received_at`)
          .run(file, signature, payload, error, new Date(stat.mtimeMs).toISOString());
      }
    } catch (error) { errors.push({ source: root, error: error.message }); }
  }
  const groups = new Map();
  for (const file of paths) {
    const row = store.db.prepare('SELECT * FROM voice_inbox_files WHERE path=?').get(file);
    if (!row?.payload) { if (row?.error) errors.push({ file, error: row.error }); continue; }
    const part = JSON.parse(row.payload), key = hash(JSON.stringify([part.deviceId, part.packageId]));
    if (!groups.has(key)) groups.set(key, { parts: [], eligible: false });
    const group = groups.get(key);
    group.parts.push(part);
    group.eligible ||= Date.parse(row.received_at) >= Date.parse(sourceRules.get(file).since);
  }
  for (const [key, group] of groups) {
    if (!group.eligible) continue;
    const signature = hash(JSON.stringify(group.parts.map(p => [p.partIndex, p.sha256, p.recordingId, p.recordedAt,
      p.finalPart, p.previousRecordingId, p.sampleCount, p.sampleRateHz, p.channels, p.conversationId,
      p.testOnly, p.audioPath, p.sourceRoot]).sort()));
    const old = store.db.prepare('SELECT * FROM voice_inbox_jobs WHERE id=?').get(key);
    if (old?.signature === signature) continue;
    if (old && ['complete', 'processing'].includes(old.status)) {
      errors.push({ jobId: key, error: 'Published or leased package changed; manual review required.' }); continue;
    }
    let status = 'waiting', error = null, ordered = group.parts;
    try {
      if (group.parts.some(p => p.testOnly) && !isolated) throw new Error('Test-only recordings cannot enter the production inbox.');
      const complete = plan(group.parts);
      if (complete) { status = 'ready'; ordered = complete; }
    } catch (e) { status = 'invalid'; error = e.message; }
    store.db.prepare(`INSERT INTO voice_inbox_jobs(id,status,payload,signature,last_error,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload,signature=excluded.signature,
      last_error=excluded.last_error,next_attempt=NULL,updated_at=excluded.updated_at`)
      .run(key, status, JSON.stringify(ordered), signature, error, now);
  }
  return { errors, counts: store.db.prepare('SELECT status,COUNT(*) count FROM voice_inbox_jobs GROUP BY status').all() };
}

async function digest(file) {
  const h = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex');
}

function wavRange(file, part) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12 || head.toString('ascii', 0, 4) !== 'RIFF'
        || head.toString('ascii', 8, 12) !== 'WAVE' || head.readUInt32LE(4) + 8 !== size) throw new Error('Incomplete WAV.');
    let position = 12, fmt = false, data;
    for (let i = 0; position + 8 <= size && i < 4096; i++) {
      const chunk = Buffer.alloc(8); fs.readSync(fd, chunk, 0, 8, position);
      const n = chunk.readUInt32LE(4), kind = chunk.toString('ascii', 0, 4), start = position + 8;
      if (start + n > size) throw new Error('Truncated WAV chunk.');
      if (kind === 'fmt ') {
        if (n < 16) throw new Error('Invalid WAV format.');
        const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, start);
        if (b.readUInt16LE(0) !== 1 || b.readUInt16LE(2) !== 1 || b.readUInt32LE(4) !== 16000
            || b.readUInt16LE(12) !== 2 || b.readUInt16LE(14) !== 16) throw new Error('Expected PCM16 mono 16kHz WAV.');
        fmt = true;
      }
      if (kind === 'data') { if (data) throw new Error('Multiple WAV data chunks.'); data = { start, length: n }; }
      position = start + n + n % 2;
    }
    if (!fmt || !data || data.length !== part.sampleCount * 2) throw new Error('WAV sample count differs from manifest.');
    return data;
  } finally { fs.closeSync(fd); }
}

export async function assembleVoicePackage(parts, destination) {
  const ordered = plan(parts); if (!ordered) throw new Error('Package incomplete.');
  if (ordered.length === 1 && ordered[0].kind !== 'voice-recording-package-part') {
    const part = ordered[0], file = localFile(part.sourceRoot, part.audioPath);
    wavRange(file, part);
    if (await digest(file) !== part.sha256.toLowerCase()) throw new Error('Capture SHA256 mismatch; original retained.');
    // A complete PC capture is already a recording, not a new synthetic package identity.
    return { ...part, audioPath: file, source: 'voice_intake' };
  }
  const length = ordered.reduce((sum, p) => sum + p.sampleCount * 2, 0), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(length, 40);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, header, { flag: 'wx' });
    for (const part of ordered) {
      const file = localFile(part.sourceRoot, part.audioPath), range = wavRange(file, part);
      if (await digest(file) !== part.sha256.toLowerCase()) throw new Error('Capture SHA256 mismatch; original retained.');
      await pipeline(fs.createReadStream(file, { start: range.start, end: range.start + range.length - 1 }), fs.createWriteStream(temporary, { flags: 'a' }));
      if (await digest(file) !== part.sha256.toLowerCase()) throw new Error('Capture changed during assembly.');
    }
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { ...ordered[0], recordingId: `package:${ordered[0].packageId}`, audioPath: destination,
    sha256: await digest(destination), source: 'voice_intake', sampleCount: length / 2, durationMs: length / 32,
    sourceParts: ordered.map(p => ({ recordingId: p.recordingId, partIndex: p.partIndex, sha256: p.sha256, recordedAt: p.recordedAt, sampleCount: p.sampleCount })) };
}

export async function processVoiceInboxOnce(store, config, { now = stamp(), transcribe = transcribeVoiceRecording } = {}) {
  ensureVoiceInbox(store);
  const owner = randomUUID(), lease = new Date(Date.parse(now) + 60000).toISOString();
  const job = store.transaction(() => {
    const next = store.db.prepare(`SELECT * FROM voice_inbox_jobs WHERE status='ready'
      OR (status='failed' AND next_attempt<=?) OR (status='processing' AND lease_until<=?) ORDER BY updated_at,id LIMIT 1`).get(now, now);
    if (!next) return null;
    store.db.prepare("UPDATE voice_inbox_jobs SET status='processing',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?")
      .run(owner, lease, now, next.id);
    return next;
  });
  if (!job) return null;
  const heartbeat = setInterval(() => store.db.prepare('UPDATE voice_inbox_jobs SET lease_until=? WHERE id=? AND lease_owner=?')
    .run(new Date(Date.now() + 60000).toISOString(), job.id, owner), 10000);
  const spool = path.join(voiceSettings(config).root, 'intake-spool', `${job.id}.wav`);
  try {
    let record;
    if (job.recording_id) record = store.db.prepare('SELECT * FROM voice_recordings WHERE id=?').get(job.recording_id);
    if (!record) {
      const manifest = await assembleVoicePackage(JSON.parse(job.payload), spool);
      record = await registerVoiceRecording(store, config, manifest);
      store.db.prepare('UPDATE voice_inbox_jobs SET recording_id=? WHERE id=? AND lease_owner=?').run(record.id, job.id, owner);
    }
    const receipt = await transcribe(store, config, record.id);
    if (receipt.busy || !Array.isArray(receipt.evidenceIds)) throw new Error('ASR not completed; retry after its lease expires.');
    store.db.prepare("UPDATE voice_inbox_jobs SET status='complete',last_error=NULL,lease_until=NULL,lease_owner=NULL,updated_at=? WHERE id=? AND lease_owner=?")
      .run(stamp(), job.id, owner);
    return { jobId: job.id, recordingId: record.id, evidenceCount: receipt.evidenceIds.length, status: 'complete' };
  } catch (error) {
    store.db.prepare("UPDATE voice_inbox_jobs SET status='failed',last_error=?,next_attempt=?,lease_until=NULL,lease_owner=NULL,updated_at=? WHERE id=? AND lease_owner=?")
      .run(error.message.slice(0, 1500), new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7))).toISOString(), stamp(), job.id, owner);
    return { jobId: job.id, status: 'failed', error: error.message };
  } finally { clearInterval(heartbeat); if (fs.existsSync(spool)) fs.unlinkSync(spool); }
}
