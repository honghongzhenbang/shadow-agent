"""Incomplete ASR never masquerades as a finished time-aligned transcript."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/voice-runtime"))
from asr import _run_paths, _windowed_package, arguments


class PartialTranscripts(unittest.TestCase):
    def test_cli_budget_default_and_validation(self):
        argv = ['--audio', 'fake.wav', '--model-dir', '.', '--output', 'json']
        self.assertEqual(arguments(argv).asr_time_budget_factor, 2)
        self.assertEqual(arguments(argv + ['--asr-time-budget-factor', '1']).asr_time_budget_factor, 1)
        for value in ['0', 'nan', '11']:
            with self.assertRaises(SystemExit):
                arguments(argv + ['--asr-time-budget-factor', value])

    def test_package_windows_keep_original_offsets_and_one_partial_owner(self):
        args = SimpleNamespace(diarization='none', cluster_threshold=.5)
        runtime = SimpleNamespace(provider=SimpleNamespace(used={'fun-asr-nano'}))
        partial = {'startMs': 4200, 'endMs': 4800, 'text': 'partial',
                   'purpose': 'core', 'budgetSeconds': 1.2, 'budgetFactor': 2,
                   'stopReason': 'audio_duration_deadline'}
        empty = {'segments': [], 'speakers': [], 'warnings': [], 'language': 'zh',
                 'timings': dict.fromkeys(['decodeMs','asrMs','diarizationMs','totalMs'], 0)}
        batches = [{**empty, 'partialResults': [partial]},
                   {**empty, 'partialResults': [{**partial, 'startMs': 1200, 'endMs': 1800}]}]
        with patch('asr._package_manifest', return_value={'sampleCount':16000}), \
             patch('asr._validate_package_chain'), patch('asr.sha256', return_value='fake'), \
             patch('asr._run_paths', side_effect=batches):
            result = _windowed_package(args, runtime, [Path(str(i)) for i in range(6)])
        self.assertEqual(result['durationMs'], 6000)
        self.assertEqual(result['completion'], 'partial')
        self.assertEqual(result['partialResults'], [partial])

    def test_optional_boundary_timeout_keeps_completed_core(self):
        args = SimpleNamespace(model_dir=Path('.'), threads=2, language='zh', diarization='none',
                               cluster_threshold=.5, max_seconds=100, max_gain_db=0)
        outputs = iter([{'text': 'core', 'engine': 'fun-asr-nano'},
                        {'text': 'boundary partial', 'engine':'fun-asr-nano', 'completion':'partial',
                         'stopReason':'audio_duration_deadline','budgetSeconds':5,'budgetFactor':2}])
        runtime = SimpleNamespace(key=(str(Path('.').resolve()),2,'zh','none'), np=None, sherpa=None,
            sf=None,soxr=None,manifest={},models={},
            provider=SimpleNamespace(decode=lambda *args:next(outputs), used={'fun-asr-nano'}))
        plan = [{'start':16000,'end':48000,'inputStart':8000,'label':'unknown',
                 'overlapSamples':8000,'forcedStart':True}]
        with patch('asr.recognition_plan', return_value=plan):
            result = _run_paths(args, runtime, [Path('fake.wav')], prepared_intervals=[(16000,48000)],
                decoded=([0]*64000,SimpleNamespace(duration=4,samplerate=16000,frames=64000,channels=1),[],[]))
        self.assertEqual(result['segments'][0]['text'], 'core')
        self.assertIsNone(result['segments'][0]['boundaryContext'])
        self.assertEqual(result['partialResults'][0]['purpose'], 'boundary-candidate')
        self.assertEqual(result['partialResults'][0]['budgetFactor'], 2)
        self.assertEqual(result['partialResults'][0]['startMs'], 500)
        self.assertEqual(result['partialResults'][0]['endMs'], 3000)

    def test_finished_windows_survive_partial_and_empty_partial(self):
        args = SimpleNamespace(model_dir=Path('.'), threads=2, language='zh', diarization='none',
                               cluster_threshold=.5, max_seconds=100, max_gain_db=0)
        outputs = iter([
            {"text": "partial", "engine": "fun-asr-nano", "completion": "partial",
             "stopReason": "audio_duration_deadline", "budgetSeconds": 1.2, "seconds": 1.2},
            {"text": "complete", "engine": "fun-asr-nano"},
            {"text": "", "engine": "fun-asr-nano", "completion": "partial",
             "stopReason": "audio_duration_deadline", "budgetSeconds": 1.2, "seconds": 1.2}])
        runtime = SimpleNamespace(key=(str(Path('.').resolve()), 2, 'zh', 'none'), np=None,
            sherpa=None, sf=None, soxr=None, manifest={}, models={},
            provider=SimpleNamespace(decode=lambda *args: next(outputs), used={'fun-asr-nano'}))
        result = _run_paths(args, runtime, [Path('fake.wav')], prepared_intervals=[(0,16000),(32000,48000),(64000,80000)],
            decoded=([0]*96000, SimpleNamespace(duration=6, samplerate=16000,frames=96000,channels=1), [], []))
        self.assertEqual(result['completion'], 'partial')
        self.assertEqual([s['text'] for s in result['segments']], ['complete'])
        self.assertEqual([s['text'] for s in result['partialResults']], ['partial', ''])
        self.assertNotIn('NO_SPEECH_DETECTED', result['warnings'])
        self.assertEqual(result['partialResults'][0]['startMs'], 0)
        self.assertEqual(result['partialResults'][0]['endMs'], 1200)


if __name__ == '__main__':
    unittest.main()
