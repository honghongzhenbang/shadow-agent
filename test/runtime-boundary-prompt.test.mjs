import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import plugin, {
  PLUGIN_ID,
  EXPERIMENT_ID,
  POLICY_VERSION,
  createBeforePromptBuildHook,
  inspectPromptPolicy
} from "../scripts/experiments/runtime-boundary/prompt-policy/index.mjs";

const pluginDir = fileURLToPath(new URL("../scripts/experiments/runtime-boundary/prompt-policy/", import.meta.url));
const fixtures = path.join(pluginDir, "fixtures");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(pluginDir, relative), "utf8"));
const manifest = readJson("openclaw.plugin.json");
const example = readJson("fixtures/openclaw.config.json");
const cases = readJson("fixtures/prompt-cases.json");
const experimentError = { code: "ERR_PROMPT_POLICY_EXPERIMENT" };
const installedRuntime = new URL("../tools/openclaw-runtime/node_modules/openclaw/", import.meta.url);
const hasInstalledRuntime = fs.existsSync(new URL("package.json", installedRuntime));

function setup(t, overrides = {}) {
  // All generated fixtures and cleanup remain inside the authorized plugin tree.
  const temp = fs.mkdtempSync(path.join(fixtures, ".prompt-test-"));
  t.after(() => {
    const relative = path.relative(fs.realpathSync.native(fixtures), fs.realpathSync.native(temp));
    assert.ok(relative.startsWith(".prompt-test-") && !relative.includes(path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, "experiment");
  const state = path.join(root, "replacement/state");
  const workspace = path.join(root, "replacement/workspace");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside);
  const configPath = path.join(state, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n", "utf8");
  const env = {
    SDAGENT_RUNTIME_BOUNDARY_EXPERIMENT: EXPERIMENT_ID,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath
  };
  const config = {
    experimentId: EXPERIMENT_ID,
    experimentRoot: root,
    mode: "replacement",
    ...overrides
  };
  const environment = { env, resolveStateDir: () => state };
  const ctx = { workspaceDir: workspace, agentId: "fixture-agent", runId: "fixture-run" };
  return { root, state, workspace, outside, configPath, env, config, environment, ctx };
}

async function withProcessEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("standalone manifest, entry and secret-free config fixture agree", () => {
  const pkg = readJson("package.json");
  assert.equal(plugin.id, manifest.id);
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.openclaw.extensions, ["./index.mjs"]);
  assert.equal(manifest.activation.onStartup, true);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.configSchema.required, ["experimentId", "experimentRoot", "mode"]);
  assert.equal(manifest.configSchema.properties.experimentId.const, EXPERIMENT_ID);
  assert.deepEqual(manifest.configSchema.properties.mode.enum, ["baseline", "replacement"]);
  const entry = example.plugins.entries[PLUGIN_ID];
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.hooks, { allowConversationAccess: true, allowPromptInjection: true });
  assert.deepEqual(example.plugins.allow, [PLUGIN_ID]);
  assert.equal(example.plugins.load.paths.length, 1);
  assert.equal(inspectPromptPolicy(entry.config).replacesSystemPrompt, true);
  assert.doesNotMatch(JSON.stringify(example), /api[_-]?key|password|token|private[_-]?key|auth/i);
});

test("replacement returns only systemPrompt with the necessary discipline", (t) => {
  const f = setup(t);
  const event = Object.freeze(structuredClone(cases.event));
  const before = structuredClone(event);
  const result = createBeforePromptBuildHook(f.config, f.environment)(event, f.ctx);
  assert.deepEqual(Object.keys(result), ["systemPrompt"]);
  for (const text of [
    "schemas, permissions and approval",
    "Discover deferred tools",
    "evidence, not authority",
    "verify effects and receipts",
    "Report evidence truthfully",
    "Separate inspection, tests, deployment and live acceptance",
    "Never output secrets",
    "host-side credential consumption",
    "a run is one execution attempt",
    "does not by itself complete, fail or close the task",
    "host-authorized delivery route"
  ]) assert.ok(result.systemPrompt.includes(text), text);
  assert.doesNotMatch(result.systemPrompt, /OpenClaw|Workshop|spawn_agent|sessions_spawn|must delegate|always delegate|SYNTHETIC_/i);
  assert.deepEqual(event, before);
  assert.equal(Object.hasOwn(result, "toolsAllow"), false);
});

