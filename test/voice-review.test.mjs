import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/db.mjs';
import { registerVoiceRecording,acceptVoiceTranscript,correctVoiceSegment } from '../src/voice-input.mjs';
import { createVoiceEnrollmentService } from '../src/voice-enrollment.mjs';
import { createVoiceReview } from '../src/voice-review.mjs';
import { dispatchInformation } from '../src/information-delivery.mjs';
import { bindTaskSession } from '../src/work-sessions.mjs';
import { nextEvidencePage,recordEvidenceDelivery } from '../src/context-delivery.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-review-')),database=path.join(root,'test.sqlite');
  const store=openDatabase(database),config={projectRoot:root,voice:{runtimeRoot:'voice'}};
  const service=createVoiceEnrollmentService(store,config),workers=[];
  t.after(async()=>{for(const w of workers)await w.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const audio=path.join(root,'test.wav'),wave=Buffer.alloc(44+16000*2*6);
  wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);
  wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);
  wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
  fs.writeFileSync(audio,wave);let n=0;
  async function recording(embedding=[1,0,0],label='s') {
    const r=await registerVoiceRecording(store,config,{audioPath:audio,deviceId:'mechanism',recordingId:`test-${++n}`,
      recordedAt:'2026-10-24T00:00:00Z',testOnly:true});
    acceptVoiceTranscript(store,config,r.id,{schemaVersion:1,durationMs:6000,
      speakers:[{label,embeddingModel:'synthetic',embedding}],
      segments:[{id:'one',startMs:0,endMs:6000,speakerLabel:label,text:'Mechanism fixture, not real identity evidence.'}]});
    return r;
  }
  function worker(options={}) {const w=createVoiceReview({database,root:path.join(root,'voice'),projectRoot:root,debounceMs:5,pollMs:0,...options});workers.push(w);return w;}
  const group=r=>service.group({recordingId:r.id,speakerLabel:'s'});
  return {root,config,store,service,recording,worker,group,count:table=>store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n};
}
async function ready(w, predicate=()=>true) {
  const until=Date.now()+30000;
  while(Date.now()<until){const s=w.read({view:'people'});if(s.state==='error')throw new Error(s.error);
    if(s.state==='ready'&&predicate(s))return s;await delay(20);}
  throw new Error('Review worker did not become ready.');
}

test('cached read-only matching aggregates people, avoids repeated I/O and reverses after revoke',async t=>{
  const f=fixture(t),a=await f.recording(),a2=await f.recording(),b=await f.recording([0,1,0]),b2=await f.recording([0,1,0]);
  const w=f.worker();assert.equal(w.read().state,'loading');
  const initial=await ready(w);assert.equal(initial.counts.unassigned,4);
  assert.equal(w.read().items.length,2,'Only one recommendation per anonymous acoustic cluster');
  const loaded=w.diagnostics().fileReads;assert.equal(loaded,4);
  const person=f.service.createPerson({name:'Fixture Person'});
  f.service.confirm({...f.group(a),personId:person.id,enroll:true});
  const afterManual=f.count('evidence');w.invalidate();
  const first=await ready(w,s=>s.counts.matched===1);
  assert.equal(first.counts.confirmed,1);assert.equal(first.items.find(x=>x.personId===person.id).groupCount,2);
  assert.equal(w.assignment(a2.id,'s').kind,'matched');
  assert.equal(f.group(a2).personId,null,'Automatic matching must not rewrite manual identity');
  assert.equal(f.count('evidence'),afterManual);assert.equal(f.count('graph_facts'),0);assert.equal(f.count('tasks'),0);
  assert.equal(w.diagnostics().fileReads,loaded);
  f.service.confirm({...f.group(b),personId:person.id,enroll:true});w.invalidate();
  const both=await ready(w,s=>s.counts.confirmed===2&&s.counts.matched===2);
  assert.equal(both.items.length,1);assert.equal(both.items[0].groupCount,4);assert.equal(w.read().items.length,0);
  assert.equal(w.read({bucketId:both.items[0].id}).groups.length,4);
  const details=f.service.segments(f.group(b));
  f.service.reviseSegment({...f.group(b),segmentId:'one',revision:details.segments[0].revision,text:'Revised text only.',personId:person.id});
  w.invalidate();await ready(w,s=>s.revision!==both.revision);assert.equal(w.diagnostics().fileReads,loaded);
  f.service.revoke(f.group(a));w.invalidate();
  const revoked=await ready(w,s=>s.counts.confirmed===1&&s.counts.unassigned===2);
  assert.equal(revoked.counts.matched,1);assert.equal(w.read().items.length,1);
  assert.equal(w.assignment(a2.id,'s').kind,'unassigned');
  assert.equal(f.group(b2).personId,null);
  const before=f.count('evidence');w.refresh();await ready(w);assert.equal(w.diagnostics().fileReads,loaded);assert.equal(f.count('evidence'),before);
  const serialized=JSON.stringify(w.read({view:'recordings'}));
  for(const secret of ['embedding','transcript_path','audio_path',f.root])assert.equal(serialized.includes(secret),false,secret);
  assert.throws(()=>w.read({page:0}));assert.throws(()=>w.read({pageSize:101}));
  assert.equal(w.read({view:'recordings',pageSize:2,page:2}).groups.length,2);
  await w.close();const restart=f.worker();const reopened=await ready(restart);
  assert.deepEqual(reopened.counts,revoked.counts);assert.equal(f.count('evidence'),before);
});

