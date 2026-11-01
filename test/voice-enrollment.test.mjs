import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import { createVoiceEnrollmentService } from "../src/voice-enrollment.mjs";
import {
  acceptVoiceTranscript, annotateVoiceSpeaker, correctVoiceSegment,
  registerVoicePerson, registerVoiceRecording, voiceRecordingDetail,
} from "../src/voice-input.mjs";

function wav({ seconds = 12, rate = 16000, channels = 1 } = {}) {
  const result = Buffer.alloc(44 + seconds * rate * channels * 2);
  result.write("RIFF");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(rate, 24);
  result.writeUInt32LE(rate * channels * 2, 28);
  result.writeUInt16LE(channels * 2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(result.length - 44, 40);
  for (let i = 44; i < result.length; i += 2) result.writeInt16LE(((i - 44) / 2) % 32000, i);
  return result;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-enrollment-test-"));
  const store = openDatabase(path.join(root, "isolated.sqlite"));
  const config = { projectRoot: root, voice: { runtimeRoot: "voice", python: "must-not-run", debounceSeconds: 2 } };
  const service = createVoiceEnrollmentService(store, config, { isolated: true });
  const audioPath = path.join(root, "fixture.wav");
  fs.writeFileSync(audioPath, wav());
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let next = 0;
  const recording = async (overrides = {}, input = {}) => {
    const rec = await registerVoiceRecording(store, config, {
      audioPath, deviceId: "test", recordingId: `recording-${++next}`,
      recordedAt: "2026-10-18T01:00:00Z", title: "Test recording", testOnly: true, ...input,
    });
    acceptVoiceTranscript(store, config, rec.id, {
      schemaVersion: 1, durationMs: 12000,
      segments: [
        { id: "one", startMs: 1000, endMs: 11000, speakerLabel: "speaker_0", text: "First phrase. " + "x".repeat(200) },
        { id: "two", startMs: 11000, endMs: 12000, speakerLabel: "speaker_0", text: "Second phrase." },
      ],
      speakers: [{ label: "speaker_0", embedding: [1, 0, 0], embeddingModel: "synthetic-test" }],
      ...overrides,
    });
    return voiceRecordingDetail(store, rec.id);
  };
  const group = (id, label = "speaker_0") => service.snapshot().groups.find((g) => g.recordingId === id && g.speakerLabel === label);
  const request = (id, person, extra = {}) => ({ recordingId: id, speakerLabel: "speaker_0", personId: person.id,
    revisionToken: group(id).revisionToken, ...extra });
  const count = (table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { root, store, config, service, audioPath, recording, group, request, count };
}

test("revoke checks revision, disables templates and preserves evidence while queuing review", async t => {
  const f = fixture(t), rec = await f.recording();
  const person = f.service.createPerson({ name: 'Test revoke' });
  const old = f.group(rec.id);
  f.service.confirm({ ...old, personId: person.id, enroll: true });
  assert.throws(() => f.service.revoke(old), { code: 'STALE_REVISION' });
  const confirmed = f.group(rec.id), before = f.count('evidence');
  const result = f.service.revoke(confirmed);
  assert.equal(result.updatedSegments, 2);
  assert.equal(f.count('evidence'), before + 2);
  assert.equal(f.group(rec.id).personId, null);
  assert.equal(f.service.snapshot().people[0].sampleCount, 0);
  assert.equal(f.service.progress({ recordingId: rec.id }).review.status, 'pending');
  assert.throws(() => f.service.revoke(confirmed), { code: 'STALE_REVISION' });
  assert.equal(f.service.revoke(f.group(rec.id)).duplicate, true);
});

test('unfinished text is paged independently even with no enrollable speaker groups', async t => {
  const f = fixture(t);
  const partialResults = [{ startMs: 0, endMs: 12000, text: 'unfinished', purpose: 'core',
    stopReason: 'audio_duration_deadline', budgetSeconds: 12 }];
  const rec = await f.recording({ completion: 'partial', segments: [], speakers: [], partialResults });
  assert.equal(f.service.snapshot().groups.length, 0);
  const page = f.service.partials({ pageSize: 1 });
  assert.equal(page.recordings[0].recordingId, rec.id);
  assert.equal(page.pagination.total, 1);
  assert.deepEqual(f.service.partials({ recordingId: rec.id }).partials, partialResults);
  assert.throws(() => f.service.partials({ recordingId: '../wrong' }), { code: 'GROUP_UNAVAILABLE' });
  assert.equal(f.count('evidence'), 0);
  assert.equal(f.count('voice_speaker_samples'), 0);
});

test("synchronous snapshot is bounded, sanitized and based on active Person samples", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.snapshot(), { isolated: true, people: [], groups: [],
    pagination: {status:'all',page:1,pageSize:50,total:0,totalPages:0,hasPrevious:false,hasNext:false}, counts: {
    recordings: 0, people: 0, groups: 0, samples: 0, totalGroups: 0, groupsTruncated: false,
    pendingGroups:0,confirmedGroups:0,
  } });
  assert.equal(createVoiceEnrollmentService(f.store, f.config).snapshot().isolated, false);
  const person = f.service.createPerson({ name: "  Alice  " });
  assert.deepEqual(person, { id: person.id, name: "Alice", sampleCount: 0 });
  assert.equal(f.service.createPerson({ name: "Alice" }).id, person.id);
  assert.throws(() => f.service.createPerson({ name: "" }), { code: "INVALID_INPUT" });
  const rec = await f.recording();
  const before = f.group(rec.id);
  assert.equal(before.segmentCount, 2);
  assert.equal(before.excerpt.length, 160);
  assert.equal(before.personId, null);
  assert.equal(before.canEnroll, true);
  assert.equal(before.sampleAvailable, true);
  const receipt = f.service.confirm(f.request(rec.id, person, { enroll: true }));
  assert.equal(receipt.enrolled, true);
  assert.equal(receipt.updatedSegments, 2);
  const snapshot = f.service.snapshot();
  assert.equal(snapshot.people.find((p) => p.id === person.id).sampleCount, 1);
  assert.equal(snapshot.groups[0].personName, "Alice");
  assert.equal(snapshot.counts.samples, 1);
  assert.notEqual(snapshot.groups[0].revisionToken, before.revisionToken);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [rec.audio_path, rec.transcript_path, "embedding_json", "synthetic-test", "x".repeat(200), "evidence_id", "data:audio"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.deepEqual(Object.keys(snapshot.people[0]).sort(), ["id", "name", "sampleCount"]);
  for (const table of ["tasks", "controller_outbox"]) assert.equal(f.count(table), 0);
});

test("person creation rejects coercion, is retry-safe and requires selection for existing namesakes", async (t) => {
  const f = fixture(t);
  for (const name of [undefined, null, 1, {}, [], { toString: () => "Alice" }, "x".repeat(81), "\nAlice", "   "]) {
    assert.throws(() => f.service.createPerson({ name }), { code: "INVALID_INPUT" });
  }
  const before = f.count("graph_entities");
  const alice = f.service.createPerson({ name: "Alice" });
  assert.deepEqual(f.service.createPerson({ name: " Alice " }), alice);
  assert.equal(f.count("graph_entities"), before + 1);
  const rec = await f.recording();
  f.service.confirm(f.request(rec.id, alice, { enroll: true }));
  assert.equal(f.service.createPerson({ name: "Alice" }).sampleCount, 1);
  assert.equal(f.service.createPerson({ name: "x".repeat(80) }).name.length, 80);
  registerVoicePerson(f.store, { key: "existing-namesake", name: "Alice" });
  assert.throws(() => f.service.createPerson({ name: "Alice" }), { code: "AMBIGUOUS_PERSON" });
});

test("late human labeling offers a cross-file candidate without rewriting historical identity", async (t) => {
  const f = fixture(t);
  const first = await f.recording();
  const second = await f.recording();
  const stable = f.group(first.id).stableVoiceId;
  assert.ok(stable);
  assert.equal(f.group(second.id).stableVoiceId, stable);
  assert.equal(f.group(first.id).associatedPerson, null);
  const person = f.service.createPerson({ name: "Alice" });
  f.service.confirm(f.request(second.id, person));
  const old = f.group(first.id);
  assert.equal(old.personId, null);
  assert.equal(old.associatedPerson.personId, person.id);
  assert.equal(old.associatedPerson.requiresConfirmation, true);
  const other = f.service.createPerson({ name: "Bob" });
  f.service.confirm(f.request(first.id, other));
  const third = await f.recording();
  assert.equal(f.group(third.id).associatedPerson, null);
  assert.equal(f.group(third.id).personId, null);
});

test("snapshot bounds each page without hiding other recording-local groups", async (t) => {
  const f = fixture(t);
  for (let r = 0; r < 3; r++) {
    await f.recording({ speakers: [], segments: Array.from({ length: 101 }, (_, i) => ({
      id: `segment-${i}`, startMs: i * 100, endMs: (i + 1) * 100, speakerLabel: `speaker_${i}`, text: "Test phrase.",
    })) }, { recordedAt: new Date(Date.UTC(2026, 0, r + 1)).toISOString() });
  }
  const snapshot = f.service.snapshot({pageSize:200});
  assert.equal(snapshot.groups.length, 200);
  assert.equal(snapshot.counts.groups, 200);
  assert.equal(snapshot.counts.totalGroups, 303);
  assert.equal(snapshot.counts.groupsTruncated, true);
  assert.equal(snapshot.counts.recordings, 3);
  assert.equal(snapshot.groups[0].recordedAt, "2026-01-03T00:00:00.000Z");
  assert.ok(snapshot.groups.every((group) => group.recordedAt !== "2026-01-01T00:00:00.000Z"));
  const second=f.service.snapshot({page:2,pageSize:200});
  assert.equal(second.groups.length,103);
  assert.equal(new Set([...snapshot.groups,...second.groups].map(g=>`${g.recordingId}:${g.speakerLabel}`)).size,303);
});

test("snapshot paginates beyond 50 recordings and retains global status counts", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 202; i++) f.service.createPerson({ name: `Person ${String(i).padStart(3, "0")}` });
  const first = await f.recording({}, { recordedAt: "2025-01-01T00:00:00Z" });
  for (let i = 0; i < 50; i++) await f.recording({}, { recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
  const pending = await registerVoiceRecording(f.store, f.config, { audioPath: f.audioPath,
    deviceId: "test", recordingId: "pending", recordedAt: "2099-01-01T00:00:00Z" });
  const snapshot = f.service.snapshot();
  assert.equal(snapshot.people.length, 200);
  assert.equal(snapshot.groups.length, 50);
  assert.equal(snapshot.counts.recordings, 51);
  assert.ok(snapshot.groups.every((g) => g.recordingId !== first.id && g.recordingId !== pending.id));
  assert.equal(snapshot.groups[0].recordedAt, "2026-01-01T00:49:00.000Z");
  assert.equal(f.service.snapshot({page:2}).groups[0].recordingId,first.id);
  assert.equal(snapshot.counts.pendingGroups,51);
  const p=f.service.snapshot().people[0];
  const old=f.service.snapshot({page:2}).groups[0];
  f.service.confirm({...old,personId:p.id});
  const confirmed=f.service.snapshot({status:'confirmed'});
  assert.equal(confirmed.groups[0].recordingId,first.id);
  assert.equal(confirmed.counts.confirmedGroups,1);
  assert.equal(confirmed.counts.pendingGroups,50);
});

test('segment review supports unknown speech without cluster enrollment or stale overwrites',async t=>{
  const f=fixture(t),rec=await f.recording({speakers:[],segments:[
    {id:'unknown-one',startMs:0,endMs:4000,speakerLabel:'unknown',text:'Unverified ASR.'},
    {id:'unknown-two',startMs:4000,endMs:8000,speakerLabel:'unknown',text:'Different speaker.'},
  ]});
  const person=f.service.createPerson({name:'Reviewed person'}),group=f.group(rec.id,'unknown');
  const data=f.service.segments({...group,pageSize:1});
  assert.equal(data.pagination.total,2);assert.equal(data.segments[0].text,'Unverified ASR.');
  assert.ok(f.service.sample({...group,segmentId:'unknown-one'}).dataUrl);
  const request={...data.segments[0],recordingId:rec.id,speakerLabel:'unknown',text:'Reviewed ASR.',personId:person.id};
  f.service.reviseSegment(request);
  assert.throws(()=>f.service.reviseSegment(request),{code:'STALE_REVISION'});
  const after=f.service.segments({recordingId:rec.id,speakerLabel:'unknown'});
  assert.equal(after.segments[0].personId,person.id);assert.equal(after.segments[1].personId,null);
  assert.equal(f.count('voice_speaker_samples'),0);assert.equal(f.count('graph_facts'),0);
  const before=f.count('evidence');
  assert.throws(()=>f.service.reviseSegment({...request,revision:after.segments[0].revision,personId:'missing',text:'Must roll back.'}));
  assert.equal(f.count('evidence'),before);
  assert.equal(f.service.segments({recordingId:rec.id,speakerLabel:'unknown'}).segments[0].text,'Reviewed ASR.');
});

test("confirmation without enrollment appends corrections and never fabricates a sample", async (t) => {
  const f = fixture(t);
  const person = f.service.createPerson({ name: "Alice" });
  const rec = await f.recording({ speakers: [] });
  assert.equal(f.group(rec.id).canEnroll, false);
  assert.throws(() => f.service.confirm(f.request(rec.id, person, { enroll: true })), { code: "ENROLLMENT_UNAVAILABLE" });
  assert.equal(f.count("evidence"), 2);
  const receipt = f.service.confirm(f.request(rec.id, person));
  assert.equal(receipt.enrolled, false);
  assert.equal(receipt.updatedSegments, 2);
  assert.equal(f.count("voice_speaker_samples"), 0);
  assert.equal(f.count("evidence"), 4);
  assert.equal(f.count("evidence_links"), 2);
  assert.equal(f.service.confirm(f.request(rec.id, person)).duplicate, true);
  assert.equal(f.count("evidence"), 4);
  const notification = JSON.parse(f.store.db.prepare("SELECT metadata_json FROM context_changes WHERE status='pending'").get().metadata_json);
  assert.equal(notification.requiresResponsibilityRecheck, true);
});

test("enrollment can follow confirmation and repeated enrollment keeps one active sample", async (t) => {
  const f = fixture(t);
  const person = f.service.createPerson({ name: "Alice" });
  const rec = await f.recording();
  f.service.confirm(f.request(rec.id, person));
  assert.equal(f.count("voice_speaker_samples"), 0);
  const receipt = f.service.confirm(f.request(rec.id, person, { enroll: true }));
  assert.equal(receipt.enrolled, true);
  assert.equal(receipt.updatedSegments, 0);
  f.service.confirm(f.request(rec.id, person, { enroll: true }));
  assert.equal(f.count("voice_speaker_samples"), 1);
  const other = f.service.createPerson({ name: "Bob" });
  f.service.confirm(f.request(rec.id, other));
  assert.equal(f.service.snapshot().counts.samples, 0);
});

test("unknown and mixed groups remain playable but cannot be enrolled or batch confirmed", async (t) => {
  const f = fixture(t);
  const alice = f.service.createPerson({ name: "Alice" });
  const bob = f.service.createPerson({ name: "Bob" });
  const unknown = await f.recording({ speakers: [], segments: [
    { id: "one", startMs: 0, endMs: 1000, speakerLabel: "unknown", text: "Unknown." },
  ] });
  const mixed = await f.recording();
  for (const [segmentId, personId] of [["one", alice.id], ["two", bob.id]]) {
    annotateVoiceSpeaker(f.store, f.config, { recordingId: mixed.id, speakerLabel: "speaker_0", segmentId, personId });
  }
  for (const [rec, label, reason] of [[unknown, "unknown", "unknown_speaker"], [mixed, "speaker_0", "mixed_confirmed_people"]]) {
    const group = f.group(rec.id, label);
    assert.equal(group.canEnroll, false);
    assert.equal(group.sampleAvailable, true);
    assert.equal(group.disabledReason, reason);
    const before = f.count("evidence");
    for (const enroll of [false, true]) {
      const receipt = f.service.confirm({ recordingId: rec.id, speakerLabel: label, personId: alice.id, enroll, revisionToken: group.revisionToken });
      assert.equal(receipt.skipped, true);
      assert.equal(receipt.reason, reason);
    }
    const playback = f.service.sample({ recordingId: rec.id, speakerLabel: label });
    assert.ok(playback.dataUrl);
    assert.equal(playback.durationMs, 12000);
    assert.equal(f.service.group({ recordingId: rec.id, speakerLabel: label }).sampleAvailable, true);
    assert.equal(f.count("evidence"), before);
  }
});

test("revision token checks every latest segment and rejects missing or stale tokens", async (t) => {
  const f = fixture(t);
  const person = f.service.createPerson({ name: "Alice" });
  const rec = await f.recording();
  const input = f.request(rec.id, person);
  assert.throws(() => f.service.confirm({ ...input, revisionToken: undefined }), { code: "STALE_REVISION" });
  assert.throws(() => f.service.confirm({ ...input, enroll: "false" }), { code: "INVALID_INPUT" });
  correctVoiceSegment(f.store, f.config, { recordingId: rec.id, segmentId: "two", text: "Corrected.", reason: "Test." });
  assert.throws(() => f.service.confirm(input), { code: "STALE_REVISION" });
  assert.equal(f.count("evidence"), 3);
  assert.equal(f.count("voice_speaker_samples"), 0);
});

test("revision check runs after acquiring the write transaction, including evidence-id-only changes", async (t) => {
  const f = fixture(t);
  const person = f.service.createPerson({ name: "Alice" });
  const rec = await f.recording();
  const input = f.request(rec.id, person);
  const other = openDatabase(path.join(f.root, "isolated.sqlite"));
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (callback) => {
    other.db.prepare("UPDATE voice_segments SET evidence_id=? WHERE recording_id=? AND segment_id='two'")
      .run(rec.segments[0].evidence_id, rec.id);
    return transaction(callback);
  };
  try { assert.throws(() => f.service.confirm(input), { code: "STALE_REVISION" }); }
  finally { other.close(); f.store.transaction = transaction; }
  assert.equal(f.count("evidence"), 2);
});

test("a failed sample insertion rolls back all confirmation revisions and context notifications", async (t) => {
  const f = fixture(t);
  const person = f.service.createPerson({ name: "Alice" });
  const rec = await f.recording();
  const notifications = f.store.db.prepare("SELECT * FROM context_changes").all();
  const before = voiceRecordingDetail(f.store, rec.id);
  f.store.db.exec("CREATE TRIGGER fail_sample BEFORE INSERT ON voice_speaker_samples BEGIN SELECT RAISE(ABORT, 'synthetic sample failure'); END;");
  assert.throws(() => f.service.confirm(f.request(rec.id, person, { enroll: true })), /synthetic sample failure/);
  assert.deepEqual(voiceRecordingDetail(f.store, rec.id), before);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM context_changes").all(), notifications);
  assert.equal(f.count("evidence"), 2);
  assert.equal(f.count("evidence_links"), 0);
  assert.equal(f.count("voice_speaker_samples"), 0);
});

test("canEnroll requires a valid transcript embedding for the exact label", async (t) => {
  const f = fixture(t);
  const rec = await f.recording();
  const valid = JSON.parse(fs.readFileSync(rec.transcript_path, "utf8"));
  for (const speakers of [[], [{ label: "different", embedding: [1, 0], embeddingModel: "test" }],
    [{ label: "speaker_0", embedding: [0, 0], embeddingModel: "test" }],
    [{ label: "speaker_0", embedding: [1, 0] }]]) {
    fs.writeFileSync(rec.transcript_path, JSON.stringify({ ...valid, speakers }));
    assert.equal(f.group(rec.id).canEnroll, false);
  }
  fs.writeFileSync(rec.transcript_path, "invalid JSON");
  assert.equal(f.group(rec.id).canEnroll, false);
  fs.unlinkSync(rec.transcript_path);
  assert.equal(f.group(rec.id).canEnroll, false);
});

test("review playback includes the complete recording and supports precise segment selection", async (t) => {
  const f = fixture(t);
  const rec = await f.recording();
  const realRead = fs.readSync;
  const realReadFile = fs.readFileSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (...args) => { const n = realRead(...args); bytes += n; return n; });
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    assert.notEqual(file, rec.audio_path, "audio must use bounded positional reads");
    return realReadFile(file, ...args);
  });
  const result = f.service.sample({ recordingId: rec.id, speakerLabel: "speaker_0", path: f.audioPath, seconds: 9999 });
  assert.equal(result.durationMs, 12000);
  assert.equal(result.nextOffsetMs, null);
  assert.equal(result.offsetMs, 0);
  const sample = Buffer.from(result.dataUrl.split(",")[1], "base64");
  assert.equal(sample.toString("ascii", 0, 4), "RIFF");
  assert.equal(sample.length, 44 + 12 * 16000 * 2);
  assert.equal(sample.readUInt32LE(40), sample.length - 44);
  assert.equal(sample.readInt16LE(44), 0);
  assert.ok(bytes <= 2 * 1024 * 1024);
  const segment = f.service.sample({ recordingId: rec.id, speakerLabel: 'speaker_0', segmentId: 'one' });
  assert.equal(segment.durationMs, 10000);
  assert.equal(segment.rangeStartMs, 1000);
  assert.equal(Buffer.from(segment.dataUrl.split(',')[1], 'base64').readInt16LE(44), 16000);
});

