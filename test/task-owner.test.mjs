import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { resolveTaskOwnerSession as legacyResolve } from '../src/agent-operations.mjs';
import { resolveTaskOwnerForDatabase, resolveTaskOwnerSession } from '../src/task-owner.mjs';
import { bindWorkSessionForDatabase, workSessionByKeyForDatabase, stableWorkSessionKey } from '../src/work-sessions.mjs';

const NOW = '2026-10-23T08:00:00.000Z';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shadow-task-owner-'));
  const file = path.join(root, 'context.sqlite');
  let store = openDatabase(file);
  t.after(() => {
    store.close();
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('shadow-task-owner-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { get store() { return store; }, get db() { return store.db; },
    restart() { store.close(); store = openDatabase(file); } };
}

test('legacy resolver is the same function re-exported from the light module', () => {
  assert.equal(legacyResolve, resolveTaskOwnerSession);
});

test('shared binding SQL preserves existing conflict, metadata, session and inactive-status semantics', t => {
  const f = fixture(t);
  const input = { provider: 'feishu', routeKey: 'im:owner', sessionKey: 'original-session', kind: 'conversation',
    generation: 7, contextEpoch: 'epoch-3', status: 'inactive', checkpointEvidenceId: 'original-checkpoint',
    eventAt: NOW, lastMessageId: 'message-1', metadata: { retained: true, replaced: 'old' } };
  const first = bindWorkSessionForDatabase(f.db, input);
  assert.deepEqual(first, f.store.workSessionByKey(first.session_key));
  assert.deepEqual(first, f.store.bindWorkSession(input));
  const replay = f.store.bindWorkSession({ ...input, sessionKey: 'must-not-rebind', generation: 99,
    contextEpoch: 'must-not-replace', status: 'active', checkpointEvidenceId: 'must-not-overwrite',
    kind: 'task', taskId: 'card-1', lastMessageId: null, metadata: { replaced: 'new', added: 1 } });
  assert.equal(replay.session_key, first.session_key);
  assert.equal(replay.generation, 7);
  assert.equal(replay.context_epoch, 'epoch-3');
  assert.equal(replay.status, 'inactive');
  assert.equal(replay.checkpoint_evidence_id, 'original-checkpoint');
  assert.equal(replay.last_message_id, 'message-1');
  assert.equal(replay.session_kind, 'task');
  assert.equal(replay.task_id, 'card-1');
  assert.deepEqual(JSON.parse(replay.metadata_json), { retained: true, replaced: 'new', added: 1 });
  f.restart();
  assert.deepEqual(workSessionByKeyForDatabase(f.db, first.session_key), replay);
  assert.equal(workSessionByKeyForDatabase(f.db, 'missing-session'), null);
});

test('raw binding defaults and malformed legacy metadata retain the previous DB behavior', t => {
  const f = fixture(t), input = { provider: 'test', conversationKey: 'legacy-route', eventAt: NOW };
  const first = f.store.bindWorkSession(input);
  assert.match(first.session_key, /^agent:main:external:/);
  assert.equal(first.session_kind, 'conversation');
  f.db.prepare('UPDATE conversation_bindings SET metadata_json=? WHERE id=?').run('{broken', first.id);
  const updated = bindWorkSessionForDatabase(f.db, { ...input, metadata: { recovered: true } });
  assert.equal(updated.id, first.id);
  assert.deepEqual(JSON.parse(updated.metadata_json), { recovered: true });
});

test('database-only facade preserves dedicated owner identity, revisions and source references across restart', t => {
  const f = fixture(t);
  const source = f.store.upsertSource({ sourceKey: 'owner-source', kind: 'feishu', uri: 'test:owner' });
  const evidence = f.store.addEvidence({ sourceId: source.id, kind: 'feishu_message', externalId: 'message_owner',
    title: 'Owner evidence', sourceLocator: 'test:owner:message',
    content: 'Original source input.', projectKey: 'project-a', occurredAt: NOW,
    metadata: { conversationKey: 'im:source-chat' } });
  const card = { id: 'task-a', title: 'Original task', notes: 'feishu://message/message_owner' };
  const originalCard = structuredClone(card);
  const first = legacyResolve(f.store, card);
  assert.equal(first.sourceConversationKey, 'im:source-chat');
  assert.equal(first.projectKey, 'project-a');
  assert.equal(first.sessionKey, stableWorkSessionKey('task', 'shadow-task', card.id));
  const second = resolveTaskOwnerForDatabase(f.db, card, { evidenceIds: [evidence.id] });
  assert.equal(second.sessionKey, first.sessionKey);
  assert.equal(second.attention.binding_revision, first.attention.binding_revision);
  assert.deepEqual(card, originalCard);
  f.restart();
  const third = resolveTaskOwnerForDatabase(f.db, card, { sourceConversationKey: 'im:revised-reference' });
  assert.equal(third.sessionKey, first.sessionKey);
  assert.equal(third.sourceConversationKey, 'im:revised-reference');
  assert.equal(third.attention.binding_revision, first.attention.binding_revision + 1);
  assert.equal(third.projectKey, 'project-a');
});

test('database facade does not initialize schema or commit an enclosing transaction', t => {
  const f = fixture(t);
  const schema = f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
  f.db.exec('BEGIN');
  const result = resolveTaskOwnerForDatabase(f.db, { id: 'rolled-back-card' });
  assert.ok(f.store.workSessionByKey(result.sessionKey));
  f.db.exec('ROLLBACK');
  assert.equal(f.store.workSessionByKey(result.sessionKey), null);
  assert.equal(f.db.prepare('SELECT * FROM work_task_attention WHERE card_id=?').get('rolled-back-card'), undefined);
  assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), schema);
  assert.throws(() => resolveTaskOwnerForDatabase(f.db, {}), /card id is required/);
});
