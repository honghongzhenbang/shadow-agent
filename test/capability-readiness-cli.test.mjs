import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { recordCapabilityProbe } from "../src/openclaw/capability-release.mjs";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "scripts/manage-mcp-capability.mjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-readiness-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const proposalPath = path.join(directory, "proposal.json");
  const manifestPath = path.join(directory, "manifest.json");
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const config = {
    agents: { entries: { main: { tools: { alsoAllow: ["other__read"], deny: ["danger"] } } } },
    mcp: { servers: { other: { enabled: true, command: "inert-other-never-executed" } } },
  };
  write(configPath, config);
  write(manifestPath, {
    name: "fixture", taskId: "isolated-cli-test", purpose: "Test publication semantics only",
    tools: ["read"], server: { command: "inert-fixture-never-executed" },
  });
  function run(action, args = [], expected = 0) {
    const result = spawnSync(process.execPath, [cli, action, "--config", configPath,
      "--proposal", proposalPath, ...args], {
      cwd: directory, encoding: "utf8", windowsHide: true, timeout: 15000,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: directory, OPENCLAW_HOME: directory },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stderr);
    return expected === 0 ? JSON.parse(result.stdout) : result;
  }
  run("prepare", ["--manifest", manifestPath]);
  // Synthetic probe receipt exercises CLI publication, not native connection proof.
  function seedProbe() {
    write(proposalPath, recordCapabilityProbe(read(proposalPath), {
      exitCode: 0, servers: { fixture: {} }, tools: ["fixture__read"], diagnostics: [],
    }));
  }
  return { config, configPath, proposalPath, directory, read, write, run, seedProbe };
}

test("actual CLI status preserves unprobed state; probe requires explicit trust", t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.proposalPath);
  assert.equal(f.run("status").probe, null);
  assert.equal(f.run("status").publication, null);
  assert.match(f.run("probe", [], 1).stderr, /trust-server/);
  assert.match(f.run("publish", [], 1).stderr, /fresh successful probe/);
  assert.deepEqual(fs.readFileSync(f.proposalPath), before);
  assert.deepEqual(f.read(f.configPath), f.config);
});

test("actual CLI disabled publication and status never imply readiness", t => {
  const f = fixture(t);
  f.seedProbe();
  const published = f.run("publish");
  assert.equal(published.publication.enabled, false);
  assert.equal(published.publication.proof, "configuration-published");
  assert.equal(published.publication.runtimeVerified, false);
  assert.equal(published.publication.businessVerified, false);
  assert.deepEqual(f.read(f.configPath).agents, f.config.agents);
  assert.deepEqual(f.run("status"), published);
  assert.equal(Object.hasOwn(published, "ready"), false);
});

test("actual CLI target publication, status and withdrawal preserve evidence boundaries", t => {
  const f = fixture(t);
  f.seedProbe();
  const published = f.run("publish", ["--authorization-evidence", "synthetic-cli-review"]);
  assert.equal(published.publication.enabled, true);
  assert.equal(published.publication.runtimeVerified, false);
  assert.equal(published.publication.businessVerified, false);
  const config = f.read(f.configPath);
  assert.deepEqual(config.mcp.servers.other, f.config.mcp.servers.other);
  assert.deepEqual(config.agents.entries.main.tools.alsoAllow, ["other__read", "fixture__read"]);
  assert.deepEqual(config.agents.entries.main.tools.deny, ["danger"]);
  assert.equal(config.mcp.servers.fixture.codex.defaultToolsApprovalMode, "prompt");

  // Status is the saved publication receipt, even after runtime config drifts.
  config.mcp.servers.fixture.enabled = false;
  f.write(f.configPath, config);
  const proposalBefore = fs.readFileSync(f.proposalPath);
  const configBefore = fs.readFileSync(f.configPath);
  const filesBefore = fs.readdirSync(f.directory).sort();
  assert.deepEqual(f.run("status"), published);
  assert.deepEqual(fs.readFileSync(f.proposalPath), proposalBefore);
  assert.deepEqual(fs.readFileSync(f.configPath), configBefore);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), filesBefore);
  assert.match(f.run("rollback", [], 1).stderr, /later edits/);

  config.mcp.servers.fixture.enabled = true;
  config.mcp.servers.other.enabled = false;
  f.write(f.configPath, config);
  const withdrawn = f.run("rollback");
  assert.ok(withdrawn.publication.rolledBackAt);
  assert.equal(withdrawn.publication.runtimeVerified, false);
  assert.equal(withdrawn.publication.businessVerified, false);
  assert.deepEqual(f.read(f.configPath).mcp.servers, { other: { ...f.config.mcp.servers.other, enabled: false } });
  assert.deepEqual(f.read(f.configPath).agents, f.config.agents);
  assert.deepEqual(f.run("status"), withdrawn);
});
