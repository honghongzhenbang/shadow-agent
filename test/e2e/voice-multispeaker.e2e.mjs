import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { openDatabase } from '../../src/db.mjs';
import { registerVoiceRecording, acceptVoiceTranscript, voiceTranscriptRevisionToken, registerVoicePerson,
  annotateVoiceSpeaker } from '../../src/voice-input.mjs';
const root=process.cwd(),id=randomBytes(8).toString('hex'),output=path.join(root,'runtime/voice/enrollment-tests',id);
fs.mkdirSync(output,{recursive:true});
const store=openDatabase(path.join(output,'preview.sqlite')),config={projectRoot:root,voice:{runtimeRoot:output}};
let recording;
try {
  const audioPath=path.join(output,'fixture.wav'); fs.writeFileSync(audioPath,'isolated fixture, no playback');
  recording=await registerVoiceRecording(store,config,{audioPath,deviceId:'test',recordingId:'multi',
    recordedAt:'2026-10-20T01:20:00Z',title:'方案讨论 · 多人标注测试',testOnly:true});
  const alice=registerVoicePerson(store,{key:'alice',name:'测试甲'});
  registerVoicePerson(store,{key:'bob',name:'测试乙'});
  acceptVoiceTranscript(store,config,recording.id,{schemaVersion:1,durationMs:18000,engine:'old',
    segments:[{id:'old',startMs:0,endMs:18000,speakerLabel:'old',text:'旧版合并转写，保留人工判断。'}],speakers:[]});
  annotateVoiceSpeaker(store,config,{recordingId:recording.id,speakerLabel:'old',personId:alice.id});
  const transcript={schemaVersion:1,durationMs:18000,engine:'moss-local',speakers:[{label:'window_0000_S01'},{label:'window_0000_S02'}],
    segments:[{id:'a',startMs:0,endMs:6000,speakerLabel:'window_0000_S01',text:'我们先确认今天的测试范围。'},
      {id:'b',startMs:6000,endMs:12000,speakerLabel:'window_0000_S02',text:'先验证多人讨论，再保留未确认的声音。'},
      {id:'c',startMs:12000,endMs:18000,speakerLabel:'window_0000_S01',text:'可以，其他人物暂时不标注。'}]};
  acceptVoiceTranscript(store,config,recording.id,transcript,{replacement:{expectedToken:voiceTranscriptRevisionToken(store,recording.id),audioSha256:recording.content_hash}});
} finally {store.close();}
const env={...process.env,SHADOW_VOICE_PREVIEW_TEST_ID:id}; delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'desktop/voice-preview.mjs')],cwd:root,env});
const errors=[];
try {
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#recordingsTab').click();
  await page.locator('#groups .group').first().waitFor();
  assert.equal(await page.locator('#groups .group').count(),1);
  await page.locator('#groups .group').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('#segments .segment').length===3);
  assert.equal(await page.locator('#speakerFocus button').count(),2);
  await page.locator('#personSelect').selectOption({label:'测试甲'}); await page.locator('#save').click();
  await page.waitForFunction(()=>document.querySelector('#annotationCount').textContent.includes('2 / 3'));
  assert.match(await page.locator('#segments .segment').nth(1).innerText(),/未确认/);
  await page.locator('#segments .segment').nth(1).getByRole('button',{name:'标注此片段',exact:true}).click();
  await page.locator('#segmentText').fill('文字可以修正，人物仍留空。');
  await page.locator('#segmentForm button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#segments').textContent.includes('文字可以修正'));
  assert.match(await page.locator('#annotationCount').innerText(),/2 \/ 3/);
  await page.locator('#transcriptVersion').selectOption('0');
  await page.waitForFunction(()=>document.querySelector('#segments').textContent.includes('旧版合并转写'));
  assert.equal(await page.locator('#segments button').count(),0);
  assert.match(await page.locator('#segments').innerText(),/测试甲/);
  await page.locator('#transcriptVersion').selectOption('');
  await page.waitForFunction(()=>document.querySelectorAll('#segments .segment').length===3);
  const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await noOverflow();await page.screenshot({path:path.join(output,'multispeaker-desktop.png'),fullPage:true});
  const window=await app.browserWindow(page);await window.evaluate(w=>w.setSize(660,740));
  await noOverflow();await page.screenshot({path:path.join(output,'multispeaker-compact.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,scope:'isolated UI, synthetic transcript'}));
} finally {await app.close();}
