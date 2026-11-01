import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openDatabase } from "../src/db.mjs";

const cliUrl = new URL("../scripts/voice-input.mjs", import.meta.url);
const configUrl = new URL("../src/config.mjs", import.meta.url);
const dbUrl = new URL("../src/db.mjs", import.meta.url);
const processUrl = new URL("../src/process.mjs", import.meta.url);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-voice-cli-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, "isolated.sqlite");
  const production = path.join(root, "production-sentinel.sqlite");
  const audio = Buffer.from("RIFF-test-fixture-not-real-audio");
  fs.writeFileSync(path.join(root, "fixture.wav"), audio);
  const manifestPath = path.join(root, "recording.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    deviceId: "TEST_ONLY-pc", recordingId: "one", conversationId: "TEST_ONLY-vad",
    recordedAt: "2026-10-16T01:00:00Z", audioPath: "fixture.wav", testOnly: true,
    durationMs: 5000, sampleRateHz: 16000, sampleCount: 80000, channels: 1,
  }));
  const transcriptPath = path.join(root, "precomputed.json");
  fs.writeFileSync(transcriptPath, JSON.stringify({
    schemaVersion: 1, audioSha256: createHash("sha256").update(audio).digest("hex"), result: {
      schemaVersion: 1, durationMs: 5000, engine: "test-only", model: "precomputed-fixture",
      audio: { sampleRateHz: 16000, sampleCount: 80000, channels: 1 },
      segments: [{ id: "s1", startMs: 0, endMs: 1000, text: "Synthetic observation.", speakerLabel: "unknown" }],
      speakers: [],
    },
  }));
  const config = { projectRoot: root, paths: { database: production }, voice: { runtimeRoot: "runtime/voice" } };

  function cli(args, { forbidDatabase = false } = {}) {
    // Run the real CLI/storage against a temporary config; forbid every Python invocation.
    const modules = {
      [configUrl.href]: `export function loadConfig() { return ${JSON.stringify(config)}; }`,
      [processUrl.href]: "export function runCommand() { throw new Error('Python must not run in CLI tests'); }",
      [dbUrl.href]: `
        import { openDatabase as open } from ${JSON.stringify(`${dbUrl.href}?voice-cli-test`)};
        export function openDatabase(database) {
          if (${forbidDatabase} || database !== ${JSON.stringify(database)}) throw new Error('Unexpected database open');
          return open(database);
        }
      `,
    };
    const bootstrap = `
      import { registerHooks } from "node:module";
      const modules = ${JSON.stringify(modules)};
      registerHooks({ load(url, context, nextLoad) {
        if (Object.hasOwn(modules, url)) return { format: "module", source: modules[url], shortCircuit: true };
        return nextLoad(url, context);
      } });
    `;
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      "--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, fileURLToPath(cliUrl), ...args], {
      cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  return { root, database, production, manifestPath, transcriptPath, cli };
}

test("voice CLI imports a precomputed result and repeats without Python or duplicate evidence", (t) => {
  const f = fixture(t);
  const args = ["import", "--manifest", f.manifestPath, "--transcript", "precomputed.json", "--database", f.database];
  const first = f.cli(args);
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.database, f.database);
  assert.equal(output.result.duplicate, false);
  assert.equal(output.result.evidenceIds.length, 1);
  const second = f.cli(args);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).result, {
    recordingId: output.result.recordingId, duplicate: true, evidenceIds: [],
  });
  const store = openDatabase(f.database);
  try {
    const recording = store.db.prepare("SELECT * FROM voice_recordings").get();
    assert.equal(recording.status, "ready");
    assert.equal(recording.attempts, 1);
    assert.equal(JSON.parse(recording.metadata_json).testOnly, true);
    for (const table of ["voice_recordings", "voice_segments", "evidence", "context_changes"]) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
    }
    for (const table of ["tasks", "controller_outbox"]) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  } finally { store.close(); }
  assert.equal(fs.existsSync(f.production), false);
});

test("voice CLI rejects disallowed transcript combinations before opening any database", (t) => {
  const f = fixture(t);
  const cases = [
    [["import", "--manifest", f.manifestPath, "--register-only"], /mutually exclusive/],
    [["import"], /--manifest is required/],
    ...["transcribe", "show", "list", "person", "label", "label-batch", "correct", "samples", "forget-sample", "unknown"].map((command) => [[command], /only allowed with import/]),
    [[], /only allowed with import/],
  ];
  for (const [args, error] of cases) {
    const result = f.cli([...args, "--transcript", f.transcriptPath, "--database", f.database], { forbidDatabase: true });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, error);
    assert.equal(result.stdout, "");
  }
  assert.equal(fs.existsSync(f.database), false);
  assert.equal(fs.existsSync(f.production), false);
});

