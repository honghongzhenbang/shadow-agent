import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyRuntimeSelection, applySystemAccessProfile, applyCorePluginProfile } from "../src/openclaw/runtime-profile.mjs";
import { applyShadowPolicyBoundary } from "./apply-shadow-policy-boundary.mjs";
import { loadConfig } from "../src/config.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const templatePath = path.join(projectRoot, "config", "openclaw-runtime-template.json");
const shadowWorkManifestPath = path.join(projectRoot, "openclaw", "shadow-work", "openclaw.plugin.json");
const workspaceTemplatePath = path.join(projectRoot, "openclaw", "workspace-template");
const configPath = process.env.OPENCLAW_CONFIG_PATH
  || path.join(projectRoot, "runtime", "openclaw-poc", "state", "openclaw.json");
const workspacePath = process.env.OPENCLAW_WORKSPACE_PATH
  || path.join(projectRoot, "runtime", "openclaw-poc", "workspace");
const databasePath = loadConfig().paths.database;
const workboardDatabasePath = path.join(
  path.resolve(process.env.OPENCLAW_STATE_DIR || path.dirname(configPath)),
  "plugins",
  "workboard",
  "workboard.sqlite",
);
const codexCommand = path.join(projectRoot, "tools", "codex-managed-current", "bin", "codex.exe");

const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
const shadowWorkManifest = JSON.parse(fs.readFileSync(shadowWorkManifestPath, "utf8"));
const overridesPath = process.env.SHADOW_RUNTIME_PROFILE_PATH
  || path.join(projectRoot, "runtime", "runtime-selection.private.json");
if (process.env.SHADOW_RUNTIME_PROFILE_PATH && !fs.existsSync(overridesPath)) {
  throw new Error("Explicit runtime profile file does not exist");
}
const overrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, "utf8")) : {};
let { config, selection } = applyRuntimeSelection(
  JSON.parse(fs.readFileSync(configPath, "utf8")), template, [shadowWorkManifest], overrides,
);
const main = config.agents?.entries?.main;
if (!main) throw new Error("OpenClaw main agent is missing.");

config.agents.defaults.thinkingDefault = template.thinkingDefault;
config.agents.defaults.heartbeat = template.heartbeat;
config.agents.defaults.workspace = workspacePath;
config.agents.defaults.contextInjection = template.contextInjection;
config.agents.defaults.compaction = {
  ...(config.agents.defaults.compaction ?? {}),
  ...template.compaction,
  midTurnPrecheck: template.compaction.midTurnPrecheck,
};
config.tools ??= {};
config.tools.loopDetection = template.tools.loopDetection;
config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries.codex ??= {};
config.plugins.entries.codex.enabled = true;
config.plugins.entries.codex.config ??= {};
config.plugins.entries.codex.config.codexDynamicToolsLoading = template.codexDynamicToolsLoading;
config.plugins.entries.codex.config.appServer ??= {};
config.plugins.entries.codex.config.appServer.command = codexCommand;
config.plugins.entries.codex.config.appServer.homeScope = template.codexRuntime.homeScope;
config.plugins.entries["shadow-work"] ??= { enabled: true };
config.plugins.entries["shadow-work"].config ??= {};
config.plugins.entries["shadow-work"].config.databasePath = databasePath;
config.plugins.entries["shadow-work"].config.workboardDatabasePath = workboardDatabasePath;
config.plugins.entries.codex.config.supervision = {
  enabled: true,
  endpoints: [{
    id: "local-stdio",
    label: "本机 Codex 会话",
    transport: "stdio-proxy",
    command: codexCommand,
    args: ["app-server", "--listen", "stdio://"],
    cwd: projectRoot,
  }],
  allowRawTranscripts: template.codexSupervision.allowRawTranscripts,
  allowWriteControls: template.codexSupervision.allowWriteControls,
};
delete config.plugins.entries["codex-supervisor"];
config.plugins.allow = [...new Set([
  ...(config.plugins.allow ?? []).filter((id) => id !== "codex-supervisor"),
  "codex",
])];
config = applyCorePluginProfile(config);
config.plugins.slots ??= {};
config.plugins.slots.contextEngine = template.contextEngine;
config = applySystemAccessProfile(config, template);
const policyBoundary = applyShadowPolicyBoundary(projectRoot);
config.agents.defaults.skipBootstrap = true;
config.plugins.load ??= {};
config.plugins.load.paths = [...new Set([
  ...(config.plugins.load.paths ?? []),
  path.join(projectRoot, "openclaw/shadow-policy"),
])];
config.plugins.allow = [...new Set([...config.plugins.allow, "shadow-policy"])];
config.plugins.entries["shadow-policy"] = {
  enabled: true,
  hooks: { allowConversationAccess: true, allowPromptInjection: true },
  config: {
    required: true,
    rulesPath: path.join(workspaceTemplatePath, "AGENTS.md"),
    collaborationPath: path.join(workspaceTemplatePath, "COLLABORATION.md"),
    databasePath,
    workboardDatabasePath,
  },
};
const { t: OpenClawSchema } = await import("../tools/openclaw-runtime/node_modules/openclaw/dist/zod-schema-D-8T4ion.js");
if (!OpenClawSchema.safeParse(config).success) throw new Error("Runtime profile failed native schema validation; configuration was not written");

