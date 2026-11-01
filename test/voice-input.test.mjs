import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import {
  acceptVoiceTranscript, annotateVoiceSpeaker, confirmVoiceSpeakerLabel, correctVoiceSegment, ensureVoiceStorage, importVoiceTranscript,
  registerVoicePerson, registerVoiceRecording, speakerCandidates, transcribeVoiceRecording,
  validateVoiceTranscript, voiceRecording, voiceRecordingDetail,
} from "../src/voice-input.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-voice-test-"));
  const store = openDatabase(path.join(root, "isolated.sqlite"));
  ensureVoiceStorage(store);
  const audioPath = path.join(root, "fixture.wav");
  fs.writeFileSync(audioPath, Buffer.from("RIFF-test-fixture-not-real-audio"));
  const config = { projectRoot: root, voice: {
    runtimeRoot: "runtime/voice", debounceSeconds: 2, python: path.join(root, "python-must-not-run.exe"),
  } };
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { audioPath, deviceId: "pc", recordingId: "one", conversationId: "meeting-1", recordedAt: "2026-10-15T09:00:00+08:00" };
  return { root, store, config, input, count: (table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n };
}

function transcript(overrides = {}) {
  return {
    schemaVersion: 1, durationMs: 5000, engine: "test-only", model: "synthetic-fixture",
    segments: [{ id: "s1", startMs: 100, endMs: 4000, text: "请小李明天核对接口。", speakerLabel: "speaker_0" }],
    speakers: [{ label: "speaker_0", embedding: [1, 0, 0], embeddingModel: "test-embedding-v1" }],
    ...overrides,
  };
}

function precomputedTranscript(f, recording, overrides = {}) {
  const transcriptPath = path.join(f.root, "precomputed.json");
  fs.writeFileSync(transcriptPath, JSON.stringify({
    schemaVersion: 1, audioSha256: recording.content_hash, result: transcript(), ...overrides,
  }));
  return transcriptPath;
}

test("voice file intake is immutable, archived and idempotent", async (t) => {
  const f = fixture(t);
  const first = await registerVoiceRecording(f.store, f.config, f.input);
  assert.equal(first.status, "pending");
  assert.notEqual(first.audio_path, f.input.audioPath);
  assert.deepEqual(fs.readFileSync(first.audio_path), fs.readFileSync(f.input.audioPath));
  assert.equal((await registerVoiceRecording(f.store, f.config, f.input)).duplicate, true);
  assert.equal(f.count("voice_recordings"), 1);
  await assert.rejects(registerVoiceRecording(f.store, f.config, { ...f.input, recordingId: "bad-transfer", sha256: "0".repeat(64) }), /checksum/);
  await assert.rejects(registerVoiceRecording(f.store, f.config, { ...f.input, recordedAt: "2026-10-15T02:00:00Z" }), /identity/);
  fs.writeFileSync(f.input.audioPath, "different audio");
  await assert.rejects(registerVoiceRecording(f.store, f.config, f.input), /identity/);
});

test("voice intake requires zoned time and does not alias device/recording ID tuples", async (t) => {
  const f = fixture(t);
  await assert.rejects(registerVoiceRecording(f.store, f.config, { ...f.input, recordedAt: "2026-10-15T09:00:00" }), /timezone/);
  await assert.rejects(registerVoiceRecording(f.store, f.config, { ...f.input, audioPath: "https://example.invalid/test.wav" }), /local file/);
  await assert.rejects(registerVoiceRecording(f.store, f.config, { ...f.input, audioPath: "\\\\server\\private\\test.wav" }), /local file/);
  const a = await registerVoiceRecording(f.store, f.config, { ...f.input, deviceId: "a:b", recordingId: "c" });
  const b = await registerVoiceRecording(f.store, f.config, { ...f.input, deviceId: "a", recordingId: "b:c" });
  assert.notEqual(a.id, b.id);
});

test("voice transcript enters canonical collaboration and one existing work session without creating tasks or facts", async (t) => {
  const f = fixture(t);
  const facts = f.count("graph_facts");
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const result = acceptVoiceTranscript(f.store, f.config, recording.id, transcript());
  const source = f.store.sourceRecord(result.evidenceIds[0]);
  assert.equal(source.observation.provider, "voice");
  assert.equal(source.observation.sourceFamily, "collaboration");
  assert.equal(source.observation.streamId, "voice:meeting-1");
  assert.equal(source.collaboration.actorId, null);
  assert.equal(source.collaboration.direction, "incoming");
  const event = f.store.db.prepare("SELECT * FROM context_changes WHERE kind='evidence_batch_ingested'").get();
  const metadata = JSON.parse(event.metadata_json);
  assert.match(event.session_key, /^agent:main:shadow:conversation:/);
  assert.equal(metadata.observational, true);
  assert.equal(metadata.identityIsNotAuthorization, true);
  assert.equal(event.status, "pending");
  assert.ok(event.not_before);
  assert.equal(f.count("tasks"), 0);
  assert.equal(f.count("graph_facts"), facts);
  assert.equal(JSON.stringify(source).includes("embedding"), false);
  assert.equal(event.metadata_json.includes("embedding"), false);
  assert.equal(acceptVoiceTranscript(f.store, f.config, recording.id, transcript()).duplicate, true);
  assert.equal(f.count("voice_segments"), 1);
});

