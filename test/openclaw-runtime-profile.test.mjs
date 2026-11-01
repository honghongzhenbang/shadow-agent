import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  inspectRuntimeProfile,
  mergeAgentToolPolicy,
  applyRuntimeSelection,
  resolveRuntimeSelection,
  applySystemAccessProfile,
  applyCorePluginProfile,
} from "../src/openclaw/runtime-profile.mjs";

const template = JSON.parse(fs.readFileSync(new URL("../config/openclaw-runtime-template.json", import.meta.url), "utf8"));
const deepseekSelection = JSON.parse(fs.readFileSync(new URL("../config/runtime-selection.example.json", import.meta.url), "utf8"));

test("fresh runtime profile enables native tasks and the required task completion hook", () => {
  const original = { agents: { entries: { main: {} } } };
  const result = applyCorePluginProfile(original);
  assert.deepEqual(result.plugins.allow, ["codex", "workboard", "shadow-work"]);
  for (const id of result.plugins.allow) assert.equal(result.plugins.entries[id].enabled, true);
  assert.equal(result.plugins.entries["shadow-work"].hooks.allowConversationAccess, true);
  assert.equal(original.plugins, undefined);
  assert.deepEqual(applyCorePluginProfile(result), result);
});

test("core plugin installation preserves unrelated extensions and application settings", () => {
  const original = { plugins: { allow: ["custom", "codex"], entries: {
    custom: { enabled: true, config: { value: "keep" } },
    workboard: { enabled: false, config: { databasePath: "existing.sqlite" } },
    "shadow-work": { hooks: { allowPromptInjection: false }, config: { databasePath: "knowledge.sqlite" } },
  } } };
  const result = applyCorePluginProfile(original);
  assert.deepEqual(result.plugins.entries.custom, original.plugins.entries.custom);
  assert.deepEqual(result.plugins.entries.workboard.config, original.plugins.entries.workboard.config);
  assert.equal(result.plugins.entries["shadow-work"].hooks.allowPromptInjection, false);
  assert.equal(result.plugins.entries["shadow-work"].hooks.allowConversationAccess, true);
  assert.equal(result.plugins.entries.workboard.enabled, true);
  assert.deepEqual(applyCorePluginProfile(result), result);
});

test("controller API selection preserves Codex worker, extensions, deny rules, and provider auth", () => {
  const original = {
    agents: { defaults: { model: "openai/old", workspace: "existing-workspace" }, entries: { main: {
      model: "openai/old", subagents: { model: "wrong/inherited" },
      tools: { profile: "minimal", alsoAllow: ["docs__read"], deny: ["docs__send"] }, skills: ["custom-skill"],
    } } },
    models: { providers: { deepseek: { baseUrl: "https://example.com", apiKey: "${MODEL_KEY}" } } },
    mcp: { servers: { docs: { url: "https://example.com/mcp" } } },
    plugins: { entries: { "shadow-work": { config: {
      databasePath: "existing-memory.sqlite", workboardDatabasePath: "existing-workboard.sqlite",
    } }, deepseek: { enabled: true } } },
  };
  const before = structuredClone(original);
  const { config } = applyRuntimeSelection(original, template, [], deepseekSelection);
  assert.equal(config.agents.entries.main.model.primary, "deepseek/deepseek-v4-pro");
  assert.equal(config.agents.entries.main.subagents.model, "openai/gpt-5.6-sol");
  assert.equal(config.agents.defaults.models["deepseek/deepseek-v4-pro"].agentRuntime.id, "openclaw");
  assert.equal(config.agents.defaults.models["openai/gpt-5.6-sol"].agentRuntime.id, "codex");
  assert.deepEqual(inspectRuntimeProfile(config).configuredSelection, {
    controller: { model: "deepseek/deepseek-v4-pro", runtime: "openclaw" },
    codingWorker: { model: "openai/gpt-5.6-sol", runtime: "codex" },
  });
  assert.deepEqual(config.mcp, original.mcp);
  assert.deepEqual(config.models, original.models);
  assert.deepEqual(config.plugins, original.plugins);
  assert.equal(config.agents.defaults.workspace, original.agents.defaults.workspace);
  assert.ok(config.agents.entries.main.skills.includes("custom-skill"));
  assert.ok(config.agents.entries.main.tools.alsoAllow.includes("docs__read"));
  assert.deepEqual(config.agents.entries.main.tools.deny, ["docs__send"]);
  assert.equal(config.skills, undefined, "model selection must not impose Workshop publishing");
  assert.deepEqual(original, before);
  assert.deepEqual(applyRuntimeSelection(config, template, [], deepseekSelection).config, config);
});

