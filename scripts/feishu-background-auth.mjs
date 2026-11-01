import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { runLarkCommand } from '../src/collectors/feishu.mjs';
import { parseJsonLoose } from '../src/utils.mjs';

export function authArgs(input) {
  if (input.mode === 'status') return ['auth', 'status', '--json', '--verify'];
  if (input.mode === 'login') {
    const scopes = String(input.scopes || '').trim();
    if (!scopes || !/^[a-zA-Z0-9_:. ,\-]+$/.test(scopes)) throw new Error('Explicit scopes are required');
    return ['auth', 'login', '--scope', scopes, '--no-wait', '--json'];
  }
  if (input.mode === 'complete') {
    if (!input.deviceCode || typeof input.deviceCode !== 'string') throw new Error('A current device code is required');
    return ['auth', 'login', '--device-code', input.deviceCode, '--json'];
  }
  if (input.mode === 'probe') {
    // Match the collector: this CLI/API combination rejects Unix-second search dates.
    const start = `${new Date(Date.now() - 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
    return ['im', '+messages-search', '--query=', `--start=${start}`, '--page-size=1', '--no-reactions', '--as=user', '--format=json'];
  }
  throw new Error('Unsupported authentication operation');
}

export function publicAuthStatus(payload) {
  const user = payload.identities?.user || {};
  return {
    userReady: user.status === 'ready' && user.verified !== false && payload.verified !== false,
    identity: payload.identity, verified: payload.verified, appId: payload.appId,
    user: Object.fromEntries(['status', 'available', 'verified', 'openId', 'userName', 'tokenStatus', 'expiresAt', 'refreshExpiresAt']
      .filter(key => user[key] !== undefined).map(key => [key, user[key]])),
  };
}

export async function runAuthOperation(input, { config = loadConfig(), runLark = runLarkCommand } = {}) {
  try {
    const result = await runLark(config, authArgs(input), { timeoutMs: input.mode === 'complete' ? 300_000 : 60_000 });
    const payload = parseJsonLoose(result.stdout || result.stderr);
    if (input.mode === 'login') {
      const data = payload.data || payload;
      if (!data.device_code || !data.verification_url) throw new Error('CLI returned no device authorization challenge');
      // Only this short-lived challenge crosses the boundary; never stored access/refresh tokens.
      return { ok: true, mode: input.mode, device_code: data.device_code, verification_url: data.verification_url,
        expires_in: data.expires_in, interval: data.interval };
    }
    if (input.mode === 'complete') {
      const verified = await runLark(config, authArgs({ mode: 'status' }), { timeoutMs: 60_000 });
      const status = publicAuthStatus(parseJsonLoose(verified.stdout || verified.stderr));
      return { ok: status.userReady,
        mode: input.mode, ...status };
    }
    if (input.mode === 'probe') {
      const data = payload.data || payload;
      if (payload.ok === false || payload.identity !== 'user' || !Array.isArray(data.messages)) throw new Error('CLI returned no verifiable user message page');
      return { ok: true, mode: input.mode, identity: payload.identity, messages: data.messages.length, hasMore: data.has_more };
    }
    return { ok: true, mode: input.mode, ...publicAuthStatus(payload) };
  } catch (error) {
    let detail;
    try { detail = parseJsonLoose(error.result?.stderr || error.result?.stdout || '').error; } catch { /* use bounded generic error */ }
    return { ok: false, mode: input.mode, error: detail
      ? { type: detail.type, subtype: detail.subtype, code: detail.code, missingScopes: detail.missing_scopes }
      : { type: 'execution', message: 'Unable to verify CLI operation; no credential output retained' } };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputPath = path.resolve(process.argv[2]);
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  fs.unlinkSync(inputPath);
  const result = await runAuthOperation(input);
  const temporaryOutput = path.join(path.dirname(inputPath), 'result.tmp');
  fs.writeFileSync(temporaryOutput, JSON.stringify(result));
  fs.renameSync(temporaryOutput, path.join(path.dirname(inputPath), 'result.json'));
  process.exitCode = result.ok ? 0 : 1;
}