test("voice CLI rejects test-only imports without an explicitly isolated database before opening it", (t) => {
  const f = fixture(t);
  const productionAlias = path.join(f.root, "unused", "..", "production-sentinel.sqlite");
  for (const option of [["--transcript", f.transcriptPath], ["--register-only"], []]) {
    for (const databaseArgs of [[], ["--database", f.production], ["--database", productionAlias], ["--database", f.production.toUpperCase()]]) {
      const result = f.cli(["import", "--manifest", f.manifestPath, ...option, ...databaseArgs], { forbidDatabase: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Test-only recordings require --database.*isolated non-production/);
      assert.equal(result.stdout, "");
    }
  }
  assert.equal(fs.existsSync(f.production), false);
  assert.equal(fs.existsSync(f.database), false);
  assert.equal(fs.existsSync(path.join(f.root, "runtime")), false);
});

test("voice CLI keeps register-only imports pending without Python", (t) => {
  const f = fixture(t);
  const result = f.cli(["import", "--manifest", f.manifestPath, "--register-only", "--database", f.database]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.status, "pending");
});

test("voice CLI never falls back to Python for an empty transcript argument", (t) => {
  const f = fixture(t);
  const result = f.cli(["import", "--manifest", f.manifestPath, "--transcript=", "--database", f.database]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid transcript path/);
  assert.doesNotMatch(result.stderr, /Python/);
});

test("voice CLI label-batch confirms one local cluster without Python, enrollment or task dispatch", (t) => {
  const f = fixture(t);
  const envelope = JSON.parse(fs.readFileSync(f.transcriptPath, "utf8"));
  envelope.result.segments = [
    { id: "s1", startMs: 0, endMs: 1000, text: "First.", speakerLabel: "speaker_00" },
    { id: "s2", startMs: 1100, endMs: 2000, text: "Second.", speakerLabel: "speaker_00" },
  ];
  envelope.result.speakers = [{ label: "speaker_00", embedding: [1, 0], embeddingModel: "test-pc-model" }];
  fs.writeFileSync(f.transcriptPath, JSON.stringify(envelope));
  const imported = f.cli(["import", "--manifest", f.manifestPath, "--transcript", f.transcriptPath, "--database", f.database]);
  assert.equal(imported.status, 0, imported.stderr);
  const recordingId = JSON.parse(imported.stdout).result.recordingId;
  const person = f.cli(["person", "--key", "confirmed", "--name", "Confirmed Person", "--database", f.database]);
  assert.equal(person.status, 0, person.stderr);
  const personId = JSON.parse(person.stdout).result.id;
  const args = ["label-batch", "--id", recordingId, "--speaker", "speaker_00", "--person-id", personId, "--confirm", "--database", f.database];
  const first = f.cli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).result.updatedSegments, 2);
  assert.equal(JSON.parse(first.stdout).result.enrolled, false);
  const second = f.cli(args);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).result.duplicate, true);
  const store = openDatabase(f.database);
  try {
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n, 4);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM voice_segments WHERE revision=2").get().n, 2);
    for (const table of ["voice_speaker_samples", "tasks", "controller_outbox"]) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  } finally { store.close(); }
  assert.equal(fs.existsSync(f.production), false);
});

test("voice CLI label-batch rejects missing confirmation, implicit database and phone unknown before opening storage", (t) => {
  const f = fixture(t);
  const base = ["label-batch", "--id", "recording", "--speaker", "speaker_00", "--person-id", "person"];
  const cases = [
    [[...base, "--database", f.database], /requires --confirm/],
    [[...base, "--confirm"], /explicit --database/],
    [["label-batch", "--confirm", "--database", f.database], /requires --id/],
    [["label-batch", "--id", "phone", "--speaker", "unknown", "--person-id", "person", "--confirm", "--database", f.database], /Unknown speech requires per-segment/],
    ...[["--enroll"], ["--unknown"], ["--segment", "s1"]].map((extra) => [
      [...base, "--confirm", "--database", f.database, ...extra], /does not accept/,
    ]),
    [["label", "--confirm", "--database", f.database], /only allowed with label-batch/],
  ];
  for (const [args, error] of cases) {
    const result = f.cli(args, { forbidDatabase: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
  assert.equal(fs.existsSync(f.database), false);
  assert.equal(fs.existsSync(f.production), false);
});
