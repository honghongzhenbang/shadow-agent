import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const run = args => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });

test('gateway discovery and stop reject another install or port without stopping real processes', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow gateway instance '));
  try {
    const result = JSON.parse(run(['-File', path.resolve('test/fixtures/gateway-instance-ownership.ps1'),
      '-Library', path.resolve('scripts/openclaw-gateway-lib.ps1'), '-Root', root]));
    assert.deepEqual(result, { passed: true, checks: 7, realProcessesStopped: 0 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('launch environment uses its own configured port and rejects invalid ports', {
  skip: process.platform !== 'win32',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow port config '));
  try {
    const script = path.join(root, 'scripts/openclaw-poc-env.ps1');
    for (const relative of ['scripts/openclaw-poc-env.ps1', 'tools/node-v24.19.0-win-x64/node.exe',
      'tools/openclaw-runtime/node_modules/.bin/openclaw.cmd', 'tools/openclaw-runtime/node_modules/openclaw/openclaw.mjs']) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    fs.copyFileSync('scripts/openclaw-poc-env.ps1', script);
    const config = path.join(root, 'runtime/openclaw-poc/state/openclaw.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const invoke = port => {
      fs.writeFileSync(config, JSON.stringify({ gateway: { port } }));
      return run(['-Command', `. '${script.replaceAll("'", "''")}'; Write-Output $OpenClawPort; Write-Output $env:OPENCLAW_GATEWAY_PORT`]).trim();
    };
    assert.equal(invoke(19173), '19173\r\n19173');
    assert.equal(invoke(undefined), '19011\r\n19011');
    for (const value of [0, 65536, -1, 'not-a-port', 19173.5]) assert.throws(() => invoke(value));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