test("two devices at the same time retain both observations and share the explicitly chosen conversation", async (t) => {
  const f = fixture(t);
  const a = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, a.id, transcript());
  const b = await registerVoiceRecording(f.store, f.config, { ...f.input, deviceId: "wearable" });
  const result = acceptVoiceTranscript(f.store, f.config, b.id, transcript());
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].disposition, "retained_unverified_overlap");
  assert.equal(f.count("voice_recordings"), 2);
  assert.equal(f.count("voice_segments"), 2);
  const events = f.store.db.prepare("SELECT * FROM context_changes WHERE kind='evidence_batch_ingested'").all();
  assert.equal(events.length, 1);
  const metadata = JSON.parse(events[0].metadata_json);
  assert.equal(metadata.count, 2);
  assert.deepEqual(metadata.recordingIds, [a.id, b.id]);
});

test("reopening the store does not relabel or acknowledge pending voice changes", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const imported = acceptVoiceTranscript(f.store, f.config, recording.id, transcript());
  const reopened = openDatabase(path.join(f.root, "isolated.sqlite"));
  try {
    const pending = reopened.db.prepare("SELECT * FROM context_changes WHERE kind='evidence_batch_ingested'").all();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].coalesce_key, "voice-conversation:voice:meeting-1");
    correctVoiceSegment(reopened, f.config, { recordingId: recording.id, segmentId: "s1", text: "人工更正的文字", reason: "回听" });
    const merged = reopened.db.prepare("SELECT * FROM context_changes WHERE kind='evidence_batch_ingested'").all();
    assert.equal(merged.length, 1);
    assert.equal(JSON.parse(merged[0].metadata_json).count, 2);
    assert.ok(JSON.parse(merged[0].metadata_json).evidenceIds.includes(imported.evidenceIds[0]));
  } finally { reopened.close(); }
});

test("silent recordings keep their receipt but do not wake the controller", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  assert.equal(acceptVoiceTranscript(f.store, f.config, recording.id, transcript({ segments: [], speakers: [] })).emptySpeech, true);
  assert.equal(voiceRecording(f.store, recording.id).status, "ready");
  assert.equal(f.count("context_changes"), 0);
});

test('deadline partials persist without becoming evidence, silence, or automatic retries', async t => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const partialResults = [{ startMs: 0, endMs: 5000, text: 'unfinished text', asrProvider: 'fun-asr-nano',
    purpose: 'core', stopReason: 'audio_duration_deadline', budgetSeconds: 5 }];
  const result = acceptVoiceTranscript(f.store, f.config, recording.id,
    transcript({ completion: 'partial', partialResults, segments: [], speakers: [] }));
  assert.equal(result.emptySpeech, false);
  assert.equal(result.completion, 'partial');
  assert.equal(f.count('evidence'), 0);
  assert.equal(f.count('context_changes'), 0);
  const saved = voiceRecording(f.store, recording.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.transcript_path, 'utf8')).partialResults, partialResults);
  assert.equal(JSON.parse(saved.metadata_json).partialCount, 1);
  assert.equal((await transcribeVoiceRecording(f.store, f.config, recording.id,
    { transcribe() { throw new Error('must not retry'); } })).duplicate, true);
});

test('partial validation rejects invalid completion and ranges but accepts empty timed-out text', () => {
  const partial = { startMs: 0, endMs: 5000, text: '', purpose: 'core',
    stopReason: 'audio_duration_deadline', budgetSeconds: 5 };
  assert.doesNotThrow(() => validateVoiceTranscript(transcript({ completion: 'partial', partialResults: [partial] })));
  assert.doesNotThrow(() => validateVoiceTranscript(transcript({ completion:'partial', partialResults:[{...partial,budgetFactor:2,budgetSeconds:10}] })));
  assert.doesNotThrow(() => validateVoiceTranscript(transcript({ completion:'partial', partialResults:[{...partial,stopReason:'output_token_limit',tokens:512,maxNewTokens:512}] })));
  assert.throws(() => validateVoiceTranscript(transcript({ completion:'partial', partialResults:[{...partial,stopReason:'output_token_limit',tokens:64,maxNewTokens:512}] })));
  for (const override of [{ budgetSeconds: 0 }, { budgetSeconds: 6 }, { startMs: -1 }, { text: null }, {budgetFactor:11}, {budgetFactor:'2'}]) {
    assert.throws(() => validateVoiceTranscript(transcript({ completion: 'partial', partialResults: [{ ...partial, ...override }] })));
  }
  assert.throws(() => validateVoiceTranscript(transcript({ partialResults: [partial] })));
  assert.throws(() => validateVoiceTranscript(transcript({ completion: 'partial' })));
});

test('precomputed partials survive import, database reopen and repeated delivery without evidence', async t => {
  const f = fixture(t);
  const rec = await registerVoiceRecording(f.store, f.config, f.input);
  const partialResults = [{startMs:0,endMs:5000,text:'未完成的中文',purpose:'core',
    stopReason:'audio_duration_deadline',budgetSeconds:10,budgetFactor:2}];
  const saved = precomputedTranscript(f, rec, {result:transcript({completion:'partial',partialResults,segments:[],speakers:[]})});
  const first = await importVoiceTranscript(f.store, f.config, rec.id, saved);
  assert.equal(first.completion, 'partial');
  const reopened = openDatabase(path.join(f.root, 'isolated.sqlite'));
  try {
    const loaded = voiceRecording(reopened,rec.id);
    assert.equal(loaded.status,'ready');
    assert.deepEqual(JSON.parse(fs.readFileSync(loaded.transcript_path,'utf8')).partialResults,partialResults);
    assert.equal((await importVoiceTranscript(reopened,f.config,rec.id,saved)).duplicate,true);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM evidence').get().n,0);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM context_changes').get().n,0);
  } finally {reopened.close();}
});

