import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchCodexSessionRead(source) {
  if (source.includes('// shadow-bounded-codex-session-v1')) return source;
  const schema = 'const SessionReadParamsSchema = Type.Object({\n\tendpoint_id: Type.Optional(Type.String()),\n\tthread_id: Type.String(),\n\tinclude_turns: Type.Optional(Type.Boolean())\n}, { additionalProperties: false });';
  const description = 'description: "Read one Codex session transcript from app-server.",';
  const result = 'response: redactCodexSupervisionValue({ thread })';
  const normalized = source.replaceAll('\r\n', '\n');
  for (const expected of [schema, description, result]) {
    if (normalized.split(expected).length !== 2) throw new Error('Unsupported Codex plugin layout; refusing an unverified transcript boundary patch');
  }
  return '// shadow-bounded-codex-session-v1\nimport { boundCodexSession } from "./shadow-bounded-codex-session.mjs";\n'
    + normalized.replace(schema, schema.replace('\tinclude_turns: Type.Optional(Type.Boolean())', [
      '\tinclude_turns: Type.Optional(Type.Boolean()),',
      '\tturn_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),',
      '\tturn_offset: Type.Optional(Type.Integer({ minimum: 0 })),',
      '\titem_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),',
      '\titem_offset: Type.Optional(Type.Integer({ minimum: 0 })),',
      '\tmax_bytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: 32768 }))',
    ].join('\n')))
      .replace(description, 'description: "Read one Codex session with bounded transcript pages. include_turns=false reads metadata; true defaults to the latest 2 turns and 12 items per turn. turn_offset and item_offset count from newest. Use turn_limit=1 to page a long turn. Inspect transcriptWindow for omissions and next offsets.",')
      .replace(result, 'response: redactCodexSupervisionValue({ thread: boundCodexSession(thread, params) })');
}

export function applyCodexSessionReadBoundary(root) {
  const projects = path.join(root, 'runtime/openclaw-poc/state/npm/projects');
  const helper = fs.readFileSync(path.join(root, 'src/openclaw/bounded-codex-session.mjs'), 'utf8');
  const targets = fs.readdirSync(projects).filter(name => name.startsWith('openclaw-codex-'))
    .map(name => path.join(projects, name, 'node_modules/@openclaw/codex/dist/index.js')).filter(file => fs.existsSync(file));
  if (!targets.length) throw new Error('Managed Codex plugin is missing');
  const edits = targets.map(file => ({ file, original: fs.readFileSync(file, 'utf8') }));
  for (const edit of edits) edit.patched = patchCodexSessionRead(edit.original);
  for (const { file, original, patched } of edits) {
    fs.writeFileSync(path.join(path.dirname(file), 'shadow-bounded-codex-session.mjs'), helper);
    if (original !== patched) fs.writeFileSync(file, patched);
  }
  return { plugins: targets.length, boundary: 'shadow-bounded-codex-session-v1' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(applyCodexSessionReadBoundary(path.resolve(process.argv[2] ?? '.'))));
}