test("system access replaces old local ceilings without changing identity or application policy", () => {
  const original = {
    tools: { profile: "coding", allow: ["read"], exec: { security: "allowlist", ask: "always" } },
    agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {
      tools: { profile: "minimal", allow: ["read"], alsoAllow: ["docs__read"], deny: ["docs__send"],
        exec: { mode: "deny", timeoutSec: 700 }, fs: { workspaceOnly: true } },
      sandbox: { mode: "all" },
    } } },
    plugins: { entries: { codex: { config: { appServer: {
      homeScope: "agent", approvalPolicy: "never", sandbox: "workspace-write", command: "codex.exe",
    }, supervision: { allowWriteControls: false } } } } },
  };
  const before = structuredClone(original);
  const result = applySystemAccessProfile(original, template);
  assert.equal(result.tools.profile, "full");
  assert.equal(result.tools.exec.mode, "full");
  assert.equal(result.tools.sessions.visibility, "agent");
  assert.equal(result.tools.fs.workspaceOnly, false);
  assert.equal(result.tools.exec.applyPatch.workspaceOnly, false);
  assert.equal(result.agents.defaults.sandbox.mode, "off");
  assert.equal(result.agents.entries.main.sandbox.mode, undefined);
  assert.equal(result.agents.entries.main.tools.profile, undefined);
  assert.equal(result.agents.entries.main.tools.allow, undefined);
  assert.equal(result.agents.entries.main.tools.exec.mode, undefined);
  assert.equal(result.agents.entries.main.tools.exec.timeoutSec, 700);
  assert.deepEqual(result.agents.entries.main.tools.deny, ["docs__send"]);
  assert.equal(result.plugins.entries.codex.config.appServer.sandbox, "danger-full-access");
  assert.equal(result.plugins.entries.codex.config.appServer.homeScope, "agent");
  assert.equal(result.plugins.entries.codex.config.supervision.allowWriteControls, false);
  assert.deepEqual(original, before);
  assert.deepEqual(applySystemAccessProfile(result, template), result);
  assert.throws(() => applySystemAccessProfile(original, { tools: { profile: "minimal" } }), /explicitly declare/);
});

test("model selection fails closed on ambiguous runtime or unrelated authority overrides", () => {
  assert.throws(() => resolveRuntimeSelection(template, { controller: { runtime: "openclaw" } }), /two runtimes/);
  assert.throws(() => resolveRuntimeSelection(template, { tools: { profile: "full" } }), /Unknown runtime override/);
  assert.throws(() => resolveRuntimeSelection(template, { controller: { model: "*" } }), /exact provider/);
  assert.throws(() => resolveRuntimeSelection(template, { codingWorker: { token: "secret" } }), /Unknown/);
});

test("runtime profile derives allowed tools from plugin contracts", () => {
  const policy = mergeAgentToolPolicy({ profile: "minimal", alsoAllow: ["session_status"] }, [{
    contracts: { tools: ["shadow_context_query", "shadow_evidence_search"] },
  }]);
  assert.deepEqual(policy.alsoAllow, ["session_status", "shadow_context_query", "shadow_evidence_search"]);
});

test("runtime profile reports exact missing tools and current compaction readiness", () => {
  const config = {
    agents: {
      defaults: {
        contextInjection: "continuation-skip",
        compaction: { mode: "safeguard", maxActiveTranscriptBytes: "20mb", midTurnPrecheck: { enabled: true } },
      },
      entries: { main: { tools: { alsoAllow: ["shadow_context_query"] } } },
    },
    plugins: { slots: { contextEngine: "shadow-work" } },
  };
  const inspected = inspectRuntimeProfile(config, { contracts: { tools: ["shadow_context_query", "shadow_evidence_search"] } });
  assert.deepEqual(inspected.missingRequiredTools, ["shadow_evidence_search"]);
  assert.equal(inspected.incrementalToolsReady, false);
  assert.equal(inspected.contextEngineReady, true);
});
