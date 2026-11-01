import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executablePath = process.env.SHADOW_ELECTRON_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
const id = randomBytes(8).toString('hex');
const env = { ...process.env, SHADOW_VOICE_PREVIEW_TEST_ID: id };
delete env.ELECTRON_RUN_AS_NODE;
execFileSync(process.execPath, ['scripts/prepare-voice-enrollment-preview.mjs'], { cwd: root, env, timeout: 600_000, stdio: 'pipe' });
const evidence = path.join(root, 'runtime/voice/enrollment-tests', id);
const application = await electron.launch({ executablePath, args: [path.join(root, 'desktop/voice-preview.mjs')], cwd: root, env });
const errors = [];
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', e => errors.push(e.message));
  const waitReady = () => page.waitForFunction(() => document.getElementById('matchingState').textContent.includes('匹配已更新'), null, { timeout: 90_000 });
  const waitCount = (name, count) => page.waitForFunction(({ name, count }) => document.getElementById(name).textContent === String(count), { name, count });
  const allGroups = () => page.evaluate(() => window.shadowVoice.review({ view: 'recordings', page: 1, pageSize: 30 }));
  const base = () => page.evaluate(() => window.shadowVoice.snapshot({ status: 'all', page: 1, pageSize: 1 }));
  const rematch = async () => {
    const started = await page.evaluate(() => window.shadowVoice.reviewRefresh());
    assert.ok(['loading', 'refreshing'].includes(started.state), 'Refresh immediately reports background work');
    await page.waitForFunction(async () => {
      const data = await window.shadowVoice.review({ view: 'recordings', page: 1, pageSize: 30 });
      return data.state === 'ready';
    });
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
  await waitReady();
  await page.locator('#recommendedTab').click();
  assert.match(await page.locator('#matchingState').innerText(), /已加载 \d+ \/ \d+ 份录音/);
  await page.locator('.bucket').first().waitFor();
  assert.match(await page.locator('#environment').innerText(), /隔离预览/);
  assert.equal(await page.getByRole('tab').count(), 3);
  assert.equal(await page.locator('#recommendedTab').getAttribute('aria-selected'), 'true');
  const initial = await allGroups();
  assert.equal(initial.groups.length, 2, 'Public fixture contains two voices, not a historical matching benchmark');
  assert.equal(initial.groups.reduce((n, g) => n + g.segmentCount, 0), 3);
  assert.equal(initial.counts.confirmed, 0);
  assert.equal(await page.locator('.person').count(), 2);
  const safe = JSON.stringify({ initial, base: await base() });
  assert.ok(!/embedding|audio_path|audioPath/.test(safe));
  await page.locator('.bucket .expand-bucket').first().click();
  await page.locator('.members .group').first().waitFor();
  assert.equal(await page.locator('.expand-bucket[aria-expanded=true]').count(), 1);
  await page.locator('.members .group').first().click();
  await page.waitForFunction(() => !document.getElementById('listen').disabled);
  const selectedKey = await page.locator('#detail').getAttribute('data-key');
  const target = initial.groups.find(g => `${g.recordingId}:${g.speakerLabel}` === selectedKey);
  assert.ok(target);
  const targetRef = { recordingId: target.recordingId, speakerLabel: target.speakerLabel };
  const sample = await page.evaluate(input => window.shadowVoice.sample(input), targetRef);
  assert.ok(sample.dataUrl.startsWith('data:audio/wav;base64,'));
  assert.ok(!(await page.locator('#detail').innerText()).includes('最多 8 秒'));
  await page.evaluate(() => {
    const Original = window.Audio;
    window.testAudio = [];
    window.Audio = function (...args) { const audio = new Original(...args); audio.muted = true; window.testAudio.push(audio); return audio; };
  });
  await page.locator('#listen').click();
  await page.waitForFunction(() => document.querySelector('#listen span').textContent === '暂停试听');
  assert.equal(await page.locator('#playback').isVisible(), true);
  assert.equal(Number(await page.locator('#playbackSeek').getAttribute('max')), sample.durationMs / 1000);
  assert.equal(await page.locator('#playbackScope').innerText(), '完整录音');
  await page.locator('#listen').click();
  assert.equal(await page.locator('#listen span').innerText(), '继续试听');
  assert.equal(await page.evaluate(() => window.testAudio.at(-1).paused), true);
  const seekSeconds = Math.min(9, sample.durationMs / 2000);
  await page.locator('#playbackSeek').evaluate((slider, value) => {
    slider.value = String(value); slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'));
  }, seekSeconds);
  await page.waitForFunction(() => !document.getElementById('listen').disabled && window.testAudio.length === 2);
  assert.equal(await page.evaluate(() => window.testAudio.at(-1).paused), true, 'Seeking a paused recording must not start playback');
  assert.ok(Math.abs(Number(await page.locator('#playbackSeek').inputValue()) - seekSeconds) < 0.1);
  await page.locator('#listen').click();
  await page.waitForFunction(() => document.querySelector('#listen span').textContent === '暂停试听');
  await page.locator('#listen').click();
  assert.ok(await page.evaluate(() => {
    const canvas = document.getElementById('mascot');
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0);
  }));
  await noOverflow();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });

  await page.locator('#addPerson').click();
  await page.locator('#personName').fill('界面测试人物');
  await rematch();
  await waitReady();
  assert.equal(await page.locator('#personDialog').isVisible(), true);
  assert.equal(await page.locator('#personName').inputValue(), '界面测试人物');
  await page.locator('#personForm button[type=submit]').click();
  await page.locator('#personDialog').waitFor({ state: 'hidden' });
  const person = (await base()).people.find(p => p.name === '界面测试人物');
  assert.ok(person);
  assert.equal(await page.locator('#personSelect').inputValue(), person.id);
  assert.equal((await allGroups()).counts.confirmed, 0, 'Selecting or creating a person does not save');

  // Confirm without enrolling first. Only the selected recording group is written.
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('未新增声纹样本'));
  await waitCount('confirmedCount', 1);
  assert.equal((await base()).people.find(p => p.id === person.id).sampleCount, 0);
  const confirmed = await allGroups();
  assert.equal(confirmed.groups.find(g => g.key === target.key).assignment.kind, 'confirmed');
  assert.ok(confirmed.groups.filter(g => g.key !== target.key).every(g => g.assignment.kind !== 'confirmed'));
  await page.locator('#peopleTab').click();
  const personBucket = page.locator('.bucket').filter({ has: page.locator('.bucket-title', { hasText: '界面测试人物' }) });
  await personBucket.waitFor();
  assert.equal(await personBucket.count(), 1, 'One entry per person');
  await personBucket.locator('.bucket-select').click();
  await page.waitForFunction(id => document.getElementById('personSelect').value === id && !document.getElementById('save').disabled, person.id);
  await personBucket.locator('.expand-bucket').click();
  await page.locator('.members .group').first().waitFor();
  assert.match(await page.locator('.members').innerText(), /人工确认/);
  await page.locator('#enroll').check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('声纹样本已保存'));
  await waitReady();
  assert.equal((await base()).people.find(p => p.id === person.id).sampleCount, 1);
  assert.equal((await allGroups()).counts.confirmed, 1, 'Automatic matching never increments human confirmations');
  await page.screenshot({ path: path.join(evidence, 'confirmed.png'), fullPage: true });

  await page.locator('#recordingsTab').click();
  await page.locator('#groups > .group').first().waitFor();
  assert.equal(await page.locator('#groups > .group').count(), 1, 'One entry per recording, not per speaker');
  const currentRows = await allGroups();
  const other = currentRows.groups.find(g => g.key !== target.key);
  const chooseSpeaker = async label => {
    const timeline = await page.evaluate(id=>window.shadowVoice.timeline({recordingId:id}), target.recordingId);
    await page.locator('#speakerFocus button').nth(timeline.speakers.findIndex(s=>s.speakerLabel===label)).click();
  };
  await chooseSpeaker(other.speakerLabel);
  await page.waitForFunction(key => document.getElementById('detail').dataset.key === key && !document.getElementById('save').disabled,
    `${other.recordingId}:${other.speakerLabel}`);
  assert.equal(await page.locator('#personSelect').inputValue(), other.personId || other.assignment.personId || '', 'No person selection leaks between recordings');
  await chooseSpeaker(target.speakerLabel);
  await page.waitForFunction(id => document.getElementById('personSelect').value === id, person.id);
  await page.locator('#refresh').click();
  assert.match(await page.locator('#status').innerText(), /未重新识别文字/);
  assert.equal(await page.locator('#peopleTab').isEnabled(), true);
  await waitReady();
  assert.equal((await base()).people.find(p => p.id === person.id).sampleCount, 1);

  const window = await application.browserWindow(page);
  await window.evaluate(w => w.setSize(660, 620));
  await page.locator('#peopleTab').click();
  await personBucket.waitFor();
  await personBucket.locator('.expand-bucket').click();
  await page.locator('.members .group').first().waitFor();
  await noOverflow();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(evidence, 'compact.png'), fullPage: true });
  await page.locator('#revoke').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已撤销'));
  await waitCount('confirmedCount', 0);
  assert.equal((await base()).people.find(p => p.id === person.id).sampleCount, 0);
  await page.locator('#recommendedTab').click();
  await waitCount('recommendedCount', initial.counts.recommended);
  await page.locator('.bucket').first().waitFor();
  const restored = await page.evaluate(() => window.shadowVoice.review({ view: 'recommended', page: 1, pageSize: 30 }));
  assert.ok(restored.items.some(b => b.representative.key === target.key), 'Revoked group returns to recommendations');

  await page.locator('#segments .segment').first().waitFor();
  await page.locator('#segments button[aria-label="试听此片段"]').first().click();
  await page.locator('#segments button[aria-label="标注此片段"]').first().click();
  const correction = '界面测试转写修订，仅用于隔离数据。';
  await page.locator('#segmentText').fill(correction);
  await page.locator('#segmentPerson').selectOption(person.id);
  // A real background rematch must not replace an open editor or its options.
  await page.evaluate(() => {
    window.savedSegmentOption = document.querySelector('#segmentPerson option:checked');
    window.savedSegmentEditor = document.getElementById('segmentText');
  });
  await rematch();
  await page.waitForTimeout(4500);
  assert.equal(await page.locator('#segmentText').inputValue(), correction);
  assert.equal(await page.locator('#segmentPerson').inputValue(), person.id);
  assert.ok(await page.evaluate(() => window.savedSegmentOption === document.querySelector('#segmentPerson option:checked')
    && window.savedSegmentEditor === document.getElementById('segmentText')));
  await noOverflow();
  await page.screenshot({ path: path.join(evidence, 'segment-edit.png') });
  await page.locator('#segmentForm button[type=submit]').click();
  await page.locator('#segmentDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('segments').textContent.includes('界面测试转写修订'));
  const revised = await page.evaluate(async input => ({
    group: await window.shadowVoice.group(input), detail: await window.shadowVoice.segments(input),
  }), targetRef);
  assert.ok(revised.detail.segments.some(s => s.text === correction && s.personId === person.id && s.revision > 1));
  assert.equal((await base()).people.find(p => p.id === person.id).sampleCount, 0, 'Segment correction must not enroll');
  await page.screenshot({ path: path.join(evidence, 'segment-saved.png'), fullPage: true });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, scope: 'isolated-voice-ui',
    noAgent: true, noMicrophone: true, fixture: { voices: 2, segments: 3, recordings: 1 },
    tabs: true, expandableUnnamedAndPersonBuckets: true, sampleEnrolledThenRevoked: true,
    automaticReviewInvalidation: true, segmentCorrectionAndIdentity: true, editorPreservedDuringPolling: true,
    minimumWindowWidth: 660, historicalMatchingAccuracy: 'not measured; backend tests cover the mechanism', errors }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence }));
} catch (error) {
  const page = application.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure.txt'), `${error.stack}\n${await page.locator('body').innerText().catch(() => '')}`);
  }
  throw error;
} finally { await application.close(); }