test('MOSS source windows preserve original ranges and reject context-only or inconsistent projections', () => {
  const segment = { id: 'moss', startMs: 59500, endMs: 62000, text: 'boundary speech',
    speakerLabel: 'window_0001_S01', contextOverlapMs: 500,
    sourceWindow: { index: 1, startMs: 59000, endMs: 90000, coreStartMs: 60000 } };
  const result = transcript({ durationMs: 90000, speakers: [], segments: [segment] });
  assert.doesNotThrow(() => validateVoiceTranscript(result));
  for (const sourceWindow of [null, { ...segment.sourceWindow, index: -1 },
    { ...segment.sourceWindow, coreStartMs: 60001.1 }, { ...segment.sourceWindow, endMs: 90010 },
    { ...segment.sourceWindow, startMs: 59600 }, { ...segment.sourceWindow, endMs: 61000 }]) {
    // Legacy providers may omit the optional window metadata.
    if (sourceWindow == null) continue;
    assert.throws(() => validateVoiceTranscript({ ...result, segments: [{ ...segment, sourceWindow }] }), /source window/);
  }
  assert.throws(() => validateVoiceTranscript({ ...result, segments: [{ ...segment, endMs: 60000 }] }), /source window/);
});

test('MOSS windows reuse anonymous voiceprints without equating local labels or confirming a person', async t => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const segments = [0, 1].map(index => ({ id: `s${index}`, startMs: index * 60000,
    endMs: index * 60000 + 4000, text: 'scope test', speakerLabel: `window_${index}_S01`,
    contextOverlapMs: 0, sourceWindow: { index, startMs: index * 59000,
      endMs: index ? 90000 : 60000, coreStartMs: index * 60000 } }));
  const speakers = segments.map((segment, index) => ({ label: segment.speakerLabel, embedding: [1, 0, 0],
    embeddingModel: 'test-moss-scope', acousticScope: `moss-window-${index}`, speechDurationMs: 4000 }));
  const receipt = acceptVoiceTranscript(f.store, f.config, recording.id,
    transcript({ durationMs: 90000, segments, speakers }));
  const voices = receipt.evidenceIds.map(id => JSON.parse(f.store.db.prepare('SELECT metadata_json FROM evidence WHERE id=?').get(id).metadata_json).voice);
  assert.ok(voices[0].stableVoiceId);
  assert.equal(voices[1].stableVoiceId, voices[0].stableVoiceId);
  assert.equal(voices[1].acousticAssociation.acousticScope, 'moss-window-1');
  assert.equal(voices[1].identityStatus, 'unknown');
  assert.equal(f.count('voice_speaker_samples'), 0);
});

test('MOSS later-window failures retain completed evidence and partial text across reopen', async t => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const partialResults = ['invalid_model_output', 'worker_error'].map((stopReason, index) => ({
    startMs: 60000 + index * 60000, endMs: 120000 + index * 60000, text: 'unparsed or unfinished',
    purpose: 'core', stopReason, budgetFactor: 2, budgetSeconds: 120,
  }));
  const imported = acceptVoiceTranscript(f.store, f.config, recording.id,
    transcript({ durationMs: 180000, completion: 'partial', partialResults }));
  assert.equal(imported.evidenceIds.length, 1);
  assert.equal(imported.completion, 'partial');
  const reopened = openDatabase(path.join(f.root, 'isolated.sqlite'));
  try {
    const rec = voiceRecording(reopened, recording.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(rec.transcript_path, 'utf8')).partialResults, partialResults);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, 1);
    assert.equal((await transcribeVoiceRecording(reopened, f.config, recording.id,
      { transcribe() { throw new Error('must not retry'); } })).duplicate, true);
  } finally { reopened.close(); }
});

test("transcription failure is retryable and a completed retry is not repeated", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  await assert.rejects(transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: async () => { throw new Error("model missing"); } }), /model missing/);
  assert.equal(voiceRecording(f.store, recording.id).status, "failed");
  assert.ok(fs.existsSync(recording.audio_path));
  await transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: async () => transcript() });
  assert.equal(voiceRecording(f.store, recording.id).attempts, 2);
  const result = await transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: () => { throw new Error("must not run"); } });
  assert.equal(result.duplicate, true);
});

test("transcriber leases stop concurrent work and reject stale results after recovery", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  let finish;
  const running = transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: () => new Promise((resolve) => { finish = resolve; }) });
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await transcribeVoiceRecording(f.store, f.config, recording.id)).busy, true);
  const oldLease = voiceRecording(f.store, recording.id).lease_until;
  f.store.db.prepare("UPDATE voice_recordings SET lease_until='2099-01-01T00:00:00.000Z' WHERE id=?").run(recording.id);
  finish(transcript());
  await assert.rejects(running, /leased/);
  assert.equal(voiceRecording(f.store, recording.id).status, "transcribing");
  assert.throws(() => acceptVoiceTranscript(f.store, f.config, recording.id, transcript(), { leaseToken: oldLease }), /leased/);
  f.store.db.prepare("UPDATE voice_recordings SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(recording.id);
  await transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: async () => transcript() });
  assert.equal(voiceRecording(f.store, recording.id).status, "ready");
});

