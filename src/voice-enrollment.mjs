import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkedVoiceSample, forgetVoiceSample, listVoiceSamples } from './voice-samples.mjs';

import {
  annotateVoiceSpeaker, confirmVoiceSpeakerLabel, correctVoiceSegment, ensureVoiceStorage,
  registerVoicePerson, validateVoiceTranscript, voiceSettings, associatedVoicePerson,
} from "./voice-input.mjs";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_GROUPS = 200;
const MAX_SEGMENTS = 20;

// Group by recording-local label, never by a cross-recording voice candidate.
const GROUP_INDEX = `WITH groups AS (
  SELECT r.id AS recording_id, r.recorded_at, s.speaker_label,
    CASE WHEN COUNT(*)=SUM(CASE WHEN json_extract(e.metadata_json,'$.voice.identityStatus')='confirmed'
      AND COALESCE(json_extract(e.metadata_json,'$.voice.personId'),'')<>'' THEN 1 ELSE 0 END)
      AND COUNT(DISTINCT json_extract(e.metadata_json,'$.voice.personId'))=1 THEN 1 ELSE 0 END AS confirmed
  FROM voice_recordings r JOIN voice_segments s ON s.recording_id=r.id
  JOIN evidence e ON e.id=s.evidence_id WHERE r.status='ready'
  GROUP BY r.id, s.speaker_label
)`;

function pageInput({ page = 1, pageSize = 50 } = {}, maximum = MAX_GROUPS) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    fail("INVALID_INPUT", "Invalid page or pageSize.");
  }
  return { page, pageSize: Math.min(pageSize, maximum) };
}

function pageWindow(input, total) {
  const totalPages = Math.ceil(total / input.pageSize);
  const page = Math.min(input.page, Math.max(1, totalPages));
  return { page, pageSize: input.pageSize, total, totalPages, hasPrevious: page > 1, hasNext: page < totalPages };
}

function parse(value) {
  try { return JSON.parse(value) ?? {}; } catch { return {}; }
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function identifier(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) {
    fail("INVALID_INPUT", `Invalid ${field}.`);
  }
  return value.trim();
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkedFile(root, file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw new Error("Unavailable file.");
  const resolved = path.resolve(file);
  if (!contained(root, resolved)) throw new Error("Unavailable file.");
  // Check every ancestor too: a directory junction must not bypass the root boundary.
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Unavailable file.");
    if (cursor === path.dirname(cursor)) break;
  }
  if (!contained(fs.realpathSync(root), fs.realpathSync(resolved))) throw new Error("Unavailable file.");
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("Unavailable file.");
  return { file: resolved, stat };
}

function withFile(root, file, callback) {
  const checked = checkedFile(root, file);
  const fd = fs.openSync(checked.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    const after = checkedFile(root, file).stat;
    if (!stat.isFile() || stat.ino !== checked.stat.ino || stat.dev !== checked.stat.dev
        || stat.ino !== after.ino || stat.dev !== after.dev) throw new Error("Unavailable file.");
    let consumed = 0;
    const read = (position, size) => {
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(size) || position < 0 || size < 0
          || position + size > stat.size || consumed + size > MAX_READ_BYTES) throw new Error("Read limit exceeded.");
      consumed += size;
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < size;) {
        const n = fs.readSync(fd, buffer, offset, size - offset, position + offset);
        if (!n) throw new Error("Truncated file.");
        offset += n;
      }
      return buffer;
    };
    return callback({ stat, read, remaining: () => MAX_READ_BYTES - consumed });
  } finally { fs.closeSync(fd); }
}

function transcriptLabels(root, recording, config) {
  try {
    const transcript = readVoiceReviewTranscript(root, recording, config);
    return new Set((transcript.speakers ?? []).filter((speaker) => speaker.embedding).map((speaker) => speaker.label));
  } catch { return new Set(); }
}

