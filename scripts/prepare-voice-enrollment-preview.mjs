import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.mjs";
import { loadConfig } from "../src/config.mjs";
import { registerVoiceRecording, registerVoicePerson, transcribeVoiceRecording, ensureVoiceStorage } from "../src/voice-input.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testId = process.env.SHADOW_VOICE_PREVIEW_TEST_ID;
if (testId && !/^[a-f0-9]{16}$/.test(testId)) throw new Error("Invalid isolated test ID.");
const preview = path.join(root, "runtime/voice", testId ? `enrollment-tests/${testId}` : "enrollment-preview");
fs.mkdirSync(preview, { recursive: true });
const store = openDatabase(path.join(preview, "preview.sqlite"));
const installedVoice = loadConfig().voice ?? {};
const config = { projectRoot: root, voice: { ...installedVoice, runtimeRoot: preview, asrProvider: 'sensevoice-local' } };
try {
  ensureVoiceStorage(store);
  const audioPath = path.join(installedVoice.assetsRoot ?? path.join(root, 'runtime/voice'), "fixtures/TEST_ONLY_two-speaker-A-B-A.wav");
  const provenance = JSON.parse(fs.readFileSync(`${audioPath}.manifest.json`, "utf8"));
  if (provenance.testOnly !== true) throw new Error("Only the public test fixture may seed this preview.");
  const recording = await registerVoiceRecording(store, config, { audioPath, sha256: provenance.sha256,
    deviceId: "public-preview", recordingId: "public-speakers-v1", conversationId: "voice-preview",
    recordedAt: "2026-10-18T00:00:00+08:00", title: "公开测试录音", testOnly: true });
  await transcribeVoiceRecording(store, config, recording.id);
  registerVoicePerson(store, { key: "preview-person-one", name: "示例人物一" });
  registerVoicePerson(store, { key: "preview-person-two", name: "示例人物二" });
  console.log(JSON.stringify({ status: "ready", database: path.join(preview,"preview.sqlite"), isolated: true, recordingId: recording.id }));
} finally { store.close(); }
