import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { ShadowStore } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { createVoiceWindowController } from './voice-window.mjs';

// Annotation-only entry point: no daemon, microphone, Gateway, intake or model imports.
const config = loadConfig();
app.setPath('userData', path.join(config.projectRoot, 'runtime/voice/review-window'));
let store, controller;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => controller?.open());
app.whenReady().then(() => {
  if (!fs.existsSync(config.paths.database)) throw new Error('Import recordings before opening review.');
  const db = new DatabaseSync(config.paths.database);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  store = new ShadowStore(db);
  controller = createVoiceWindowController({ getStore: () => store, getConfig: () => config });
  controller.open();
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { controller?.dispose(); store?.close(); });
