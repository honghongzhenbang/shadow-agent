import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { openDatabase } from '../../src/db.mjs';
import { registerVoiceRecording, acceptVoiceTranscript } from '../../src/voice-input.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const id = randomBytes(8).toString('hex');
const output = path.join(root, 'runtime/voice/enrollment-tests', id);
fs.mkdirSync(output, { recursive: true });
const store = openDatabase(path.join(output, 'preview.sqlite'));
const config = { projectRoot: root, voice: { runtimeRoot: output } };
const audioPath = path.join(output, 'fixture.wav');
// This isolated UI test never decodes, enrolls, or plays this synthetic file.
fs.writeFileSync(audioPath, 'synthetic fixture');
try {
  for (let index = 0; index < 6; index++) {
    const recording = await registerVoiceRecording(store, config, { audioPath, deviceId: 'test',
      recordingId: `partial-${index}`, recordedAt: `2026-10-25T00:00:0${index}Z`, title: '未完成转写测试', testOnly: true });
    acceptVoiceTranscript(store, config, recording.id, { schemaVersion: 1, durationMs: 30000, segments: [],
      speakers: [], completion: 'partial', partialResults: [{ startMs: 0, endMs: 30000, purpose: 'core',
        stopReason: index === 5 ? 'output_token_limit' : index === 4 ? 'worker_error'
          : index === 3 ? 'invalid_model_output' : 'audio_duration_deadline',
        ...(index === 5 ? { tokens:512, maxNewTokens:512 } : {}),
        budgetFactor:index === 0 ? 1 : 2, budgetSeconds: index === 0 ? 30 : 60,
        text: index === 5 ? '已保留中文片段。' + 'x'.repeat(500) : '' }] });
  }
} finally { store.close(); }
const env = { ...process.env, SHADOW_VOICE_PREVIEW_TEST_ID: id };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: process.env.SHADOW_ELECTRON_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'),
  args: [path.join(root, 'desktop/voice-preview.mjs')], cwd: root, env });
const errors = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#partialSection').waitFor();
  assert.equal(await page.locator('#partialRecordings details').count(), 5);
  await page.locator('#partialRecordings summary').first().click();
  await page.locator('.partial-result pre').waitFor();
  assert.match(await page.locator('.partial-result pre').innerText(), /^已保留中文片段/);
  assert.match(await page.locator('.partial-result small').innerText(), /未进入知识库/);
  assert.match(await page.locator('.partial-result small').innerText(), /输出长度上限/);
  for (const [index, reason] of [[1, '识别运行失败'], [2, '输出格式未完成']]) {
    const item = page.locator('#partialRecordings details').nth(index);
    await item.locator('summary').click();
    assert.ok((await item.locator('.partial-result small').innerText()).includes(reason));
    assert.ok((await item.locator('.partial-result small').innerText()).includes('未进入知识库'));
  }
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'partials-desktop.png'), fullPage: true });
  const window = await application.browserWindow(page);
  await window.evaluate(w => w.setSize(660, 620));
  await noOverflow();
  await page.screenshot({ path: path.join(output, 'partials-compact.png'), fullPage: true });
  await page.locator('#nextPartials').click();
  await page.waitForFunction(() => document.querySelectorAll('#partialRecordings details').length === 1);
  await page.locator('#partialRecordings summary').click();
  await page.locator('.partial-result pre').waitFor();
  assert.equal(await page.locator('.partial-result pre').innerText(), '截止时尚无已生成文字');
  assert.equal((await page.evaluate(() => window.shadowVoice.snapshot())).groups.length, 0);
  assert.deepEqual(errors, []);
  const db = openDatabase(path.join(output, 'preview.sqlite'));
  try {
    for (const table of ['evidence', 'voice_segments', 'voice_speaker_samples']) {
      assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { db.close(); }
  console.log(JSON.stringify({ passed: true, evidenceDirectory: output, scope: 'isolated UI only' }));
} finally { await application.close(); }
