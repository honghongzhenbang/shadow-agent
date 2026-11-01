import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-runtime-selection-"));
try {
  const configPath = path.join(dir, "openclaw.json");
  const selectionPath = path.join(dir, "selection.json");
  const workspace = path.join(dir, "workspace");
  const config = {
    agents: { defaults: {}, entries: { main: { tools: { profile: "minimal" }, skills: ["custom-existing"] } } },
    plugins: { load: { paths: [path.join(root, "openclaw/shadow-work")] }, entries: { "shadow-work": { enabled: true } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "SHADOW_PREFERENCES.md"), "Fixture Private Owner: fixture-only business background");
  fs.copyFileSync(path.join(root, "config/runtime-selection.example.json"), selectionPath);
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: dir, OPENCLAW_HOME: dir,
    SHADOW_AGENT_DATABASE: path.join(dir, "context.sqlite"),
    OPENCLAW_WORKSPACE_PATH: workspace, SHADOW_RUNTIME_PROFILE_PATH: selectionPath, OPENCLAW_NO_RESPAWN: "1" };
  const apply = spawnSync(process.execPath, [path.join(root, "scripts/apply-openclaw-runtime-profile.mjs")], { cwd: root, env, encoding: "utf8", windowsHide: true });
  assert.equal(apply.status, 0, apply.stderr);
  const result = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(result.agents.entries.main.model.primary, "deepseek/deepseek-v4-pro");
  assert.equal(result.agents.entries.main.subagents.model, "openai/gpt-5.6-sol");
  assert.equal(result.agents.defaults.models["deepseek/deepseek-v4-pro"].agentRuntime.id, "openclaw");
  assert.equal(result.agents.defaults.models["openai/gpt-5.6-sol"].agentRuntime.id, "codex");
  assert.equal(result.plugins.entries["shadow-work"].config.databasePath, path.join(dir, "context.sqlite"));
  assert.equal(result.plugins.entries["shadow-work"].config.workboardDatabasePath, path.join(dir, "plugins/workboard/workboard.sqlite"));
  assert.equal(result.plugins.entries["shadow-policy"].config.databasePath, path.join(dir, "context.sqlite"));
  assert.ok(result.agents.entries.main.skills.includes("custom-existing"));
  assert.equal(result.tools.profile, "full");
  assert.equal(result.tools.exec.mode, "full");
  assert.equal(result.tools.fs.workspaceOnly, false);
  assert.equal(result.agents.entries.main.tools.profile, undefined);
  assert.equal(result.plugins.entries.codex.config.appServer.sandbox, "danger-full-access");
  assert.equal(result.plugins.entries.codex.config.appServer.homeScope, "agent");
  assert.equal(result.plugins.entries["shadow-policy"].config.collaborationPath, path.join(root, "openclaw/workspace-template/COLLABORATION.md"));
  assert.equal(result.plugins.entries["shadow-policy"].config.preferencesPath, undefined);
  assert.equal(fs.existsSync(path.join(workspace, "SHADOW_PREFERENCES.md")), false);
  const historyRoot = path.join(dir, "policy-history");
  const history = fs.readdirSync(historyRoot).map(name => path.join(historyRoot, name, "SHADOW_PREFERENCES.md")).find(file => fs.existsSync(file));
  assert.match(fs.readFileSync(history, "utf8"), /Fixture Private Owner/);
  for (const name of ["capability-growth", "task-progression"]) assert.ok(fs.existsSync(path.join(workspace, "skills", name, "SKILL.md")));
  const validate = spawnSync(process.execPath, [path.join(root, "tools/openclaw-runtime/node_modules/openclaw/openclaw.mjs"), "config", "validate", "--json"],
    { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(validate.status, 0, `${validate.stderr}\n${validate.stdout}`);
  console.log(JSON.stringify({ passed: true, nativeValidation: JSON.parse(validate.stdout), modelCalls: 0, productionTouched: false }));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
