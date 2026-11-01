import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.mjs';
import { inspectHistoricalRecording, importHistoricalRecording, copyHistoricalSpeakerIndex } from '../src/voice-history.mjs';
import { associateSpeakers, voiceSourceKey } from '../src/voice-speaker-index.mjs';
import { annotateVoiceSpeaker, correctVoiceSegment, registerVoicePerson } from '../src/voice-input.mjs';
import { discoverVoiceInbox, processVoiceInboxOnce } from '../src/voice-inbox.mjs';
import { dispatchInformation } from '../src/information-delivery.mjs';
import { bindTaskSession } from '../src/work-sessions.mjs';
import { appendChangeEvidence, recordEvidenceDelivery, nextEvidencePage } from '../src/context-delivery.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-history-')), capture=path.join(root,'capture');
  fs.mkdirSync(capture);
  const store=openDatabase(path.join(root,'test.sqlite'));
  const config={projectRoot:root,voice:{runtimeRoot:'voice',debounceSeconds:0,intake:{sources:[{path:capture,since:'2000-01-01T00:00:00Z'}]}}};
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const wav=Buffer.alloc(44+32000*3);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);
  wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  fs.writeFileSync(path.join(capture,'audio.wav'),wav);
  const sha256=createHash('sha256').update(wav).digest('hex');
  const manifest={kind:'voice-audio-file',deviceId:'pc-test',recordingId:'recording-one',conversationId:'original-session',
    recordedAt:'2026-10-19T01:00:00+00:00',durationMs:3000,sampleRateHz:16000,sampleCount:48000,channels:1,
    sha256,audioPath:'audio.wav',testOnly:false};
  const transcript={schemaVersion:1,durationMs:3000,audio:{sampleRateHz:16000,sampleCount:48000,channels:1},
    engine:'synthetic-mechanism-only',model:'fixture',segments:[{id:'s1',startMs:0,endMs:3000,speakerLabel:'speaker_00',text:'Original observation.'}],
    speakers:[{label:'speaker_00',embeddingModel:'test',embedding:[1,0,0]}]};
  const file=path.join(capture,'audio.wav.manifest.json');
  const save=()=>{fs.writeFileSync(file,JSON.stringify(manifest));fs.writeFileSync(path.join(capture,'transcript.json'),JSON.stringify({schemaVersion:1,audioSha256:sha256,result:transcript}));};
  save();
  return {root,capture,store,config,manifest,transcript,file,save,count:table=>store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n};
}

test('historical import reuses ASR, time, acoustic identity and original ID across replay/intake',async t=>{
  const f=fixture(t), sourceIndex=path.join(f.root,'old-speakers.sqlite');
  const original=associateSpeakers(sourceIndex,{sourceKey:voiceSourceKey(f.manifest.deviceId,f.manifest.recordingId),audioSha256:f.manifest.sha256,transcript:f.transcript});
  await copyHistoricalSpeakerIndex(sourceIndex,path.join(f.root,'voice/speaker-index.sqlite'));
  await assert.rejects(copyHistoricalSpeakerIndex(sourceIndex,path.join(f.root,'voice/speaker-index.sqlite')),/overwrite/);
  const first=await importHistoricalRecording(f.store,f.config,f.capture,f.file);
  assert.equal(first.evidenceIds.length,1);
  const e=f.store.db.prepare('SELECT * FROM evidence WHERE id=?').get(first.evidenceIds[0]);
  assert.equal(e.occurred_at,'2026-10-19T01:00:00.000Z');
  assert.equal(JSON.parse(e.metadata_json).voice.stableVoiceId,original.speakers[0].voiceId);
  assert.equal(JSON.parse(e.metadata_json).voice.identityStatus,'unknown');
  const before=f.count('evidence');
  assert.equal((await importHistoricalRecording(f.store,f.config,f.capture,f.file)).duplicate,true);
  assert.equal(f.count('evidence'),before);
  assert.equal(discoverVoiceInbox(f.store,f.config).errors.length,0);
  const result=await processVoiceInboxOnce(f.store,f.config,{transcribe:async(s,c,id)=>{
    assert.equal(id,first.recordingId);
    return {recordingId:id,duplicate:true,evidenceIds:[]};
  }});
  assert.equal(result.status,'complete');assert.equal(f.count('voice_recordings'),1);
  assert.equal(f.count('graph_facts'),0);assert.equal(f.count('tasks'),0);
});

