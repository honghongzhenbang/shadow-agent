// Test-only subprocess contract fixture. Never imports application code or an ASR model.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const control = JSON.parse(fs.readFileSync(path.join(root, "control.json"), "utf8"));
assert.equal(process.argv[2], "import");
assert.equal(process.argv[3], "--manifest");
assert.equal(process.argv[4], "manifest.json");
assert.equal(process.argv[5], "--database");
assert.equal(path.resolve(process.argv[6]), path.join(root, "isolated.sqlite"));
const manifest = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
assert.equal(manifest.audioPath, "audio.wav");
assert.equal(manifest.testOnly, true);
assert.ok(fs.existsSync(manifest.audioPath));
fs.writeFileSync(path.join(root, "child-pid.json"), JSON.stringify(process.pid));
if (control.mode === "failed") {
  process.stderr.write("Synthetic ASR failure, no model or production DB used.\n");
  process.exitCode = 9;
} else if (control.mode === "busy") {
  process.stdout.write(JSON.stringify({ result: { recordingId: "fixture-id", busy: true } }));
} else if (control.mode === "invalid") {
  process.stdout.write(JSON.stringify({ result: { status: "pending" } }));
} else if (control.mode === "wait") {
  await new Promise((resolve) => setTimeout(resolve, 60000));
} else {
  process.stdout.write(JSON.stringify({ result: { recordingId: "fixture-id", evidenceIds: [], duplicate: false } }));
}
