"""Local engine selection and bounded recovery, independent of speaker identity."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import uuid

from transcript_quality import issues
from streaming_deadline import AudioDeadline, audio_budget


class StreamingAsrProcess:
    engine = "fun-asr-nano"
    max_seconds = 35
    budget_factor = 2.0

    def _start(self, command, sf):
        self.sf, self.process = sf, None
        self.temporary = tempfile.TemporaryDirectory(prefix="shadow-asr-")
        self.stderr = open(Path(self.temporary.name) / "stderr.log", "w+b")
        self.responses = queue.Queue()
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self.stderr, text=True, encoding="utf-8",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            def read():
                try:
                    for line in self.process.stdout:
                        self.responses.put((time.monotonic(), json.loads(line)))
                except Exception as error:
                    self.responses.put((time.monotonic(), {"error": str(error)}))
                finally:
                    self.responses.put((time.monotonic(), {"error": "ASR worker exited"}))
            self.reader = threading.Thread(target=read, daemon=True)
            self.reader.start()
            self.receipt = self.receive()
            if self.receipt.get("ready") is not True:
                raise RuntimeError("ASR worker did not become ready")
        except Exception:
            self.close()
            raise

    def receive(self):
        try:
            _, result = self.responses.get(timeout=900)
        except queue.Empty:
            raise RuntimeError("ASR worker made no response for 15 minutes")
        if result.get("error"):
            raise RuntimeError(result["error"])
        return result

    def decode(self, samples, language, not_after=None):
        if self.process is None:
            raise RuntimeError("ASR worker is closed")
        if not 0 < len(samples) <= self.max_seconds * 16000:
            raise ValueError("ASR window exceeds worker duration limit")
        deadline = AudioDeadline(audio_budget(len(samples) / 16000, self.budget_factor))
        if not_after is not None:
            deadline.ends = min(deadline.ends, not_after)
        request_id = uuid.uuid4().hex
        file = Path(self.temporary.name) / "window.wav"
        self.sf.write(str(file), samples, 16000, subtype="FLOAT")
        self.process.stdin.write(json.dumps({"audio": str(file), "language": language,
            "requestId": request_id, "startedMonotonic": deadline.started,
            "deadlineMonotonic": deadline.ends, "budgetFactor": self.budget_factor}) + "\n")
        self.process.stdin.flush()
        return self._receive_decode(request_id, deadline)

    def _receive_decode(self, request_id, deadline):
        latest = {"text": "", "tokens": 0}
        stop_reason, error = "audio_duration_deadline", None
        while True:
            try:
                received_at, row = self.responses.get(timeout=deadline.remaining())
            except queue.Empty:
                break
            if received_at >= deadline.ends:
                break
            if row.get("error"):
                if row.get("requestId") not in (None, request_id):
                    raise RuntimeError("ASR worker response identity mismatch")
                stop_reason, error = "worker_error", str(row["error"])
                break
            if row.get("requestId") != request_id:
                raise RuntimeError("ASR worker response identity mismatch")
            if row.get("event") == "progress":
                latest = {"text": row["text"], "tokens": row["tokens"]}
                continue
            if row.get("event") != "result":
                raise RuntimeError("Unexpected ASR worker response")
            return {**row, "seconds": time.monotonic() - deadline.started,
                    "budgetSeconds": deadline.seconds, "budgetFactor": self.budget_factor}
        stopped = time.monotonic()
        self.close()
        return {**latest, "engine": self.engine, "reachedEos": False,
                "completion": "partial", "stopReason": stop_reason,
                **({"error": error} if error else {}),
                "budgetSeconds": deadline.seconds, "budgetFactor": self.budget_factor,
                "seconds": stopped - deadline.started,
                "cleanupSeconds": time.monotonic() - stopped,
                "requestId": request_id}

    def close(self):
        if self.process:
            if self.process.poll() is None:
                if os.name == "nt":
                    # A Windows venv python.exe can be a launcher; terminating only
                    # that PID leaves the native interpreter (and its GPU work) alive.
                    stopped = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"),
                        "/PID", str(self.process.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, timeout=10,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    if stopped.returncode and self.process.poll() is None:
                        raise RuntimeError("Could not stop the ASR worker process tree")
                else:
                    self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            if hasattr(self, "reader"):
                self.reader.join(timeout=2)
            for stream in (self.process.stdin, self.process.stdout):
                if stream:
                    stream.close()
            self.process = None
        self.stderr.close()
        self.temporary.cleanup()


class FunProcess(StreamingAsrProcess):
    def __init__(self, args, sf):
        self.budget_factor = getattr(args, "asr_time_budget_factor", 2.0)
        audio_budget(1, self.budget_factor)
        if not args.fun_python or not args.fun_model_dir or not args.fun_weight_sha256:
            raise RuntimeError("Fun runtime not configured")
        command = [args.fun_python, "-I", "-B", str(Path(__file__).with_name("fun_worker.py")),
                   "--model-dir", str(args.fun_model_dir), "--weight-sha256", args.fun_weight_sha256,
                   "--parent-pid", str(os.getpid()),
                   "--min-free-mib", str(args.min_free_mib), "--min-vram-mib", str(args.min_vram_mib)]
        self._start(command, sf)


class MossProcess(StreamingAsrProcess):
    engine = "moss-local"

    def __init__(self, args, sf):
        self.budget_factor = getattr(args, "asr_time_budget_factor", 2.0)
        audio_budget(1, self.budget_factor)
        self.max_seconds = args.moss_max_seconds
        if not args.moss_python or not args.moss_model_dir or not args.moss_upstream or not args.moss_cache_dir:
            raise RuntimeError("MOSS runtime not configured")
        self._start([args.moss_python, "-I", "-B", str(Path(__file__).with_name("moss_deadline_worker.py")),
            "--model-dir", str(args.moss_model_dir), "--upstream", str(args.moss_upstream),
            "--cache", str(args.moss_cache_dir), "--parent-pid", str(os.getpid())], sf)


class MossProvider:
    """An explicit joint transcription/diarization selection never silently falls back."""

    def __init__(self, args, sf, factory=MossProcess):
        self.args, self.sf, self.factory = args, sf, factory
        self.worker, self.attempts, self.used = None, [], set()

    def close(self):
        if self.worker:
            self.worker.close()
            self.worker = None

    def decode(self, samples, start, purpose="core"):
        try:
            if self.worker is None:
                self.worker = self.factory(self.args, self.sf)
                self.attempts.append({"kind": "loaded", **self.worker.receipt})
            result = self.worker.decode(samples, self.args.language)
            result = {**result, "engine": "moss-local"}
            self.attempts.append({**result, "startMs": round(start / 16),
                                 "endMs": round((start + len(samples)) / 16), "purpose": purpose})
            self.used.add("moss-local")
            if result.get("completion") == "partial":
                self.close()
            return result
        except Exception as error:
            self.attempts.append({"engine": "moss-local", "startMs": round(start / 16),
                                 "purpose": purpose, "error": str(error)})
            self.close()
            raise


class LocalProvider:
    def __init__(self, args, sense_decode, sf, factory=FunProcess):
        self.args, self.sense_decode, self.sf, self.factory = args, sense_decode, sf, factory
        self.budget_factor = getattr(args, "asr_time_budget_factor", 2.0)
        audio_budget(1, self.budget_factor)
        self.fun = None
        self.disabled = args.asr_provider == "sensevoice-local"
        self.attempts = []
        self.used = set()

    def close(self):
        if self.fun:
            self.fun.close()
            self.fun = None

    def _attempt(self, samples, start, engine, purpose, budget=None):
        if len(samples) > 35 * 16000:
            raise ValueError("ASR window exceeds 35 seconds")
        try:
            if engine == "fun-asr-nano":
                if not self.fun:
                    self.fun = self.factory(self.args, self.sf)
                    self.attempts.append({"kind": "loaded", **self.fun.receipt})
                if budget is not None and budget["deadline"] is None:
                    budget["deadline"] = AudioDeadline(budget["seconds"])
                result = self.fun.decode(samples, self.args.language,
                    not_after=budget["deadline"].ends if budget is not None else None)
            else:
                result = self.sense_decode(samples)
            problems = issues(result["text"], result.get("reachedEos", True))
            self.attempts.append({**result, "engine": engine, "startMs": round(start / 16),
                                  "endMs": round((start + len(samples)) / 16), "purpose": purpose,
                                  "issues": problems})
            if result.get("completion") == "partial":
                self.used.add(engine)
                if engine == "fun-asr-nano":
                    self.close()
                return {**result, "engine": engine}
            if not problems:
                self.used.add(engine)
                return {**result, "engine": engine}
        except Exception as error:
            self.attempts.append({"engine": engine, "startMs": round(start / 16),
                                  "purpose": purpose, "error": str(error)})
            if engine == "fun-asr-nano":
                self.disabled = True
                self.close()
        return None

    def decode(self, samples, start, purpose="core"):
        budget = {"seconds": audio_budget(len(samples) / 16000, self.budget_factor), "deadline": None}
        if not self.disabled:
            result = self._attempt(samples, start, "fun-asr-nano", purpose, budget)
            if result:
                return result
            # Halving a problematic window changes the failing acoustic context.
            # This is one bounded recovery level, never a retry of identical input.
            if not self.disabled and len(samples) > 2 * 16000:
                middle = len(samples) // 2
                parts = []
                for part, offset in [(samples[:middle], start), (samples[middle:], start + middle)]:
                    result = self._attempt(part, offset, "fun-asr-nano", purpose + "-shorter", budget)
                    parts.append(result)
                    if result and result.get("completion") == "partial":
                        return {"text": " ".join(p["text"] for p in parts if p), "engine": "fun-asr-nano",
                                "completion": "partial", "stopReason": result["stopReason"],
                                "tokens": result.get("tokens"), "maxNewTokens": result.get("maxNewTokens"),
                                "budgetSeconds": budget["seconds"], "budgetFactor": self.budget_factor,
                                "seconds": time.monotonic() - budget["deadline"].started,
                                "recovered": False}
                if all(parts):
                    return {"text": " ".join(p["text"] for p in parts), "engine": "fun-asr-nano", "recovered": True}
            if self.args.fallback == "none":
                raise RuntimeError("Fun transcription failed; local fallback disabled")
        elif self.args.asr_provider != "sensevoice-local" and self.args.fallback == "none":
            raise RuntimeError("Fun unavailable; local fallback disabled")
        result = self._attempt(samples, start, "sensevoice-local", purpose)
        if result:
            return result
        raise RuntimeError("Unresolved ASR quality failure; refusing to publish this recording")
