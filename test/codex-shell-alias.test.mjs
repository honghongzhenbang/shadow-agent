import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { patchCodexShellAlias, shellAliasGuard } from "../scripts/apply-codex-shell-alias.mjs";

test("restricted child reuses the host shell projection, without widening sandbox/node/memory runs", () => {
  const source = `(function(input, executionPolicy) { const filteredTools = 'unchanged'; ${shellAliasGuard} return 'project-policy-filtered-exec'; })`;
  const patched = patchCodexShellAlias(source);
  assert.equal(patchCodexShellAlias(patched), patched);
  const guard = vm.runInNewContext(patched, {
    isCodexMemoryFlushRun: p => p?.trigger === "memory",
    shouldKeepOpenClawShellDynamicTools: (i, p) => i.params?.trigger !== "memory"
      && i.nativeToolSurfaceEnabled === false && i.sandbox?.enabled !== true && p.effectiveExecHost !== "node",
  });
  const policy = { nativeToolSurfaceAllowed: false, effectiveExecHost: "gateway" };
  assert.equal(guard({ nativeToolSurfaceEnabled: false }, policy), "project-policy-filtered-exec");
  assert.equal(guard({ nativeToolSurfaceEnabled: false, sandbox: { enabled: true } }, policy), "unchanged");
  assert.equal(guard({ nativeToolSurfaceEnabled: false }, { ...policy, effectiveExecHost: "node" }), "unchanged");
  assert.equal(guard({ nativeToolSurfaceEnabled: false, params: { trigger: "memory" } }, policy), "unchanged");
  assert.equal(guard({ nativeToolSurfaceEnabled: true }, policy), "unchanged");
  assert.equal(guard({ nativeToolSurfaceEnabled: true }, { ...policy, nativeToolSurfaceAllowed: true }), "project-policy-filtered-exec");
});

test("shell projection patch refuses drift and ambiguous upstream matches", () => {
  assert.throws(() => patchCodexShellAlias("changed"), /Unsupported/);
  assert.throws(() => patchCodexShellAlias(shellAliasGuard.repeat(2)), /Unsupported/);
});