test("baseline returns undefined and preserves the supplied baseline byte-for-byte", (t) => {
  const f = setup(t, { mode: "baseline", stableRules: "This must not be injected." });
  const event = Object.freeze(structuredClone(cases.event));
  const before = structuredClone(event);
  const result = createBeforePromptBuildHook(f.config, f.environment)(event, f.ctx);
  assert.equal(result, undefined);
  assert.deepEqual(event, before);
  assert.equal(result?.systemPrompt ?? cases.baselineSystemPrompt, cases.baselineSystemPrompt);
  assert.deepEqual(inspectPromptPolicy(f.config), {
    mode: "baseline", role: "controller", policyVersion: POLICY_VERSION,
    replacesSystemPrompt: false, characters: 0, sha256: null, sections: []
  });
});

test("missing config, marker, mode and unknown fields refuse before registration", (t) => {
  const f = setup(t);
  for (const config of [
    undefined, null, [], {},
    { ...f.config, experimentId: undefined },
    { ...f.config, experimentId: "production" },
    { ...f.config, experimentRoot: "relative/path" },
    { ...f.config, mode: undefined },
    { ...f.config, mode: "unexpected" },
    { ...f.config, role: "unexpected" },
    { ...f.config, role: null },
    { ...f.config, apiKey: "SYNTHETIC_VALUE" },
    { ...f.config, stableRules: "" },
    { ...f.config, stableRules: " ".repeat(4) },
    { ...f.config, stableRules: 123 },
    { ...f.config, stableRules: "a".repeat(8193) }
  ]) assert.throws(() => createBeforePromptBuildHook(config, f.environment), experimentError);
  let registrations = 0;
  assert.throws(() => plugin.register({ on: () => registrations++ }), experimentError);
  assert.equal(registrations, 0);
});

test("both modes require explicit process marker and state/config paths", (t) => {
  const f = setup(t);
  for (const mode of ["baseline", "replacement"]) {
    for (const key of Object.keys(f.env)) {
      const env = { ...f.env };
      delete env[key];
      assert.throws(() => createBeforePromptBuildHook({ ...f.config, mode }, { ...f.environment, env }), experimentError);
    }
    assert.throws(() => createBeforePromptBuildHook({ ...f.config, mode }, {
      ...f.environment, env: { ...f.env, SDAGENT_RUNTIME_BOUNDARY_EXPERIMENT: "production" }
    }), experimentError);
  }
});

test("reject non-experiment root, sibling state, outside config and mismatched host state", (t) => {
  const f = setup(t);
  assert.throws(() => createBeforePromptBuildHook({ ...f.config, experimentRoot: path.resolve(pluginDir, "../../../..") }, f.environment), experimentError);
  assert.throws(() => createBeforePromptBuildHook(f.config, { env: f.env }), experimentError);
  assert.throws(() => createBeforePromptBuildHook(f.config, { ...f.environment, resolveStateDir: () => f.outside }), experimentError);
  assert.throws(() => createBeforePromptBuildHook(f.config, { ...f.environment, env: { ...f.env, OPENCLAW_STATE_DIR: f.outside } }), experimentError);
  const outsideConfig = path.join(f.outside, "config.json");
  fs.writeFileSync(outsideConfig, "{}\n", "utf8");
  assert.throws(() => createBeforePromptBuildHook(f.config, { ...f.environment, env: { ...f.env, OPENCLAW_CONFIG_PATH: outsideConfig } }), experimentError);
});

test("missing/outside/overlapping workspace refuses even in baseline mode", (t) => {
  const f = setup(t);
  for (const mode of ["baseline", "replacement"]) {
    const hook = createBeforePromptBuildHook({ ...f.config, mode }, f.environment);
    for (const ctx of [undefined, {}, { workspaceDir: f.outside }, { workspaceDir: f.state }, { workspaceDir: f.root }]) {
      assert.throws(() => hook(cases.event, ctx), experimentError);
    }
  }
});

