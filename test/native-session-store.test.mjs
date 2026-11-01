import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveNativeSessionDatabase, readNativeSessionId } from '../openclaw/shadow-work/src/native-session-store.mjs';

const sdkUrl = pathToFileURL(path.resolve('tools/openclaw-runtime/node_modules/openclaw/dist/plugin-sdk/session-store-paths.js')).href;

test('K4: host-native resolver honors default and custom stores, not workspace agentDir', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-native-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const base = { agents: { list: [{ id: 'main', agentDir: path.join(root, 'unrelated-workspace') }] } };
  const key = 'agent:main:subagent:owned-child';
  const resolve = config => resolveNativeSessionDatabase(config, key, { env, sdkUrl });
  assert.equal(await resolve(base), path.join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'));
  const explicit = path.join(root, 'custom', 'only.sqlite');
  assert.equal(await resolve({ ...base, session: { store: explicit } }), explicit);
  assert.equal(await resolve({ ...base, session: { store: path.join(root, 'custom', 'notes.json') } }), path.join(root, 'custom', 'notes.sqlite'));
  assert.equal(await resolve({ ...base, session: { store: path.join(root, 'custom', 'sessions.json') } }), path.join(root, 'custom', 'openclaw-agent.sqlite'));
  assert.deepEqual(fs.readdirSync(root), [], 'resolution must not initialize a database or write directories');
});

test('K4: current native incarnation is a live read, not either historical run', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-native-current-'));
  const filename = path.join(root, 'native.sqlite');
  const db = new DatabaseSync(filename);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY,current_session_id TEXT,entry_valid INTEGER,archived_at TEXT,entry_json TEXT)');
  const put = (id, entryId = id, valid = 1, archived = null) => db.prepare('INSERT OR REPLACE INTO session_nodes VALUES(?,?,?,?,?)')
    .run('child', id, valid, archived, JSON.stringify({ sessionId: entryId }));
  put('first'); assert.equal(readNativeSessionId(filename, 'child'), 'first');
  put('second'); assert.equal(readNativeSessionId(filename, 'child'), 'second');
  put('second', 'first'); assert.equal(readNativeSessionId(filename, 'child'), null);
  put('second', 'second', 0); assert.equal(readNativeSessionId(filename, 'child'), null);
  put('second', 'second', 1, 'archived'); assert.equal(readNativeSessionId(filename, 'child'), null);
  assert.equal(readNativeSessionId(filename, 'other'), null);
  assert.equal(readNativeSessionId(path.join(root, 'missing.sqlite'), 'child'), null);
  assert.equal(fs.existsSync(path.join(root, 'missing.sqlite')), false);
});
