import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startVoiceIntakeService } from '../src/voice-intake-service.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-supervisor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const spawnChild = (...args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 999999; child.kill = () => { child.killed = true; };
    calls.push({ args, child }); return child;
  };
  return { root, calls, spawnChild, config: { projectRoot: root, voice: { intake: { enabled: true } } } };
}

test('disabled intake creates no process or files', t => {
  const f = fixture(t); f.config.voice.intake.enabled = false;
  startVoiceIntakeService(f.config, { spawnChild: f.spawnChild }).stop();
  assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('supervisor wakes only for complete receipts, rotates logs and stops its own process tree', t => {
  const f = fixture(t); let changes = 0;
  const service = startVoiceIntakeService(f.config, { spawnChild: f.spawnChild, onChange: () => changes++ });
  t.after(() => service.stop());
  const child = f.calls[0].child;
  assert.equal(f.calls[0].args[2].windowsHide, true);
  child.stdout.emit('data', Buffer.from('{"result":{"sta'));
  child.stdout.emit('data', Buffer.from('tus":"complete"}}\n{"result":{"status":"failed"}}\n'));
  assert.equal(changes, 1);
  const log = path.join(f.root, 'logs/voice-intake.log');
  fs.writeFileSync(log, Buffer.alloc(4 * 1024 * 1024 + 1));
  child.stderr.emit('data', Buffer.from('diagnostic\n'));
  assert.ok(fs.existsSync(`${log}.previous`)); assert.equal(fs.readFileSync(log, 'utf8'), 'diagnostic\n');
  service.stop();
  if (process.platform === 'win32') {
    assert.equal(f.calls[1].args[0], 'taskkill.exe');
    assert.deepEqual(f.calls[1].args[1], ['/PID', String(child.pid), '/T', '/F']);
  } else assert.equal(child.killed, true);
  child.emit('close');
});

test('unexpected exit restarts after backoff, explicit shutdown cancels restart', t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = startVoiceIntakeService(f.config, { spawnChild: f.spawnChild });
  f.calls[0].child.emit('close'); t.mock.timers.tick(29999); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1); assert.equal(f.calls.length, 2);
  f.calls[1].child.emit('close'); service.stop(); t.mock.timers.tick(60000);
  assert.equal(f.calls.length, 2);
});
