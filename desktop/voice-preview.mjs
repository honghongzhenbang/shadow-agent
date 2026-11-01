import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { openDatabase } from "../src/db.mjs";
import { createVoiceWindowController } from "./voice-window.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testId = process.env.SHADOW_VOICE_PREVIEW_TEST_ID;
if (testId && !/^[a-f0-9]{16}$/.test(testId)) throw new Error("Invalid isolated test ID.");
const preview = path.join(root, "runtime/voice", testId ? `enrollment-tests/${testId}` : "enrollment-preview");
// This host never loads production config, Gateway, daemon, collection or microphone code.
app.setPath("userData", path.join(preview, "electron"));
let store, controller;
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => controller?.open());
app.whenReady().then(() => {
  const database = path.join(preview,"preview.sqlite");
  if (!fs.existsSync(database)) throw new Error("Run scripts/prepare-voice-enrollment-preview.mjs first.");
  store = openDatabase(database);
  controller = createVoiceWindowController({ getStore: () => store,
    getConfig: () => ({ projectRoot: root, voice: { runtimeRoot: preview } }), isolated: true });
  controller.open();
}).catch((error) => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => { controller?.dispose(); store?.close(); });
