"""PC streaming tests. Fake devices only; no real microphone or production database."""

import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import queue
import signal
import sys
import tempfile
import time
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "voice-runtime"))
from runtime_common import RUNTIME, ASSETS, bootstrap, sha256, sidecar, write_json
bootstrap()
import numpy as np
import asr
import listen


class Detector:
    def __init__(self, segments=(), on_flush=()):
        self.schedule = list(segments)
        self.on_flush = list(on_flush)
        self.ready = []
        self.total = 0

    def accept_waveform(self, samples):
        self.total += len(samples)
        while self.schedule and self.schedule[0][2] <= self.total:
            start, end, _ = self.schedule.pop(0)
            self.ready.append(SimpleNamespace(start=start, samples=np.zeros(end - start)))

    def empty(self):
        return not self.ready

    @property
    def front(self):
        return self.ready[0]

    def pop(self):
        self.ready.pop(0)

    def flush(self):
        self.ready.extend(SimpleNamespace(start=a, samples=np.zeros(b - a)) for a, b in self.on_flush)

    def is_speech_detected(self):
        return bool(self.schedule and self.schedule[0][0] < self.total < self.schedule[0][2])

    @property
    def current_segment(self):
        return SimpleNamespace(start=self.schedule[0][0])


class ContinuousDetector:
    """No natural endpoint: flush keeps the absolute sample clock, as sherpa does."""
    def __init__(self, silence=0):
        self.total, self.silence = 0, silence
        self.start = None
        self.ready = []
        self.flushes = 0

    def accept_waveform(self, samples):
        if self.start is None and self.total >= self.silence:
            self.start = self.total
        self.total += len(samples)

    def is_speech_detected(self):
        return self.start is not None

    @property
    def current_segment(self):
        return SimpleNamespace(start=self.start)

    def empty(self):
        return not self.ready

    @property
    def front(self):
        return self.ready[0]

    def pop(self):
        self.ready.pop(0)

    def flush(self):
        self.flushes += 1
        if self.start is not None:
            self.ready.append(SimpleNamespace(start=self.start, samples=np.zeros(self.total - self.start)))
            self.start = None


class FakeSoundDevice:
    class CallbackStop(Exception):
        pass

    class CallbackAbort(Exception):
        pass

    def __init__(self, chunks=3, status=""):
        self.chunks, self.status = chunks, status
        self.closed = False
        self.opens = 0

    def RawInputStream(self, **kwargs):
        owner = self
        self.opens += 1

        class Stream:
            active = False

            def start(self):
                for _ in range(owner.chunks):
                    try:
                        kwargs["callback"](b"\x01\x00" * 512, 512, None, owner.status)
                    except (owner.CallbackStop, owner.CallbackAbort):
                        break

            def abort(self):
                self.active = False

            def close(self):
                owner.closed = True

        return Stream()


class FakeRuntime:
    def __init__(self, args):
        self.recognizer = self.extractor = object()
        self.loads = {"asr": 1, "embedding": 1}

    def release_heavy(self):
        self.recognizer = self.extractor = None