fs.mkdirSync(workspacePath, { recursive: true });
const workspaceFiles = ["AGENTS.md", "HEARTBEAT.md", "TOOLS.md"];
for (const name of workspaceFiles) {
  const sourceName = name === "AGENTS.md" ? "RUNTIME_AGENTS.md" : name;
  fs.copyFileSync(path.join(workspaceTemplatePath, sourceName), path.join(workspacePath, name));
}
// Preserve prior local text without promoting it into system-level instructions.
for (const name of ["SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "SHADOW_PREFERENCES.md"]) {
  const source = path.resolve(workspacePath, name);
  if (path.dirname(source) !== path.resolve(workspacePath)) throw new Error("Persona path escapes workspace");
  if (!fs.existsSync(source)) continue;
  const history = path.join(path.dirname(configPath), "policy-history", new Date().toISOString().replaceAll(":", "-"));
  fs.mkdirSync(history, { recursive: true });
  fs.renameSync(source, path.join(history, name));
}
for (const name of ["capability-growth", "task-progression"]) {
  const skillPath = path.join(workspacePath, "skills", name);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.copyFileSync(path.join(workspaceTemplatePath, "skills", name, "SKILL.md"), path.join(skillPath, "SKILL.md"));
}
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  configPath,
  model: config.agents.defaults.model,
  selection,
  thinkingDefault: config.agents.defaults.thinkingDefault,
  heartbeat: config.agents.defaults.heartbeat.every,
  contextInjection: config.agents.defaults.contextInjection,
  contextEngine: config.plugins.slots.contextEngine,
  compaction: config.agents.defaults.compaction,
  subagents: config.agents.defaults.subagents,
  loopDetection: config.tools.loopDetection,
  toolProfile: config.tools.profile,
  systemAccess: { execMode: config.tools.exec.mode, workspaceOnly: config.tools.fs.workspaceOnly },
  allowedTools: main.tools.alsoAllow.length,
  skills: main.skills.length,
  codexDynamicToolsLoading: config.plugins.entries.codex.config.codexDynamicToolsLoading,
  codexRuntime: {
    homeScope: config.plugins.entries.codex.config.appServer.homeScope,
    approvalPolicy: config.plugins.entries.codex.config.appServer.approvalPolicy,
    sandbox: config.plugins.entries.codex.config.appServer.sandbox,
    forcedRuntime: selection.controller.runtime,
  },
  codexSupervision: {
    endpoint: config.plugins.entries.codex.config.supervision.endpoints[0].id,
    allowRawTranscripts: config.plugins.entries.codex.config.supervision.allowRawTranscripts,
    allowWriteControls: config.plugins.entries.codex.config.supervision.allowWriteControls,
  },
  workspacePath,
  workspaceFiles,
  policyBoundary,
  sessionsVisibility: config.tools.sessions.visibility,
}));