test("modified archive fails before ASR rather than publishing a changed recording", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  fs.writeFileSync(recording.audio_path, "changed archived content");
  let called = false;
  await assert.rejects(transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: async () => { called = true; return transcript(); } }), /checksum/);
  assert.equal(called, false);
  assert.equal(f.count("evidence"), 0);
  assert.equal(voiceRecording(f.store, recording.id).status, "failed");
});

test("precomputed transcripts reuse validated ingestion and are idempotent without Python", async (t) => {
  const f = fixture(t);
  const audio = { sampleRateHz: 16000, sampleCount: 80000, channels: 1 };
  const recording = await registerVoiceRecording(f.store, f.config, { ...f.input, ...audio, durationMs: 5000 });
  const payload = transcript({ audio, timings: { asrSeconds: 0.25 } });
  const transcriptPath = precomputedTranscript(f, recording, { result: payload });
  fs.writeFileSync(transcriptPath, `\uFEFF${fs.readFileSync(transcriptPath, "utf8")}`);
  const facts = f.count("graph_facts");
  const result = await importVoiceTranscript(f.store, f.config, recording.id, transcriptPath);
  assert.equal(result.duplicate, false);
  assert.equal(result.evidenceIds.length, 1);
  const completed = voiceRecording(f.store, recording.id);
  assert.equal(completed.status, "ready");
  assert.equal(completed.attempts, 1);
  assert.equal(completed.lease_until, null);
  assert.equal(completed.last_error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(completed.transcript_path, "utf8")), payload);
  assert.deepEqual(result.timings, payload.timings);
  assert.equal(f.store.sourceRecord(result.evidenceIds[0]).observation.provider, "voice");
  assert.equal(voiceRecordingDetail(f.store, recording.id).segments[0].metadata.voice.engine, payload.engine);
  assert.equal(f.count("tasks"), 0);
  assert.equal(f.count("controller_outbox"), 0);
  assert.equal(f.count("graph_facts"), facts);
  const duplicate = await importVoiceTranscript(f.store, f.config, recording.id, transcriptPath);
  assert.deepEqual(duplicate, { recordingId: recording.id, duplicate: true, evidenceIds: [] });
  assert.deepEqual(voiceRecording(f.store, recording.id), completed);
  assert.equal(f.count("evidence"), 1);
  assert.equal(f.count("voice_segments"), 1);
  assert.equal(f.count("context_changes"), 1);
});

test("precomputed audio hash mismatch fails without evidence and can be retried", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const transcriptPath = precomputedTranscript(f, recording, { audioSha256: "0".repeat(64) });
  await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), /audioSha256.*checksum/);
  const failed = voiceRecording(f.store, recording.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lease_until, null);
  assert.match(failed.last_error, /audioSha256/);
  assert.equal(failed.transcript_path, null);
  assert.equal(f.count("evidence"), 0);
  assert.equal(f.count("context_changes"), 0);
  precomputedTranscript(f, recording, { audioSha256: recording.content_hash.toUpperCase() });
  await importVoiceTranscript(f.store, f.config, recording.id, transcriptPath);
  assert.equal(voiceRecording(f.store, recording.id).status, "ready");
  assert.equal(voiceRecording(f.store, recording.id).attempts, 2);
});

test("precomputed JSON and envelopes reject malformed or oversized input before publication", async (t) => {
  const cases = [
    ["empty", () => "", /nonempty/],
    ["malformed JSON", () => "{", /JSON/],
    ["invalid UTF-8", () => Buffer.from([123, 34, 255, 34, 58, 49, 125]), /JSON/],
    ["null envelope", () => "null", /envelope/],
    ["array envelope", () => "[]", /envelope/],
    ["raw ASR result", () => JSON.stringify(transcript()), /envelope/],
    ["wrong envelope schema", (value) => JSON.stringify({ ...value, schemaVersion: 2 }), /envelope/],
    ["short hash", (value) => JSON.stringify({ ...value, audioSha256: "a".repeat(63) }), /envelope/],
    ["non-hex hash", (value) => JSON.stringify({ ...value, audioSha256: "g".repeat(64) }), /envelope/],
    ["non-string hash", (value) => JSON.stringify({ ...value, audioSha256: [value.audioSha256] }), /envelope/],
    ["missing result", (value) => JSON.stringify({ ...value, result: undefined }), /envelope/],
    ["wrong result schema", (value) => JSON.stringify({ ...value, result: transcript({ schemaVersion: 2 }) }), /transcript schema/],
    ["duplicate segments", (value) => JSON.stringify({ ...value, result: transcript({
      segments: [transcript().segments[0], transcript().segments[0]],
    }) }), /Duplicate/],
    ["invalid duration", (value) => JSON.stringify({ ...value, result: transcript({ durationMs: 43_200_001 }) }), /duration/],
    ["over 2 MiB", (value) => JSON.stringify(value).padEnd(2 * 1024 * 1024 + 1, " "), /2 MiB/],
  ];
  for (const [name, content, error] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      const recording = await registerVoiceRecording(f.store, f.config, f.input);
      const transcriptPath = precomputedTranscript(f, recording);
      const envelope = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
      fs.writeFileSync(transcriptPath, content(envelope));
      await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), error);
      const failed = voiceRecording(f.store, recording.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.lease_until, null);
      assert.equal(failed.transcript_path, null);
      assert.equal(f.count("evidence"), 0);
      assert.equal(f.count("voice_segments"), 0);
      assert.equal(f.count("context_changes"), 0);
    });
  }
});

