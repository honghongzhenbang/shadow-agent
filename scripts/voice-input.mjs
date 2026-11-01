import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { forgetVoiceSample, listVoiceSamples } from '../src/voice-samples.mjs';
import {
  annotateVoiceSpeaker, confirmVoiceSpeakerLabel, correctVoiceSegment, ensureVoiceStorage, importVoiceTranscript, registerVoicePerson,
  registerVoiceRecording, transcribeVoiceRecording, voiceRecordingDetail,
} from "../src/voice-input.mjs";

const HELP = `Voice information input (local only; does not start the Agent or microphone).

node scripts/voice-input.mjs import --manifest recording.json [--register-only | --transcript transcript.json]
node scripts/voice-input.mjs transcribe --id RECORDING_ID
node scripts/voice-input.mjs show --id RECORDING_ID
node scripts/voice-input.mjs list
node scripts/voice-input.mjs person --key STABLE_PERSON_KEY --name DISPLAY_NAME
node scripts/voice-input.mjs label --id RECORDING_ID --speaker SPEAKER_LABEL --person-id GRAPH_PERSON_ID [--enroll]
node scripts/voice-input.mjs label --id RECORDING_ID --speaker unknown --segment SEGMENT_ID --person-id GRAPH_PERSON_ID
node scripts/voice-input.mjs label --id RECORDING_ID --speaker SPEAKER_LABEL --unknown
node scripts/voice-input.mjs label-batch --id RECORDING_ID --speaker SPEAKER_LABEL --person-id GRAPH_PERSON_ID --confirm --database PATH
node scripts/voice-input.mjs correct --id RECORDING_ID --segment SEGMENT_ID --text CORRECTED_TEXT --reason REASON
node scripts/voice-input.mjs samples [--page N] [--person-id ID] [--id RECORDING_ID]
node scripts/voice-input.mjs forget-sample --sample-id SAMPLE_ID [--revision-token TOKEN]

All commands accept --database PATH. Use an isolated database for test recordings.
--runtime-root PATH isolates archive/results; --assets-root PATH reuses local models/packages.
Default inference is auto-local (validated Fun runtime, else SenseVoice), with network denied.
--provider auto-local|fun-asr-nano|sensevoice-local|moss-local selects an engine for this invocation.
--fun-python PATH --fun-model-dir PATH --fun-weight-sha256 SHA configure the isolated worker.
--moss-python PATH --moss-model-dir PATH --moss-upstream PATH configure joint MOSS ASR/diarization.
--moss-cache-dir PATH --moss-max-seconds N configure its local cache and window (default 60s).
--fallback sensevoice-local|none controls local fallback. No automatic cloud upload.
--transcript is import-only and cannot be combined with --register-only.
Transcript: local JSON <= 2 MiB, {schemaVersion:1,audioSha256:hex,result:ASR_JSON}.
Precomputed transcripts reuse ingestion validation without running Python.
Manifest: {deviceId, recordingId, conversationId?, recordedAt: ISO with timezone,
  audioPath: absolute or relative to manifest, title?, timeBasis?, timeUncertaintyMs?}
"label" confirms a speaker for this recording; --enroll explicitly saves a local
speaker template. Future similarity matches remain candidates, never authorization.
"label-batch" confirms all existing segments of ONE recording-local acoustic label.
It requires --confirm and an explicit --database; it does not match other recordings
or enroll voiceprints. PC clustered labels may be confirmed; phone transcription-only
results have unknown labels and no voiceprints: use per-segment "label" instead.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" }, database: { type: "string" }, manifest: { type: "string" },
      transcript: { type: "string" },
      "runtime-root": { type: "string" }, "assets-root": { type: "string" },
      provider: { type: "string" }, "fun-python": { type: "string" }, "fun-model-dir": { type: "string" },
      "fun-weight-sha256": { type: "string" }, fallback: { type: "string" },
      'moss-python': {type: 'string'}, 'moss-model-dir': {type: 'string'}, 'moss-upstream': {type: 'string'},
      'moss-cache-dir': {type: 'string'}, 'moss-max-seconds': {type: 'string'},
      id: { type: "string" }, key: { type: "string" }, name: { type: "string" },
      speaker: { type: "string" }, "person-id": { type: "string" }, enroll: { type: "boolean" },
      unknown: { type: "boolean" }, "sample-id": { type: "string" }, "register-only": { type: "boolean" },
      confirm: { type: "boolean" },
      page: { type: 'string' }, 'revision-token': { type: 'string' },
      segment: { type: "string" }, text: { type: "string" }, reason: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.transcript !== undefined) {
    if (command !== "import") throw new Error("--transcript is only allowed with import.");
    if (values["register-only"]) throw new Error("--register-only and --transcript are mutually exclusive.");
  }
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (!["import", "transcribe", "show", "list", "person", "label", "label-batch", "correct", "samples", "forget-sample"].includes(command)) {
    throw new Error(`Unknown voice command: ${command}`);
  }
  if (values.confirm !== undefined && command !== "label-batch") throw new Error("--confirm is only allowed with label-batch.");
  if (command === "label-batch") {
    if (!values.confirm) throw new Error("label-batch requires --confirm after user review.");
    if (!values.database?.trim()) throw new Error("label-batch requires an explicit --database.");
    if (!values.id?.trim() || !values.speaker?.trim() || !values["person-id"]?.trim()) {
      throw new Error("label-batch requires --id, --speaker and --person-id.");
    }
    if (values.speaker.trim() === "unknown") throw new Error("Unknown speech requires per-segment label; phone transcription-only results have no voiceprints.");
    if (values.enroll || values.unknown || values.segment !== undefined) {
      throw new Error("label-batch does not accept --enroll, --unknown or --segment.");
    }
  }
  const config = loadConfig();
  config.voice ??= {};
  if (values["runtime-root"]) config.voice.runtimeRoot = path.resolve(values["runtime-root"]);
  if (values["assets-root"]) config.voice.assetsRoot = path.resolve(values["assets-root"]);
  for (const [option, key] of [["provider", "asrProvider"], ["fun-python", "funPython"],
    ["fun-model-dir", "funModelDir"], ["fun-weight-sha256", "funWeightSha256"], ["fallback", "fallback"],
    ['moss-python','mossPython'], ['moss-model-dir','mossModelDir'], ['moss-upstream','mossUpstream'],
    ['moss-cache-dir','mossCacheDir']]) {
    if (values[option] != null) config.voice[key] = values[option];
  }
  if (values['moss-max-seconds'] != null) config.voice.mossMaxSeconds = Number(values['moss-max-seconds']);
  const databasePath = path.resolve(values.database ?? config.paths.database);
  let manifest;
  if (command === "import") {
    if (!values.manifest) throw new Error("--manifest is required.");
    const manifestPath = path.resolve(values.manifest);
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
    if (manifest.testOnly && (!values.database || databasePath.toLowerCase() === path.resolve(config.paths.database).toLowerCase())) {
      throw new Error("Test-only recordings require --database pointing to an isolated non-production database.");
    }
    if (typeof manifest.audioPath !== "string") throw new Error("Manifest audioPath is required.");
    manifest.audioPath = path.resolve(path.dirname(manifestPath), manifest.audioPath);
  }
  const store = openDatabase(databasePath);
  try {
    ensureVoiceStorage(store);
    let result;
    if (command === "import") {
      const recording = await registerVoiceRecording(store, config, manifest);
      result = values["register-only"] ? { recordingId: recording.id, status: recording.status, duplicate: recording.duplicate }
        : values.transcript !== undefined ? await importVoiceTranscript(store, config, recording.id, values.transcript)
          : await transcribeVoiceRecording(store, config, recording.id);
    } else if (command === "transcribe") {
      result = await transcribeVoiceRecording(store, config, values.id);
    } else if (command === "show") {
      result = voiceRecordingDetail(store, values.id);
      if (!result) throw new Error("Recording not found.");
    } else if (command === "list") {
      result = store.db.prepare(`SELECT id, device_id, conversation_id, recorded_at, received_at, duration_ms,
        status, attempts, last_error FROM voice_recordings ORDER BY received_at DESC LIMIT 50`).all();
    } else if (command === "person") {
      result = registerVoicePerson(store, { key: values.key, name: values.name });
    } else if (command === "label") {
      if (Boolean(values["person-id"]) === Boolean(values.unknown)) throw new Error("Choose --person-id or --unknown.");
      result = annotateVoiceSpeaker(store, config, {
        recordingId: values.id, speakerLabel: values.speaker, personId: values["person-id"], enroll: values.enroll, segmentId: values.segment,
      });
    } else if (command === "label-batch") {
      result = confirmVoiceSpeakerLabel(store, config, {
        recordingId: values.id, speakerLabel: values.speaker, personId: values["person-id"], confirmedByUser: values.confirm,
      });
    } else if (command === "correct") {
      result = correctVoiceSegment(store, config, {
        recordingId: values.id, segmentId: values.segment, text: values.text, reason: values.reason,
      });
    } else if (command === "samples") {
      result = listVoiceSamples(store, { page: Number(values.page ?? 1), pageSize: 100,
        personId: values['person-id'], recordingId: values.id }).samples;
    } else if (command === "forget-sample") {
      if (!values["sample-id"]) throw new Error("--sample-id is required.");
      result = forgetVoiceSample(store, { sampleId: values['sample-id'], revisionToken: values['revision-token'] });
    }
    process.stdout.write(`${JSON.stringify({ database: databasePath, result }, null, 2)}\n`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
