import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ShadowStore, openDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { ensureVoiceStorage } from '../src/voice-input.mjs';
import { copyHistoricalSpeakerIndex, importHistoricalRecording } from '../src/voice-history.mjs';

const { values } = parseArgs({ options: { report:{type:'string'}, database:{type:'string'},
  'runtime-root':{type:'string'}, 'speaker-index':{type:'string'}, apply:{type:'boolean'},
  'existing-schema':{type:'boolean'}, limit:{type:'string'}, receipt:{type:'string'} } });
if (!values.report || !values.database || !values['runtime-root'] || !values.receipt) throw new Error('Explicit report/database/runtime-root/receipt required.');
const report = JSON.parse(fs.readFileSync(values.report, 'utf8'));
const selected = report.records.filter(r=>r.status==='usable').slice(0, values.limit ? Number(values.limit) : undefined);
if (values.limit && (!Number.isSafeInteger(Number(values.limit)) || Number(values.limit)<1)) throw new Error('Invalid limit.');
const config = loadConfig();
config.voice = { ...config.voice, runtimeRoot:path.resolve(values['runtime-root']) };
if (!values.apply) {
  console.log(JSON.stringify({ dryRun:true, selected:selected.length, skipped:report.records.length-selected.length, database:values.database }));
} else {
  if (values['existing-schema'] && !fs.existsSync(values.database)) throw new Error('Existing database is missing.');
  // Existing-schema mode deliberately avoids application-wide migrations on a production import.
  const store = values['existing-schema'] ? new ShadowStore(new DatabaseSync(values.database)) : openDatabase(values.database);
  const receipt = { startedAt:new Date().toISOString(), database:path.resolve(values.database), root:report.root,
    recordings:[], errors:[], usesExistingAsr:true, startsAgent:false };
  fs.mkdirSync(path.dirname(path.resolve(values.receipt)), {recursive:true});
  const save = () => fs.writeFileSync(values.receipt, JSON.stringify(receipt,null,2));
  try {
    store.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
    ensureVoiceStorage(store);
    if (values['speaker-index']) receipt.acousticIndex = await copyHistoricalSpeakerIndex(values['speaker-index'], path.join(config.voice.runtimeRoot,'speaker-index.sqlite'));
    for (const row of selected) {
      try { receipt.recordings.push({ manifest:row.manifest, ...await importHistoricalRecording(store, config, report.root, row.manifest) }); }
      catch(e) { receipt.errors.push({manifest:row.manifest,error:e.message}); }
      if ((receipt.recordings.length+receipt.errors.length)%100===0) {
        save(); console.log(JSON.stringify({ imported:receipt.recordings.length, errors:receipt.errors.length }));
      }
    }
  } finally { receipt.finishedAt=new Date().toISOString(); save(); store.close(); }
  console.log(JSON.stringify({ imported:receipt.recordings.length, errors:receipt.errors.length, receipt:values.receipt }));
  if (receipt.errors.length) process.exitCode = 1;
}
