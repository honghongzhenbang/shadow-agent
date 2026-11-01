"""The real upstream parser needs Python 3.10+; no model or GPU is loaded."""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/voice-runtime'))
from moss_deadline_worker import transcript_result
from streaming_deadline import generation_status


@unittest.skipUnless(sys.version_info >= (3, 10), 'Run with the configured MOSS Python for upstream slots dataclasses')
class MossOutput(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT / 'runtime/voice-moss/upstream/moss_transcribe_diarize/transcript_parser.py'
        if not path.is_file():
            raise unittest.SkipTest('Upstream MOSS parser is not installed; do not download for a unit test')
        spec = importlib.util.spec_from_file_location('test_installed_moss_transcript_parser', path)
        cls.upstream = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.upstream
        spec.loader.exec_module(cls.upstream)

    def result(self, text, **changes):
        status = generation_status(expired=False, tokens=30, max_tokens=512, reached_eos=True)
        return transcript_result(text, {**status, **changes}, self.upstream.TranscriptStreamParser)

    def test_upstream_reproduces_silent_tail_discard(self):
        text = '[0][S01]complete[1][1][S02]unfinished'
        legacy = self.upstream.parse_transcript(text)
        self.assertEqual([row.text for row in legacy], ['complete'])
        result = self.result(text)
        self.assertEqual(result['completion'], 'partial')
        self.assertEqual(result['stopReason'], 'invalid_model_output')
        self.assertEqual(result['segments'], [])

    def test_valid_turns_are_not_changed(self):
        text = ' [00.0][S01]hello [note] world[1.0]\n[1.5][S02]next[2.0]\n '
        result = self.result(text)
        self.assertEqual(result['completion'], 'complete')
        self.assertEqual([s['text'] for s in result['segments']], ['hello [note] world', 'next'])

    def test_incomplete_and_invalid_terminal_states_never_look_complete(self):
        for tail in ('[', '[1.', '[1]', '[1][S', '[1][S02]', '[1][S02]tail[',
                     '[1][S02]tail[2.', '[bad]', 'trailing text'):
            with self.subTest(tail=tail):
                result = self.result('[0][S01]complete[1]' + tail)
                self.assertEqual(result['completion'], 'partial')
                self.assertEqual(result['stopReason'], 'invalid_model_output')

    def test_empty_eos_remains_empty_not_an_invented_transcript(self):
        result = self.result(' \n ')
        self.assertEqual(result['completion'], 'complete')
        self.assertEqual(result['segments'], [])

    def test_token_and_time_stop_reasons_are_not_replaced_by_format_check(self):
        for reason in ('output_token_limit', 'audio_duration_deadline', 'worker_error'):
            result = self.result('[0][S01]unfinished', completion='partial', stopReason=reason)
            self.assertEqual(result['completion'], 'partial')
            self.assertEqual(result['stopReason'], reason)
            self.assertEqual(result['segments'], [])


if __name__ == '__main__':
    unittest.main()
