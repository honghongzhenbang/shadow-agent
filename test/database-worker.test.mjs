import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseWorkerClient } from '../openclaw/shadow-work/src/database-worker-client.js';
const options = { workerUrl: new URL('./fixtures/database-worker-fixture.mjs', import.meta.url) };

test('context writer uses the same validated Node runtime as Gateway', () => {
  const source = fs.readFileSync(new URL('../scripts/start-context-service.ps1', import.meta.url), 'utf8');
  assert.match(source, /node-v24\.19\.0-win-x64/);
  assert.doesNotMatch(source, /Get-Command node/);
});

test('blocking database work does not block Gateway timers and preserves request order', async () => {
  const client = new DatabaseWorkerClient({}, options);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  try {
    const results = await Promise.all([client.call('slow', { id: 1 }), client.call('read', { id: 2 })]);
    assert.deepEqual(results, [{ id: 1 }, { id: 2 }]);
    assert.ok(ticks >= 5, `Expected responsive main event loop, observed ${ticks} ticks`);
  } finally { clearInterval(timer); await client.close(); }
});

test('worker crash rejects unknown outcomes without replaying a mutation', async () => {
  const client = new DatabaseWorkerClient({}, options);
  try {
    await assert.rejects(client.call('exit', {}), /outcome may require readback/);
    assert.deepEqual(await client.call('read', { recovered: true }), { recovered: true });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(client.call('read', {}, { signal: controller.signal }), /cancelled/);
  } finally { await client.close(); }
});