test('external annotation is noticed without a UI mutation and newly arrived files extend the cache',async t=>{
  const f=fixture(t),a=await f.recording();await f.recording();const w=f.worker({pollMs:30});await ready(w);
  const p=f.service.createPerson({name:'External fixture'});
  f.service.confirm({...f.group(a),personId:p.id,enroll:true});
  await ready(w,s=>s.counts.confirmed===1&&s.counts.matched===1);
  assert.equal(w.diagnostics().fileReads,2);
  await f.recording();await ready(w,s=>s.counts.groups===3);
  assert.equal(w.diagnostics().fileReads,3);
});

test('unreadable transcript remains available for review but cannot provide an invented embedding',async t=>{
  const f=fixture(t),r=await f.recording(),record=f.store.db.prepare('SELECT * FROM voice_recordings WHERE id=?').get(r.id);
  fs.writeFileSync(record.transcript_path,'not-json');
  const w=f.worker();const s=await ready(w);
  assert.equal(s.counts.groups,1);assert.equal(s.counts.confirmed,0);assert.equal(s.counts.matched,0);
  assert.equal(w.diagnostics().unreadableFiles,1);
  assert.equal(f.count('evidence'),1);
});

test('real task delivery linkage survives a later voice correction without rating content by keywords',async t=>{
  const f=fixture(t),r=await f.recording();
  const source=f.store.db.prepare('SELECT * FROM context_changes ORDER BY seq DESC LIMIT 1').get();
  f.store.db.prepare("UPDATE context_changes SET status='leased',lease_owner='review-test',lease_until='2099-01-01T00:00:00Z' WHERE seq=?").run(source.seq);
  recordEvidenceDelivery(f.store.db,source.seq,'review-test',nextEvidencePage(f.store.db,source.seq));
  const evidence=f.store.db.prepare('SELECT evidence_id FROM voice_segments WHERE recording_id=?').get(r.id).evidence_id;
  const task=bindTaskSession(f.store,{id:'voice-review-linked-task'});
  dispatchInformation(f.store.db,{sourceChangeSeq:source.seq,sessionKey:source.session_key,leaseOwner:'review-test',
    evidenceIds:[evidence],knowledge:false,tasks:[{taskId:'voice-review-linked-task',sessionKey:task.session_key,reason:'Synthetic mechanism linkage.'}],rationale:'Read source.'});
  correctVoiceSegment(f.store,f.config,{recordingId:r.id,segmentId:'one',text:'A revised statement.',reason:'Fixture correction'});
  const w=f.worker();await ready(w);const item=w.read().items[0];
  assert.equal(item.taskCount,1);assert.ok(item.reasonCodes.includes('task_related'));
});

test('manual refresh detects changed or unavailable cached transcripts without discarding recordings',async t=>{
  const f=fixture(t),r=await f.recording(),w=f.worker();
  const initial=await ready(w),record=f.store.db.prepare('SELECT * FROM voice_recordings WHERE id=?').get(r.id);
  const text=fs.readFileSync(record.transcript_path,'utf8'),changed=JSON.parse(text);
  changed.speakers[0].embedding=[0,1,0];
  fs.writeFileSync(record.transcript_path,JSON.stringify(changed,null,2));w.refresh();
  await ready(w,s=>s.revision!==initial.revision);assert.equal(w.diagnostics().fileReads,2);
  fs.writeFileSync(record.transcript_path,'unavailable');w.refresh();
  await ready(w);assert.equal(w.diagnostics().unreadableFiles,1);assert.equal(w.read().counts.groups,1);
  fs.writeFileSync(record.transcript_path,text);w.refresh();
  await ready(w,s=>s.revision===initial.revision);assert.equal(w.diagnostics().fileReads,3);
  assert.equal(f.count('evidence'),1);
});

test('coalesced changes publish the latest manual identity, not an earlier match revision',async t=>{
  const f=fixture(t),r=await f.recording();await f.recording();
  const w=f.worker({debounceMs:40});await ready(w);
  const p=f.service.createPerson({name:'Latest identity fixture'});
  f.service.confirm({...f.group(r),personId:p.id,enroll:true});w.invalidate();
  f.service.revoke(f.group(r));w.invalidate();
  f.service.confirm({...f.group(r),personId:p.id,enroll:true});w.invalidate();
  const final=await ready(w,s=>s.counts.confirmed===1&&s.counts.matched===1);
  assert.equal(final.items.filter(x=>x.personId===p.id).length,1);
  assert.equal(w.diagnostics().builds,2);
  await delay(80);assert.equal(w.read().revision,final.revision);
});
