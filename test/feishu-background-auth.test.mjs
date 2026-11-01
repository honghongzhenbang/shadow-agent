import assert from 'node:assert/strict';
import test from 'node:test';
import { authArgs, publicAuthStatus, runAuthOperation } from '../scripts/feishu-background-auth.mjs';
const result = value => ({ stdout: JSON.stringify(value), stderr: '' });

test('background auth requires explicit scopes and uses argument arrays', () => {
  assert.throws(() => authArgs({ mode: 'login' }), /scopes/);
  assert.throws(() => authArgs({ mode: 'login', scopes: 'im;logout' }), /scopes/);
  assert.throws(() => authArgs({ mode: 'logout' }), /Unsupported/);
  assert.deepEqual(authArgs({ mode: 'login', scopes: 'search:message offline_access' }),
    ['auth', 'login', '--scope', 'search:message offline_access', '--no-wait', '--json']);
});

test('auth output allowlist never returns access tokens, refresh tokens or raw error output', async () => {
  const payload = { access_token: 'secret', identities: { user: { status: 'ready', refresh_token: 'secret' } } };
  assert.equal(JSON.stringify(publicAuthStatus(payload)).includes('secret'), false);
  const failed = await runAuthOperation({ mode: 'status' }, { config: {}, runLark: async () => {
    throw Object.assign(new Error('secret'), { result: { stderr: JSON.stringify({ error: { type: 'authentication', subtype: 'token_missing', message: 'secret', hint: 'secret' } }) } });
  } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.subtype, 'token_missing');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  const unknown = await runAuthOperation({ mode: 'status' }, { config: {}, runLark: async () => { throw new Error('secret'); } });
  assert.equal(JSON.stringify(unknown).includes('secret'), false);
});

test('background completion verifies identity again and does not infer authorization from login exit', async () => {
  const calls = [];
  const answer = await runAuthOperation({ mode: 'complete', deviceCode: 'current-challenge' }, { config: {}, runLark: async (_config, args) => {
    calls.push(args);
    return result(args[1] === 'login' ? { ok: true } : { identities: { user: { status: 'missing' } } });
  } });
  assert.equal(answer.ok, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['auth', 'status', '--json', '--verify']);
});

test('background probe proves a real user message read without returning conversation content', async () => {
  const start = authArgs({ mode: 'probe' }).find(arg => arg.startsWith('--start=')).slice('--start='.length);
  assert.match(start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.ok(Math.abs(Date.parse(start) - (Date.now() - 86_400_000)) < 2_000);
  const answer = await runAuthOperation({ mode: 'probe' }, { config: {}, runLark: async () => result({ ok: true, identity: 'user', data: { messages: [{ content: 'private' }], has_more: false } }) });
  assert.equal(answer.ok, true);
  assert.equal(answer.messages, 1);
  assert.equal(JSON.stringify(answer).includes('private'), false);
});

test('login challenge keeps opaque URL intact without returning token fields', async () => {
  const verification_url = 'https://example.invalid/authorize?opaque=a%2Bb';
  const answer = await runAuthOperation({ mode: 'login', scopes: 'search:message' }, { config: {}, runLark: async () => result({
    device_code: 'current-device', verification_url, expires_in: 300, access_token: 'secret', refresh_token: 'secret',
  }) });
  assert.equal(answer.verification_url, verification_url);
  assert.equal(answer.device_code, 'current-device');
  assert.equal(JSON.stringify(answer).includes('secret'), false);
});