test("precomputed JSON allows exactly 2 MiB and measures bytes rather than characters", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const transcriptPath = precomputedTranscript(f, recording);
  const json = fs.readFileSync(transcriptPath, "utf8");
  fs.appendFileSync(transcriptPath, " ".repeat(2 * 1024 * 1024 - Buffer.byteLength(json)));
  assert.equal(fs.statSync(transcriptPath).size, 2 * 1024 * 1024);
  assert.equal((await importVoiceTranscript(f.store, f.config, recording.id, transcriptPath)).duplicate, false);
});

test("precomputed JSON reads remain bounded if the file grows after stat", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const transcriptPath = precomputedTranscript(f, recording);
  const stat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (...args) => {
    const original = stat(...args);
    fs.appendFileSync(transcriptPath, " ".repeat(2 * 1024 * 1024));
    return original;
  }, { times: 1 });
  const read = fs.readSync;
  let bytesRead = 0;
  t.mock.method(fs, "readSync", (...args) => {
    const size = read(...args);
    bytesRead += size;
    return size;
  });
  await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), /exceeds the 2 MiB limit/);
  assert.equal(bytesRead, 2 * 1024 * 1024 + 1);
  assert.equal(voiceRecording(f.store, recording.id).status, "failed");
  assert.equal(f.count("evidence"), 0);
});

test("precomputed transcript paths must be local regular files", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  for (const transcriptPath of ["https://example.invalid/asr.json", "file:///asr.json", "\\\\server\\share\\asr.json", "//server/share/asr.json", "\\\\.\\pipe\\asr"]) {
    await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), /local file paths/);
  }
  await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, f.root), /regular JSON file/);
  await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, ""), /transcript path/);
  await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, path.join(f.root, "missing.json")), /ENOENT/);
  assert.equal(f.count("evidence"), 0);
});

test("precomputed results still enforce declared duration and sample metadata", async (t) => {
  const audio = { sampleRateHz: 16000, sampleCount: 80000, channels: 1 };
  for (const key of ["durationMs", "sampleRateHz", "sampleCount", "channels", "missing audio"]) {
    await t.test(key, async (t) => {
      const f = fixture(t);
      const recording = await registerVoiceRecording(f.store, f.config, { ...f.input, ...audio, durationMs: 5000 });
      const result = transcript({ audio: { ...audio } });
      if (key === "durationMs") result.durationMs = 4000;
      else if (key === "missing audio") delete result.audio;
      else result.audio[key] += 1;
      const transcriptPath = precomputedTranscript(f, recording, { result });
      await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), /differs from the transfer manifest/);
      assert.equal(voiceRecording(f.store, recording.id).status, "failed");
      assert.equal(f.count("evidence"), 0);
      assert.equal(f.count("context_changes"), 0);
    });
  }
});

test("precomputed imports honor active leases and recover expired leases", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const transcriptPath = precomputedTranscript(f, recording);
  f.store.db.prepare("UPDATE voice_recordings SET status='transcribing', lease_until='2099-01-01T00:00:00.000Z' WHERE id=?").run(recording.id);
  const leased = voiceRecording(f.store, recording.id);
  assert.deepEqual(await importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), { recordingId: recording.id, busy: true });
  assert.deepEqual(voiceRecording(f.store, recording.id), leased);
  assert.equal(f.count("evidence"), 0);
  f.store.db.prepare("UPDATE voice_recordings SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(recording.id);
  await importVoiceTranscript(f.store, f.config, recording.id, transcriptPath);
  assert.equal(voiceRecording(f.store, recording.id).status, "ready");
  assert.equal(voiceRecording(f.store, recording.id).attempts, 1);
});

test("precomputed imports cannot publish or clear a replacement transcriber's lease", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const transcriptPath = precomputedTranscript(f, recording);
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (...args) => {
    f.store.db.prepare("UPDATE voice_recordings SET lease_until='2099-01-01T00:00:00.000Z' WHERE id=?").run(recording.id);
    return read(...args);
  }, { times: 1 });
  await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), /leased by another transcriber/);
  const leased = voiceRecording(f.store, recording.id);
  assert.equal(leased.status, "transcribing");
  assert.equal(leased.lease_until, "2099-01-01T00:00:00.000Z");
  assert.equal(leased.last_error, null);
  assert.equal(f.count("evidence"), 0);
});

test("precomputed imports verify archived audio before and after loading the result", async (t) => {
  for (const when of ["before", "during"]) {
    await t.test(when, async (t) => {
      const f = fixture(t);
      const recording = await registerVoiceRecording(f.store, f.config, f.input);
      const transcriptPath = precomputedTranscript(f, recording);
      const changeAudio = () => fs.writeFileSync(recording.audio_path, "changed archive");
      if (when === "before") changeAudio();
      else {
        const read = fs.readSync;
        t.mock.method(fs, "readSync", (...args) => { changeAudio(); return read(...args); });
      }
      await assert.rejects(importVoiceTranscript(f.store, f.config, recording.id, transcriptPath), /Archived audio/);
      assert.equal(voiceRecording(f.store, recording.id).status, "failed");
      assert.equal(f.count("evidence"), 0);
      assert.equal(f.count("context_changes"), 0);
    });
  }
});