test('bounded playback chunks cover long audio exactly and seek without changing annotation state', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.audioPath, wav({ seconds: 95 }));
  const rec = await f.recording({ durationMs: 95000 });
  const request = { recordingId: rec.id, speakerLabel: 'speaker_0' };
  const before = { evidence: f.count('evidence'), samples: f.count('voice_speaker_samples'), group: f.group(rec.id) };
  let offsetMs = 0; const chunks = [], offsets = [];
  do {
    const result = f.service.sample({ ...request, offsetMs });
    const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64');
    assert.ok(bytes.length <= 2 * 1024 * 1024 + 44);
    assert.equal(result.offsetMs, offsetMs);
    assert.equal(result.durationMs, 95000);
    chunks.push(bytes.subarray(44)); offsets.push(offsetMs);
    offsetMs = result.nextOffsetMs;
  } while (offsetMs !== null);
  assert.deepEqual(offsets, [0, 30000, 60000, 90000]);
  assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(rec.audio_path).subarray(44));
  const seek = f.service.sample({ ...request, offsetMs: 82000 });
  assert.equal(seek.offsetMs, 82000);
  assert.equal(seek.nextOffsetMs, null);
  assert.equal(f.service.sample({ ...request, offsetMs: 95000 }).unavailable, true);
  for (const invalid of [-1, NaN, Infinity, '1']) {
    assert.throws(() => f.service.sample({ ...request, offsetMs: invalid }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual({ evidence: f.count('evidence'), samples: f.count('voice_speaker_samples'), group: f.group(rec.id) }, before);
});

test("sample stays under 2 MiB for high-rate stereo and honors shorter segment bounds", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.audioPath, wav({ rate: 96000, channels: 2 }));
  const rec = await f.recording();
  const read = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (...args) => { const n = read(...args); bytes += n; return n; });
  const request = { recordingId: rec.id, speakerLabel: "speaker_0", segmentId: 'one' };
  const sample = Buffer.from(f.service.sample(request).dataUrl.split(",")[1], "base64");
  assert.ok(bytes <= 2 * 1024 * 1024);
  assert.ok(sample.readUInt32LE(40) / (96000 * 4) <= 8);
  f.store.db.prepare("UPDATE voice_segments SET end_ms=1500 WHERE recording_id=? AND segment_id='one'").run(rec.id);
  const short = Buffer.from(f.service.sample(request).dataUrl.split(",")[1], "base64");
  assert.equal(short.readUInt32LE(40), 96000 * 4 / 2);
});

