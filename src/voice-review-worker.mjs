import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { readVoiceReviewTranscript, voiceGroupState } from './voice-enrollment.mjs';
import { buildVoiceReview } from './voice-review-model.mjs';

const db = new DatabaseSync(workerData.database, { readOnly: true });
db.exec('PRAGMA busy_timeout=5000');
const config = { projectRoot: workerData.projectRoot, voice: { runtimeRoot: workerData.root } };
const cache = new Map(), matchCache = new Map();
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let latest = 0, running = false, pending, lastVersion = null, lastFingerprint = null, lastSampleVersion = null;
let samples = [];
const metrics = { builds: 0, fileReads: 0, cacheHits: 0, unreadableFiles: 0 };

function dataVersion() { return db.prepare('PRAGMA data_version').get().data_version; }
function normalize(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 4096 || values.some(x => !Number.isFinite(x))) return null;
  const norm = Math.hypot(...values);
  return norm ? values.map(x => x / norm) : null;
}
function inputSnapshot() {
  db.exec('BEGIN');
  try {
    const recordings = db.prepare("SELECT id,recorded_at,transcript_path,updated_at,content_hash FROM voice_recordings WHERE status='ready' ORDER BY recorded_at DESC,id").all();
    const rows = db.prepare(`SELECT s.*,substr(e.content,1,160) AS excerpt,e.metadata_json,p.name AS person_name,
      p.status AS person_status FROM voice_segments s JOIN evidence e ON e.id=s.evidence_id
      LEFT JOIN graph_entities p ON p.id=json_extract(e.metadata_json,'$.voice.personId') AND p.type='Person'
      ORDER BY s.recording_id,s.speaker_label,s.start_ms,s.segment_id`).all();
    const samples = db.prepare(`SELECT s.id,s.person_id AS personId,p.name AS personName,s.embedding_model AS embeddingModel,
      s.embedding_json,s.evidence_id FROM voice_speaker_samples s JOIN graph_entities p ON p.id=s.person_id
      WHERE s.active=1 AND p.type='Person' AND p.status='active' ORDER BY s.id`).all();
    let taskLinks = [];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='information_deliveries'").get()) {
      taskLinks = db.prepare(`SELECT DISTINCT json_extract(e.metadata_json,'$.voice.recordingId') AS recordingId,
        json_extract(e.metadata_json,'$.voice.speakerLabel') AS speakerLabel,d.task_id
        FROM information_deliveries d JOIN evidence e ON e.id=d.evidence_id
        WHERE d.purpose='task_progress_due' AND d.task_id IS NOT NULL AND e.kind='voice_transcript'
        ORDER BY recordingId,speakerLabel,d.task_id`).all();
    }
    const fingerprint = hash([recordings, rows.map(r => [r.evidence_id,r.revision,r.person_name,r.person_status]), samples, taskLinks]);
    db.exec('COMMIT');
    return { recordings, rows, samples, taskLinks, fingerprint };
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}

