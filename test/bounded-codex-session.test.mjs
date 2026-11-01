import test from 'node:test';
import assert from 'node:assert/strict';
import { boundCodexSession } from '../src/openclaw/bounded-codex-session.mjs';
import { patchCodexSessionRead } from '../scripts/apply-codex-session-read-boundary.mjs';

test('large transcript is bounded before redaction without altering the source', () => {
  const huge = 'z'.repeat(20_000_000);
  const thread = { id: 'thread', cwd: 'E:/project', turns: [
    { id: 'first', status: 'completed', items: [{ id: 'old', text: huge }] },
    { id: 'last', status: 'completed', items: Array.from({ length: 80 }, (_, i) => ({ id: String(i), type: 'agentMessage', text: i === 79 ? 'actual outcome' : huge })) },
  ] };
  const start = performance.now();
  const result = boundCodexSession(thread);
  assert.ok(performance.now() - start < 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384);
  assert.equal(result.turns.at(-1).items.at(-1).text, 'actual outcome');
  assert.equal(result.transcriptWindow.truncated, true);
  assert.equal(thread.turns[0].items[0].text.length, huge.length);
});

test('turn and item pagination are stable and preserve exact IDs', () => {
  const thread = { id: 't', turns: Array.from({ length: 6 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: Array.from({ length: 5 }, (_, j) => ({ id: `item-${j}`, text: 'ok' })) })) };
  const first = boundCodexSession(thread, { turn_limit: 1, item_limit: 2 });
  assert.deepEqual(first.turns[0].items.map(i => i.id), ['item-3', 'item-4']);
  assert.equal(first.transcriptWindow.nextTurnOffset, 1);
  assert.equal(first.transcriptWindow.items[0].nextItemOffset, 2);
  const next = boundCodexSession(thread, { turn_limit: 1, item_limit: 2, item_offset: 2 });
  assert.deepEqual(next.turns[0].items.map(i => i.id), ['item-1', 'item-2']);
  assert.equal(boundCodexSession(thread, { turn_limit: 1, turn_offset: 1 }).turns[0].id, 'turn-4');
});

test('UTF8, deep and cyclic input remain bounded and explicitly partial', () => {
  const item = { text: '\u4e2d'.repeat(50000) }; item.loop = item;
  const result = boundCodexSession({ id: 't', turns: [{ id: 'x', items: [item] }] }, { max_bytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  assert.equal(result.transcriptWindow.truncated, true);
});

test('runtime patch is idempotent, precedes redaction and rejects unknown layouts', () => {
  const fixture = 'const SessionReadParamsSchema = Type.Object({\n\tendpoint_id: Type.Optional(Type.String()),\n\tthread_id: Type.String(),\n\tinclude_turns: Type.Optional(Type.Boolean())\n}, { additionalProperties: false });\ndescription: "Read one Codex session transcript from app-server.",\nresponse: redactCodexSupervisionValue({ thread })';
  const patched = patchCodexSessionRead(fixture);
  assert.match(patched, /redactCodexSupervisionValue\(\{ thread: boundCodexSession\(thread, params\)/);
  assert.equal(patchCodexSessionRead(patched), patched);
  assert.throws(() => patchCodexSessionRead('unknown'), /Unsupported/);
});
