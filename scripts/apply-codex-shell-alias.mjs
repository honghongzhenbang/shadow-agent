import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const shellAliasGuard = 'if (isCodexMemoryFlushRun(input.params) || input.nativeToolSurfaceEnabled !== true || input.sandbox?.enabled === true || !executionPolicy.nativeToolSurfaceAllowed || executionPolicy.effectiveExecHost !== "gateway") return filteredTools;';
const patchedGuard = '// shadow-restricted-shell-alias-v1\n\tconst restrictedHostShell = input.nativeToolSurfaceEnabled === false && shouldKeepOpenClawShellDynamicTools(input, executionPolicy);\n\tif (isCodexMemoryFlushRun(input.params) || (!restrictedHostShell && (input.nativeToolSurfaceEnabled !== true || !executionPolicy.nativeToolSurfaceAllowed)) || input.sandbox?.enabled === true || executionPolicy.effectiveExecHost !== "gateway") return filteredTools;';

// Reuse the upstream policy-filtered gateway_exec projection; never invent a new executor.
export function patchCodexShellAlias(source) {
  if (source.includes(patchedGuard)) return source;
  if (source.includes("shadow-restricted-shell-alias-v1") || source.split(shellAliasGuard).length !== 2) {
    throw new Error("Unsupported Codex shell projection layout; refusing an unverified patch");
  }
  return source.replace(shellAliasGuard, patchedGuard);
}

export function applyCodexShellAlias(root) {
  const projects = path.join(root, "runtime/openclaw-poc/state/npm/projects");
  const candidates = fs.readdirSync(projects).filter(name => name.startsWith("openclaw-codex-"))
    .map(name => path.join(projects, name, "node_modules/@openclaw/codex/dist"))
    .filter(dir => fs.existsSync(dir));
  if (candidates.length !== 1) throw new Error("Expected exactly one installed Codex plugin generation; resolve active generation before patching");
  const dir = candidates[0];
  const edits = fs.readdirSync(dir).filter(name => /^dynamic-tools-.*\.js$/.test(name))
    .map(name => ({ file: path.join(dir, name), source: fs.readFileSync(path.join(dir, name), "utf8") }))
    .filter(edit => edit.source.includes("function addGatewayShellDynamicToolsIfAvailable("));
  if (edits.length !== 1) throw new Error("Codex gateway shell projection not found unambiguously");
  const edit = edits[0];
  const patched = patchCodexShellAlias(edit.source);
  if (patched !== edit.source) {
    const backup = `${edit.file}.pre-shadow-shell-alias`;
    if (!fs.existsSync(backup)) fs.copyFileSync(edit.file, backup);
    fs.writeFileSync(edit.file, patched, "utf8");
  }
  return { changed: patched !== edit.source, file: edit.file, boundary: "shadow-restricted-shell-alias-v1" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(applyCodexShellAlias(path.resolve(process.argv[2] ?? "."))));
}