test('broken audio, time, transcript and test fixtures cannot masquerade as usable history',async t=>{
  for(const error of ['time','hash','duration','test','path']) await t.test(error,async t=>{
    const f=fixture(t);
    if(error==='time')f.manifest.recordedAt='2026-10-19T01:00:00';
    if(error==='duration')f.transcript.durationMs=4000;
    if(error==='test')f.manifest.testOnly=true;
    if(error==='path') {fs.copyFileSync(path.join(f.capture,'audio.wav'),path.join(f.root,'outside.wav'));f.manifest.audioPath='../outside.wav';}
    f.save();if(error==='hash')fs.appendFileSync(path.join(f.capture,'audio.wav'),'changed');
    await assert.rejects(importHistoricalRecording(f.store,f.config,f.capture,f.file));
    assert.equal(f.count('evidence'),0);
  });
});

test('import CLI is dry-run by default and returns failure for rejected historical records', t => {
  const f=fixture(t), report=path.join(f.root,'audit.json'), receipt=path.join(f.root,'receipt.json'), database=path.join(f.root,'cli.sqlite');
  f.manifest.testOnly=true;f.save();
  fs.writeFileSync(report,JSON.stringify({root:f.capture,records:[{status:'usable',manifest:f.file}]}));
  const script=fileURLToPath(new URL('../scripts/import-voice-history.mjs',import.meta.url));
  const args=[script,'--report',report,'--database',database,'--runtime-root',path.join(f.root,'cli-voice'),'--receipt',receipt];
  const dry=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(dry.status,0,dry.stderr);assert.equal(fs.existsSync(database),false);
  const apply=spawnSync(process.execPath,[...args,'--apply'],{encoding:'utf8'});
  assert.equal(apply.status,1,apply.stderr);
  const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
  assert.equal(result.errors.length,1);assert.equal(result.recordings.length,0);
});

test('voice corrections stay immutable and can dispatch identical evidence to task and curator without duplicate facts',async t=>{
  const f=fixture(t), imported=await importHistoricalRecording(f.store,f.config,f.capture,f.file);
  const person=registerVoicePerson(f.store,{key:'fixture-person',name:'Fixture Person'});
  annotateVoiceSpeaker(f.store,f.config,{recordingId:imported.recordingId,speakerLabel:'speaker_00',personId:person.id});
  const correction=correctVoiceSegment(f.store,f.config,{recordingId:imported.recordingId,segmentId:'s1',text:'Corrected observation.',reason:'Listening review'});
  assert.equal(f.store.db.prepare('SELECT content FROM evidence WHERE id=?').get(imported.evidenceIds[0]).content,'Original observation.');
  const source=f.store.db.prepare("SELECT * FROM context_changes WHERE status='pending' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(source.metadata_json).requiresResponsibilityRecheck,true);
  f.store.db.prepare("UPDATE context_changes SET status='leased',lease_owner='source-test',lease_until='2099-01-01T00:00:00Z' WHERE seq=?").run(source.seq);
  appendChangeEvidence(f.store.db,source.seq,correction.evidenceIds);
  recordEvidenceDelivery(f.store.db,source.seq,'source-test',nextEvidencePage(f.store.db,source.seq));
  const binding=bindTaskSession(f.store,{id:'voice-related-task'});
  const args={sourceChangeSeq:source.seq,sessionKey:source.session_key,leaseOwner:'source-test',evidenceIds:correction.evidenceIds,
    knowledge:true,tasks:[{taskId:'voice-related-task',sessionKey:binding.session_key,reason:'Same topic evidence.'}],rationale:'Review original input in both roles.'};
  const result=dispatchInformation(f.store.db,args);
  assert.ok(result);
  const count=f.count('context_changes');dispatchInformation(f.store.db,args);assert.equal(f.count('context_changes'),count);
  const deliveries=f.store.db.prepare('SELECT purpose,evidence_id FROM information_deliveries').all();
  assert.ok(deliveries.some(r=>r.purpose==='knowledge_review_due'));
  assert.ok(deliveries.some(r=>r.purpose==='task_progress_due'));
  assert.equal(f.count('graph_facts'),0);
});
