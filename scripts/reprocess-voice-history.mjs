import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ShadowStore } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { acceptVoiceTranscript, localTranscriptionCommand, voiceSettings, voiceTranscriptRevisionToken } from '../src/voice-input.mjs';

const { values } = parseArgs({ options: { apply: {type:'boolean'}, batch: {type:'string'}, limit: {type:'string'},
  'moss-python': {type:'string'}, 'moss-model-dir': {type:'string'}, 'moss-upstream': {type:'string'} } });
if (!values.batch) throw new Error('Explicit --batch directory required. Default is read-only inventory.');
const config = loadConfig();
config.voice = { ...config.voice, asrProvider: 'moss-local', fallback: 'none',
  mossPython: values['moss-python'], mossModelDir: values['moss-model-dir'], mossUpstream: values['moss-upstream'] };
const settings = voiceSettings(config);
const batch = path.resolve(values.batch), manifestPath = path.join(batch, 'manifest.private.json');
const statePath = path.join(batch, 'progress.private.json'), lockPath = path.join(batch, 'running.lock');
const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!(limit > 0 && (limit === Infinity || Number.isSafeInteger(limit)))) throw new Error('Invalid limit.');
const store = new ShadowStore(new DatabaseSync(config.paths.database, { readOnly: !values.apply }));
store.db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON');
const atomic = (file, data) => { fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(file + '.tmp', file); };
let worker, workerExit, lineReader, pending, ownsLock = false;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  let manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const candidates = manifest?.recordings ?? store.db.prepare(`SELECT id,content_hash,audio_path,duration_ms,recorded_at FROM voice_recordings
    WHERE status='ready' AND COALESCE(json_extract(metadata_json,'$.testOnly'),0)=0
      AND json_extract(metadata_json,'$.source')='historical_pc_capture'
    ORDER BY duration_ms DESC,recorded_at DESC,id`).all();
  if (!values.apply) {
    console.log(JSON.stringify({ dryRun: true, database: config.paths.database, recordings: candidates.length,
      hours: candidates.reduce((sum,r)=>sum+r.duration_ms,0)/3600000,
      missingAudio: candidates.filter(r=>!fs.existsSync(r.audio_path)).length,
      activeSamples: store.db.prepare('SELECT COUNT(*) n FROM voice_speaker_samples WHERE active=1').get().n }));
  } else {
    fs.mkdirSync(batch, {recursive:true});
    if (fs.existsSync(lockPath)) {
      const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (alive(old.pid)) throw new Error(`Batch already running (${old.pid}).`);
      fs.unlinkSync(lockPath);
    }
    fs.writeFileSync(lockPath, JSON.stringify({pid:process.pid}), {flag:'wx'}); ownsLock = true;
    if (manifest && (manifest.database !== config.paths.database || manifest.root !== settings.root)) throw new Error('Batch target changed.');
    const invocation = localTranscriptionCommand(config, candidates[0]?.audio_path ?? 'unused.wav', path.join(batch,'unused.json'));
    const workerArgs = invocation.args.map(arg => arg.endsWith('transcribe.py') ? path.join(config.projectRoot,'scripts/voice-runtime/history_worker.py') : arg);
    const sourceFiles = ['src/voice-input.mjs','src/voice-speaker-index.mjs','scripts/reprocess-voice-history.mjs',
      ...fs.readdirSync(path.join(config.projectRoot,'scripts/voice-runtime')).filter(f=>f.endsWith('.py')).map(f=>'scripts/voice-runtime/'+f)];
    const sourceHashes = Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(config.projectRoot,file))).digest('hex')]));
    const fingerprint = createHash('sha256').update(JSON.stringify([workerArgs, invocation.env, sourceHashes])).digest('hex');
    if (manifest && manifest.fingerprint !== fingerprint) throw new Error('Batch model/config changed; use a separate batch.');
    manifest ??= { database:config.paths.database, root:settings.root, startedAt:new Date().toISOString(),
      fingerprint, sourceHashes, recordings:candidates };
    if (!fs.existsSync(manifestPath)) atomic(manifestPath, manifest);
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
      startedAt:manifest.startedAt, total:candidates.length, results:[], errors:[] };
    const finished = new Set(state.results.map(r=>r.recordingId));
    const attempted = new Set([...finished, ...state.errors.map(r=>r.recordingId)]);
    const save = () => {
      state.updatedAt = new Date().toISOString(); state.completed = state.results.length;
      state.remaining = state.total - attempted.size;
      atomic(statePath, state);
    };
    const getWorker = () => {
      if (worker) return;
      worker = spawn(invocation.command, workerArgs, {cwd:config.projectRoot, env:{...process.env,...invocation.env}, windowsHide:true, stdio:['pipe','pipe','pipe']});
      workerExit = new Promise(resolve => worker.once('exit', (code,signal) => {
        pending?.reject(new Error(`History worker exited (${code}/${signal})`)); pending = null; resolve({code,signal});
      }));
      worker.once('error', error => { pending?.reject(error); pending = null; });
      worker.stderr.on('data', data => fs.appendFileSync(path.join(batch,'worker.stderr.log'),data));
      lineReader = createInterface({input:worker.stdout});
      lineReader.on('line', line => {
        if (!line.startsWith('HISTORY_RESULT ')) return;
        const reply = JSON.parse(line.slice(15));
        if (!pending || reply.recordingId !== pending.recordingId) return;
        const waiter = pending; pending = null; waiter.resolve(reply);
      });
    };
    state.status = 'running'; save();
    let processed = 0;
    for (const row of candidates) {
      if (attempted.has(row.id)) continue;
      if (processed >= limit || fs.existsSync(path.join(batch,'STOP'))) break;
      processed++;
      const outputPath = path.join(batch, row.id + '.json'), started = Date.now();
      state.current = {recordingId:row.id,durationMs:row.duration_ms,startedAt:new Date().toISOString()}; save();
      try {
        // Snapshot before inference: a user editing this recording wins over automatic replacement.
        const requestPath = path.join(batch, row.id + '.request.json');
        const request = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath,'utf8'))
          : { expectedToken:voiceTranscriptRevisionToken(store,row.id), audioSha256:row.content_hash };
        if (!fs.existsSync(requestPath)) atomic(requestPath,request);
        const expectedToken = request.expectedToken;
        if (!fs.existsSync(outputPath)) {
          getWorker();
          const reply = await new Promise((resolve,reject) => {
            pending = {recordingId:row.id,resolve,reject};
            worker.stdin.write(JSON.stringify({recordingId:row.id,audioPath:row.audio_path,
              audioSha256:row.content_hash,outputPath})+'\n', error=>{if(error) reject(error);});
          });
          if (!reply.ok) throw new Error(reply.error);
        }
        const envelope = JSON.parse(fs.readFileSync(outputPath,'utf8'));
        if (envelope.audioSha256 !== row.content_hash) throw new Error('Result audio mismatch.');
        if (envelope.result.partialResults?.some(p=>p.stopReason==='worker_error')) {
          throw new Error('Worker failure; saved partial result without replacing the previous transcript.');
        }
        const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(row.audio_path)) hash.update(chunk);
        if (hash.digest('hex') !== row.content_hash) throw new Error('Archived audio changed.');
        const accepted = acceptVoiceTranscript(store,config,row.id,envelope.result,
          {replacement:{expectedToken,audioSha256:row.content_hash}});
        state.results.push({recordingId:row.id,completion:envelope.result.completion,
          segments:envelope.result.segments.length,speakers:envelope.result.speakers.length,
          durationMs:row.duration_ms,elapsedMs:Date.now()-started,duplicate:accepted.duplicate});
        finished.add(row.id);
      } catch(error) {
        state.errors.push({recordingId:row.id,error:error.message,at:new Date().toISOString()});
        if (worker && worker.exitCode !== null) throw error;
      } finally { attempted.add(row.id); state.current=null; save(); }
    }
    state.status = state.remaining ? 'paused' : state.errors.length ? 'completed_with_errors' : 'completed'; save();
    console.log(JSON.stringify({status:state.status,total:state.total,completed:state.completed,remaining:state.remaining,errors:state.errors.length}));
  }
} finally {
  if (worker && worker.exitCode === null) { worker.stdin.end(JSON.stringify({stop:true})+'\n'); await workerExit; }
  lineReader?.close(); store.close();
  if (ownsLock) fs.unlinkSync(lockPath);
}
