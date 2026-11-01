import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { discoverVoiceInbox, processVoiceInboxOnce } from '../src/voice-inbox.mjs';

const { values } = parseArgs({ options: { once: { type: 'boolean' }, parent: { type: 'string' } } });
const config = loadConfig();
if (!config.voice?.intake?.enabled) throw new Error('Voice intake is disabled. Configure explicit local sources and since timestamps first.');
const store = openDatabase(config.paths.database);
let stopping = false, parentWatch;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
if (values.parent) {
  const pid = Number(values.parent);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid parent PID.');
  parentWatch = setInterval(() => {
    try { process.kill(pid, 0); } catch {
      stopping = true;
      clearInterval(parentWatch);
      if (process.platform === 'win32') {
        // Stop CPU/GPU descendants too; the durable job lease recovers on next launch.
        const killer = spawn('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => process.exit(1));
      } else process.exit(1);
    }
  }, 2000);
}
const lock = path.join(config.projectRoot, 'runtime/voice-intake.lock.json');
fs.mkdirSync(path.dirname(lock), { recursive: true });
if (fs.existsSync(lock)) {
  const old = JSON.parse(fs.readFileSync(lock, 'utf8'));
  let alive = false; try { process.kill(old.pid, 0); alive = true; } catch { /* stale owner */ }
  if (alive) throw new Error('Voice intake is already running.');
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
let previousErrors = '';
try {
  do {
    const discovery = discoverVoiceInbox(store, config);
    store.setSetting('voice:intake:status', JSON.stringify({ state: 'scanning', at: new Date().toISOString(), ...discovery }));
    const result = await processVoiceInboxOnce(store, config);
    const state = result?.status === 'failed' || discovery.errors.length ? 'attention' : result ? 'processed' : 'idle';
    store.setSetting('voice:intake:status', JSON.stringify({ state, at: new Date().toISOString(), ...discovery, result }));
    const errorSignature = JSON.stringify(discovery.errors);
    if (result || errorSignature !== previousErrors) console.log(JSON.stringify({ event: 'voice-intake', state, result, errors: discovery.errors }));
    previousErrors = errorSignature;
    if (!values.once && !stopping) await new Promise(resolve => setTimeout(resolve, result?.status === 'complete' ? 100 : 5000));
  } while (!values.once && !stopping);
} finally {
  clearInterval(parentWatch);
  store.setSetting('voice:intake:status', JSON.stringify({ state: 'offline', at: new Date().toISOString() }));
  store.close();
  if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock);
}
