import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const marker = '// shadow-codex-route-context-v1';
const header = `${marker}\nimport { bindCodexRouteHandlers } from "./shadow-codex-route-context.mjs";\n`;
const original = '\t\troute.handlers = handlers;';
const replacement = '\t\troute.handlers = bindCodexRouteHandlers(handlers);';
const count = (source, text) => source.split(text).length - 1;

export function patchCodexRouteContext(source) {
  const text = source.replaceAll('\r\n', '\n');
  const patched = text.startsWith(header);
  const body = patched ? text.slice(header.length) : text;
  const assignment = patched ? replacement : original;
  const activation = body.match(/activateNow\(route, handlers\) \{\n([\s\S]*?)\n\t?\}/)?.[1];
  if (count(body, 'activateNow(route, handlers) {') !== 1
    || !activation || count(activation, assignment) !== 1 || count(body, assignment) !== 1
    || count(body, patched ? original : replacement) !== 0
    || count(body, marker) !== 0
    || count(body, 'bindCodexRouteHandlers') !== (patched ? 1 : 0)) {
    throw new Error('Unsupported Codex route activation layout; refusing an unverified context patch');
  }
  return patched ? text : header + body.replace(original, replacement);
}

function contained(root, file) {
  const real = fs.realpathSync(file);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Codex route patch path escapes the selected root');
  }
  return real;
}

export function applyCodexRouteContext(root) {
  const base = fs.realpathSync(path.resolve(root));
  const projects = contained(base, path.join(base, 'runtime/openclaw-poc/state/npm/projects'));
  const helper = fs.readFileSync(contained(base, path.join(base, 'src/openclaw/codex-route-context.mjs')));
  const edits = [];
  for (const name of fs.readdirSync(projects).filter(name => name.startsWith('openclaw-codex-'))) {
    const distPath = path.join(projects, name, 'node_modules/@openclaw/codex/dist');
    if (!fs.existsSync(distPath)) continue;
    const dist = contained(base, distPath);
    const files = fs.readdirSync(dist).filter(file => /^attempt-client-cleanup-.*\.js$/.test(file));
    if (files.length !== 1) throw new Error('Expected one managed Codex route module');
    const file = contained(base, path.join(dist, files[0]));
    const helperTarget = path.join(dist, 'shadow-codex-route-context.mjs');
    if (fs.lstatSync(helperTarget, { throwIfNoEntry: false })) contained(base, helperTarget);
    const before = fs.readFileSync(file, 'utf8');
    edits.push({ file, helperTarget, before, after: patchCodexRouteContext(before) });
  }
  if (!edits.length) throw new Error('Managed Codex plugin is missing');
  // Validate every generation before writing any of them. No lifecycle state or
  // running process is changed here; callers must install into an offline root.
  for (const edit of edits) {
    fs.writeFileSync(edit.helperTarget, helper);
    if (edit.before !== edit.after) fs.writeFileSync(edit.file, edit.after);
  }
  return { plugins: edits.length, changed: edits.filter(edit => edit.before !== edit.after).length,
    boundary: marker.slice(3), helperSha256: createHash('sha256').update(helper).digest('hex') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('An explicit offline installation root is required');
  console.log(JSON.stringify(applyCodexRouteContext(process.argv[2])));
}
