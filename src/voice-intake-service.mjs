import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ASR and directory scanning live outside the controller's event loop and DB connection.
export function startVoiceIntakeService(config, { spawnChild = spawn, onChange = () => {} } = {}) {
  if (!config.voice?.intake?.enabled) return { stop() {} };
  let child, stopped = false, retry, output = '';
  const logPath = path.join(config.projectRoot, 'logs/voice-intake.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const start = () => {
    if (stopped) return;
    child = spawnChild(process.execPath, [path.join(config.projectRoot, 'scripts/voice-intake.mjs'), '--parent', String(process.pid)],
      { cwd: config.projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const log = chunk => {
      try {
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > 4 * 1024 * 1024) {
          fs.rmSync(`${logPath}.previous`, { force: true });
          fs.renameSync(logPath, `${logPath}.previous`);
        }
        fs.appendFileSync(logPath, chunk);
      } catch { /* A log failure must not crash the controller. */ }
    };
    child.stderr?.on('data', log);
    child.stdout?.on('data', chunk => {
      log(chunk); output += chunk.toString();
      const lines = output.split('\n'); output = lines.pop().slice(-65536);
      for (const line of lines) {
        try { if (JSON.parse(line).result?.status === 'complete') onChange(); } catch { /* diagnostic text */ }
      }
    });
    child.on('error', error => log(`${new Date().toISOString()} ${error.message}\n`));
    child.once('close', () => { child = null; if (!stopped) retry = setTimeout(start, 30000); });
  };
  start();
  return { stop() {
    if (stopped) return;
    stopped = true; clearTimeout(retry);
    if (!child?.pid) return;
    // Windows kill of a parent alone leaves Python/ASR descendants alive.
    if (process.platform === 'win32') {
      const killer = spawnChild('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child?.kill());
    } else child.kill('SIGTERM');
  } };
}
