"""Opt-in PC speech capture. Replay/recovery never open a microphone."""

import argparse
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import gc
import hashlib
import json
import math
from pathlib import Path
import platform
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import uuid
import wave

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_common import (ROOT, RUNTIME, ASSETS, audio_manifest, bootstrap, deny_network,
                            emit_error, sha256, sidecar, write_json)
import asr

RATE = 16000
FRAME = 512


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--microphone", action="store_true", help="Explicitly open the microphone; Ctrl+C stops")
    mode.add_argument("--replay", type=Path, help="Local audio replay, always test-only; no microphone")
    mode.add_argument("--resume", type=Path, help="Retry an existing session's saved clips; no microphone")
    duration = parser.add_mutually_exclusive_group()
    duration.add_argument("--seconds", type=float)
    duration.add_argument("--until-stopped", action="store_true")
    parser.add_argument("--output-root", type=Path, default=RUNTIME / "live")
    parser.add_argument("--model-dir", type=Path, default=ASSETS / "models")
    parser.add_argument("--device", type=int)
    parser.add_argument("--device-id", default="pc-" + hashlib.sha256(platform.node().encode()).hexdigest()[:16])
    parser.add_argument("--threads", type=int, default=2, help="ASR/embedding threads; front-end VAD uses one")
    parser.add_argument("--pre-roll-ms", type=int, default=500)
    parser.add_argument("--silence-ms", type=int, default=800)
    parser.add_argument("--idle-unload-seconds", type=float, default=180)
    parser.add_argument("--import", dest="do_import", action="store_true", help="Import through the existing voice Evidence path")
    parser.add_argument("--database", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--capture-only", action="store_true", help="Persist complete clips for the main durable intake; no separate ASR/import")
    args = parser.parse_args(argv)
    if args.capture_only and args.do_import:
        parser.error("--capture-only cannot also run a direct importer")
    if args.microphone and args.seconds is None and not args.until_stopped:
        parser.error("--microphone requires --seconds or --until-stopped")
    if not args.microphone and (args.seconds is not None or args.until_stopped or args.device is not None):
        parser.error("Capture duration/device options require --microphone")
    if args.seconds is not None and (not math.isfinite(args.seconds) or not 0 < args.seconds <= 43200):
        parser.error("--seconds must be finite and in (0, 43200]")
    if args.seconds is not None and round(args.seconds * RATE) < 1:
        parser.error("Duration must contain at least one sample")
    if not 1 <= args.threads <= 16 or not 0 <= args.pre_roll_ms <= 1000 or not 300 <= args.silence_ms <= 2000:
        parser.error("Threads: 1-16; pre-roll: 0-1000 ms; silence: 300-2000 ms")
    if not math.isfinite(args.idle_unload_seconds) or not 1 <= args.idle_unload_seconds <= 3600:
        parser.error("--idle-unload-seconds must be in [1, 3600]")
    if not args.device_id.strip():
        parser.error("--device-id must not be empty")
    if args.database and not args.do_import:
        parser.error("--database requires --import")
    if args.replay and args.do_import and not args.database:
        parser.error("Replay import requires an explicit isolated --database")
    args.output_root = args.output_root.resolve()
    if args.resume and args.resume.resolve().parent != args.output_root:
        parser.error("--resume must be a direct session directory under --output-root")
    if args.resume and not args.resume.is_dir():
        parser.error("--resume must name an existing session")
    return args


class CaptureInterrupted(RuntimeError):
    """A recoverable capture interruption, never a storage or ASR failure."""


class CaptureBufferInterrupted(CaptureInterrupted):
    """Lost PCM must be reported as a gap, never published as contiguous audio."""


class CaptureClock:
    """Detect suspend/device gaps before assigning PCM to an old UTC epoch."""
    def __init__(self):
        self.previous = None

    def check(self, frames, monotonic_at, utc_at, adc_at=None):
        current = (frames, monotonic_at, utc_at, adc_at)
        if self.previous is not None:
            count, mono, utc, adc = self.previous
            expected = count / RATE
            elapsed = monotonic_at - mono
            wall_elapsed = utc_at - utc
            if elapsed - expected > 2 or abs(wall_elapsed - elapsed) > 2:
                raise CaptureInterrupted(
                    f"Capture clock discontinuity: expected={expected:.3f}s, "
                    f"callback={elapsed:.3f}s, wall={wall_elapsed:.3f}s; capture gap")
            if adc is not None and adc_at is not None and (
                    adc_at < adc or abs(adc_at - adc - expected) > 0.5):
                raise CaptureInterrupted(
                    f"ADC clock discontinuity: expected={expected:.3f}s, adc={adc_at-adc:.3f}s; capture gap")
        self.previous = current


class SpeechGate:
    """Streaming Silero decisions, bounded original PCM context, absolute sample offsets."""

    def __init__(self, detector, np, emit, pre_roll_ms=500, silence_ms=800):
        self.detector, self.np, self.emit = detector, np, emit
        self.pre = round(pre_roll_ms * RATE / 1000)
        self.tail = round(0.2 * RATE)
        self.max_segment_samples = 20 * RATE
        self.capacity = self.max_segment_samples + round((silence_ms / 1000 + pre_roll_ms / 1000 + 3) * RATE)
        self.buffers = deque()
        self.total = self.kept = self.last_end = self.clips = 0
        self.active_start = None
        self.forced_splits = 0

    def feed(self, pcm):
        samples = self.np.frombuffer(pcm, dtype="<i2").astype(self.np.float32) / 32768
        if not 0 < len(samples) <= FRAME:
            raise ValueError("Capture frame must contain 1-512 PCM16 samples")
        self.buffers.append((self.total, samples))
        self.total += len(samples)
        self.kept += len(samples)
        self.detector.accept_waveform(self.np.pad(samples, (0, FRAME - len(samples))))
        self._drain()
        if self.detector.is_speech_detected():
            if self.active_start is None:
                self.active_start = self.detector.current_segment.start
            start = max(0, self.last_end, self.active_start - self.pre)
            if self.total - start >= self.max_segment_samples:
                # sherpa's max_speech_duration is a soft VAD target, not a bound.
                # Flush preserves its absolute clock; save before evicting PCM.
                self.detector.flush()
                self._drain()
                self.forced_splits += 1
                self.active_start = None
        else:
            self.active_start = None
        while self.buffers and self.kept - len(self.buffers[0][1]) >= self.capacity:
            self.kept -= len(self.buffers.popleft()[1])

    def _drain(self):
        while not self.detector.empty():
            segment = self.detector.front
            start = max(0, self.last_end, segment.start - self.pre)
            end = min(self.total, segment.start + len(segment.samples) + self.tail)
            if end <= start:
                self.detector.pop()
                continue
            if not self.buffers or start < self.buffers[0][0]:
                oldest = self.buffers[0][0] if self.buffers else self.total
                raise CaptureBufferInterrupted(
                    f"VAD segment exceeded the bounded audio buffer: requested=[{start},{end}), "
                    f"retained=[{oldest},{self.total}), capacity={self.capacity}; capture gap")
            pieces = [data[max(0, start - offset):min(len(data), end - offset)]
                      for offset, data in self.buffers if offset < end and offset + len(data) > start]
            samples = self.np.concatenate(pieces)
            if len(samples) != end - start:
                raise CaptureBufferInterrupted(
                    f"Missing samples: requested=[{start},{end}), available={len(samples)}; capture gap")
            pcm = self.np.rint(samples * 32768).clip(-32768, 32767).astype("<i2").tobytes()
            self.emit(start, end, pcm)
            self.detector.pop()
            self.last_end, self.clips = end, self.clips + 1

    def finish(self):
        self.detector.flush()
        self._drain()


class SessionStore:
    def __init__(self, root, session_id=None, max_bytes=2 * 1024**3, min_free=256 * 1024**2):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.directory = self.root / (session_id or str(uuid.uuid4()))
        self.directory.mkdir(exist_ok=session_id is not None)
        self.max_bytes, self.min_free = max_bytes, min_free
        self.lock = threading.Lock()
        self.used = sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())

    def reserve(self, size):
        if self.used + size > self.max_bytes or shutil.disk_usage(self.root).free - size < self.min_free:
            raise RuntimeError("Voice storage limit/low disk space; capture stopped, existing audio retained")
        self.used += size

    def json(self, path, value):
        size = len(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")) + 1
        with self.lock:
            # Reserve the temporary copy as well; replacement is atomic.
            old = path.stat().st_size if path.exists() else 0
            self.reserve(size)
            write_json(path, value)
            self.used -= old

    def save(self, start, end, pcm, started_at, args, test_only, stream_id=None):
        if len(pcm) != (end - start) * 2:
            raise ValueError("PCM length differs from sample offsets")
        directory = self.directory / str(uuid.uuid4())
        with self.lock:
            self.reserve(len(pcm) + 44)
            directory.mkdir()
            audio = directory / "audio.wav"
            with audio.open("xb") as raw:
                with wave.open(raw, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(RATE)
                    wav.writeframes(pcm)
                raw.flush()
                import os
                os.fsync(raw.fileno())
        recorded = (started_at + timedelta(seconds=start / RATE)).isoformat()
        manifest = audio_manifest(audio, started_at=recorded, sample_rate=RATE,
                                  sample_count=end - start, channels=1,
                                  source_type="pc-stream-vad", test_only=test_only,
                                  details={"streamSampleStart": start, "streamSampleEnd": end,
                                           "streamId": stream_id or self.directory.name,
                                           "preRollMs": args.pre_roll_ms, "silenceMs": args.silence_ms,
                                           "warnings": ["VAD-filtered clip; unselected silence is not archived"]})
        # PC VAD clips use the same post-capture package contract as phone recordings.
        # A local clip is one complete part; phone captures may contain many fixed parts.
        manifest.update({"kind": "voice-recording-package-part",
                         "deviceId": args.device_id, "recordingId": directory.name,
                         "conversationId": "pc-capture:" + self.directory.name,
                         "packageId": directory.name, "partIndex": 0,
                         "previousRecordingId": None, "finalPart": True,
                         "recordedAt": recorded, "audioPath": audio.name,
                         "timeBasis": "test_replay_time" if test_only else "pc_stream_start_utc_estimate",
                         "timeUncertaintyMs": None, "source": "explicit_pc_vad_capture"})
        # The manifest is the durable-complete marker. Incomplete WAVs are never queued.
        self.json(sidecar(audio), manifest)
        return directory


def inference_args(args, audio):
    return SimpleNamespace(audio=audio, model_dir=args.model_dir, threads=args.threads,
                           diarization="vad-cluster", cluster_threshold=0.5, language="zh", max_seconds=60)


class ClipWorker:
    def __init__(self, args, store, runtime_factory=asr.AsrRuntime, infer=asr.run, runner=subprocess.run):
        self.args, self.store = args, store
        self.runtime_factory, self.infer, self.runner = runtime_factory, infer, runner
        self.jobs = queue.Queue(maxsize=16)
        self.stop, self.failed = threading.Event(), threading.Event()
        self.error = None
        self.runtime = None
        self.completed = self.imported = self.unloads = 0
        self.thread = threading.Thread(target=self._work, name="voice-transcriber", daemon=False)

    def start(self):
        self.thread.start()

    def enqueue(self, directory):
        if self.failed.is_set():
            raise RuntimeError("Transcriber failed: " + str(self.error))
        try:
            self.jobs.put_nowait(directory)
        except queue.Full:
            raise RuntimeError("Transcription backlog is full; capture stopped, saved clips can be resumed")

    def process(self, directory):
        audio, output = directory / "audio.wav", directory / "transcript.json"
        if sidecar(audio).stat().st_size > 65536:
            raise ValueError("Saved manifest is too large")
        manifest = json.loads(sidecar(audio).read_text(encoding="utf-8"))
        if manifest.get("sha256") != sha256(audio):
            raise ValueError("Saved audio checksum mismatch")
        if manifest.get("testOnly") and self.args.do_import and not self.args.database:
            raise ValueError("Test-only recovery requires an explicit isolated --database")
        if getattr(self.args, "capture_only", False):
            self.store.json(directory / "state.json", {"status": "awaiting_intake", "updatedAt": datetime.now(timezone.utc).isoformat()})
            self.completed += 1
            return
        if not output.exists():
            options = inference_args(self.args, audio)
            if self.runtime is None:
                self.runtime = self.runtime_factory(options)
            result = self.infer(options, self.runtime)
            self.store.json(output, {"schemaVersion": 1, "audioSha256": manifest["sha256"], "result": result})
        else:
            if output.stat().st_size > 2 * 1024**2:
                raise ValueError("Saved transcript is too large")
            envelope = json.loads(output.read_text(encoding="utf-8"))
            if envelope.get("schemaVersion") != 1 or envelope.get("audioSha256") != manifest["sha256"]:
                raise ValueError("Saved transcript checksum mismatch")
            result = envelope.get("result")
            if not isinstance(result, dict) or result.get("schemaVersion") != 1 or not isinstance(result.get("segments"), list):
                raise ValueError("Saved transcript has no complete ASR result")
        imported = False
        receipt = None
        if any(s.get("embedding") for s in result.get("speakers", [])):
            index = (self.store.directory / "speaker-index.sqlite" if manifest.get("testOnly")
                     else RUNTIME / "speaker-index.sqlite")
            try:
                linked = subprocess.run(
                    [self.args.node, str(ROOT / "scripts/voice-speaker-link.mjs"), str(index),
                     str(sidecar(audio)), str(output)], cwd=str(ROOT), capture_output=True,
                    text=True, encoding="utf-8", timeout=30,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if linked.returncode:
                    raise RuntimeError(linked.stderr[-1000:])
                association = json.loads(linked.stdout)
            except (OSError, subprocess.TimeoutExpired, ValueError, RuntimeError) as exc:
                # Optional association must not interrupt capture or lose saved ASR.
                association = {"status": "pending_retry", "error": str(exc),
                               "audioSha256": manifest["sha256"]}
            self.store.json(directory / "speaker-links.json", association)
        if self.args.do_import:
            command = [self.args.node, str(ROOT / "scripts" / "voice-input.mjs"), "import",
                       "--manifest", str(sidecar(audio)), "--transcript", str(output)]
            if self.args.database:
                command += ["--database", str(self.args.database.resolve())]
            process = self.runner(command, cwd=str(ROOT), capture_output=True, text=True,
                                  encoding="utf-8", timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if process.returncode:
                raise RuntimeError("Voice import failed: " + process.stderr[-2000:])
            response = json.loads(process.stdout)
            receipt = response.get("result", {})
            if not receipt.get("recordingId") or receipt.get("busy") or not (
                    receipt.get("duplicate") or isinstance(receipt.get("evidenceIds"), list)):
                raise RuntimeError("Import returned no completed receipt; saved audio retained")
            imported = True
            self.imported += 1
        self.store.json(directory / "state.json", {"status": "imported" if imported else "transcribed",
                                                  "receipt": receipt, "updatedAt": datetime.now(timezone.utc).isoformat()})
        self.completed += 1

    def _work(self):
        last_work = time.monotonic()
        while not self.stop.is_set() or not self.jobs.empty():
            try:
                directory = self.jobs.get(timeout=0.25)
            except queue.Empty:
                if self.runtime is not None and time.monotonic() - last_work >= self.args.idle_unload_seconds:
                    if self.runtime.recognizer is not None or self.runtime.extractor is not None:
                        self.runtime.release_heavy()
                        gc.collect()
                        self.unloads += 1
                continue
            try:
                self.process(directory)
            except Exception as exc:
                self.error = str(exc)
                self.failed.set()
                try:
                    self.store.json(directory / "state.json", {"status": "failed", "error": self.error})
                except Exception:
                    pass
                break
            finally:
                last_work = time.monotonic()
                self.jobs.task_done()

    def finish(self):
        self.stop.set()
        self.thread.join()
        if self.failed.is_set():
            raise RuntimeError("Transcription/import failed; use --resume: " + str(self.error))


@contextmanager
def exclusive_root(root):
    import msvcrt
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".listener.lock").open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError("Another PC voice listener/recovery is using this output root") from exc
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def shared_input_settings(sd, device):
    # Only WASAPI accepts these settings. Do not select another physical input
    # or enable exclusive capture when another application is using this one.
    if not hasattr(sd, "query_devices"):
        return {}
    info = sd.query_devices(device, "input")
    host = sd.query_hostapis(info["hostapi"])
    return {"extra_settings": sd.WasapiSettings(exclusive=False)} if host["name"] == "Windows WASAPI" else {}


def capture_stream(args, gate, worker, sd, stop_file, stop_requested=None, on_started=None):
    stop_requested = stop_requested if stop_requested is not None else threading.Event()
    if stop_requested.is_set() or stop_file.exists():
        return
    frames = queue.Queue(maxsize=128)
    problems = queue.Queue(maxsize=1)
    target = round(args.seconds * RATE) if args.seconds is not None else None
    received = 0
    clock = CaptureClock()

    def callback(data, count, timing, status):
        nonlocal received
        try:
            if stop_requested.is_set():
                raise sd.CallbackStop()
            adc = getattr(timing, "inputBufferAdcTime", None)
            clock.check(count, time.monotonic(), time.time(),
                        adc if isinstance(adc, (int, float)) and math.isfinite(adc) and adc > 0 else None)
            if status:
                raise CaptureInterrupted("Audio device reported lost samples: " + str(status))
            take = count if target is None else min(count, target - received)
            if take:
                frames.put_nowait(bytes(data)[:take * 2])
                received += take
            if target is not None and received >= target:
                raise sd.CallbackStop()
        except (queue.Full, RuntimeError) as exc:
            try:
                problems.put_nowait(exc if isinstance(exc, CaptureInterrupted)
                                    else RuntimeError(str(exc) or "Audio callback queue overflow"))
            except queue.Full:
                pass
            raise sd.CallbackAbort()

    stream = sd.RawInputStream(samplerate=RATE, blocksize=FRAME, channels=1, dtype="int16",
                               device=args.device, callback=callback, **shared_input_settings(sd, args.device))
    normal_stop = False
    try:
        if stop_requested.is_set() or stop_file.exists():
            return
        if hasattr(sd, "query_devices"):
            device = sd.query_devices(args.device, "input")
            print(json.dumps({"event": "capture_device", "deviceName": device["name"],
                              "hostApi": sd.query_hostapis(device["hostapi"])["name"],
                              "sampleRate": RATE, "blocksize": FRAME,
                              "actualLatency": getattr(stream, "latency", None),
                              "updatedAt": datetime.now(timezone.utc).isoformat()},
                             ensure_ascii=False), file=sys.stderr, flush=True)
        moment = datetime.now(timezone.utc)
        started = time.monotonic()
        last_frame = started
        stream.start()
        if on_started:
            on_started(moment)
        while True:
            if not problems.empty():
                raise problems.get_nowait()
            if worker.failed.is_set():
                raise RuntimeError("Transcriber stopped: " + str(worker.error))
            if stop_requested.is_set() or stop_file.exists():
                normal_stop = True
                break
            try:
                gate.feed(frames.get(timeout=0.1))
                last_frame = time.monotonic()
            except queue.Empty:
                active = stream.active
                # The callback may have stopped while the consumer awaited a frame.
                if stop_requested.is_set() or stop_file.exists():
                    normal_stop = True
                    break
                if not active:
                    if target is None or received != target:
                        raise CaptureInterrupted("Microphone stopped unexpectedly; input recovery required")
                    normal_stop = True
                    break
                if time.monotonic() - last_frame > 5:
                    raise CaptureInterrupted("Microphone returned no frames for 5 seconds")
    finally:
        try:
            stream.abort()
        finally:
            stream.close()
    if normal_stop:
        if not problems.empty():
            raise problems.get_nowait()
        while not frames.empty():
            gate.feed(frames.get_nowait())
        gate.finish()


def recover_capture(args, worker, sd, stop_file, stop_requested, make_gate, publish,
                    capture=capture_stream, monotonic=time.monotonic, wait=None):
    """Keep the user's capture intent alive; every reopen gets a new time base."""
    wait = wait or stop_requested.wait
    deadline = monotonic() + args.seconds if args.seconds is not None else None
    totals = {"total": 0, "clips": 0, "forced_splits": 0, "interruptions": 0, "lastInterruption": None}
    failures = 0
    backend_error = getattr(sd, "PortAudioError", CaptureInterrupted)
    while not stop_requested.is_set() and not stop_file.exists():
        remaining = None if deadline is None else deadline - monotonic()
        if remaining is not None and remaining < 1 / RATE:
            break
        epoch = str(uuid.uuid4())
        gate, anchor = make_gate(epoch)
        options = SimpleNamespace(**vars(args))
        options.seconds = remaining
        epoch_started = monotonic()

        def on_started(moment):
            anchor(moment)
            publish({"state": "capturing", "streamId": epoch, "startedAt": moment.isoformat(),
                     "interruptions": totals["interruptions"]})

        try:
            capture(options, gate, worker, sd, stop_file, stop_requested, on_started)
            totals["total"] += gate.total
            totals["clips"] += gate.clips
            totals["forced_splits"] += getattr(gate, "forced_splits", 0)
            break
        except (CaptureInterrupted, backend_error) as exc:
            # Invalid format/flags/channels cannot be fixed by waiting. Device
            # unavailable or a lost endpoint can; never catch disk/worker errors.
            if (isinstance(exc, backend_error) and len(exc.args) > 1 and isinstance(exc.args[1], int)
                    and exc.args[1] in {-9998, -9997, -9995, -9994, -9984}):
                raise
            totals["total"] += gate.total
            totals["clips"] += gate.clips
            totals["forced_splits"] += getattr(gate, "forced_splits", 0)
            totals["interruptions"] += 1
            totals["lastInterruption"] = str(exc)
            if gate.total >= RATE * 30 and monotonic() - epoch_started >= 30:
                failures = 0
            delay = (1, 2, 5, 10, 30)[min(failures, 4)]
            failures += 1
            publish({"state": "waiting_for_input", "reason": str(exc), "retryInSeconds": delay,
                     "streamId": epoch, "interruptions": totals["interruptions"],
                     "gapStartedAt": datetime.now(timezone.utc).isoformat(),
                     "partialTailDiscarded": True})
            # A broken stream's uncommitted tail is not made falsely continuous
            # with the next one. Previously persisted clips continue processing.
            until = monotonic() + delay
            if deadline is not None:
                until = min(until, deadline)
            while monotonic() < until and not stop_requested.is_set() and not stop_file.exists():
                if worker.failed.is_set():
                    raise RuntimeError("Transcriber stopped: " + str(worker.error))
                wait(min(0.1, max(0, until - monotonic())))
    publish({"state": "stopped", "interruptions": totals["interruptions"],
             "deadlineReached": deadline is not None and monotonic() >= deadline})
    return SimpleNamespace(**totals)


def run(args, stop_requested=None):
    stop_requested = stop_requested if stop_requested is not None else threading.Event()
    bootstrap()
    deny_network()
    import numpy as np
    import sherpa_onnx as sherpa
    import soundfile as sf
    import soxr
    if sherpa.__version__ != "1.13.8":
        raise RuntimeError("Unexpected sherpa-onnx version")
    with exclusive_root(args.output_root):
        store = SessionStore(args.output_root, args.resume.name if args.resume else None)
        summary_path = store.directory / "session.json"
        worker = ClipWorker(args, store)
        previous = json.loads(summary_path.read_text(encoding="utf-8")) if args.resume and summary_path.exists() else {}
        summary = {"schemaVersion": 1, "sessionDirectory": str(store.directory),
                   "mode": "recovery" if args.resume else "replay" if args.replay else "microphone",
                   "testOnly": bool(args.replay) or bool(previous.get("testOnly")), "status": "running"}
        store.json(summary_path, summary)
        worker.start()
        error = None
        started = time.perf_counter()
        gate = None
        try:
            if args.resume:
                for manifest in sorted(store.directory.glob("*/audio.wav.manifest.json")):
                    if stop_requested.is_set():
                        break
                    state_path = manifest.parent / "state.json"
                    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
                    link_path = manifest.parent / "speaker-links.json"
                    pending_link = (link_path.exists() and
                                    json.loads(link_path.read_text(encoding="utf-8")).get("status") == "pending_retry")
                    if state.get("status") in {"imported", "transcribed"} and not args.do_import and not pending_link:
                        continue
                    # Recovery has no live callback to starve, so it may wait for the bounded worker.
                    while worker.jobs.full() and not worker.failed.is_set() and not stop_requested.is_set():
                        time.sleep(0.05)
                    if stop_requested.is_set():
                        break
                    worker.enqueue(manifest.parent)
            else:
                manifest, models = asr.load_models(args.model_dir, False)
                detector = asr.create_vad(models["vad"], 1, sherpa, silence=args.silence_ms / 1000)
                started_at = datetime.now(timezone.utc)

                def emit(start, end, pcm):
                    directory = store.save(start, end, pcm, started_at, args, bool(args.replay))
                    worker.enqueue(directory)

                def on_started(moment):
                    nonlocal started_at
                    started_at = moment

                gate = SpeechGate(detector, np, emit, args.pre_roll_ms, args.silence_ms)
                stop_file = store.directory / "STOP"
                print(json.dumps({"event": "listening" if args.microphone else "replaying",
                                  "sessionDirectory": str(store.directory), "stopFile": str(stop_file)},
                                 ensure_ascii=False), file=sys.stderr, flush=True)
                if args.replay:
                    samples, _, _ = asr.decode_audio(args.replay, 3600, np, sf, soxr)
                    pcm = asr.pcm16_precision(samples, np)
                    for offset in range(0, len(pcm), FRAME):
                        if stop_requested.is_set():
                            break
                        if worker.failed.is_set():
                            raise RuntimeError(str(worker.error))
                        while worker.jobs.full() and not worker.failed.is_set() and not stop_requested.is_set():
                            time.sleep(0.05)
                        if stop_requested.is_set():
                            break
                        gate.feed(np.rint(pcm[offset:offset + FRAME] * 32768).astype("<i2").tobytes())
                    gate.finish()
                else:
                    import sounddevice as sd
                    if not stop_requested.is_set():
                        def make_gate(epoch):
                            anchor = [datetime.now(timezone.utc)]
                            def save_epoch(start, end, pcm):
                                directory = store.save(start, end, pcm, anchor[0], args, False, epoch)
                                worker.enqueue(directory)
                            detector = asr.create_vad(models["vad"], 1, sherpa, silence=args.silence_ms / 1000)
                            return (SpeechGate(detector, np, save_epoch, args.pre_roll_ms, args.silence_ms),
                                    lambda moment: anchor.__setitem__(0, moment))

                        transitions = deque(maxlen=32)

                        def publish(state):
                            state["updatedAt"] = datetime.now(timezone.utc).isoformat()
                            transitions.append(dict(state))
                            store.json(store.directory / "capture-status.json", {**state, "recentTransitions": list(transitions)})
                            print(json.dumps({"event": "capture_state", **state}), file=sys.stderr, flush=True)

                        gate = None
                        try:
                            gate = recover_capture(args, worker, sd, stop_file, stop_requested, make_gate, publish)
                        except Exception as exc:
                            try:
                                publish({"state": "failed", "reason": str(exc)})
                            except Exception:
                                pass  # The original disk/worker fault remains the reported failure.
                            raise
        except (Exception, KeyboardInterrupt) as exc:
            error = str(exc) or "Interrupted"
        finally:
            try:
                worker.finish()
            except Exception as exc:
                error = error or str(exc)
            summary.update({"status": "failed" if error else "stopped", "error": error,
                            "capturedSamples": gate.total if gate else None,
                            "speechClips": gate.clips if gate else None,
                            "captureInterruptions": getattr(gate, "interruptions", 0),
                            "forcedSplits": getattr(gate, "forced_splits", 0),
                            "lastCaptureInterruption": getattr(gate, "lastInterruption", None),
                            "completedClips": worker.completed, "importedClips": worker.imported,
                            "stopRequested": stop_requested.is_set(),
                            "modelLoads": worker.runtime.loads if worker.runtime else {"asr": 0, "embedding": 0},
                            "idleUnloads": worker.unloads, "elapsedMs": round((time.perf_counter() - started) * 1000, 3)})
            store.json(summary_path, summary)
        if error:
            raise RuntimeError(error + "; evidence: " + str(store.directory))
        return summary


def main(argv=None):
    args = arguments(argv)
    stop_requested = threading.Event()
    previous = signal.signal(signal.SIGINT, lambda *_: stop_requested.set())
    try:
        print(json.dumps(run(args, stop_requested), ensure_ascii=False))
        return 0
    except Exception as exc:
        emit_error(exc)
        return 1
    finally:
        signal.signal(signal.SIGINT, previous)


if __name__ == "__main__":
    sys.exit(main())
