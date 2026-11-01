"""Deterministic boundary/provider tests. No model, network or production database."""
import random
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/voice-runtime"))
from recognition_windows import recognition_plan
from transcript_quality import issues
from local_provider import LocalProvider
from fun_worker import watch_parent


class Windows(unittest.TestCase):
    def test_continuous_speech_overlap_is_only_a_view(self):
        intervals = [(0, 16000 * 100)]
        windows = recognition_plan(intervals, ["a"], intervals[0][1])
        self.assertEqual(intervals, [(0, 1600000)])
        self.assertEqual(sum(w["end"] - w["start"] for w in windows), 1600000)
        self.assertTrue(any(w["overlapSamples"] == 16000 for w in windows))
        self.assertTrue(all(w["inputEnd"] - w["inputStart"] <= 35 * 16000 for w in windows))

    def test_never_borrows_another_speaker(self):
        windows = recognition_plan([(0, 40 * 16000), (40 * 16000, 48 * 16000)], ["a", "b"], 48 * 16000)
        a, b = [w for w in windows if w["label"] == "a"], [w for w in windows if w["label"] == "b"]
        self.assertLessEqual(max(w["inputEnd"] for w in a), 40 * 16000)
        self.assertGreaterEqual(b[0]["inputStart"], 40 * 16000)
        self.assertEqual(b[0]["overlapSamples"], 0)

    def test_unknown_does_not_merge_different_turns(self):
        windows = recognition_plan([(0, 16000), (18000, 34000)], ["unknown", "unknown"], 34000)
        self.assertEqual(len(windows), 2)
        self.assertTrue(all(w["overlapSamples"] == 0 for w in windows))

    def test_short_tail_balanced_not_dropped(self):
        windows = recognition_plan([(0, 36 * 16000)], ["a"], 36 * 16000)
        self.assertEqual(len(windows), 2)
        self.assertTrue(all(w["end"] - w["start"] >= 3 * 16000 for w in windows))
        self.assertEqual(windows[-1]["end"], 36 * 16000)

    def test_natural_pause_preferred(self):
        windows = recognition_plan([(0, 25 * 16000), (26 * 16000, 60 * 16000)], ["a", "a"], 60 * 16000)
        self.assertEqual(windows[0]["end"], int(25.5 * 16000))
        self.assertFalse(windows[1]["forcedStart"])

    def test_short_answer_kept(self):
        self.assertEqual(len(recognition_plan([(0, 5000)], ["unknown"], 5000)), 1)

    def test_invalid_bound_rejected(self):
        for limit in (0, 36, float("nan")):
            with self.assertRaises(ValueError):
                recognition_plan([(0, 1)], ["a"], 1, max_seconds=limit)

    def test_random_coverage_and_no_overlap_in_cores(self):
        rng = random.Random(7)
        for _ in range(300):
            intervals, labels, cursor = [], [], 0
            for index in range(rng.randint(1, 20)):
                start = cursor + rng.randint(0, 30000)
                cursor = start + rng.randint(1000, 1500000)
                intervals.append((start, cursor))
                labels.append(rng.choice(["a", "b", "unknown"]))
            windows = recognition_plan(intervals, labels, cursor)
            self.assertTrue(all(w["inputEnd"] - w["inputStart"] <= 560000 for w in windows))
            self.assertTrue(all(a["end"] <= b["start"] for a, b in zip(windows, windows[1:])))
            for start, end in intervals:
                covered = sum(max(0, min(end, w["end"]) - max(start, w["start"])) for w in windows)
                self.assertEqual(covered, end - start)


class WorkerLifetime(unittest.TestCase):
    def test_parent_exit_terminates_worker(self):
        alive, ended, codes = threading.Event(), threading.Event(), []
        alive.set()
        parent = SimpleNamespace(is_running=alive.is_set)
        def terminate(code):
            codes.append(code)
            ended.set()
        worker = watch_parent(parent, terminate, interval=0.001)
        self.assertFalse(ended.is_set())
        alive.clear()
        self.assertTrue(ended.wait(1))
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(codes, [70])


