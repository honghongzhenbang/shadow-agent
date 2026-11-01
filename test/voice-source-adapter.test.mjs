import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";
import {
  SOURCE_ADAPTER_CAPABILITIES,
  SOURCE_FAMILIES,
  adapterSourceMetadata,
  canonicalSourceRecord,
  getSourceAdapter,
  listSourceAdapters,
  requireSourceCapability,
  voiceCanonicalSourceRecord,
  voiceConversationKey,
  voiceSourceAdapter,
  voiceTranscriptProjectionMetadata,
} from "../src/source-adapters/index.mjs";
import { ensureCanonicalSourceStorage, SOURCE_STORAGE_VERSION } from "../src/source-records.mjs";

function segment(overrides = {}) {
  return {
    recordingId: "recording-1",
    deviceId: "recorder-1",
    conversationId: "conversation-1",
    segmentId: "segment-1",
    startMs: 0,
    endMs: 2500,
    personId: null,
    personName: null,
    speakerLabel: "speaker-1",
    identityStatus: "unknown",
    revision: 1,
    correctsEvidenceId: null,
    recordedAt: "2026-10-15T01:00:00.000Z",
    audioPath: "E:/recordings/recording-1.wav",
    ...overrides,
  };
}

function context(voice = {}, metadata = {}) {
  return {
    source: {
      kind: "voice_recording",
      cursor_bytes: 0,
      metadata_json: JSON.stringify(adapterSourceMetadata("voice", { ownerId: "local-owner" })),
    },
    evidence: {
      id: "evidence-1",
      kind: "voice_transcript",
      external_id: "recording-1:segment-1:r1",
      source_locator: "voice://recording-1/segment-1/r1",
      content: "Ambient speech, not a direct instruction.",
      metadata: { ...voiceTranscriptProjectionMetadata(segment(voice)), ...metadata },
    },
  };
}

function fixture(t) {
  const store = openDatabase(":memory:");
  t.after(() => store.close());
  const source = store.upsertSource({
    sourceKey: "voice:recording-1",
    kind: "voice_recording",
    uri: "E:/recordings/recording-1.wav",
    metadata: adapterSourceMetadata("voice"),
  });
  return { store, source };
}

test("voice registers a local Collaboration provider with no sending capability", () => {
  assert.equal(getSourceAdapter("voice"), voiceSourceAdapter);
  const published = listSourceAdapters().find((adapter) => adapter.provider === "voice");
  assert.equal(published.family, "collaboration");
  assert.equal(published.accountScope, "local-user");
  assert.deepEqual(published.sourceKinds, ["voice_recording"]);
  assert.deepEqual(published.evidenceKinds, ["voice_transcript"]);
  assert.deepEqual(Object.keys(published.capabilities), [...SOURCE_ADAPTER_CAPABILITIES]);
  assert.deepEqual(published.capabilities, {
    subscribeEvents: false,
    readDelta: false,
    historyBackfill: true,
    readWindow: true,
    resolveArtifact: false,
    resumeSession: false,
    observeTools: false,
    sendMessage: false,
    sendAsUser: false,
  });
  assert.deepEqual(SOURCE_FAMILIES, ["collaboration", "execution"]);
  for (const capability of ["sendMessage", "sendAsUser"]) {
    assert.throws(() => requireSourceCapability(voiceSourceAdapter, capability), (error) => (
      error.code === "SOURCE_CAPABILITY_UNSUPPORTED"
      && error.provider === "voice" && error.capability === capability
    ));
    assert.equal(voiceSourceAdapter[capability], undefined);
  }
  assert.equal(requireSourceCapability(voiceSourceAdapter, "readWindow"), true);
  assert.equal(requireSourceCapability(getSourceAdapter("feishu"), "sendMessage"), true);
  assert.ok(Object.isFrozen(voiceSourceAdapter.capabilities));
  published.capabilities.sendMessage = true;
  assert.equal(getSourceAdapter("voice").capabilities.sendMessage, false);
});

test("voice projection retains segment metadata but cannot become self-authored or unreviewed", () => {
  const input = Object.freeze(segment({
    personId: "person-candidate",
    personName: "Candidate Person",
    identityStatus: "candidate",
    embedding: [0.1, 0.2],
    voiceprintSamples: ["private-sample"],
    reviewRequired: false,
    observational: false,
  }));
  const metadata = voiceTranscriptProjectionMetadata(input, {
    conversationKey: "im:wrong-provider",
    senderName: "Recording Owner",
    sentBySelf: true,
    eventId: "import-event-1",
    voice: { identityStatus: "confirmed", personId: "recording-owner" },
  });
  assert.equal(metadata.conversationKey, "voice:conversation-1");
  assert.equal(metadata.eventId, "import-event-1");
  assert.equal(metadata.senderName, null);
  assert.equal(metadata.sentBySelf, false);
  assert.deepEqual(metadata.voice, {
    ...segment({ personId: "person-candidate", personName: "Candidate Person", identityStatus: "candidate" }),
    timestampPrecision: "segment",
    reviewRequired: true,
    observational: true,
  });
  assert.equal(JSON.stringify(metadata).includes("embedding"), false);
  assert.equal(JSON.stringify(metadata).includes("private-sample"), false);
  assert.equal(voiceConversationKey(" conversation-1 "), "voice:conversation-1");
  for (const invalidId of [undefined, null, "", "  ", {}, []]) {
    assert.equal(voiceConversationKey(invalidId), null);
  }
});