test('high-rate byte-budget continuation has no missing or duplicate PCM frames', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.audioPath, wav({ rate: 96000, channels: 2 }));
  const rec = await f.recording(), chunks = [];
  let offsetMs = 0;
  do {
    const result = f.service.sample({ recordingId: rec.id, speakerLabel: 'speaker_0', offsetMs });
    assert.ok(result.dataUrl);
    chunks.push(Buffer.from(result.dataUrl.split(',')[1], 'base64').subarray(44));
    offsetMs = result.nextOffsetMs;
  } while (offsetMs !== null);
  assert.deepEqual(Buffer.concat(chunks), fs.readFileSync(rec.audio_path).subarray(44));
});

test("sample rejects invalid, truncated, non-PCM16, missing and out-of-range audio without leaking paths", async (t) => {
  const f = fixture(t);
  const rec = await f.recording();
  const request = { recordingId: rec.id, speakerLabel: "speaker_0" };
  const variants = [Buffer.from("not a WAV"), wav().subarray(0, 80)];
  for (const [offset, value] of [[20, 3], [34, 8], [32, 3], [22, 0]]) {
    const bad = wav(); bad.writeUInt16LE(value, offset); variants.push(bad);
  }
  const hugeChunk = wav(); hugeChunk.writeUInt32LE(0xffffffff, 16); variants.push(hugeChunk);
  for (const bad of variants) {
    fs.writeFileSync(rec.audio_path, bad);
    assert.deepEqual(f.service.sample(request), { unavailable: true, reason: "sample_unavailable" });
  }
  fs.writeFileSync(rec.audio_path, wav({ seconds: 1 }));
  assert.equal(f.service.sample(request).unavailable, true);
  fs.unlinkSync(rec.audio_path);
  assert.equal(f.group(rec.id).sampleAvailable, false);
  assert.equal(f.service.sample(request).unavailable, true);
  assert.deepEqual(f.service.sample({ ...request, recordingId: "missing" }), { unavailable: true, reason: "group_unavailable" });
  assert.equal(f.service.sample({ ...request, speakerLabel: "missing" }).unavailable, true);
});