test("failed capture declarations may be corrected and retried without changing recording identity", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, { ...f.input, durationMs: 4000, channels: 2 });
  await assert.rejects(transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: async () => transcript() }), /duration differs/);
  const correction = await registerVoiceRecording(f.store, f.config, { ...f.input, durationMs: 5000, channels: 1 });
  assert.equal(correction.id, recording.id);
  assert.equal(correction.captureMetadataUpdated, true);
  const result = transcript({ audio: { sampleRateHz: 16000, sampleCount: 80000, channels: 1 } });
  await transcribeVoiceRecording(f.store, f.config, recording.id, { transcribe: async () => result });
  assert.equal(voiceRecording(f.store, recording.id).status, "ready");
  assert.equal(JSON.parse(voiceRecording(f.store, recording.id).metadata_json).captureCorrections.length, 1);
  await assert.rejects(registerVoiceRecording(f.store, f.config, { ...f.input, channels: 2 }), /before publication/);
});

test("malformed transcripts fail before creating partial evidence", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  const invalid = transcript();
  invalid.segments.push({ ...invalid.segments[0] });
  assert.throws(() => acceptVoiceTranscript(f.store, f.config, recording.id, invalid), /Duplicate/);
  assert.throws(() => validateVoiceTranscript(transcript({ speakers: {} })), /speaker list/);
  assert.throws(() => validateVoiceTranscript(transcript({ durationMs: 43_200_001 })), /duration/);
  assert.throws(() => validateVoiceTranscript(transcript({ durationMs: 600_001 }), { maxDurationMs: 600_000 }), /duration/);
  assert.equal(f.count("evidence"), 0);
  assert.equal(voiceRecording(f.store, recording.id).status, "pending");
});

test("boundary candidates stay on one observation and cannot change identity or create duplicate evidence", async t => {
  const f = fixture(t), recording = await registerVoiceRecording(f.store, f.config, f.input);
  const result = transcript();
  result.segments[0].startMs = 1000;
  result.segments[0].forcedStart = true;
  result.segments[0].boundaryContext = { text: "前半句加后半句", startMs: 0, endMs: 4000, overlapMs: 1000,
    policy: "core-text-with-context-candidate-not-word-aligned" };
  const accepted = acceptVoiceTranscript(f.store, f.config, recording.id, result);
  assert.equal(accepted.evidenceIds.length, 1);
  const evidence = f.store.db.prepare('SELECT * FROM evidence WHERE id=?').get(accepted.evidenceIds[0]);
  assert.equal(evidence.content, result.segments[0].text);
  assert.equal(JSON.parse(evidence.metadata_json).voice.boundaryContext.text, "前半句加后半句");
  assert.equal(JSON.parse(evidence.metadata_json).voice.identityStatus, "unknown");
  assert.equal(acceptVoiceTranscript(f.store, f.config, recording.id, result).duplicate, true);
  result.segments[0].boundaryContext.startMs = -1;
  assert.throws(() => validateVoiceTranscript(result), /boundary context/);
});

test("capture declarations are retained and mismatched audio duration is rejected", async (t) => {
  const f = fixture(t);
  const recording = await registerVoiceRecording(f.store, f.config, { ...f.input, durationMs: 4000, sampleRateHz: 16000, sampleCount: 64000, channels: 1 });
  assert.equal(JSON.parse(recording.metadata_json).capture.sampleCount, 64000);
  assert.throws(() => acceptVoiceTranscript(f.store, f.config, recording.id, transcript()), /duration differs/);
  assert.equal(f.count("evidence"), 0);
});

test("confirmed voice labels reuse Person entities; embeddings only propose future matches", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "alice", name: "测试甲" });
  assert.equal(registerVoicePerson(f.store, { key: "alice", name: "测试甲" }).id, person.id);
  assert.throws(() => registerVoicePerson(f.store, { key: "alice", name: "另一个人" }), /assigned/);
  const a = await registerVoiceRecording(f.store, f.config, f.input);
  const original = acceptVoiceTranscript(f.store, f.config, a.id, transcript()).evidenceIds[0];
  const annotation = annotateVoiceSpeaker(f.store, f.config, { recordingId: a.id, speakerLabel: "speaker_0", personId: person.id, enroll: true });
  assert.equal(annotation.enrolled, true);
  assert.equal(f.store.sourceRecord(annotation.evidenceIds[0]).collaboration.actorId, person.id);
  assert.ok(f.store.db.prepare("SELECT id FROM evidence WHERE id=?").get(original));
  const b = await registerVoiceRecording(f.store, f.config, { ...f.input, recordingId: "two" });
  const imported = acceptVoiceTranscript(f.store, f.config, b.id, transcript());
  const segment = voiceRecordingDetail(f.store, b.id).segments[0];
  assert.equal(segment.metadata.voice.identityStatus, "candidate");
  assert.equal(segment.metadata.voice.candidates[0].personId, person.id);
  assert.equal(f.store.sourceRecord(imported.evidenceIds[0]).collaboration.actorId, null);
  assert.equal(segment.metadata.sentBySelf, false);
  assert.equal(speakerCandidates(f.store, [1, 0, 0], "different-model").length, 0);
});