async function build({ epoch, force }) {
  const begin = performance.now(), initialVersion = dataVersion();
  if (!force && lastVersion === initialVersion) return parentPort.postMessage({ type:'unchanged', epoch });
  const input = inputSnapshot();
  if (!force && input.fingerprint === lastFingerprint) {
    lastVersion = initialVersion;
    return parentPort.postMessage({ type:'unchanged', epoch });
  }
  parentPort.postMessage({ type:'progress', epoch, progress:{loaded:0,total:input.recordings.length} });
  const records = new Map(input.recordings.map(r => [r.id,r]));
  const taskMap = new Map();
  for (const link of input.taskLinks) {
    const key=JSON.stringify([link.recordingId,link.speakerLabel]);
    if (!taskMap.has(key)) taskMap.set(key,new Set());
    taskMap.get(key).add(link.task_id);
  }
  const grouped = new Map();
  for (const row of input.rows) {
    if (!records.has(row.recording_id)) continue;
    const key = JSON.stringify([row.recording_id,row.speaker_label]);
    if (!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(row);
  }
  const failed = new Set();
  let loaded = 0;
  for (const record of input.recordings) {
    if (epoch !== latest) return;
    const stamp = hash([record.transcript_path,record.content_hash,record.updated_at]);
    let item = cache.get(record.id);
    let fileStamp;
    try {
      if (force || !item || item.stamp !== stamp) {
        const stat = fs.statSync(record.transcript_path);
        fileStamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      }
      if (!item || item.stamp !== stamp || (fileStamp !== undefined && item.fileStamp !== fileStamp)) {
        const transcript = readVoiceReviewTranscript(workerData.root, record, config);
        const speakers = new Map((transcript.speakers ?? []).map(s => [s.label, {
          embedding:normalize(s.embedding), embeddingModel:s.embeddingModel ?? transcript.embeddingModel,
          speechMs:s.speechDurationMs ?? transcript.segments.filter(x => x.speakerLabel === s.label)
            .reduce((n,x) => n+x.endMs-x.startMs,0),
        }]));
        item = { stamp, fileStamp, speakers };
        cache.set(record.id,item);metrics.fileReads++;
      } else metrics.cacheHits++;
    } catch { cache.delete(record.id); failed.add(record.id); }
    loaded++;
    if (loaded % 50 === 0 || loaded === input.recordings.length) {
      parentPort.postMessage({ type:'progress', epoch, progress:{loaded,total:input.recordings.length} });
      await yieldTurn();
    }
  }
  for (const id of cache.keys()) if (!records.has(id)) cache.delete(id);
  const groups = [];
  for (const [key,rows] of grouped) {
    const record = records.get(rows[0].recording_id), label = rows[0].speaker_label;
    const state = voiceGroupState(record,label,rows);
    const voice = rows.map(r => parse(r.metadata_json).voice ?? {});
    const confirmedIds = [...new Set(voice.filter(v => v.identityStatus==='confirmed' && v.personId).map(v => v.personId))];
    const stableIds = [...new Set(voice.map(v => v.stableVoiceId).filter(Boolean))];
    const acoustic = cache.get(record.id)?.speakers.get(label);
    const tasks = taskMap.get(key)??new Set();
    groups.push({ key,recordingId:record.id,speakerLabel:label,recordedAt:record.recorded_at,
      stableVoiceId:stableIds.length===1?stableIds[0]:null,...state,confirmedPersonIds:confirmedIds,
      personActive:!state.personId||rows.every(r=>r.person_status==='active'),
      partialConfirmation:!state.personId && confirmedIds.length>0,segmentCount:rows.length,
      speechMs:acoustic?.speechMs ?? rows.reduce((n,r)=>n+r.end_ms-r.start_ms,0),
      excerpt:rows.map(r=>r.excerpt).join(' ').slice(0,160),embedding:acoustic?.embedding??null,
      embeddingModel:acoustic?.embeddingModel??null,taskCount:tasks.size });
  }
  const sampleVersion = hash(input.samples);
  if (sampleVersion !== lastSampleVersion) {
    matchCache.clear(); lastSampleVersion = sampleVersion;
    samples = input.samples.map(s => ({ personId:s.personId,personName:s.personName,embeddingModel:s.embeddingModel,
      embedding:normalize(parse(s.embedding_json)) })).filter(s=>s.embedding);
  }
  const result = buildVoiceReview(groups,samples,{...workerData.matching,matchCache,sampleVersion});
  // A concurrent annotation invalidates this entire view. Never publish a mixed revision.
  if (epoch !== latest) return;
  if (dataVersion() !== initialVersion && inputSnapshot().fingerprint !== input.fingerprint) {
    parentPort.postMessage({ type:'stale', epoch });return;
  }
  lastVersion = initialVersion;lastFingerprint = input.fingerprint;metrics.builds++;metrics.unreadableFiles=failed.size;
  const publicGroups = groups.map(g => ({ key:g.key,recordingId:g.recordingId,speakerLabel:g.speakerLabel,
    recordedAt:g.recordedAt,stableVoiceId:g.stableVoiceId,personId:g.personId,personName:g.personName,
    segmentCount:g.segmentCount,excerpt:g.excerpt,assignment:result.assignments[g.key] }));
  parentPort.postMessage({ type:'ready',epoch,revision:hash([input.fingerprint,sampleVersion,groups.map(g=>[g.key,g.embedding])]),
    payload:{buckets:result.buckets,recommended:result.recommended,counts:result.counts,groups:publicGroups},
    metrics:{...metrics,buildMs:performance.now()-begin,matchCacheEntries:matchCache.size},progress:{loaded,total:input.recordings.length} });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const job=pending;pending=null;
      try { await build(job); }
      catch { parentPort.postMessage({type:'failure',epoch:job.epoch,error:'声音匹配暂不可用，请刷新重试。'}); }
    }
  } finally { running=false; }
}
parentPort.on('message',message=>{
  if (message.type!=='refresh')return;
  latest=message.epoch;pending=message;void drain();
});