test("sample refuses outside-root paths, directories, symlinks and directory junctions", async (t) => {
  const f = fixture(t);
  const rec = await f.recording();
  const request = { recordingId: rec.id, speakerLabel: "speaker_0" };
  const setPath = (file) => f.store.db.prepare("UPDATE voice_recordings SET audio_path=? WHERE id=?").run(file, rec.id);
  const sibling = path.join(f.root, "voice-elsewhere");
  fs.mkdirSync(sibling);
  fs.copyFileSync(f.audioPath, path.join(sibling, "audio.wav"));
  for (const file of [f.audioPath, path.join(sibling, "audio.wav"), path.join(f.root, "voice"), "https://example.invalid/audio.wav", "relative.wav"]) {
    setPath(file);
    assert.equal(f.service.sample(request).unavailable, true);
    assert.equal(f.group(rec.id).sampleAvailable, false);
  }
  const junction = path.join(f.root, "voice", "junction");
  fs.symlinkSync(sibling, junction, process.platform === "win32" ? "junction" : "dir");
  setPath(path.join(junction, "audio.wav"));
  assert.equal(f.service.sample(request).unavailable, true);
  assert.equal(f.group(rec.id).sampleAvailable, false);
  const link = path.join(f.root, "voice", "link.wav");
  try { fs.symlinkSync(rec.audio_path, link, "file"); }
  catch (error) {
    if (error.code !== "EPERM") throw error;
    // Windows may require elevation for file symlinks; exercise the same lstat guard.
    fs.copyFileSync(rec.audio_path, link);
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (file, ...args) => file === link ? { isSymbolicLink: () => true } : lstat(file, ...args));
  }
  setPath(link);
  assert.equal(f.service.sample(request).unavailable, true);
});

test("sample handles odd-sized ancillary WAV chunks and always closes its descriptor on failure", async (t) => {
  const f = fixture(t);
  const rec = await f.recording();
  const audio = wav();
  const junk = Buffer.alloc(10);
  junk.write("JUNK"); junk.writeUInt32LE(1, 4);
  const padded = Buffer.concat([audio.subarray(0, 12), junk, audio.subarray(12)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  fs.writeFileSync(rec.audio_path, padded);
  const request = { recordingId: rec.id, speakerLabel: "speaker_0" };
  assert.ok(f.service.sample(request).dataUrl);
  const close = fs.closeSync;
  let closed = 0;
  t.mock.method(fs, "closeSync", (...args) => { closed++; return close(...args); });
  t.mock.method(fs, "readSync", () => 0);
  assert.equal(f.service.sample(request).unavailable, true);
  assert.equal(closed, 1);
});
