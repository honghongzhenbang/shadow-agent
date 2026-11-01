import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { patchCodexShellAlias } from "../../scripts/apply-codex-shell-alias.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const projects = path.join(root, "runtime/openclaw-poc/state/npm/projects");
const project = fs.readdirSync(projects).filter(name => name.startsWith("openclaw-codex-"));
assert.equal(project.length, 1);
const dir = path.join(projects, project[0], "node_modules/@openclaw/codex/dist");
const file = fs.readdirSync(dir).find(name => /^dynamic-tools-.*\.js$/.test(name));
const source = patchCodexShellAlias(fs.readFileSync(path.join(dir, file), "utf8"));
const start = source.indexOf("function addGatewayShellDynamicToolsIfAvailable(");
const end = source.indexOf("/** Decides whether Codex native code mode", start);
assert.ok(start >= 0 && end > start);
const run = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
  isCodexMemoryFlushRun: p => p.trigger === "memory",
  shouldKeepOpenClawShellDynamicTools: (i, p) => i.params.trigger !== "memory" && i.nativeToolSurfaceEnabled === false && !i.sandbox?.enabled && p.effectiveExecHost !== "node",
  normalizeCodexDynamicToolName: name => name,
  isCodexDynamicToolExcluded: (config, names) => names.some(name => config.codexDynamicToolsExclude?.includes(name)),
  CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME: "gateway_exec",
  CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME: "gateway_process",
  resolveCodexScheduledToolProjectionFactory: () => ({}),
  createGatewayExecProjection: (_factory, original) => ({ name: "gateway_exec", original }),
  createGatewayProcessProjection: (_factory, original) => ({ name: "gateway_process", original }),
});
const exec = { name: "exec" };
const processTool = { name: "process" };
const input = { params: { hostCapabilities: {} }, nativeToolSurfaceEnabled: false, pluginConfig: {} };
const policy = { nativeToolSurfaceAllowed: false, effectiveExecHost: "gateway" };
const projected = run([], [exec, processTool], input, policy);
assert.equal(projected.length, 2);
assert.equal(projected[0].original, exec);
assert.equal(projected[1].original, processTool);
assert.equal(run([], [processTool], input, policy).length, 0);
assert.equal(run([], [exec], { ...input, pluginConfig: { codexDynamicToolsExclude: ["exec"] } }, policy).length, 0);
assert.equal(run([], [exec], { ...input, sandbox: { enabled: true } }, policy).length, 0);
assert.equal(run([], [exec], input, { ...policy, effectiveExecHost: "node" }).length, 0);
console.log(JSON.stringify({ passed: true, installedProjection: file, modelCalls: 0, productionTouched: false }));
