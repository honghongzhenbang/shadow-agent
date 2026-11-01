import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { localTranscriptionCommand, voiceSettings } from '../src/voice-input.mjs';

test('local provider is the default and asset reuse does not move the evidence archive', () => {
  const projectRoot = process.cwd();
  const config = { projectRoot, voice: { runtimeRoot: 'runtime/isolated-voice', assetsRoot: 'runtime/existing-local-assets' } };
  const settings = voiceSettings(config);
  assert.equal(settings.asrProvider, 'auto-local');
  assert.notEqual(settings.root, settings.assetsRoot);
  const command = localTranscriptionCommand(config, 'input.wav', 'result.json');
  assert.equal(command.command, 'D:/anaconda/python.exe');
  assert.ok(command.args.includes(path.join(settings.assetsRoot, 'models')));
  assert.equal(command.env.SHADOW_VOICE_ASSETS_ROOT, settings.assetsRoot);
  assert.equal(command.args[command.args.indexOf('--max-gain-db') + 1], '12');
  assert.equal(command.args[command.args.indexOf('--asr-time-budget-factor') + 1], '2');
  assert.ok(!JSON.stringify(command).includes('https://'));
});

test('Fun configuration keeps isolated runtimes and validates local fallback', () => {
  const config = { voice: { funPython: 'runtime/fun/python.exe', funModelDir: 'runtime/fun/model', funWeightSha256: 'a'.repeat(64) } };
  const command = localTranscriptionCommand(config, 'in.wav', 'out.json');
  assert.ok(command.args.includes('--fun-python'));
  assert.ok(command.args.includes('auto-local'));
  assert.ok(command.args.includes('43200'));
  assert.equal(command.args.includes('0'), false);
  assert.throws(() => localTranscriptionCommand({ voice: { fallback: 'cloud' } }, 'a', 'b'), /fallback/);
  assert.throws(() => localTranscriptionCommand({ voice: { minFreeMiB: 0 } }, 'a', 'b'), /reserves/);
  for (const maxGainDb of [Infinity, -1, 19, '12']) {
    assert.throws(() => localTranscriptionCommand({ voice: { maxGainDb } }, 'a', 'b'), /gain/);
  }
  for (const asrTimeBudgetFactor of [Infinity, 0, 11, '2']) {
    assert.throws(() => localTranscriptionCommand({ voice: { asrTimeBudgetFactor } }, 'a', 'b'), /budget factor/);
  }
  const custom = localTranscriptionCommand({voice:{asrTimeBudgetFactor:3}}, 'a', 'b');
  assert.equal(custom.args[custom.args.indexOf('--asr-time-budget-factor') + 1], '3');
});
test('unimplemented external backend fails explicitly instead of uploading or falling back', () => {
  assert.throws(() => localTranscriptionCommand({ projectRoot: process.cwd(), voice: { asrProvider: 'future-cloud' } }, 'a.wav', 'out.json'), /no automatic cloud fallback/);
});
test('omitted projectRoot resolves the runtime entrypoint from the current project', () => {
  const command = localTranscriptionCommand({}, 'in.wav', 'out.json');
  assert.ok(command.args.includes(path.join(process.cwd(), 'scripts', 'voice-runtime', 'transcribe.py')));
});

test('explicit MOSS uses the common intake with independent model paths and duration', () => {
  const voice = {asrProvider:'moss-local', mossPython:'runtime/moss/python.exe', mossModelDir:'runtime/moss/model',
    mossUpstream:'runtime/moss/upstream', mossCacheDir:'runtime/isolated/moss-cache'};
  const invocation = localTranscriptionCommand({voice},'in.wav','out.json');
  assert.equal(invocation.args[invocation.args.indexOf('--moss-max-seconds')+1],'60');
  assert.equal(invocation.args[invocation.args.indexOf('--asr-provider')+1],'moss-local');
  assert.equal(invocation.args[invocation.args.indexOf('--moss-cache-dir')+1],path.resolve(voice.mossCacheDir));
  assert.ok(!invocation.args.includes('--fun-python'));
  assert.throws(()=>localTranscriptionCommand({voice:{asrProvider:'moss-local'}},'a','b'),/not configured/);
  for (const mossMaxSeconds of [0,121,NaN,'60']) {
    assert.throws(()=>localTranscriptionCommand({voice:{...voice,mossMaxSeconds}},'a','b'),/duration/);
  }
});