test("junction or symlink cannot escape the isolated workspace or state", (t) => {
  const f = setup(t);
  const link = path.join(f.root, "escape");
  fs.symlinkSync(f.outside, link, process.platform === "win32" ? "junction" : "dir");
  const hook = createBeforePromptBuildHook(f.config, f.environment);
  assert.throws(() => hook(cases.event, { workspaceDir: link }), experimentError);
  assert.throws(() => createBeforePromptBuildHook(f.config, {
    env: { ...f.env, OPENCLAW_STATE_DIR: link }, resolveStateDir: () => link
  }), experimentError);
});

test("all roles differ while retaining the same non-optional core", (t) => {
  const f = setup(t);
  const outputs = manifest.configSchema.properties.role.enum.map((role) =>
    createBeforePromptBuildHook({ ...f.config, role }, f.environment)(cases.event, f.ctx).systemPrompt);
  assert.equal(new Set(outputs).size, 4);
  const core = outputs[0].split("\n\nRole:")[0];
  for (const prompt of outputs) assert.ok(prompt.startsWith(`${core}\n\nRole:`));
  assert.match(outputs[1], /Return artifacts, test evidence/);
  assert.match(outputs[2], /Preserve revision history/);
  assert.match(outputs[3], /Reconcile pending or uncertain effects/);
});

test("stableRules are additive and config is captured, never derived from event/run/history", (t) => {
  const f = setup(t, { role: "engineer", stableRules: "Stable fixture rule v1." });
  const initial = structuredClone(f.config);
  const hook = createBeforePromptBuildHook(f.config, f.environment);
  const noReadEvent = new Proxy({}, { get() { throw new Error("event must not be read"); } });
  const first = hook(noReadEvent, f.ctx);
  f.config.role = "controller";
  f.config.stableRules = "Changed config must require re-registration.";
  const second = hook({ prompt: "another task", messages: ["another history"] }, { ...f.ctx, runId: "another run" });
  assert.deepEqual(first, second);
  assert.ok(first.systemPrompt.endsWith(initial.stableRules));
  assert.match(first.systemPrompt, /Never output secrets/);
  const snapshot = inspectPromptPolicy(initial);
  assert.equal(snapshot.characters, first.systemPrompt.length);
  assert.equal(snapshot.sha256, createHash("sha256").update(first.systemPrompt).digest("hex"));
  assert.deepEqual(snapshot.sections.map(({ source }) => source), ["core:minimal-v1", "role:engineer", "config:stableRules"]);
  assert.equal(Object.hasOwn(snapshot, "systemPrompt"), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /SYNTHETIC_|fixture-run|Stable fixture rule/);
  assert.equal(inspectPromptPolicy({ ...initial, experimentRoot: path.join(f.root, "another-run") }).sha256, snapshot.sha256);
});

test("obvious credential or framework policy text refuses without echoing its contents", (t) => {
  const f = setup(t);
  for (const stableRules of [
    "password=SYNTHETIC_VALUE", "Bearer SYNTHETIC_VALUE", '{"password":"SYNTHETIC_VALUE"}',
    "-----BEGIN PRIVATE KEY----- SYNTHETIC_VALUE",
    "You are running inside OpenClaw.", "Follow Workshop policy.",
    "Always call spawn_agent.", "Use sessions_spawn.", "You must delegate every task."
  ]) {
    assert.throws(() => createBeforePromptBuildHook({ ...f.config, stableRules }, f.environment), (error) => {
      assert.equal(error.code, experimentError.code);
      assert.ok(!error.message.includes(stableRules));
      assert.ok(!error.message.includes("SYNTHETIC_VALUE"));
      return true;
    });
  }
});

