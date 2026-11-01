import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright';
import { voiceSamplesFixture } from '../helpers/voice-samples-fixture.mjs';
import { registerVoiceRecording, acceptVoiceTranscript } from '../../src/voice-input.mjs';

const root = process.cwd(), id = randomBytes(8).toString('hex');
const output = path.join(root, 'runtime/voice/enrollment-tests', id), f = await voiceSamplesFixture(output);
const namesake = f.service.createPerson({ name: 'Separate person with no samples' });
f.store.db.prepare('UPDATE graph_entities SET name=? WHERE id=?').run(f.alice.name, namesake.id);
const other = await registerVoiceRecording(f.store, f.config, { audioPath: path.join(output, 'synthetic.wav'),
  deviceId: 'test', recordingId: 'unconfirmed-other', recordedAt: '2026-10-19T01:20:00Z', testOnly: true });
acceptVoiceTranscript(f.store, f.config, other.id, { schemaVersion: 1, engine: 'synthetic', durationMs: 45000,
  segments: [{ id: 'other', speakerLabel: 'other', startMs: 0, endMs: 12000, text: 'Unconfirmed separate recording.' }],
  speakers: [{ label: 'other', embedding: [1, 0], embeddingModel: 'synthetic-sample-test' }] });
const tracked = ['voice_segments', 'voice_recordings', 'evidence', 'evidence_links', 'context_changes', 'graph_facts'];
const state = db => Object.fromEntries(tracked.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const before = state(f.store.db), saved = f.store.db.prepare('SELECT * FROM voice_recordings WHERE id=?').get(f.recording.id);
const paths = [saved.audio_path, saved.transcript_path, ...JSON.parse(saved.metadata_json).previousTranscripts.map(p => p.archivePath)];
const hashes = () => paths.map(p => createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
const beforeFiles = hashes(); f.store.close();
const env = { ...process.env, SHADOW_VOICE_PREVIEW_TEST_ID: id }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [path.join(root, 'desktop/voice-preview.mjs')], cwd: root, env });
const errors = [];
const modify = callback => {
  const db = new DatabaseSync(f.database);
  try { return callback(db); } finally { db.close(); }
};
let passed = false;
try {
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(async id => {
    const data = await window.shadowVoice.review({ view: 'recordings' });
    return data.state === 'ready' && data.groups.some(g => g.recordingId === id && g.assignment?.kind === 'matched');
  }, other.id);
  await page.locator('#recordingsTab').click();
  await page.locator('#groups .group').first().click();
  await page.waitForFunction(() => document.querySelector('#personSelect').value !== '');
  await page.locator('#personSelect').selectOption(f.alice.id);
  await page.locator('#enroll').check();
  assert.equal(await page.locator('aside #manageSamples').count(), 1);
  assert.equal(await page.locator('main #manageSamples').count(), 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'people-desktop.png') });
  await page.locator(`#people button[data-person-id="${f.alice.id}"]`).click();
  await page.waitForFunction(id => document.querySelectorAll('.sample-row').length === 1 &&
    document.querySelector('.sample-row').dataset.sampleId === id, f.old.id);
  assert.equal(await page.locator('#samplePerson').inputValue(), f.alice.id);
  await page.locator('#samplePerson').selectOption(f.bob.id);
  await page.waitForFunction(id => document.querySelectorAll('.sample-row').length === 1 &&
    document.querySelector('.sample-row').dataset.sampleId === id, f.current.id);
  await page.locator('#samplePerson').selectOption(namesake.id);
  await page.waitForFunction(() => !document.querySelector('#samplePerson').disabled && document.querySelectorAll('.sample-row').length === 0);
  assert.match(await page.locator('#sampleList').innerText(), /暂无匹配/);
  assert.equal(await page.locator('#samplePerson').inputValue(), namesake.id, 'A namesake with no samples must not expose another person\'s samples');
  await page.locator('#closeSamples').click();
  await page.locator(`#people button[data-person-id="${f.alice.id}"]`).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelectorAll('.sample-row').length === 1 &&
    document.querySelector('.sample-row').dataset.sampleId === id, f.old.id);
  await page.locator('#sampleQuery').fill('no such recording');
  await page.locator('#sampleSearch button').click();
  await page.waitForFunction(() => !document.querySelector('#sampleQuery').disabled && document.querySelectorAll('.sample-row').length === 0);
  await page.locator('#closeSamples').click();
  assert.equal(await page.locator('#personSelect').inputValue(), f.alice.id);
  assert.equal(await page.locator('#enroll').isChecked(), true);
  await page.locator('#manageSamples').click();
  await page.waitForFunction(() => document.querySelectorAll('.sample-row').length === 2);
  assert.equal(await page.locator('#samplePerson').inputValue(), '');
  assert.equal(await page.locator('#sampleQuery').inputValue(), '', 'Opening all samples resets the previous person search');
  const old = page.locator(`.sample-row[data-sample-id="${f.old.id}"]`);
  assert.match(await old.innerText(), /旧声音组/);
  assert.match(await page.locator(`.sample-row[data-sample-id="${f.current.id}"]`).innerText(), /当前声音组/);
  await page.locator('#sampleQuery').fill('Historical fixture');
  await page.locator('#sampleSearch button').click();
  await page.waitForFunction(() => document.querySelectorAll('.sample-row').length === 1);
  assert.equal(await old.count(), 1);
  await old.getByRole('button', { name: '听来源录音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#sampleSeek').max === '45' && !document.querySelector('#sampleSeek').disabled);
  await page.locator('#toggleSampleAudio').click();
  await page.locator('#sampleSeek').evaluate(el => { el.value = '32'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('#sampleTime').textContent.startsWith('0:32'));
  await old.getByRole('button', { name: '移除此样本', exact: true }).click();
  await page.locator('#cancelRemoveSample').click();
  assert.equal(modify(db => db.prepare('SELECT COUNT(*) n FROM voice_speaker_samples').get().n), 2);
  await old.getByRole('button', { name: '移除此样本', exact: true }).click();
  modify(db => db.prepare('UPDATE voice_speaker_samples SET active=0 WHERE id=?').run(f.old.id));
  await page.locator('#confirmRemoveSample').click();
  await page.waitForFunction(() => document.querySelector('#samplesMessage').textContent.includes('已变更'));
  assert.equal(modify(db => db.prepare('SELECT COUNT(*) n FROM voice_speaker_samples').get().n), 2);
  assert.match(await old.innerText(), /已停用/);
  await page.screenshot({ path: path.join(output, 'samples-desktop.png'), fullPage: true });
  const window = await app.browserWindow(page);
  await window.evaluate(w => { w.setMinimumSize(320, 480); w.setContentSize(390, 740); });
  await page.waitForFunction(() => innerWidth >= 300 && innerWidth <= 440);
  fs.writeFileSync(path.join(output, 'viewport.json'), JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))));
  await page.screenshot({ path: path.join(output, 'samples-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    document.querySelector('#samplesDialog').scrollWidth <= document.querySelector('#samplesDialog').clientWidth));
  await window.evaluate(w => w.setSize(1000, 740));
  // A concurrent exact removal is an idempotent result, not an error or deletion of the next row.
  await old.getByRole('button', { name: '移除此样本', exact: true }).click();
  modify(db => db.prepare('DELETE FROM voice_speaker_samples WHERE id=?').run(f.old.id));
  await page.locator('#confirmRemoveSample').click();
  await page.waitForFunction(() => document.querySelector('#samplesMessage').textContent.includes('没有重复修改'));
  await page.locator('#sampleQuery').fill(''); await page.locator('#sampleSearch button').click();
  await page.waitForFunction(() => document.querySelectorAll('.sample-row').length === 1);
  const current = page.locator(`.sample-row[data-sample-id="${f.current.id}"]`);
  assert.equal(await current.count(), 1);
  // Reinsert the known isolated template to test an actual successful UI delete, not only no-op.
  modify(db => db.prepare(`INSERT INTO voice_speaker_samples
    (id,person_id,recording_id,speaker_label,embedding_model,embedding_json,evidence_id,created_at,active)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(...['id','person_id','recording_id','speaker_label','embedding_model','embedding_json','evidence_id','created_at','active'].map(k => f.old[k])));
  await page.locator('#reloadSamples').click();
  await page.waitForFunction(() => document.querySelectorAll('.sample-row').length === 2);
  await old.getByRole('button', { name: '移除此样本', exact: true }).click();
  await page.locator('#confirmRemoveSample').click();
  await page.waitForFunction(() => document.querySelector('#samplesMessage').textContent.includes('已移除此样本'));
  assert.equal(await old.count(), 0); assert.equal(await current.count(), 1);
  await page.locator('#closeSamples').click();
  assert.equal(await page.locator('#personSelect').inputValue(), f.alice.id);
  assert.equal(await page.locator('#enroll').isChecked(), true);
  await page.waitForFunction(async id => {
    const data = await window.shadowVoice.review({ view: 'recordings' });
    return data.state === 'ready' && data.groups.some(g => g.recordingId === id && g.assignment?.kind === 'unassigned');
  }, other.id);
  await window.evaluate(w => { w.setMinimumSize(320, 480); w.setContentSize(390, 740); });
  await page.locator('aside').scrollIntoViewIfNeeded();
  await page.locator(`#people button[data-person-id="${f.bob.id}"]`).waitFor({ state: 'visible' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'people-mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('aside button')].every(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
  })), 'People controls remain within the narrow viewport');
  assert.deepEqual(errors, []); passed = true;
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.txt'), String(error.stack));
  const page = app.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure-state.json'), JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      message: document.querySelector('#samplesMessage')?.textContent, errors: [...document.querySelectorAll('.error')].map(e => e.textContent) })).catch(() => null)));
  }
  throw error;
} finally { await app.close(); }
const raw = new DatabaseSync(f.database, { readOnly: true });
try {
  assert.deepEqual(state(raw), before);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM voice_speaker_samples').get().n, 1);
  assert.ok(raw.prepare('SELECT 1 FROM voice_speaker_samples WHERE id=?').get(f.current.id));
  assert.deepEqual(hashes(), beforeFiles);
} finally { raw.close(); }
console.log(JSON.stringify({ passed, output, scope: 'isolated actual Electron IPC, synthetic audio/labels, no ASR or model', pageErrors: errors }));