class ListenTests(unittest.TestCase):
    def setUp(self):
        temp_root = RUNTIME / "test-tmp"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.args = listen.arguments(["--replay", "unused.wav", "--output-root", str(self.root)])
        self.store = listen.SessionStore(self.root)
        self.start = datetime(2026, 10, 16, 1, 0, tzinfo=timezone.utc)

    def save(self, start=16000, count=16000):
        return self.store.save(start, start + count, b"\x01\x00" * count, self.start, self.args, True)

    def fake_worker(self, runner=None, infer=None):
        return listen.ClipWorker(self.args, self.store, runtime_factory=FakeRuntime,
                                 infer=infer or (lambda *_: {"schemaVersion": 1, "segments": []}),
                                 runner=runner or (lambda *_a, **_k: None))

    def feed(self, gate, count):
        for _ in range(count):
            gate.feed(b"\x01\x00" * 512)

    def test_arguments_require_explicit_mode_and_duration(self):
        for argv in ([], ["--microphone"], ["--microphone", "--seconds", "0.000001"],
                     ["--microphone", "--seconds", "nan"], ["--microphone", "--seconds", "43201"],
                     ["--replay", "x.wav", "--until-stopped"], ["--replay", "x.wav", "--device", "0"],
                     ["--replay", "x.wav", "--import"], ["--replay", "x.wav", "--database", "x.db"],
                     ["--replay", "x.wav", "--pre-roll-ms", "2000"],
                     ["--replay", "x.wav", "--idle-unload-seconds", "nan"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                listen.arguments(argv)

    def test_resume_only_existing_direct_session(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            listen.arguments(["--resume", str(self.root / "missing"), "--output-root", str(self.root)])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            listen.arguments(["--resume", str(self.root), "--output-root", str(self.root)])

    def test_silence_keeps_only_bounded_ring_no_emissions(self):
        clips = []
        gate = listen.SpeechGate(Detector(), np, lambda *x: clips.append(x))
        self.feed(gate, 4000)
        gate.finish()
        self.assertEqual(clips, [])
        self.assertLessEqual(gate.kept, gate.capacity + 512)

    def test_preroll_tail_and_exact_original_samples(self):
        clips = []
        gate = listen.SpeechGate(Detector([(16000, 24000, 28000)]), np, lambda *x: clips.append(x))
        self.feed(gate, 60)
        self.assertEqual(len(clips), 1)
        start, end, pcm = clips[0]
        self.assertEqual((start, end), (8000, 27200))
        self.assertEqual(pcm, b"\x01\x00" * (end - start))

    def test_continuous_speech_saves_before_eviction_with_exact_pcm(self):
        detector = ContinuousDetector()
        clips = []
        gate = listen.SpeechGate(detector, np, lambda *x: clips.append(x))
        source = (np.arange(95 * listen.RATE + 123, dtype=np.int64) % 65536 - 32768).astype('<i2')
        for offset in range(0, len(source), listen.FRAME):
            gate.feed(source[offset:offset + listen.FRAME].tobytes())
            self.assertLessEqual(gate.kept, gate.capacity + listen.FRAME)
        gate.finish()
        self.assertEqual(b''.join(c[2] for c in clips), source.tobytes())
        self.assertEqual(clips[0][0], 0)
        self.assertEqual(clips[-1][1], len(source))
        self.assertTrue(all(a[1] == b[0] for a,b in zip(clips, clips[1:])))
        self.assertTrue(all(b-a <= 20*listen.RATE + listen.FRAME for a,b,_ in clips))
        self.assertEqual(gate.forced_splits, 4)

    def test_long_silence_does_not_make_new_speech_a_tiny_periodic_chunk(self):
        detector = ContinuousDetector(silence=19*listen.RATE)
        clips = []
        gate = listen.SpeechGate(detector, np, lambda *x: clips.append(x))
        self.feed(gate, 1100)  # 35.2 seconds, only ~16 seconds of speech
        self.assertEqual(clips, [])
        gate.finish()
        self.assertEqual(len(clips), 1)
        self.assertEqual(gate.forced_splits, 0)

    def test_forced_split_publish_failure_preserves_pending_audio(self):
        detector = ContinuousDetector()
        def fail(*_):
            raise RuntimeError('disk failure')
        gate = listen.SpeechGate(detector, np, fail)
        with self.assertRaisesRegex(RuntimeError, 'disk failure'):
            self.feed(gate, 625)
        self.assertFalse(detector.empty())
        self.assertEqual(gate.last_end, 0)
        self.assertEqual(gate.clips, 0)
        self.assertEqual(gate.buffers[0][0], 0)
        clips = []
        gate.emit = lambda *x: clips.append(x)
        gate.finish()
        self.assertEqual(clips[0][2], b'\x01\x00' * (20 * listen.RATE))

    def test_native_vad_soft_limit_cannot_overrun_ring(self):
        self.check_native_vad()

    def test_native_forced_split_then_silence_can_resume_speech(self):
        self.check_native_vad(pause_after_split=True)

    def check_native_vad(self, pause_after_split=False):
        import sherpa_onnx as sherpa
        _, models = asr.load_models(ASSETS / 'models', False)
        config = sherpa.VadModelConfig()
        config.silero_vad.model = models['vad']
        config.silero_vad.threshold = 0.5
        config.silero_vad.min_speech_duration = 0.25
        config.silero_vad.min_silence_duration = 0.8
        # Deliberately disable the native 20s soft target. Our gate owns the bound.
        config.silero_vad.max_speech_duration = 3600
        config.sample_rate = listen.RATE
        config.num_threads = 1
        detector = sherpa.VoiceActivityDetector(config, buffer_size_in_seconds=30)
        clips = []
        with wave.open(str(ASSETS / 'fixtures' / 'BAC009S0764W0121.wav'), 'rb') as audio:
            self.assertEqual((audio.getframerate(), audio.getnchannels(), audio.getsampwidth()),
                             (listen.RATE, 1, 2))
            speech = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
        # Repeat a voiced interval from the public fixture, not private recordings.
        source = np.tile(speech[listen.RATE:2*listen.RATE], 65)
        if pause_after_split:
            source = np.concatenate((source[:20*listen.RATE+listen.FRAME],
                                     np.zeros(3*listen.RATE, dtype='<i2'),
                                     source[:5*listen.RATE],
                                     np.zeros(2*listen.RATE, dtype='<i2')))
        def verify(start, end, pcm):
            self.assertEqual(pcm, source[start:end].tobytes())
            clips.append((start, end))
        gate = listen.SpeechGate(detector, np, verify)
        for offset in range(0, len(source), listen.FRAME):
            gate.feed(source[offset:offset+listen.FRAME].tobytes())
            self.assertLessEqual(gate.kept, gate.capacity+listen.FRAME)
        gate.finish()
        self.assertGreaterEqual(gate.forced_splits, 1 if pause_after_split else 3)
        self.assertTrue(all(a[1] <= b[0] for a,b in zip(clips,clips[1:])))
        self.assertTrue(all(b-a <= 20*listen.RATE+listen.FRAME for a,b in clips))
        if pause_after_split:
            self.assertTrue(any(a <= 24*listen.RATE and b >= 27*listen.RATE for a,b in clips))
        else:
            self.assertTrue(all(a[1] == b[0] for a,b in zip(clips,clips[1:])))
            self.assertEqual(clips[-1][1], len(source))

    def test_forty_minute_continuous_stream_has_bounded_storage_and_exact_offsets(self):
        count = 0
        last = 0
        def verify(start, end, pcm):
            nonlocal count, last
            self.assertEqual(start, last)
            self.assertEqual(pcm, b'\x01\x00' * (end-start))
            count += 1
            last = end
        gate = listen.SpeechGate(ContinuousDetector(), np, verify)
        self.feed(gate, 40*60*listen.RATE//listen.FRAME)
        gate.finish()
        self.assertEqual(count, 120)
        self.assertEqual(last, 40*60*listen.RATE)
        self.assertLessEqual(gate.kept, gate.capacity+listen.FRAME)

    def test_neighboring_segments_do_not_duplicate_audio(self):
        clips = []
        gate = listen.SpeechGate(Detector([(4000, 8000, 12000), (10000, 16000, 19000)]),
                                 np, lambda *x: clips.append(x))
        self.feed(gate, 40)
        self.assertEqual(len(clips), 2)
        self.assertEqual(clips[1][0], clips[0][1])

    def test_short_final_frame_flush_clamps_to_actual_samples(self):
        clips = []
        gate = listen.SpeechGate(Detector(on_flush=[(0, 512)]), np, lambda *x: clips.append(x))
        gate.feed(b"\x02\x00" * 123)
        gate.finish()
        self.assertEqual(clips[0], (0, 123, b"\x02\x00" * 123))

    def test_failed_publication_does_not_pop_the_detector_segment(self):
        def fail(*_):
            raise KeyboardInterrupt()
        detector = Detector([(0, 512, 512)])
        gate = listen.SpeechGate(detector, np, fail)
        with self.assertRaises(KeyboardInterrupt):
            gate.feed(b"\x01\x00" * 512)
        self.assertFalse(detector.empty())
        self.assertEqual(gate.clips, 0)
        published = []
        gate.emit = lambda *item: published.append(item)
        gate.finish()
        self.assertEqual(len(published), 1)
        self.assertTrue(detector.empty())

    def test_sigint_during_publication_sets_stop_without_interrupting_save(self):
        previous = signal.getsignal(signal.SIGINT)
        stored = []
        def fake_run(args, stop_requested):
            def publish(start, end, pcm):
                signal.raise_signal(signal.SIGINT)
                stored.append(self.store.save(start, end, pcm, self.start, self.args, True))
            gate = listen.SpeechGate(Detector([(0, 512, 512)]), np, publish)
            gate.feed(b"\x01\x00" * 512)
            self.assertTrue(stop_requested.is_set())
            self.assertEqual(gate.clips, 1)
            self.assertTrue(gate.detector.empty())
            return {"stopRequested": True}
        with patch.object(listen, "run", side_effect=fake_run), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(listen.main(["--replay", "unused.wav"]), 0)
        self.assertTrue(sidecar(stored[0] / "audio.wav").exists())
        self.assertEqual(signal.getsignal(signal.SIGINT), previous)

    def test_invalid_and_expired_frames_fail_instead_of_fabricating(self):
        gate = listen.SpeechGate(Detector(), np, lambda *_: None)
        for pcm in (b"", b"\x00", b"\x00\x00" * 513):
            with self.assertRaises(ValueError):
                gate.feed(pcm)
        self.feed(gate, 1000)
        gate.detector.on_flush = [(0, 16000)]
        with self.assertRaisesRegex(RuntimeError, "buffer"):
            gate.finish()

    def test_manifest_time_uses_sample_offset_and_same_conversation(self):
        first, second = self.save(), self.save(64000)
        a, b = [json.loads(sidecar(p / "audio.wav").read_text(encoding="utf-8")) for p in (first, second)]
        self.assertEqual(a["recordedAt"], (self.start + timedelta(seconds=1)).isoformat())
        self.assertEqual(b["recordedAt"], (self.start + timedelta(seconds=4)).isoformat())
        self.assertEqual(a["conversationId"], b["conversationId"])
        self.assertNotEqual(a["recordingId"], b["recordingId"])
        self.assertEqual(a["sha256"], sha256(first / "audio.wav"))
        self.assertTrue(a["testOnly"])
        with wave.open(str(first / "audio.wav"), "rb") as wav:
            self.assertEqual(wav.getnframes(), 16000)

    def test_quota_and_free_space_stop_before_publication(self):
        self.store.max_bytes = 1
        with self.assertRaisesRegex(RuntimeError, "storage limit"):
            self.save()
        self.assertEqual(list(self.store.directory.iterdir()), [])
        self.store.max_bytes = 2 * 1024**3
        with patch.object(listen.shutil, "disk_usage", return_value=SimpleNamespace(free=0)), self.assertRaises(RuntimeError):
            self.save()

    def test_idle_worker_loads_nothing(self):
        worker = self.fake_worker()
        worker.start()
        worker.finish()
        self.assertIsNone(worker.runtime)

    def test_worker_reuses_runtime_and_saves_hash_bound_transcript(self):
        seen = []
        worker = self.fake_worker(infer=lambda _, runtime: seen.append(runtime) or {"schemaVersion": 1})
        directories = [self.save(), self.save(64000)]
        worker.start()
        for directory in directories:
            worker.enqueue(directory)
        worker.finish()
        self.assertIs(seen[0], seen[1])
        self.assertEqual(worker.completed, 2)
        envelope = json.loads((directories[0] / "transcript.json").read_text(encoding="utf-8"))
        self.assertEqual(envelope["audioSha256"], sha256(directories[0] / "audio.wav"))

    def test_idle_unloads_heavy_models(self):
        self.args.idle_unload_seconds = 0.01
        worker = self.fake_worker()
        worker.start()
        worker.enqueue(self.save())
        deadline = time.monotonic() + 3
        while not worker.unloads and not worker.failed.is_set() and time.monotonic() < deadline:
            time.sleep(0.02)
        worker.finish()
        self.assertEqual(worker.unloads, 1)
        self.assertIsNone(worker.runtime.recognizer)

    def test_optional_acoustic_link_failure_keeps_transcription_and_can_retry(self):
        directory = self.save()
        result = {"schemaVersion": 1, "segments": [],
                  "speakers": [{"label": "speaker_00", "embedding": [1, 0]}]}
        worker = self.fake_worker(infer=lambda *_: result)
        with patch.object(listen.subprocess, "run", side_effect=OSError("Node unavailable")):
            worker.process(directory)
        link = json.loads((directory / "speaker-links.json").read_text(encoding="utf-8"))
        self.assertEqual(link["status"], "pending_retry")
        self.assertEqual(json.loads((directory / "state.json").read_text())["status"], "transcribed")
        with patch.object(listen.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout='{"speakers":[]}', stderr="")):
            worker.process(directory)
        self.assertNotIn("status", json.loads((directory / "speaker-links.json").read_text()))
        self.assertTrue((directory / "audio.wav").exists())

    def test_backlog_rejects_without_deleting_saved_audio(self):
        worker = self.fake_worker()
        directory = self.save()
        for _ in range(16):
            worker.enqueue(directory)
        with self.assertRaisesRegex(RuntimeError, "backlog"):
            worker.enqueue(directory)
        self.assertTrue(sidecar(directory / "audio.wav").is_file())

    def test_inference_failure_retains_original_and_marks_failure(self):
        directory = self.save()
        def fail(*_):
            raise RuntimeError("inference test failure")
        worker = self.fake_worker(infer=fail)
        worker.start()
        worker.enqueue(directory)
        with self.assertRaisesRegex(RuntimeError, "resume"):
            worker.finish()
        self.assertEqual(json.loads((directory / "state.json").read_text())["status"], "failed")
        self.assertTrue((directory / "audio.wav").exists())

    def test_tampered_original_or_transcript_is_rejected(self):
        directory = self.save()
        worker = self.fake_worker()
        write_json(directory / "transcript.json", {"schemaVersion": 1, "audioSha256": "0" * 64})
        with self.assertRaisesRegex(ValueError, "transcript checksum"):
            worker.process(directory)
        (directory / "audio.wav").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "audio checksum"):
            worker.process(directory)

    def test_cached_envelope_without_result_is_not_completed(self):
        directory = self.save()
        write_json(directory / "transcript.json", {"schemaVersion": 1,
                   "audioSha256": sha256(directory / "audio.wav")})
        with self.assertRaisesRegex(ValueError, "complete ASR"):
            self.fake_worker().process(directory)
        self.assertFalse((directory / "state.json").exists())

    def test_import_success_receipt_and_cached_recovery(self):
        self.args.do_import, self.args.database = True, self.root / "isolated.sqlite"
        calls = []
        def runner(command, **_):
            calls.append(command)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"result": {
                "recordingId": "a" * 32, "evidenceIds": [], "emptySpeech": True}}), stderr="")
        directory = self.save()
        worker = self.fake_worker(runner=runner)
        worker.process(directory)
        recovery = self.fake_worker(runner=runner, infer=lambda *_: self.fail("Cached transcript must not rerun ASR"))
        recovery.process(directory)
        self.assertIn("--transcript", calls[0])
        self.assertEqual(recovery.imported, 1)
        self.assertIsNone(recovery.runtime)

    def test_import_busy_not_claimed_as_success(self):
        self.args.do_import, self.args.database = True, self.root / "isolated.sqlite"
        def runner(*_a, **_k):
            return SimpleNamespace(returncode=0, stdout=json.dumps({"result": {"recordingId": "x", "busy": True}}))
        with self.assertRaisesRegex(RuntimeError, "completed receipt"):
            self.fake_worker(runner=runner).process(self.save())

    def test_test_only_recovery_cannot_default_to_production(self):
        self.args.do_import = True
        with self.assertRaisesRegex(ValueError, "isolated"):
            self.fake_worker().process(self.save())

    def test_output_root_is_single_instance(self):
        with listen.exclusive_root(self.root):
            with self.assertRaisesRegex(RuntimeError, "Another PC"):
                with listen.exclusive_root(self.root):
                    self.fail("Second lock must fail")
        with listen.exclusive_root(self.root):
            pass

    def test_fake_device_closes_and_flushes_on_finite_capture(self):
        self.args.seconds = 0.09
        clips = []
        gate = listen.SpeechGate(Detector(on_flush=[(0, 2000)]), np, lambda *x: clips.append(x))
        fake = FakeSoundDevice()
        listen.capture_stream(self.args, gate, self.fake_worker(), fake, self.root / "STOP")
        self.assertTrue(fake.closed)
        self.assertEqual(gate.total, 1440)
        self.assertEqual(clips[0][1], 1440)

    def test_stop_request_prevents_opening_device(self):
        stopped = threading.Event()
        stopped.set()
        fake = FakeSoundDevice()
        gate = listen.SpeechGate(Detector(), np, lambda *_: None)
        listen.capture_stream(self.args, gate, self.fake_worker(), fake, self.root / "STOP", stopped)
        self.assertEqual(fake.opens, 0)

    def test_stream_time_anchor_is_set_after_device_creation(self):
        self.args.seconds = 0.09
        fake = FakeSoundDevice()
        timestamps = []
        def started(moment):
            self.assertEqual(fake.opens, 1)
            timestamps.append(moment)
        gate = listen.SpeechGate(Detector(), np, lambda *_: None)
        listen.capture_stream(self.args, gate, self.fake_worker(), fake, self.root / "STOP", on_started=started)
        self.assertEqual(len(timestamps), 1)
        self.assertIsNotNone(timestamps[0].tzinfo)

    def test_stop_while_awaiting_frame_flushes_final_speech(self):
        self.args.seconds = None
        stopped = threading.Event()
        clips = []
        gate = listen.SpeechGate(Detector(on_flush=[(0, 512)]), np, lambda *item: clips.append(item))
        class StoppingDevice(FakeSoundDevice):
            def RawInputStream(self, **kwargs):
                owner = self
                class Stream:
                    def start(self):
                        kwargs["callback"](b"\x01\x00" * 512, 512, None, "")

                    @property
                    def active(self):
                        # Models SIGINT + CallbackStop during queue.get's timeout.
                        stopped.set()
                        return False

                    def abort(self):
                        pass

                    def close(self):
                        owner.closed = True
                return Stream()
        fake = StoppingDevice()
        listen.capture_stream(self.args, gate, self.fake_worker(), fake, self.root / "STOP", stopped)
        self.assertTrue(stopped.is_set() and fake.closed)
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0][1], 512)

    def test_cached_runtime_rechecks_weights_when_loading_again(self):
        asset = self.root / "weights.onnx"
        asset.write_bytes(b"original")
        runtime = asr.AsrRuntime.__new__(asr.AsrRuntime)
        runtime.models = {"asr": str(asset)}
        runtime.manifest = {"files": {"asr": {"sha256": sha256(asset)}}}
        runtime.verify_asset("asr")
        asset.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Model changed"):
            runtime.verify_asset("asr")

    def test_device_overflow_and_callback_backlog_abort_without_flush(self):
        self.args.seconds = None
        for fake in (FakeSoundDevice(status="input overflow"), FakeSoundDevice(chunks=140)):
            gate = listen.SpeechGate(Detector(on_flush=[(0, 512)]), np, lambda *_: self.fail("No partial publication"))
            with self.assertRaises(RuntimeError):
                listen.capture_stream(self.args, gate, self.fake_worker(), fake, self.root / "STOP")
            self.assertTrue(fake.closed)

    def test_unexpected_device_stop_does_not_auto_restart(self):
        self.args.seconds = None
        fake = FakeSoundDevice(chunks=1)
        gate = listen.SpeechGate(Detector(), np, lambda *_: None)
        with self.assertRaisesRegex(RuntimeError, "unexpectedly"):
            listen.capture_stream(self.args, gate, self.fake_worker(), fake, self.root / "STOP")
        self.assertEqual(fake.opens, 1)


if __name__ == "__main__":
    buffer = io.StringIO()
    result = unittest.TextTestRunner(stream=buffer, verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ListenTests))
    print(buffer.getvalue())
    (RUNTIME / "results").mkdir(parents=True, exist_ok=True)
    (RUNTIME / "results" / "listen-unit-tests.txt").write_text(buffer.getvalue(), encoding="utf-8")
    write_json(RUNTIME / "results" / "listen-unit-tests.json", {
        "testOnly": True, "testsRun": result.testsRun, "errors": len(result.errors),
        "failures": len(result.failures), "captureBackend": "fake-only"})
    sys.exit(0 if result.wasSuccessful() else 1)
