import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { digest } from "../../src/openclaw/capability-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-capability-e2e-"));
const configPath = path.join(tmp, "openclaw.json");
const manifestPath = path.join(tmp, "candidate.json");
const proposalPath = path.join(tmp, "proposal.json");
const config = { agents: { entries: { main: { tools: { profile: "minimal", alsoAllow: ["session_status"] } } } } };
const read = (name) => JSON.parse(fs.readFileSync(name, "utf8"));
function run(action, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/manage-mcp-capability.mjs"), action,
    "--config", configPath, "--proposal", proposalPath, ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 240000 });
  assert.equal(result.status, expected, `${action}: ${result.stderr}\n${result.stdout}`);
  return result;
}
try {
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "fixture", taskId: "isolated-task", purpose: "Verify native MCP without production data",
    tools: ["read"], server: { command: process.execPath, args: [path.join(root, "test/fixtures/capability-mcp-server.mjs")] } }));
  run("prepare", ["--manifest", manifestPath]);
  run("probe", [], 1);
  run("probe", ["--trust-server"]);
  assert.equal(read(proposalPath).probe.passed, true);
  assert.deepEqual(read(configPath), config);
  const beforePublication = read(proposalPath);
  run("publish", ["--authorization-evidence", "isolated-test-approval"]);
  assert.equal(read(configPath).mcp.servers.fixture.enabled, true);
  assert.equal(read(proposalPath).publication.businessVerified, false);
  const published = read(proposalPath);
  fs.writeFileSync(`${proposalPath}.intent.json`, JSON.stringify({ action: "publish", beforeHash: digest(config), afterHash: digest(read(configPath)), result: published }));
  fs.writeFileSync(proposalPath, JSON.stringify(beforePublication));
  run("recover");
  assert.deepEqual(read(proposalPath), published);
  run("rollback");
  assert.deepEqual(read(configPath).agents, config.agents);
  assert.deepEqual(read(configPath).mcp.servers, {});
  console.log(JSON.stringify({ passed: true, nativeProbe: read(proposalPath).probe, productionTouched: false }));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