test("user-confirmed label batch revises every matching segment in only one recording", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "batch-person", name: "Confirmed Person" });
  const a = await registerVoiceRecording(f.store, f.config, f.input);
  const initial = acceptVoiceTranscript(f.store, f.config, a.id, transcript({ segments: [
    { id: "s1", startMs: 0, endMs: 1000, text: "First statement.", speakerLabel: "speaker_0" },
    { id: "s2", startMs: 1100, endMs: 2000, text: "Second statement.", speakerLabel: "speaker_0" },
    { id: "s3", startMs: 2100, endMs: 3000, text: "Another speaker.", speakerLabel: "speaker_1" },
    { id: "s4", startMs: 3100, endMs: 4000, text: "Unknown speech.", speakerLabel: "unknown" },
  ] }));
  const b = await registerVoiceRecording(f.store, f.config, { ...f.input, recordingId: "another-recording" });
  acceptVoiceTranscript(f.store, f.config, b.id, transcript());
  const originals = f.store.db.prepare("SELECT * FROM evidence ORDER BY id").all();
  const input = { recordingId: a.id, speakerLabel: "speaker_0", personId: person.id, confirmedByUser: true };
  const result = confirmVoiceSpeakerLabel(f.store, f.config, input);
  assert.equal(result.scope, "recording_speaker_label");
  assert.equal(result.updatedSegments, 2);
  assert.equal(result.enrolled, false);
  const current = voiceRecordingDetail(f.store, a.id).segments;
  assert.deepEqual(current.map((segment) => segment.revision), [2, 2, 1, 1]);
  assert.deepEqual(current.map((segment) => segment.metadata.voice.personId), [person.id, person.id, null, null]);
  for (const original of originals) {
    assert.deepEqual(f.store.db.prepare("SELECT * FROM evidence WHERE id=?").get(original.id), original);
    assert.equal(f.store.sourceRecord(original.id).collaboration.actorId, null);
  }
  for (const [index, evidenceId] of result.evidenceIds.entries()) {
    assert.equal(f.store.sourceRecord(evidenceId).collaboration.actorId, person.id);
    assert.equal(f.store.db.prepare("SELECT child_evidence_id FROM evidence_links WHERE parent_evidence_id=? AND relation='corrects'").get(evidenceId).child_evidence_id,
      initial.evidenceIds[index]);
  }
  assert.equal(voiceRecordingDetail(f.store, b.id).segments[0].metadata.voice.personId, null);
  const pending = f.store.db.prepare("SELECT metadata_json FROM context_changes WHERE status='pending'").get();
  const metadata = JSON.parse(pending.metadata_json);
  assert.equal(metadata.requiresResponsibilityRecheck, true);
  assert.ok(initial.evidenceIds.slice(0, 2).every((id) => metadata.correctsEvidenceIds.includes(id)));
  const count = f.count("evidence");
  const retry = confirmVoiceSpeakerLabel(f.store, f.config, input);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.updatedSegments, 0);
  assert.equal(f.count("evidence"), count);
  assert.equal(f.store.db.prepare("SELECT metadata_json FROM context_changes WHERE status='pending'").get().metadata_json, pending.metadata_json);
  for (const table of ["voice_speaker_samples", "tasks", "controller_outbox"]) assert.equal(f.count(table), 0, table);
});

test("label batch rejects unconfirmed, unknown-phone, enrollment and partial requests without mutations", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "phone-person", name: "Phone Person" });
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, recording.id, transcript({ speakers: [], segments: [
    { id: "s1", startMs: 0, endMs: 1000, text: "Phone statement.", speakerLabel: "unknown" },
    { id: "s2", startMs: 1100, endMs: 2000, text: "Possibly someone else.", speakerLabel: "unknown" },
  ] }));
  const input = { recordingId: recording.id, speakerLabel: "unknown", personId: person.id, confirmedByUser: true };
  const before = voiceRecordingDetail(f.store, recording.id);
  const cases = [
    [{ confirmedByUser: false }, /explicit user confirmation/],
    [{ confirmedByUser: undefined }, /explicit user confirmation/],
    [{ confirmedByUser: "true" }, /explicit user confirmation/],
    [{}, /Unknown speech.*without acoustic clustering/],
    [{ speakerLabel: "speaker_0", enroll: true }, /separate operations/],
    [{ speakerLabel: "speaker_0", segmentId: "s1" }, /separate operations/],
    [{ speakerLabel: "speaker_0", personId: null }, /Invalid personId/],
    [{ speakerLabel: "speaker_0", personId: "missing-person" }, /existing active Person/],
    [{ speakerLabel: "speaker_0", recordingId: "missing-recording" }, /not ready/],
    [{ speakerLabel: "speaker_0" }, /Speaker label not found/],
  ];
  for (const [override, error] of cases) {
    assert.throws(() => confirmVoiceSpeakerLabel(f.store, f.config, { ...input, ...override }), error);
    assert.deepEqual(voiceRecordingDetail(f.store, recording.id), before);
    assert.equal(f.count("evidence"), 2);
    assert.equal(f.count("voice_speaker_samples"), 0);
  }
  annotateVoiceSpeaker(f.store, f.config, { ...input, segmentId: "s1" });
  assert.deepEqual(voiceRecordingDetail(f.store, recording.id).segments.map((segment) => segment.metadata.voice.personId), [person.id, null]);
});

test("label batch rolls back all revisions and review notification on a later segment failure", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "rollback-person", name: "Rollback Person" });
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, recording.id, transcript({ segments: [
    { id: "s1", startMs: 0, endMs: 1000, text: "One.", speakerLabel: "speaker_0" },
    { id: "s2", startMs: 1100, endMs: 2000, text: "Two.", speakerLabel: "speaker_0" },
  ] }));
  const before = voiceRecordingDetail(f.store, recording.id);
  const pending = f.store.db.prepare("SELECT * FROM context_changes").all();
  f.store.db.exec(`CREATE TRIGGER fail_batch_revision BEFORE INSERT ON evidence
    WHEN NEW.external_id LIKE '%:s2:r2'
    BEGIN SELECT RAISE(ABORT, 'synthetic batch failure'); END;`);
  assert.throws(() => confirmVoiceSpeakerLabel(f.store, f.config, {
    recordingId: recording.id, speakerLabel: "speaker_0", personId: person.id, confirmedByUser: true,
  }), /synthetic batch failure/);
  assert.deepEqual(voiceRecordingDetail(f.store, recording.id), before);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM context_changes").all(), pending);
  assert.equal(f.count("evidence"), 2);
  assert.equal(f.count("evidence_links"), 0);
  assert.equal(f.count("source_observations"), 2);
  assert.equal(f.count("collaboration_events"), 2);
});

