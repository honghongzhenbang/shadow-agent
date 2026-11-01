import assert from "node:assert/strict";
import test from "node:test";
import { prepareCapability, recordCapabilityProbe, publishCapability, rollbackCapability, PROBE_MAX_AGE_MS } from "../src/openclaw/capability-release.mjs";

const config = { agents: { entries: { main: { tools: { profile: "minimal", alsoAllow: ["session_status"], deny: ["danger"] } } } } };
const candidate = { name: "docs", taskId: "task-1", purpose: "Read project docs", tools: ["read"], server: { url: "https://example.com/mcp", transport: "streamable-http" } };
const now = new Date("2026-10-18T01:00:00Z");
const prepare = () => prepareCapability(candidate, config, now);
const probe = (draft = prepare()) => recordCapabilityProbe(draft, { exitCode: 0, servers: { docs: { tools: 1 } }, tools: ["docs__read"], diagnostics: [] }, now);

test("capability defaults disabled and never claims runtime or business proof", () => {
  const result = publishCapability(probe(), config, { now });
  assert.equal(result.config.mcp.servers.docs.enabled, false);
  assert.deepEqual(result.config.agents, config.agents);
  assert.equal(result.draft.publication.runtimeVerified, false);
  assert.equal(result.draft.publication.businessVerified, false);
  assert.equal(result.config.mcp.servers.docs.codex.defaultToolsApprovalMode, "prompt");
});

test("authorized exact tool publication and surgical rollback preserve later unrelated edits", () => {
  const result = publishCapability(probe(), config, { now, authorizationEvidence: "user-approval-1" });
  assert.equal(result.config.mcp.servers.docs.enabled, true);
  assert.deepEqual(result.config.agents.entries.main.tools.alsoAllow, ["session_status", "docs__read"]);
  result.config.mcp.servers.other = { enabled: true };
  result.config.agents.entries.main.tools.alsoAllow.push("other__read");
  const rolled = rollbackCapability(result.draft, result.config);
  assert.equal(rolled.mcp.servers.docs, undefined);
  assert.deepEqual(rolled.mcp.servers.other, { enabled: true });
  assert.deepEqual(rolled.agents.entries.main.tools.alsoAllow, ["session_status", "other__read"]);
  assert.deepEqual(rolled.agents.entries.main.tools.deny, ["danger"]);
  result.config.mcp.servers.docs.enabled = false;
  assert.throws(() => rollbackCapability(result.draft, result.config), /later edits/);
});

test("stale, tampered, unprobed, missing tools, and concurrent config changes fail closed", () => {
  assert.throws(() => publishCapability(prepare(), config, { now }), /probe/);
  assert.throws(() => publishCapability(probe(), config, { now: new Date(+now + PROBE_MAX_AGE_MS + 1) }), /probe/);
  assert.throws(() => publishCapability(probe(), { ...config, changed: true }, { now }), /config changed/);
  const tampered = probe(); tampered.candidate.tools.push("send");
  assert.throws(() => publishCapability(tampered, config, { now }), /Candidate changed/);
  const failed = recordCapabilityProbe(prepare(), { exitCode: 0, servers: { docs: {} }, tools: [], diagnostics: [] }, now);
  assert.equal(failed.probe.passed, false);
  assert.throws(() => publishCapability(failed, config, { now }), /probe/);
  const published = publishCapability(probe(), config, { now });
  assert.throws(() => publishCapability(published.draft, published.config, { now }), /Already published/);
});

test("reject wildcard tools, raw credential headers, collisions, and unsupported fields", () => {
  assert.throws(() => prepareCapability({ ...candidate, tools: ["*"] }, config), /wildcards/);
  assert.throws(() => prepareCapability({ ...candidate, server: { ...candidate.server, headers: { Authorization: "Bearer secret" } } }, config), /credentials/);
  assert.throws(() => prepareCapability({ ...candidate, server: { ...candidate.server, sslVerify: false } }, config), /Unknown/);
  assert.throws(() => prepareCapability(candidate, { ...config, mcp: { servers: { docs: {} } } }), /already exists/);
});