export function readVoiceReviewTranscript(root, recording, config) {
  const transcript = withFile(root, recording.transcript_path, ({ stat, read }) =>
    JSON.parse(read(0, stat.size).toString('utf8')));
  return validateVoiceTranscript(transcript, voiceSettings(config));
}

export { groupState as voiceGroupState };

function groupRows(store, recordingId, speakerLabel = null) {
  return store.db.prepare(`
    SELECT s.*, substr(e.content, 1, 160) AS excerpt, e.metadata_json, p.name AS person_name
    FROM voice_segments s JOIN evidence e ON e.id=s.evidence_id
    LEFT JOIN graph_entities p ON p.id=json_extract(e.metadata_json, '$.voice.personId') AND p.type='Person'
    WHERE s.recording_id=? AND (? IS NULL OR s.speaker_label=?)
    ORDER BY s.start_ms, s.segment_id
  `).all(recordingId, speakerLabel, speakerLabel);
}

function groupState(recording, label, rows) {
  const people = new Map();
  let confirmed = 0;
  for (const row of rows) {
    const voice = parse(row.metadata_json).voice;
    if (voice?.identityStatus === "confirmed" && voice.personId) {
      people.set(voice.personId, row.person_name ?? voice.personName ?? null);
      confirmed++;
    }
  }
  const personId = people.size === 1 && confirmed === rows.length ? [...people.keys()][0] : null;
  const disabledReason = label === "unknown" ? "unknown_speaker" : people.size > 1 ? "mixed_confirmed_people" : null;
  const revisionToken = createHash("sha256").update(JSON.stringify([
    recording.id, label, rows.map((row) => [row.segment_id, row.revision, row.evidence_id]),
  ])).digest("hex");
  return { personId, personName: personId ? people.get(personId) : null, disabledReason, revisionToken };
}

function wavSample(root, recording, segment, offsetMs = 0) {
  return withFile(root, recording.audio_path, ({ stat, read, remaining }) => {
    const header = read(0, 12);
    const end = header.readUInt32LE(4) + 8;
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE"
        || end < 12 || end > stat.size) throw new Error("Invalid WAV.");
    let format;
    let data;
    let position = 12;
    for (let chunks = 0; position + 8 <= end && chunks < 4096; chunks++) {
      const chunk = read(position, 8);
      const kind = chunk.toString("ascii", 0, 4);
      const size = chunk.readUInt32LE(4);
      const start = position + 8;
      if (start + size + (size % 2) > end) throw new Error("Invalid WAV chunk.");
      if (kind === "fmt " && !format) {
        if (size < 16) throw new Error("Invalid WAV format.");
        format = read(start, 16);
      }
      if (kind === "data" && !data) data = { start, size };
      if (format && data) break;
      position = start + size + (size % 2);
    }
    if (!format || !data) throw new Error("Missing WAV chunks.");
    const channels = format.readUInt16LE(2);
    const rate = format.readUInt32LE(4);
    const block = format.readUInt16LE(12);
    if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16 || !channels || !rate
        || block !== channels * 2 || format.readUInt32LE(8) !== rate * block || data.size % block) {
      throw new Error("Only PCM16 WAV is supported.");
    }
    if (Math.abs(data.size * 1000 / (block * rate) - recording.duration_ms) > 2) {
      throw new Error('Audio duration differs from the registered recording.');
    }
    if (segment && (!Number.isSafeInteger(segment.start_ms) || !Number.isSafeInteger(segment.end_ms)
        || segment.start_ms < 0 || segment.end_ms <= segment.start_ms)) throw new Error("Invalid sample range.");
    const rangeStart = segment ? Math.floor(segment.start_ms * rate / 1000) : 0;
    const rangeEnd = Math.min(data.size / block, segment ? Math.floor(segment.end_ms * rate / 1000) : Infinity);
    const startFrame = rangeStart + Math.round(offsetMs * rate / 1000);
    if (startFrame >= rangeEnd) throw new Error("Playback offset outside audio range.");
    // Bound each IPC read, not the listening duration. The UI continues or seeks by frame-derived offsets.
    const frames = Math.min(rangeEnd - startFrame, rate * 30, Math.floor(remaining() / block));
    if (frames <= 0) throw new Error("Empty sample.");
    const pcm = read(data.start + startFrame * block, frames * block);
    const output = Buffer.alloc(44 + pcm.length);
    output.write("RIFF", 0);
    output.writeUInt32LE(output.length - 8, 4);
    output.write("WAVEfmt ", 8);
    output.writeUInt32LE(16, 16);
    format.copy(output, 20);
    output.write("data", 36);
    output.writeUInt32LE(pcm.length, 40);
    pcm.copy(output, 44);
    return { dataUrl: `data:audio/wav;base64,${output.toString("base64")}`,
      offsetMs: (startFrame - rangeStart) * 1000 / rate,
      nextOffsetMs: startFrame + frames < rangeEnd ? (startFrame + frames - rangeStart) * 1000 / rate : null,
      durationMs: (rangeEnd - rangeStart) * 1000 / rate, rangeStartMs: rangeStart * 1000 / rate };
  });
}

