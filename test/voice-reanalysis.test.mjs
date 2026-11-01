import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db.mjs';
import { registerVoiceRecording, acceptVoiceTranscript, annotateVoiceSpeaker, registerVoicePerson,
  voiceTranscriptRevisionToken } from '../src/voice-input.mjs';
import { createVoiceEnrollmentService } from '../src/voice-enrollment.mjs';

const newTranscript = () => ({ schemaVersion:1, durationMs:12000, engine:'moss-local', model:'test',
  segments:[{id:'s0',startMs:0,endMs:6000,text:'first speaker',speakerLabel:'window_0000_S01'},
    {id:'s1',startMs:6000,endMs:12000,text:'second speaker',speakerLabel:'window_0000_S02'}],
  speakers:[{label:'window_0000_S01',embedding:[1,0],embeddingModel:'test'},
    {label:'window_0000_S02',embedding:[0,1],embeddingModel:'test'}] });
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-reanalysis-'));
  const store=openDatabase(path.join(root,'test.sqlite')), config={projectRoot:root,voice:{runtimeRoot:root}};
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const audioPath=path.join(root,'audio.wav');fs.writeFileSync(audioPath,'isolated test, not decoded');
  const recording=await registerVoiceRecording(store,config,{audioPath,deviceId:'test',recordingId:'one',recordedAt:'2026-10-19T00:00:00Z',testOnly:true});
  acceptVoiceTranscript(store,config,recording.id,{schemaVersion:1,durationMs:12000,engine:'old',
    segments:[{id:'old',startMs:0,endMs:12000,text:'old manual text',speakerLabel:'old'}],
    speakers:[{label:'old',embedding:[1,0],embeddingModel:'test'}]});
  const person=registerVoicePerson(store,{key:'person',name:'Test Person'});
  const service=createVoiceEnrollmentService(store,config,{isolated:true});
  const replace=(result=newTranscript(),expectedToken=voiceTranscriptRevisionToken(store,recording.id))=>
    acceptVoiceTranscript(store,config,recording.id,result,{replacement:{expectedToken,audioSha256:recording.content_hash}});
  return {store,config,recording,person,service,replace};
}
test('new ASR version retains manual evidence and samples; labels are not inherited',async t=>{
  const f=await fixture(t);
  annotateVoiceSpeaker(f.store,f.config,{recordingId:f.recording.id,speakerLabel:'old',personId:f.person.id,enroll:true});
  const old=f.service.timeline({recordingId:f.recording.id}).segments[0];
  const receipt=f.replace(); assert.equal(receipt.evidenceIds.length,2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM voice_speaker_samples WHERE active=1').get().n,1);
  const current=f.service.timeline({recordingId:f.recording.id});
  assert.equal(current.speakers.length,2); assert.equal(current.confirmedCount,0);
  assert.equal(current.history[0].annotatedCount,1);
  assert.deepEqual(f.service.timeline({recordingId:f.recording.id,historyIndex:0}).segments[0],{...old,ordinal:1});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM evidence_links WHERE relation='retranscribes'").get().n,2);
  assert.equal(f.replace().duplicate,true);
  assert.equal(f.service.timeline({recordingId:f.recording.id}).history.length,1);
});
test('one person or one utterance can be saved while the other stays unknown',async t=>{
  const f=await fixture(t); f.replace();
  const timeline=f.service.timeline({recordingId:f.recording.id});
  const first=timeline.segments[0];
  f.service.reviseSegment({recordingId:f.recording.id,...first,text:'corrected',personId:f.person.id});
  const after=f.service.timeline({recordingId:f.recording.id});
  assert.equal(after.confirmedCount,1);assert.equal(after.segments[1].personId,null);
  assert.equal(after.segments[0].text,'corrected');
  assert.equal(f.service.recordings().groups.length,1);
  assert.equal(f.service.recordings().groups[0].speakerCount,2);
});
test('edits during inference reject replacement and wrong hash rejects before pointer changes',async t=>{
  const f=await fixture(t), token=voiceTranscriptRevisionToken(f.store,f.recording.id);
  annotateVoiceSpeaker(f.store,f.config,{recordingId:f.recording.id,speakerLabel:'old',personId:f.person.id});
  assert.throws(()=>f.replace(newTranscript(),token),/STALE_REVISION/);
  assert.equal(f.service.timeline({recordingId:f.recording.id}).confirmedCount,1);
  assert.throws(()=>acceptVoiceTranscript(f.store,f.config,f.recording.id,newTranscript(),{replacement:{expectedToken:token,audioSha256:'0'.repeat(64)}}),/identity mismatch/);
  assert.equal(f.service.timeline({recordingId:f.recording.id}).history.length,0);
});
test('empty reanalysis preserves old view and emits revision notice, not fabricated words',async t=>{
  const f=await fixture(t); f.replace({...newTranscript(),segments:[],speakers:[],engine:'local-no-speech'});
  assert.equal(f.service.timeline({recordingId:f.recording.id}).segments.length,0);
  assert.equal(f.service.timeline({recordingId:f.recording.id,historyIndex:0}).segments.length,1);
  assert.equal(f.service.recordings().groups.length,1);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT metadata_json FROM context_changes ORDER BY seq DESC LIMIT 1').get().metadata_json).reanalysis,true);
});
