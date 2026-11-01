import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateVoiceTranscript } from '../src/voice-input.mjs';
import { loadConfig } from '../src/config.mjs';

const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const records = [], errors = [], counts = {};
const queue = [root];
while (queue.length) {
  const directory = queue.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) queue.push(file);
    else if (entry.name === 'audio.wav.manifest.json') {
      const row = { manifest: file };
      try {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        Object.assign(row, { deviceId: m.deviceId, recordingId: m.recordingId, conversationId: m.conversationId,
          recordedAt: m.recordedAt, durationMs: m.durationMs, kind: m.kind, testOnly: m.testOnly,
          audio: path.resolve(directory, m.audioPath ?? m.audioFile), sha256: m.sha256 });
        const h = createHash('sha256');
        for await (const chunk of fs.createReadStream(row.audio)) h.update(chunk);
        if (h.digest('hex') !== m.sha256) throw new Error('audio_sha_mismatch');
        row.bytes = fs.statSync(row.audio).size;
        row.transcript = path.join(directory, 'transcript.json');
        if (!fs.existsSync(row.transcript)) throw new Error('missing_transcript');
        const t = JSON.parse(fs.readFileSync(row.transcript, 'utf8'));
        if (t.audioSha256 !== m.sha256) throw new Error('transcript_sha_mismatch');
        validateVoiceTranscript(t.result);
        if (Math.abs(t.result.durationMs - m.durationMs) > 2) throw new Error('duration_mismatch');
        row.segments = t.result.segments.length;
        row.textSegments = t.result.segments.filter(s => s.text.trim()).length;
        row.speakers = (t.result.speakers ?? []).length;
        row.embeddings = (t.result.speakers ?? []).filter(s => s.embedding?.length).length;
        row.unknownSegments = t.result.segments.filter(s => s.speakerLabel === 'unknown').length;
        row.links = fs.existsSync(path.join(directory, 'speaker-links.json'));
        row.status = m.testOnly ? 'test_only' : 'usable';
      } catch (e) { row.status = e.message; errors.push({ file, error: e.message }); }
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      records.push(row);
    }
  }
}
records.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
const config = loadConfig();
const db = new DatabaseSync(config.paths.database, { readOnly: true });
let database;
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  database = { path: config.paths.database, userVersion: db.prepare('PRAGMA user_version').get(),
    tables: tables.length, counts: Object.fromEntries(['voice_recordings','voice_segments','voice_speaker_samples']
      .map(t => [t, tables.includes(t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : null])) };
} finally { db.close(); }
const report = { root, counts, summary: { recordings: records.length, bytes: records.reduce((s,r)=>s+(r.bytes??0),0),
  durationHours: records.reduce((s,r)=>s+(r.durationMs??0),0)/3600000,
  segments: records.reduce((s,r)=>s+(r.segments??0),0), textSegments: records.reduce((s,r)=>s+(r.textSegments??0),0),
  embeddings: records.reduce((s,r)=>s+(r.embeddings??0),0), links: records.filter(r=>r.links).length,
  unknownSegments: records.reduce((s,r)=>s+(r.unknownSegments??0),0), first:records[0]?.recordedAt,last:records.at(-1)?.recordedAt }, database, records, errors };
fs.mkdirSync(path.dirname(output), { recursive:true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ counts, summary:report.summary, database, output }));