export function createVoiceEnrollmentService(store, config, { isolated = false } = {}) {
  ensureVoiceStorage(store);
  const root = voiceSettings(config).root;
  const recordingById = (id) => store.db.prepare("SELECT * FROM voice_recordings WHERE id=? AND status='ready'").get(id);

  return {
    samples(input) { return listVoiceSamples(store, input); },
    forgetSample(input = {}) {
      if (typeof input.revisionToken !== 'string') fail('INVALID_INPUT', 'A sample revisionToken is required.');
      return forgetVoiceSample(store, input);
    },
    sampleAudio({ sampleId, revisionToken, offsetMs = 0 } = {}) {
      if (typeof revisionToken !== 'string' || !Number.isFinite(offsetMs) || offsetMs < 0) {
        fail('INVALID_INPUT', 'Invalid sample playback request.');
      }
      const row = checkedVoiceSample(store, { sampleId, revisionToken });
      const recording = row && recordingById(row.recording_id);
      if (!recording) return { unavailable: true, reason: 'sample_unavailable' };
      try { return wavSample(root, recording, null, offsetMs); }
      catch { return { unavailable: true, reason: 'sample_unavailable' }; }
    },
    recordings(input = {}) {
      const pagination = pageWindow(pageInput(input, 50), store.db.prepare("SELECT COUNT(*) n FROM voice_recordings WHERE status='ready'").get().n);
      const rows = store.db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM voice_segments WHERE recording_id=r.id) segment_count,
        (SELECT COUNT(DISTINCT speaker_label) FROM voice_segments WHERE recording_id=r.id) speaker_count,
        (SELECT speaker_label FROM voice_segments WHERE recording_id=r.id ORDER BY start_ms,segment_id LIMIT 1) first_label
        FROM voice_recordings r WHERE status='ready'
        ORDER BY (json_extract(metadata_json,'$.transcriptDigest') IS NOT NULL) DESC,recorded_at DESC,id
        LIMIT ? OFFSET ?`).all(pagination.pageSize, (pagination.page - 1) * pagination.pageSize);
      return { pagination, groups: rows.map(r => ({ recordingId: r.id, speakerLabel: r.first_label ?? 'unknown',
        recording: true, recordedAt: r.recorded_at, title: parse(r.metadata_json).title,
        engine: parse(r.metadata_json).engine, segmentCount: r.segment_count, speakerCount: r.speaker_count,
        updatedAt: r.updated_at, transcriptDigest: parse(r.metadata_json).transcriptDigest ?? null })) };
    },
    timeline({ recordingId, historyIndex, ...input } = {}) {
      const recording = recordingById(identifier(recordingId, 'recordingId'));
      if (!recording) fail('GROUP_UNAVAILABLE', 'Recording is not ready.');
      const metadata = parse(recording.metadata_json);
      const history = metadata.previousTranscripts ?? [];
      let rows;
      if (historyIndex !== undefined) {
        if (!Number.isSafeInteger(historyIndex) || !history[historyIndex]) fail('INVALID_INPUT', 'Invalid transcript version.');
        const archived = withFile(root, history[historyIndex].archivePath, ({ stat, read }) => JSON.parse(read(0, stat.size).toString('utf8')));
        if (archived.recordingId !== recordingId || archived.audioSha256 !== recording.content_hash) fail('INVALID_INPUT', 'History identity mismatch.');
        rows = archived.segments;
      } else rows = store.db.prepare(`SELECT s.*,e.content,e.metadata_json FROM voice_segments s JOIN evidence e ON e.id=s.evidence_id
        WHERE recording_id=? ORDER BY start_ms,segment_id`).all(recordingId);
      const labels = [...new Set(rows.map(r => r.speaker_label))];
      const pagination = pageWindow(pageInput({ pageSize: 20, ...input }, MAX_SEGMENTS), rows.length);
      return { recordingId, recordedAt: recording.recorded_at, title: metadata.title, engine: metadata.engine,
        history: history.map(({ engine, at, annotatedCount, segmentCount }, index) => ({ index, engine, at, annotatedCount, segmentCount })),
        historyIndex: historyIndex ?? null, pagination,
        speakers: labels.map((label, index) => ({ speakerLabel: label, ordinal: index + 1,
          ...groupState(recording, label, rows.filter(r => r.speaker_label === label)) })),
        confirmedCount: rows.filter(r => parse(r.metadata_json).voice?.identityStatus === 'confirmed').length,
        segments: rows.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize).map(r => {
          const voice = parse(r.metadata_json).voice ?? {};
          return { segmentId: r.segment_id, speakerLabel: r.speaker_label, ordinal: labels.indexOf(r.speaker_label) + 1,
            startMs: r.start_ms, endMs: r.end_ms, text: r.content, revision: r.revision,
            personId: voice.personId, personName: voice.personName, identityStatus: voice.identityStatus };
        }) };
    },
    partials({ recordingId, ...input } = {}) {
      const requested = pageInput(input, MAX_SEGMENTS);
      if (recordingId !== undefined) {
        const recording = recordingById(identifier(recordingId, 'recordingId'));
        if (!recording) fail('GROUP_UNAVAILABLE', 'Recording is not ready.');
        const partials = readVoiceReviewTranscript(root, recording, config).partialResults ?? [];
        const pagination = pageWindow(requested, partials.length);
        return { recordingId, pagination, partials: partials.slice((pagination.page - 1) * pagination.pageSize,
          pagination.page * pagination.pageSize) };
      }
      const condition = "status='ready' AND json_extract(metadata_json,'$.completion')='partial'";
      const total = store.db.prepare(`SELECT COUNT(*) AS n FROM voice_recordings WHERE ${condition}`).get().n;
      const pagination = pageWindow(requested, total);
      const rows = store.db.prepare(`SELECT id,recorded_at,metadata_json FROM voice_recordings WHERE ${condition}
        ORDER BY recorded_at DESC,id LIMIT ? OFFSET ?`).all(pagination.pageSize, (pagination.page - 1) * pagination.pageSize);
      return { pagination, recordings: rows.map(row => ({ recordingId: row.id, recordedAt: row.recorded_at,
        title: String(parse(row.metadata_json).title ?? 'Voice recording').slice(0, 120),
        partialCount: parse(row.metadata_json).partialCount })) };
    },
    group({ recordingId, speakerLabel } = {}) {
      recordingId = identifier(recordingId, 'recordingId');
      speakerLabel = identifier(speakerLabel, 'speakerLabel');
      const recording = recordingById(recordingId);
      if (!recording) fail('GROUP_UNAVAILABLE', 'Recording is not ready.');
      const rows = groupRows(store, recordingId, speakerLabel);
      if (!rows.length) fail('GROUP_UNAVAILABLE', 'Speaker label not found.');
      const state = groupState(recording, speakerLabel, rows);
      const ids = [...new Set(rows.map(r => parse(r.metadata_json).voice?.stableVoiceId).filter(Boolean))];
      const stableVoiceId = ids.length === 1 ? ids[0] : null;
      const labels = transcriptLabels(root, recording, config);
      let audioExists = false;
      try { checkedFile(root, recording.audio_path); audioExists = true; } catch { /* Hint only. */ }
      return { recordingId, speakerLabel, stableVoiceId, associatedPerson: associatedVoicePerson(store, stableVoiceId),
        recordedAt: recording.recorded_at, title: String(parse(recording.metadata_json).title ?? 'Voice recording').slice(0,120),
        segmentCount: rows.length, excerpt: rows.map(r => r.excerpt).join(' ').slice(0,160), ...state,
        canEnroll: !state.disabledReason && labels.has(speakerLabel),
        enrollmentDisabledReason: state.disabledReason ?? (labels.has(speakerLabel) ? null : 'no_speaker_embedding'),
        sampleAvailable: audioExists };
    },
    progress({ recordingId } = {}) {
      recordingId = identifier(recordingId, "recordingId");
      const row = store.db.prepare(`SELECT seq,status,ack_note,acknowledged_at,summary,not_before FROM context_changes
        WHERE json_extract(metadata_json,'$.provider')='voice' AND (EXISTS
        (SELECT 1 FROM json_each(context_changes.metadata_json,'$.recordingIds') WHERE value=?) OR EXISTS
        (SELECT 1 FROM context_change_evidence m JOIN evidence e ON e.id=m.evidence_id
          WHERE m.change_seq=context_changes.seq AND json_extract(e.metadata_json,'$.voice.recordingId')=?))
        ORDER BY seq DESC LIMIT 1`).get(recordingId, recordingId);
      const deliveries = { knowledge: { total: 0, pending: 0, leased: 0, acknowledged: 0 },
        tasks: { total: 0, pending: 0, leased: 0, acknowledged: 0 } };
      if (row && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='information_deliveries'").get()) {
        for (const item of store.db.prepare(`SELECT d.purpose,c.status,COUNT(DISTINCT c.seq) AS n
          FROM information_deliveries d JOIN information_dispatches i ON i.id=d.dispatch_id
          JOIN context_changes c ON c.seq=d.change_seq JOIN evidence e ON e.id=d.evidence_id
          WHERE i.source_change_seq=? AND json_extract(e.metadata_json,'$.voice.recordingId')=?
          GROUP BY d.purpose,c.status`).all(row.seq, recordingId)) {
          const target = deliveries[item.purpose === 'knowledge_review_due' ? 'knowledge' : 'tasks'];
          target.total += item.n;
          target[item.status] = item.n;
        }
      }
      const intake = parse(store.getSetting('voice:intake:status', '{}'));
      return { review: row ? { status: row.status, note: String(row.ack_note ?? row.summary ?? '').slice(0, 1200),
        acknowledgedAt: row.acknowledged_at, dueAt: row.not_before } : null, deliveries,
        intake: { enabled: config.voice?.intake?.enabled === true, state: intake.state ?? 'offline', at: intake.at ?? null,
          errorCount: intake.errors?.length ?? 0 } };
    },
    snapshot({ status = "all", ...input } = {}) {
      if (!["all", "pending", "confirmed"].includes(status)) fail("INVALID_INPUT", "Invalid group status.");
      const requested = pageInput(input);
      const people = store.db.prepare(`
        SELECT p.id, p.name, COUNT(s.id) AS sampleCount FROM graph_entities p
        LEFT JOIN voice_speaker_samples s ON s.person_id=p.id AND s.active=1
        WHERE p.type='Person' AND p.status='active' GROUP BY p.id ORDER BY p.name, p.id LIMIT 200
      `).all().map((person) => ({ ...person }));
      const totals = store.db.prepare(`${GROUP_INDEX} SELECT COUNT(*) AS totalGroups,
        COALESCE(SUM(confirmed),0) AS confirmedGroups, COALESCE(SUM(1-confirmed),0) AS pendingGroups FROM groups`).get();
      const pagination = { status, ...pageWindow(requested,
        status === "all" ? totals.totalGroups : status === "confirmed" ? totals.confirmedGroups : totals.pendingGroups) };
      const index = store.db.prepare(`${GROUP_INDEX} SELECT * FROM groups
        WHERE (?='all' OR confirmed=?) ORDER BY recorded_at DESC, recording_id, speaker_label
        LIMIT ? OFFSET ?`).all(status, status === "confirmed" ? 1 : 0, pagination.pageSize, (pagination.page - 1) * pagination.pageSize);
      const groups = [];
      const recordings = new Map();
      for (const item of index) {
        if (!recordings.has(item.recording_id)) {
          const recording = recordingById(item.recording_id);
          let audioExists = false;
          try { checkedFile(root, recording.audio_path); audioExists = true; } catch { /* Availability is only a hint. */ }
          recordings.set(item.recording_id, { recording, audioExists, labels: transcriptLabels(root, recording, config) });
        }
        const { recording, labels, audioExists } = recordings.get(item.recording_id);
        const label = item.speaker_label;
        const rows = groupRows(store, recording.id, label);
          const state = groupState(recording, label, rows);
          const stableIds = [...new Set(rows.map((r) => parse(r.metadata_json).voice?.stableVoiceId).filter(Boolean))];
          const stableVoiceId = stableIds.length === 1 ? stableIds[0] : null;
          groups.push({
            recordingId: recording.id, speakerLabel: label,
            stableVoiceId, associatedPerson: associatedVoicePerson(store, stableVoiceId),
            title: String(parse(recording.metadata_json).title ?? "Voice recording").slice(0, 120),
            recordedAt: recording.recorded_at, segmentCount: rows.length,
            excerpt: rows.map((row) => row.excerpt).join(" ").slice(0, 160),
            ...state,
            canEnroll: !state.disabledReason && labels.has(label),
            enrollmentDisabledReason: state.disabledReason ?? (labels.has(label) ? null : "no_speaker_embedding"),
            sampleAvailable: audioExists,
          });
      }
      return { isolated: Boolean(isolated), people, groups, pagination, counts: {
        recordings: store.db.prepare("SELECT COUNT(*) AS n FROM voice_recordings WHERE status='ready'").get().n,
        people: people.length, groups: groups.length,
        samples: people.reduce((sum, person) => sum + person.sampleCount, 0),
        ...totals, groupsTruncated: pagination.total > groups.length,
      } };
    },

    segments({ recordingId, speakerLabel, revisionToken, ...input } = {}) {
      recordingId = identifier(recordingId, "recordingId");
      speakerLabel = identifier(speakerLabel, "speakerLabel");
      const requested = pageInput({ pageSize: MAX_SEGMENTS, ...input }, MAX_SEGMENTS);
      const recording = recordingById(recordingId);
      if (!recording) fail("GROUP_UNAVAILABLE", "Recording is not ready.");
      const rows = groupRows(store, recordingId, speakerLabel);
      if (!rows.length) fail("GROUP_UNAVAILABLE", "Speaker label not found.");
      const state = groupState(recording, speakerLabel, rows);
      if (revisionToken !== undefined && revisionToken !== state.revisionToken) {
        fail("STALE_REVISION", "Voice group changed; refresh before reading.");
      }
      const pagination = pageWindow(requested, rows.length);
      const segments = store.db.prepare(`SELECT s.segment_id,s.start_ms,s.end_ms,s.revision,
        substr(e.content,1,16000) AS content,length(e.content)>16000 AS text_truncated,
        json_extract(e.metadata_json,'$.voice.identityStatus') AS identity_status,
        json_extract(e.metadata_json,'$.voice.personId') AS person_id,p.name AS person_name
        FROM voice_segments s JOIN evidence e ON e.id=s.evidence_id
        LEFT JOIN graph_entities p ON p.id=json_extract(e.metadata_json,'$.voice.personId') AND p.type='Person'
        WHERE s.recording_id=? AND s.speaker_label=? ORDER BY s.start_ms,s.segment_id LIMIT ? OFFSET ?`)
        .all(recordingId, speakerLabel, pagination.pageSize, (pagination.page - 1) * pagination.pageSize)
        .map((row) => ({ segmentId: row.segment_id, startMs: row.start_ms, endMs: row.end_ms,
          text: row.content, textTruncated: Boolean(row.text_truncated), revision: row.revision,
          identityStatus: row.identity_status, personId: row.person_id, personName: row.person_name }));
      return { recordingId, speakerLabel, recordedAt: recording.recorded_at, revisionToken: state.revisionToken, pagination, segments };
    },

    reviseSegment({ recordingId, speakerLabel, segmentId, revision, text, personId } = {}) {
      recordingId = identifier(recordingId, "recordingId");
      speakerLabel = identifier(speakerLabel, "speakerLabel");
      segmentId = identifier(segmentId, "segmentId");
      if (!Number.isSafeInteger(revision) || revision < 1 || typeof text !== 'string' || !text.trim() || text.length > 16000) {
        fail('INVALID_INPUT', 'Valid revision and nonempty transcript required.');
      }
      if (personId !== null) personId = identifier(personId, 'personId');
      return store.transaction(() => {
        const row = store.db.prepare('SELECT revision FROM voice_segments WHERE recording_id=? AND speaker_label=? AND segment_id=?')
          .get(recordingId, speakerLabel, segmentId);
        if (!row) fail('GROUP_UNAVAILABLE', 'Segment not found.');
        if (row.revision !== revision) fail('STALE_REVISION', 'Segment changed; refresh before correcting.');
        const joined = Object.create(store); joined.transaction = callback => callback();
        const corrected = correctVoiceSegment(joined, config, { recordingId, segmentId, text, reason: '人工试听标注' });
        const identity = annotateVoiceSpeaker(joined, config, { recordingId, speakerLabel, segmentId, personId, enroll: false });
        return { updatedSegments: Number(!corrected.duplicate || !identity.duplicate) };
      });
    },

    createPerson({ name } = {}) {
      if (typeof name !== "string" || name.length > 80 || !name.trim() || /[\x00-\x1f]/.test(name)) {
        fail("INVALID_INPUT", "Person name must be a nonempty string of at most 80 characters.");
      }
      name = name.trim();
      return store.transaction(() => {
        const existing = store.db.prepare(`
          SELECT p.id, p.name, (SELECT COUNT(*) FROM voice_speaker_samples s WHERE s.person_id=p.id AND s.active=1) AS sampleCount
          FROM graph_entities p WHERE p.type='Person' AND p.status='active' AND p.name=? ORDER BY p.id LIMIT 2
        `).all(name);
        if (existing.length > 1) fail("AMBIGUOUS_PERSON", "Multiple people have this name; select an existing person.");
        if (existing.length) return { ...existing[0] };
        const person = registerVoicePerson(store, { key: randomUUID(), name });
        const saved = store.db.prepare("SELECT id, name FROM graph_entities WHERE id=?").get(person.id);
        return { ...saved, sampleCount: 0 };
      });
    },

    revoke({ recordingId, speakerLabel, revisionToken } = {}) {
      recordingId = identifier(recordingId, "recordingId");
      speakerLabel = identifier(speakerLabel, "speakerLabel");
      return store.transaction(() => {
        const recording = recordingById(recordingId);
        if (!recording) fail("GROUP_UNAVAILABLE", "Recording is not ready.");
        const rows = groupRows(store, recordingId, speakerLabel);
        if (!rows.length) fail("GROUP_UNAVAILABLE", "Speaker label not found.");
        if (groupState(recording, speakerLabel, rows).revisionToken !== revisionToken) {
          fail("STALE_REVISION", "Voice group changed; refresh before correcting.");
        }
        const transactionalStore = Object.create(store);
        transactionalStore.transaction = (callback) => callback();
        const result = annotateVoiceSpeaker(transactionalStore, config, { recordingId, speakerLabel, personId: null });
        return { updatedSegments: result.evidenceIds.length, duplicate: result.duplicate };
      });
    },

    confirm({ recordingId, speakerLabel, personId, enroll = false, revisionToken } = {}) {
      recordingId = identifier(recordingId, "recordingId");
      speakerLabel = identifier(speakerLabel, "speakerLabel");
      personId = identifier(personId, "personId");
      if (typeof enroll !== "boolean") fail("INVALID_INPUT", "enroll must be a boolean.");
      return store.transaction(() => {
        const recording = recordingById(recordingId);
        if (!recording) fail("GROUP_UNAVAILABLE", "Recording is not ready.");
        const rows = groupRows(store, recordingId, speakerLabel);
        if (!rows.length) fail("GROUP_UNAVAILABLE", "Speaker label not found.");
        const state = groupState(recording, speakerLabel, rows);
        if (state.disabledReason) return { recordingId, speakerLabel, personId, skipped: true,
          reason: state.disabledReason, enrolled: false, updatedSegments: 0, revisionToken: state.revisionToken };
        if (typeof revisionToken !== "string" || revisionToken !== state.revisionToken) {
          fail("STALE_REVISION", "Voice group changed; refresh before confirming.");
        }
        if (enroll && !transcriptLabels(root, recording, config).has(speakerLabel)) {
          fail("ENROLLMENT_UNAVAILABLE", "No speaker embedding available; confirmation without enrollment is possible.");
        }
        // Existing voice APIs own their transaction. This facade joins our checked write transaction,
        // without mutating the shared store or duplicating annotation/enrollment business rules.
        const transactionalStore = Object.create(store);
        transactionalStore.transaction = (callback) => callback();
        const result = enroll
          ? annotateVoiceSpeaker(transactionalStore, config, { recordingId, speakerLabel, personId, enroll: true })
          : confirmVoiceSpeakerLabel(transactionalStore, config, { recordingId, speakerLabel, personId, confirmedByUser: true });
        return { recordingId, speakerLabel, personId, enrolled: result.enrolled, duplicate: result.duplicate,
          updatedSegments: result.evidenceIds.length,
          revisionToken: groupState(recording, speakerLabel, groupRows(store, recordingId, speakerLabel)).revisionToken };
      });
    },

    sample({ recordingId, speakerLabel, segmentId, offsetMs = 0 } = {}) {
      recordingId = identifier(recordingId, "recordingId");
      speakerLabel = identifier(speakerLabel, "speakerLabel");
      if (segmentId !== undefined) segmentId = identifier(segmentId, "segmentId");
      if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || offsetMs < 0) {
        fail('INVALID_INPUT', 'Playback offset must be a finite nonnegative number.');
      }
      const recording = recordingById(recordingId);
      if (!recording) return { unavailable: true, reason: "group_unavailable" };
      const rows = groupRows(store, recordingId, speakerLabel);
      if (!rows.length && segmentId !== undefined) return { unavailable: true, reason: "group_unavailable" };
      const segment = segmentId === undefined ? null : rows.find((row) => row.segment_id === segmentId);
      if (segmentId !== undefined && !segment) return { unavailable: true, reason: "segment_unavailable" };
      try { return wavSample(root, recording, segment, offsetMs); }
      catch { return { unavailable: true, reason: "sample_unavailable" }; }
    },
  };
}
