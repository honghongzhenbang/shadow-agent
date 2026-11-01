import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An additive read-plane field; no changes to upstream queueing or execution.
export function patchRunWaitPresence(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  const current = '// shadow-run-wait-presence-v2\n\t\t\t\trunKnown: context.chatAbortControllers.has(runId),';
  if (normalized.includes(current)) return source;
  if (normalized.includes('// shadow-run-wait-presence-v1')) {
    const legacy = /\/\/ shadow-run-wait-presence-v1\n\t{4}runKnown: (?:activeRunRegistered|context\.chatAbortControllers\.has\(runId\)),/g;
    if ([...normalized.matchAll(legacy)].length !== 1) throw new Error('Unsupported OpenClaw presence patch; refusing an unverified upgrade');
    return normalized.replace(legacy, current);
  }
  const anchor = '\t\t\t\ttimeoutPhase: activeRunRegistered ? "gateway_draining" : "queue",';
  if (normalized.split(anchor).length !== 2) throw new Error("Unsupported OpenClaw wait layout; refusing an unverified presence patch");
  return normalized.replace(anchor, `${anchor}\n\t\t\t\t${current}`);
}

export function applyRunWaitPresence(root) {
  const dir = path.join(root, "tools/openclaw-runtime/node_modules/openclaw/dist");
  const files = fs.readdirSync(dir).filter(name => /^principal-.*\.js$/.test(name));
  const edits = files.map(name => ({ file: path.join(dir, name), source: fs.readFileSync(path.join(dir, name), "utf8") }))
    .filter(item => item.source.includes("const waitForTurn = async (params) =>"));
  if (!edits.length) throw new Error("OpenClaw wait implementation not found");
  for (const edit of edits) edit.patched = patchRunWaitPresence(edit.source);
  for (const edit of edits) if (edit.source !== edit.patched) fs.writeFileSync(edit.file, edit.patched);
  return { patched: edits.length, boundary: "shadow-run-wait-presence-v2" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(applyRunWaitPresence(path.resolve(process.argv[2] ?? "."))));
}
