import { defineSourceAdapter } from "../contracts.mjs";

export const voiceSourceAdapter = defineSourceAdapter({
  provider: "voice",
  family: "collaboration",
  displayName: "Voice",
  accountScope: "local-user",
  capabilities: {
    subscribeEvents: false,
    readDelta: false,
    historyBackfill: true,
    readWindow: true,
    resolveArtifact: false,
    resumeSession: false,
    observeTools: false,
    sendMessage: false,
    sendAsUser: false,
  },
  sourceKinds: ["voice_recording"],
  evidenceKinds: ["voice_transcript"],
});

function parseMetadata(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() || null : null;
}

export function voiceConversationKey(conversationId) {
  const id = optionalText(conversationId);
  return id ? `voice:${id}` : null;
}

export function voiceTranscriptProjectionMetadata(input = {}, overrides = {}) {
  const value = parseMetadata(input);
  const voice = {
    recordingId: optionalText(value.recordingId),
    deviceId: optionalText(value.deviceId),
    conversationId: optionalText(value.conversationId),
    segmentId: optionalText(value.segmentId),
    startMs: Number.isFinite(value.startMs) ? value.startMs : null,
    endMs: Number.isFinite(value.endMs) ? value.endMs : null,
    timestampPrecision: optionalText(value.timestampPrecision) ?? "segment",
    personId: optionalText(value.personId),
    personName: optionalText(value.personName),
    speakerLabel: optionalText(value.speakerLabel),
    identityStatus: ["confirmed", "candidate", "unknown"].includes(value.identityStatus)
      ? value.identityStatus : "unknown",
    revision: Number.isInteger(value.revision) && value.revision > 0 ? value.revision : 1,
    correctsEvidenceId: optionalText(value.correctsEvidenceId),
    ...(optionalText(value.annotatedBy) ? { annotatedBy: optionalText(value.annotatedBy) } : {}),
    ...(optionalText(value.annotatedAt) ? { annotatedAt: optionalText(value.annotatedAt) } : {}),
    recordedAt: optionalText(value.recordedAt),
    audioPath: optionalText(value.audioPath),
    reviewRequired: true,
    observational: true,
  };
  return {
    ...overrides,
    conversationKey: voiceConversationKey(voice.conversationId),
    senderName: voice.identityStatus === "confirmed" && voice.personId ? voice.personName : null,
    sentBySelf: false,
    voice,
  };
}

export function voiceCanonicalSourceRecord({ source, evidence }) {
  if (evidence.kind !== "voice_transcript") return null;
  const metadata = parseMetadata(evidence.metadata_json ?? evidence.metadata);
  const { voice, conversationKey } = voiceTranscriptProjectionMetadata(metadata.voice);
  // Neither recording ownership nor a speaker prediction establishes a person.
  const actorId = voice.identityStatus === "confirmed" ? voice.personId : null;
  const messageId = evidence.external_id ?? evidence.id;
  const sourceObjectId = voice.recordingId && voice.segmentId
    ? `${voice.recordingId}:${voice.segmentId}` : messageId;
  return {
    observation: {
      schemaVersion: 2,
      provider: voiceSourceAdapter.provider,
      sourceFamily: voiceSourceAdapter.family,
      accountScope: voiceSourceAdapter.accountScope,
      sourceObjectId,
      eventId: metadata.eventId ?? evidence.external_id ?? null,
      streamId: conversationKey,
      parentId: voice.correctsEvidenceId,
      causationId: null,
      cursor: source.cursor_bytes ?? null,
      visibility: metadata.visibility ?? "private",
      eventKind: "message",
      providerPayloadRef: voice.audioPath ?? evidence.source_locator,
    },
    collaboration: {
      actorId,
      actorKind: actorId ? "person" : "unknown",
      spaceId: null,
      conversationId: conversationKey,
      threadId: null,
      messageId,
      replyTo: voice.correctsEvidenceId,
      direction: "incoming",
      mentions: [],
      attachments: voice.audioPath ? [{
        kind: "audio",
        sourceLocator: voice.audioPath,
        recordingId: voice.recordingId,
        segmentId: voice.segmentId,
        startMs: voice.startMs,
        endMs: voice.endMs,
        timestampPrecision: voice.timestampPrecision,
      }] : [],
      status: null,
      dueAt: null,
      deleted: metadata.deleted === true,
      updated: voice.revision > 1,
    },
  };
}