class Providers(unittest.TestCase):
    def make(self, replies=None, startup_error=False, fallback="sensevoice-local", provider="auto-local", sense="normal speech"):
        self.calls = []
        parent = self
        class FakeFun:
            receipt = {"ready": True}
            def __init__(self, *_):
                parent.calls.append("load")
                if startup_error:
                    raise RuntimeError("CUDA unavailable")
            def decode(self, samples, language, not_after=None):
                parent.calls.append(len(samples))
                parent.deadlines.append(not_after)
                return replies.pop(0)
            def close(self):
                parent.calls.append("close")
        self.deadlines = []
        return LocalProvider(SimpleNamespace(asr_provider=provider, fallback=fallback, language="zh"),
            lambda samples: {"text": sense}, None, factory=FakeFun)

    def test_unavailable_falls_back_once_per_job(self):
        provider = self.make(startup_error=True)
        self.assertEqual(provider.decode([0] * 16000, 0)["engine"], "sensevoice-local")
        provider.decode([0] * 16000, 16000)
        self.assertEqual(self.calls.count("load"), 1)
        self.assertIn("CUDA", provider.attempts[0]["error"])

    def test_disabled_fallback_fails(self):
        with self.assertRaises(RuntimeError):
            self.make(startup_error=True, fallback="none").decode([0] * 16000, 0)

    def test_explicit_sense_never_starts_fun(self):
        self.make(provider="sensevoice-local").decode([0] * 16000, 0)
        self.assertEqual(self.calls, [])

    def test_fun_reused_and_released(self):
        provider = self.make([{"text": "one"}, {"text": "two"}])
        provider.decode([0] * 16000, 0)
        provider.decode([0] * 16000, 16000)
        provider.close()
        self.assertEqual(self.calls.count("load"), 1)
        self.assertEqual(self.calls.count("close"), 1)

    def test_loop_retries_shorter_then_falls_back(self):
        provider = self.make([{"text": "x" * 100}] * 3)
        result = provider.decode([0] * 560000, 0)
        self.assertEqual(result["engine"], "sensevoice-local")
        self.assertEqual(self.calls, ["load", 560000, 280000, 280000])
        self.assertEqual(len([a for a in provider.attempts if a.get("issues")]), 3)

    def test_recovery_to_shorter_fun(self):
        provider = self.make([{"text": "bad", "reachedEos": False}, {"text": "first"}, {"text": "second"}])
        self.assertTrue(provider.decode([0] * 560000, 0)["recovered"])
        self.assertEqual(len(set(self.deadlines)), 1)

    def test_deadline_keeps_partial_without_retry_or_fallback(self):
        provider = self.make([{"text": "x" * 100, "completion": "partial",
                               "stopReason": "audio_duration_deadline", "reachedEos": False}])
        result = provider.decode([0] * 560000, 0)
        self.assertEqual(result["completion"], "partial")
        self.assertEqual(self.calls, ["load", 560000, "close"])

    def test_empty_deadline_is_preserved(self):
        provider = self.make([{"text": "", "completion": "partial", "reachedEos": False}])
        self.assertEqual(provider.decode([0] * 16000, 0)["text"], "")
        self.assertEqual(self.calls, ["load", 16000, "close"])

    def test_partial_recovery_is_not_published_as_complete(self):
        provider = self.make([{"text": "bad", "reachedEos": False},
                              {"text": "first", "completion": "partial", "stopReason":"audio_duration_deadline"}, {"text": "second"}])
        self.assertEqual(provider.decode([0] * 560000, 0)["completion"], "partial")
        self.assertEqual(self.calls, ["load", 560000, 280000, "close"])

    def test_token_limit_preserves_text_without_recovery_or_fallback(self):
        provider = self.make([{'text':'x'*100,'completion':'partial','stopReason':'output_token_limit',
                              'reachedEos':False,'tokens':512,'maxNewTokens':512}])
        result = provider.decode([0]*560000, 0)
        self.assertEqual(result['text'], 'x'*100)
        self.assertEqual(result['stopReason'], 'output_token_limit')
        self.assertEqual(self.calls, ['load',560000,'close'])

    def test_failed_fallback_not_published(self):
        with self.assertRaises(RuntimeError):
            self.make(startup_error=True, sense="").decode([0] * 16000, 0)

    def test_decoder_checks_not_accuracy(self):
        self.assertEqual(issues("好，好，再试一次"), [])
        self.assertTrue(issues("我今天天" * 50))
        self.assertTrue(issues("有文字", False))
        self.assertEqual(issues("说错的字也可能正常结束"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
