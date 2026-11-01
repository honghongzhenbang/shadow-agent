"""Recovery policy tests with fake clocks/devices; never opens a microphone."""
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "voice-runtime"))
import listen


class BackendError(Exception):
    pass


class RecoveryTests(unittest.TestCase):
    def test_clock_accepts_regular_frames_and_small_jitter(self):
        clock = listen.CaptureClock()
        for i in range(100):
            clock.check(512, 10+i*.032, 1000+i*.032, 20+i*.032)

    def test_clock_catches_suspend_even_when_monotonic_pauses(self):
        for mono in (10.032, 60.032):
            clock = listen.CaptureClock()
            clock.check(512, 10, 1000, 20)
            with self.assertRaisesRegex(listen.CaptureInterrupted, "clock discontinuity"):
                clock.check(512, mono, 1050.032, 20.032)

    def test_clock_catches_device_gap_and_backward_utc_adjustment(self):
        for mono, utc, adc in ((10.032, 1000.032, 22), (10.032, 990, 20.032)):
            clock = listen.CaptureClock()
            clock.check(512, 10, 1000, 20)
            with self.assertRaises(listen.CaptureInterrupted):
                clock.check(512, mono, utc, adc)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.stop_file = Path(self.temp.name) / "STOP"
        self.stop = threading.Event()
        self.clock = 0.0
        self.states = []
        self.epochs = []
        self.args = SimpleNamespace(seconds=60, device=None)
        self.worker = SimpleNamespace(failed=threading.Event(), error=None)

    def wait(self, seconds):
        self.clock += seconds

    def make_gate(self, epoch):
        self.epochs.append(epoch)
        return SimpleNamespace(total=0, clips=0), lambda _: None

    def run_capture(self, capture):
        return listen.recover_capture(self.args, self.worker, SimpleNamespace(PortAudioError=BackendError),
                                      self.stop_file, self.stop, self.make_gate, self.states.append,
                                      capture=capture, monotonic=lambda: self.clock, wait=self.wait)

    def test_busy_then_ready_new_epoch_keeps_same_wallclock_deadline(self):
        calls = []
        def capture(args, gate, worker, sd, stop_file, stop, started):
            calls.append(args.seconds)
            if len(calls) == 1:
                self.clock += 10
                raise BackendError("busy", -9985)
            started(datetime.now(timezone.utc))
            gate.total = 16000
        result = self.run_capture(capture)
        self.assertEqual(result.interruptions, 1)
        self.assertEqual(result.total, 16000)
        self.assertAlmostEqual(calls[1], 49, places=5)
        self.assertEqual(len(set(self.epochs)), 2)
        self.assertEqual([s["state"] for s in self.states], ["waiting_for_input", "capturing", "stopped"])

    def test_stop_during_retry_never_reopens(self):
        def capture(*_):
            raise BackendError("busy", -9985)
        def wait(seconds):
            self.stop.set()
            self.clock += seconds
        self.wait = wait
        self.run_capture(capture)
        self.assertEqual(len(self.epochs), 1)

    def test_stop_file_prevents_any_open(self):
        self.stop_file.touch()
        self.run_capture(lambda *_: self.fail("must not open"))
        self.assertEqual(self.epochs, [])

    def test_storage_and_pipeline_failures_are_not_retried(self):
        for error in (RuntimeError("storage full"), BackendError("invalid rate", -9997)):
            self.epochs.clear()
            def capture(*_):
                raise error
            with self.assertRaises(type(error)):
                self.run_capture(capture)
            self.assertEqual(len(self.epochs), 1)

    def test_buffer_gap_reopens_with_new_epoch_and_records_reason(self):
        def capture(args, gate, worker, sd, stop_file, stop, started):
            started(datetime.now(timezone.utc))
            gate.total, gate.clips, gate.forced_splits = 16000, 1, 1
            if len(self.epochs) == 1:
                self.clock += 12
                raise listen.CaptureBufferInterrupted('requested=[0,448000), retained=[58880,448000); capture gap')
        result = self.run_capture(capture)
        self.assertEqual(result.interruptions, 1)
        self.assertEqual(result.forced_splits, 2)
        self.assertEqual(len(set(self.epochs)), 2)
        waiting = next(s for s in self.states if s['state'] == 'waiting_for_input')
        self.assertTrue(waiting['partialTailDiscarded'])
        self.assertIn('retained=', waiting['reason'])
        self.assertEqual(result.total, 32000)

    def test_buffer_gap_stop_during_backoff_never_reopens(self):
        def capture(*_):
            raise listen.CaptureBufferInterrupted('capture gap')
        def wait(seconds):
            self.stop_file.touch()
            self.clock += seconds
        self.wait = wait
        self.run_capture(capture)
        self.assertEqual(len(self.epochs), 1)

    def test_backoff_bounded_and_deadline_does_not_extend_capture(self):
        self.args.seconds = 90
        def capture(*_):
            raise BackendError("device gone", -9996)
        result = self.run_capture(capture)
        delays = [s["retryInSeconds"] for s in self.states if s["state"] == "waiting_for_input"]
        self.assertEqual(delays[:5], [1, 2, 5, 10, 30])
        self.assertLessEqual(max(delays), 30)
        self.assertAlmostEqual(self.clock, 90, places=4)
        self.assertTrue(self.states[-1]["deadlineReached"])
        self.assertGreater(result.interruptions, 0)

    def test_worker_failure_during_wait_is_not_device_failure(self):
        def capture(*_):
            self.worker.failed.set()
            self.worker.error = "test inference error"
            raise listen.CaptureInterrupted("device lost")
        with self.assertRaisesRegex(RuntimeError, "Transcriber stopped"):
            self.run_capture(capture)
        self.assertEqual(len(self.epochs), 1)

    def test_wasapi_shared_mode_without_changing_device(self):
        calls = []
        sd = SimpleNamespace(query_devices=lambda device, kind: calls.append((device, kind)) or {"hostapi": 3},
                             query_hostapis=lambda _: {"name": "Windows WASAPI"},
                             WasapiSettings=lambda **kw: kw)
        self.assertEqual(listen.shared_input_settings(sd, 7), {"extra_settings": {"exclusive": False}})
        self.assertEqual(calls, [(7, "input")])
        sd.query_hostapis = lambda _: {"name": "MME"}
        self.assertEqual(listen.shared_input_settings(sd, 7), {})


if __name__ == "__main__":
    unittest.main()