test("identity corrections append evidence and invalidate old samples without erasing history", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "alice", name: "测试甲" });
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, recording.id, transcript());
  const label = { recordingId: recording.id, speakerLabel: "speaker_0", personId: person.id };
  annotateVoiceSpeaker(f.store, f.config, { ...label, enroll: true });
  assert.equal(annotateVoiceSpeaker(f.store, f.config, label).duplicate, true);
  const result = annotateVoiceSpeaker(f.store, f.config, { ...label, personId: null });
  assert.equal(f.count("evidence"), 3);
  assert.equal(f.store.sourceRecord(result.evidenceIds[0]).collaboration.actorId, null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM voice_speaker_samples WHERE active=1").get().n, 0);
  assert.equal(voiceRecordingDetail(f.store, recording.id).segments[0].revision, 3);
});

test("annotation reads the latest segment after taking the write transaction", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "alice", name: "测试甲" });
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, recording.id, transcript());
  const other = openDatabase(path.join(f.root, "isolated.sqlite"));
  const originalTransaction = f.store.transaction.bind(f.store);
  f.store.transaction = (callback) => {
    correctVoiceSegment(other, f.config, { recordingId: recording.id, segmentId: "s1", text: "另一进程刚修正的文字", reason: "模拟并发" });
    f.store.transaction = originalTransaction;
    return originalTransaction(callback);
  };
  try {
    annotateVoiceSpeaker(f.store, f.config, { recordingId: recording.id, speakerLabel: "speaker_0", personId: person.id });
    const current = voiceRecordingDetail(f.store, recording.id).segments[0];
    assert.equal(current.revision, 3);
    assert.equal(current.metadata.voice.revision, 3);
    assert.equal(current.metadata.voice.identityStatus, "confirmed");
    assert.equal(current.content, "另一进程刚修正的文字");
  } finally { other.close(); f.store.transaction = originalTransaction; }
});

test("text correction survives later coalesced audio and asks for responsibility re-evaluation", async (t) => {
  const f = fixture(t);
  const a = await registerVoiceRecording(f.store, f.config, f.input);
  const oldId = acceptVoiceTranscript(f.store, f.config, a.id, transcript()).evidenceIds[0];
  const result = correctVoiceSegment(f.store, f.config, { recordingId: a.id, segmentId: "s1", text: "请小王明天核对接口。", reason: "人名转写错误" });
  assert.equal(voiceRecordingDetail(f.store, a.id).segments[0].content, "请小王明天核对接口。");
  assert.equal(f.store.sourceRecord(result.evidenceIds[0]).collaboration.replyTo, oldId);
  const b = await registerVoiceRecording(f.store, f.config, { ...f.input, recordingId: "two" });
  acceptVoiceTranscript(f.store, f.config, b.id, transcript());
  const pending = JSON.parse(f.store.db.prepare("SELECT metadata_json FROM context_changes WHERE kind='evidence_batch_ingested'").get().metadata_json);
  assert.equal(pending.requiresResponsibilityRecheck, true);
  assert.ok(pending.correctsEvidenceIds.includes(oldId));
  assert.equal(f.store.db.prepare("SELECT content FROM evidence WHERE id=?").get(oldId).content, "请小李明天核对接口。");
  assert.equal(f.count("tasks"), 0);
});

test("annotation without embeddings is supported but biometric enrollment is not fabricated", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "alice", name: "测试甲" });
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, recording.id, transcript({ speakers: [] }));
  const label = { recordingId: recording.id, speakerLabel: "speaker_0", personId: person.id };
  assert.throws(() => annotateVoiceSpeaker(f.store, f.config, { ...label, enroll: true }), /No speaker embedding/);
  assert.equal(annotateVoiceSpeaker(f.store, f.config, label).enrolled, false);
});

test("unknown short utterances require per-segment identity annotation", async (t) => {
  const f = fixture(t);
  const person = registerVoicePerson(f.store, { key: "alice", name: "测试甲" });
  const recording = await registerVoiceRecording(f.store, f.config, f.input);
  acceptVoiceTranscript(f.store, f.config, recording.id, transcript({
    speakers: [], segments: [
      { id: "a", startMs: 0, endMs: 500, text: "好", speakerLabel: "unknown" },
      { id: "b", startMs: 1000, endMs: 1500, text: "不行", speakerLabel: "unknown" },
    ],
  }));
  const label = { recordingId: recording.id, speakerLabel: "unknown", personId: person.id };
  assert.throws(() => annotateVoiceSpeaker(f.store, f.config, label), /not one speaker/);
  annotateVoiceSpeaker(f.store, f.config, { ...label, segmentId: "a" });
  const segments = voiceRecordingDetail(f.store, recording.id).segments;
  assert.equal(segments[0].metadata.voice.personId, person.id);
  assert.equal(segments[1].metadata.voice.identityStatus, "unknown");
});