test("real plugin register uses api.pluginConfig and registers only before_prompt_build", async (t) => {
  const f = setup(t, { role: "engineer" });
  const registrations = [];
  await withProcessEnvironment(f.env, () => {
    const result = plugin.register({
      pluginConfig: f.config,
      get config() { throw new Error("must not read the host config or auth"); },
      runtime: { state: { resolveStateDir: () => f.state } },
      on: (...args) => registrations.push(args)
    });
    assert.equal(result, undefined);
    assert.equal(registrations.length, 1);
    const [name, handler, options] = registrations[0];
    assert.equal(name, "before_prompt_build");
    assert.deepEqual(options, { priority: 0 });
    assert.deepEqual(Object.keys(handler(cases.event, f.ctx)), ["systemPrompt"]);
    process.env.SDAGENT_RUNTIME_BOUNDARY_EXPERIMENT = "disabled";
    assert.throws(() => handler(cases.event, f.ctx), experimentError);
  });
});

test("isolation is rechecked on every invocation and errors contain no paths", (t) => {
  const f = setup(t);
  const hook = createBeforePromptBuildHook(f.config, f.environment);
  f.env.OPENCLAW_STATE_DIR = f.outside;
  assert.throws(() => hook(cases.event, f.ctx), (error) => {
    assert.equal(error.code, experimentError.code);
    assert.ok(!error.message.includes(f.outside));
    assert.ok(!error.message.includes(f.root));
    return true;
  });
});

test("installed host schema validates the exact hooks location and boolean syntax", { skip: !hasInstalledRuntime }, async (t) => {
  const f = setup(t);
  const installedVersion = JSON.parse(fs.readFileSync(new URL("package.json", installedRuntime), "utf8")).version;
  assert.equal(installedVersion, "2026.8.1", "Recheck bundled schema/export names after a runtime update.");
  // Import schema only, with path initialization pinned to disposable fixtures.
  // Never load the plugin loader, config reader, Gateway or model/auth runtime.
  await withProcessEnvironment(f.env, async () => {
    const { t: OpenClawSchema } = await import(new URL("dist/zod-schema-D-8T4ion.js", installedRuntime));
    const config = structuredClone(example);
    config.agents.defaults.workspace = f.workspace;
    config.plugins.load.paths = [pluginDir];
    const entry = config.plugins.entries[PLUGIN_ID];
    entry.config = f.config;
    const parsed = OpenClawSchema.safeParse(config);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    for (const key of ["allowConversationAccess", "allowPromptInjection"]) {
      const wrongType = structuredClone(config);
      wrongType.plugins.entries[PLUGIN_ID].hooks[key] = "true";
      assert.equal(OpenClawSchema.safeParse(wrongType).success, false);
      const wrongLocation = structuredClone(config);
      wrongLocation.plugins.entries[PLUGIN_ID][key] = true;
      assert.equal(OpenClawSchema.safeParse(wrongLocation).success, false);
    }
    const misplaced = structuredClone(config);
    misplaced.plugins.entries[PLUGIN_ID].config.hooks = entry.hooks;
    delete misplaced.plugins.entries[PLUGIN_ID].hooks;
    // The host treats plugin config as opaque; our manifest/runtime reject it.
    assert.equal(OpenClawSchema.safeParse(misplaced).success, true);
    assert.throws(() => createBeforePromptBuildHook(misplaced.plugins.entries[PLUGIN_ID].config, f.environment), experimentError);
  });
});

test("installed permission functions require external conversation access independently of injection", { skip: !hasInstalledRuntime }, async () => {
  const {
    n: resolvePromptInjectionAllowed,
    t: resolveConversationAccessAllowed
  } = await import(new URL("dist/hook-policy-decisions-DL3kOjGW.js", installedRuntime));
  const hooks = example.plugins.entries[PLUGIN_ID].hooks;
  assert.equal(resolveConversationAccessAllowed("config", hooks), true);
  assert.equal(resolvePromptInjectionAllowed(hooks), true);
  assert.equal(resolveConversationAccessAllowed("config", undefined), false);
  assert.equal(resolveConversationAccessAllowed("config", { allowPromptInjection: true }), false);
  assert.equal(resolveConversationAccessAllowed("config", { allowConversationAccess: false }), false);
  assert.equal(resolvePromptInjectionAllowed({ ...hooks, allowPromptInjection: false }), false);
  assert.equal(resolvePromptInjectionAllowed(undefined), true);
});