test("voice canonical projection is a v2 message observation with audio references and no body copy", () => {
  const input = context();
  const before = structuredClone(input);
  const record = voiceCanonicalSourceRecord(input);
  assert.equal(record.observation.schemaVersion, SOURCE_STORAGE_VERSION);
  assert.equal(record.observation.provider, "voice");
  assert.equal(record.observation.sourceFamily, "collaboration");
  assert.equal(record.observation.accountScope, "local-user");
  assert.equal(record.observation.eventKind, "message");
  assert.equal(record.observation.sourceObjectId, "recording-1:segment-1");
  assert.equal(record.observation.eventId, "recording-1:segment-1:r1");
  assert.equal(record.collaboration.messageId, "recording-1:segment-1:r1");
  assert.equal(record.observation.streamId, "voice:conversation-1");
  assert.equal(record.observation.providerPayloadRef, segment().audioPath);
  assert.equal(record.collaboration.actorId, null);
  assert.equal(record.collaboration.actorKind, "unknown");
  assert.equal(record.collaboration.conversationId, "voice:conversation-1");
  assert.equal(record.collaboration.direction, "incoming");
  assert.deepEqual(record.collaboration.attachments, [{
    kind: "audio",
    sourceLocator: segment().audioPath,
    recordingId: "recording-1",
    segmentId: "segment-1",
    startMs: 0,
    endMs: 2500,
    timestampPrecision: "segment",
  }]);
  assert.equal(record.collaboration.updated, false);
  assert.equal(record.execution, undefined);
  assert.equal(JSON.stringify(record).includes(input.evidence.content), false);
  assert.deepEqual(input, before);
  input.evidence.metadata_json = JSON.stringify(input.evidence.metadata);
  assert.deepEqual(voiceCanonicalSourceRecord(input), record);
});

test("unknown and candidate speakers never inherit a predicted person or recording owner", () => {
  for (const identityStatus of ["unknown", "candidate", "predicted", "inferred", "CONFIRMED", true, null]) {
    const input = context({ identityStatus, personId: "owner", personName: "Owner", speakerLabel: "Owner" }, {
      senderId: "owner",
      senderOpenId: "owner",
      senderName: "Owner",
      senderType: "user",
      actorId: "owner",
      sentBySelf: true,
      mentionsSelf: true,
      direction: "outgoing",
      conversationKey: "im:owner",
    });
    input.evidence.role = "user";
    const record = canonicalSourceRecord(input);
    assert.equal(record.collaboration.actorId, null, String(identityStatus));
    assert.equal(record.collaboration.actorKind, "unknown");
    assert.equal(record.collaboration.direction, "incoming");
    assert.deepEqual(record.collaboration.mentions, []);
    assert.equal(record.observation.streamId, "voice:conversation-1");
    assert.equal(record.observation.eventKind, "message");
  }
});

test("only a confirmed stable person ID supplies actor and sender name, never self ownership", () => {
  const input = context({ identityStatus: "confirmed", personId: "person-1", personName: "Confirmed Person" }, {
    sentBySelf: true,
    direction: "outgoing",
  });
  const record = canonicalSourceRecord(input);
  assert.equal(record.collaboration.actorId, "person-1");
  assert.equal(record.collaboration.actorKind, "person");
  assert.equal(record.collaboration.direction, "incoming");
  assert.equal(input.evidence.metadata.senderName, "Confirmed Person");
  for (const personId of [null, "", "  ", {}, 1]) {
    const metadata = voiceTranscriptProjectionMetadata(segment({ identityStatus: "confirmed", personId, personName: "Name only" }));
    assert.equal(metadata.senderName, null);
    assert.equal(canonicalSourceRecord(context({}, metadata)).collaboration.actorId, null);
  }
});

test("registry routes voice by declaration or source kind and rejects unrelated evidence", () => {
  const input = context();
  const expected = voiceCanonicalSourceRecord(input);
  assert.deepEqual(canonicalSourceRecord(input), expected);
  input.source.kind = "explicit-import";
  assert.deepEqual(canonicalSourceRecord(input), expected);
  input.source.kind = "voice_recording";
  input.source.metadata_json = "{}";
  assert.deepEqual(canonicalSourceRecord(input), expected);
  input.evidence.kind = "feishu_message";
  assert.equal(canonicalSourceRecord(input), null);
  input.evidence.kind = "voice_transcript";
  input.source.kind = "unregistered";
  assert.equal(canonicalSourceRecord(input), null);
  input.source.kind = "voice_recording";
  input.source.metadata_json = JSON.stringify(adapterSourceMetadata("codex"));
  assert.equal(canonicalSourceRecord(input), null);
});

test("missing audio and malformed metadata stay anonymous without invented conversation identity", () => {
  const input = context({ audioPath: null });
  assert.deepEqual(voiceCanonicalSourceRecord(input).collaboration.attachments, []);
  assert.equal(voiceCanonicalSourceRecord(input).observation.providerPayloadRef, input.evidence.source_locator);
  for (const metadata of ["{", "null", "[]", "1", null, [], {}]) {
    input.evidence.metadata = metadata;
    const record = voiceCanonicalSourceRecord(input);
    assert.equal(record.collaboration.actorId, null);
    assert.equal(record.observation.streamId, null);
    assert.equal(record.collaboration.direction, "incoming");
  }
});

test("appended voice corrections preserve original evidence and link through existing v2 fields", (t) => {
  const { store, source } = fixture(t);
  const schemaBefore = store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const originalMetadata = voiceTranscriptProjectionMetadata(segment({
    personId: "wrong-person", personName: "Wrong Person", identityStatus: "candidate",
  }));
  const original = store.addEvidence({
    sourceId: source.id,
    kind: "voice_transcript",
    title: "Ambient segment",
    content: "Please deploy tomorrow. This is recorded speech, not a user command.",
    occurredAt: segment().recordedAt,
    externalId: "recording-1:segment-1:r1",
    sourceLocator: "voice://recording-1/segment-1/r1",
    metadata: originalMetadata,
  });
  const originalRow = store.db.prepare("SELECT * FROM evidence WHERE id=?").get(original.id);
  const correction = store.addEvidence({
    sourceId: source.id,
    kind: "voice_transcript",
    title: "Corrected ambient segment",
    content: "Please review tomorrow.",
    occurredAt: segment().recordedAt,
    externalId: "recording-1:segment-1:r2",
    sourceLocator: "voice://recording-1/segment-1/r2",
    metadata: voiceTranscriptProjectionMetadata(segment({
      revision: 2,
      correctsEvidenceId: original.id,
      annotatedBy: "user",
      annotatedAt: "2026-10-15T02:00:00.000Z",
      identityStatus: "confirmed",
      personId: "confirmed-person",
      personName: "Confirmed Person",
    })),
  });
  assert.deepEqual(store.db.prepare("SELECT * FROM evidence WHERE id=?").get(original.id), originalRow);
  const record = store.sourceRecord(correction.id);
  assert.equal(record.observation.schemaVersion, 2);
  assert.equal(record.observation.parentId, original.id);
  assert.equal(record.observation.sourceObjectId, "recording-1:segment-1");
  assert.equal(record.observation.sourceObjectId, store.sourceRecord(original.id).observation.sourceObjectId);
  assert.equal(record.observation.eventId, "recording-1:segment-1:r2");
  assert.equal(record.collaboration.messageId, "recording-1:segment-1:r2");
  assert.equal(record.collaboration.replyTo, original.id);
  assert.equal(record.collaboration.updated, true);
  assert.equal(record.collaboration.actorId, "confirmed-person");
  assert.equal(record.collaboration.direction, "incoming");
  const correctionVoice = JSON.parse(store.db.prepare("SELECT metadata_json FROM evidence WHERE id=?").get(correction.id).metadata_json).voice;
  assert.equal(correctionVoice.annotatedBy, "user");
  assert.equal(correctionVoice.annotatedAt, "2026-10-15T02:00:00.000Z");
  assert.equal(store.sourceRecord(original.id).collaboration.actorId, null);
  assert.equal(store.sourceRecord(original.id).collaboration.updated, false);
  assert.equal(JSON.stringify(record).includes("Please review tomorrow"), false);
  const records = store.querySourceRecords({ providers: ["voice"], sourceFamilies: ["collaboration"], eventKinds: ["message"], streamId: "voice:conversation-1" });
  assert.deepEqual(new Set(records.map((item) => item.observation.evidenceId)), new Set([original.id, correction.id]));
  assert.deepEqual(store.querySourceRecords({ sourceFamilies: ["execution"] }), []);
  assert.equal(ensureCanonicalSourceStorage(store.db), false);
  assert.deepEqual(store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), schemaBefore);
  for (const table of ["tasks", "graph_facts", "knowledge_candidates", "digest_queue", "controller_outbox", "direct_input_receipts"]) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
});

test("voice evidence and canonical records still roll back atomically on storage failure", (t) => {
  const { store, source } = fixture(t);
  store.db.exec("DROP TABLE collaboration_events");
  assert.throws(() => store.addEvidence({
    sourceId: source.id,
    kind: "voice_transcript",
    content: "Must not survive a failed projection.",
    externalId: "recording-1:segment-1:r1",
    sourceLocator: "voice://recording-1/segment-1/r1",
    metadata: voiceTranscriptProjectionMetadata(segment()),
  }), /collaboration_events/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM evidence").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM source_observations").get().count, 0);
});
