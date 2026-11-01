"""Local engineering probe. No accuracy score or production database access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from types import SimpleNamespace
import wave

import psutil


FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class Monitor:
    def __init__(self):
        self.roots = [psutil.Process()]
        self.samples = []
        self.gpu = []
        self.stop = threading.Event()
        self.gpu_process = subprocess.Popen([
            "nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits", "--loop-ms=250"
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, creationflags=FLAGS)
        def read_gpu():
            for line in self.gpu_process.stdout:
                try:
                    memory, utilization = [float(value.strip()) for value in line.strip().split(",")]
                    self.gpu.append({"at": time.monotonic(), "usedMiB": memory, "utilizationPercent": utilization})
                except ValueError:
                    pass
        def read_host():
            while not self.stop.wait(0.1):
                rss = {}
                private = {}
                for process in list(self.roots):
                    try:
                        for child in [process] + process.children(recursive=True):
                            memory = child.memory_info()
                            rss[str(child.pid)] = memory.rss
                            if hasattr(memory, "private"):
                                private[str(child.pid)] = memory.private
                    except psutil.Error:
                        pass
                self.samples.append({"at": time.monotonic(), "rss": rss, "privateBytes": private,
                                     "availableBytes": psutil.virtual_memory().available})
        self.threads = [threading.Thread(target=read_gpu, daemon=True), threading.Thread(target=read_host, daemon=True)]
        for thread in self.threads:
            thread.start()

    def close(self):
        self.stop.set()
        self.cleanup_errors = []
        try:
            if self.gpu_process.poll() is None:
                self.gpu_process.terminate()
            try:
                self.gpu_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.gpu_process.kill()
                self.gpu_process.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired) as error:
            self.cleanup_errors.append(str(error))
        for thread in self.threads:
            thread.join(timeout=10)
        if not self.threads[0].is_alive():
            self.gpu_process.stdout.close()

    def result(self):
        return {"host": self.samples, "gpu": self.gpu,
                "sampledOwnedRssPeakBytes": max((sum(row["rss"].values()) for row in self.samples), default=0),
                "sampledOwnedPrivatePeakBytes": max((sum(row.get("privateBytes", {}).values())
                                                     for row in self.samples), default=0),
                "sampledDeviceUsedPeakMiB": max((row["usedMiB"] for row in self.gpu), default=None),
                "cleanupErrors": getattr(self, "cleanup_errors", []),
                "gpuScope": "whole-device, not exclusive; sampling can miss short peaks"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=["cold", "warm", "concurrent"], required=True)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--config", type=Path, default=Path("config/agent.local.json"))
    args = parser.parse_args()
    if not re.fullmatch(r"(?:cuda|vulkan):\d+", args.device):
        parser.error("Specify an explicit CUDA or Vulkan GPU index from doctor")
    args.output.mkdir(parents=True, exist_ok=False)
    with wave.open(str(args.audio), "rb") as stream:
        duration = stream.getnframes() / stream.getframerate()
    command = [str(args.native.resolve())]
    if args.mode == "cold":
        command += ["diarize", str(args.audio.resolve()), "--preset", "v3-offline", "--json"]
    else:
        command += ["bench", "diarize", str(args.audio.resolve()), "--repetitions", "2",
                    "--concurrency", "1", "--warmup", "1", "--json"]
    command += ["--model", str(args.model.resolve()), "--device", args.device, "--verbose"]
    result = {"mode": args.mode, "audioSeconds": duration, "command": command,
              "audioSha256": hashlib.sha256(args.audio.read_bytes()).hexdigest()}
    monitor = Monitor()
    native = None
    fun = None
    begun = time.monotonic()
    try:
        if args.mode == "concurrent":
            import soundfile as sf
            from local_provider import FunProcess
            voice = json.loads(args.config.read_text(encoding="utf-8-sig"))["voice"]
            configured = SimpleNamespace(fun_python=voice["funPython"], fun_model_dir=voice["funModelDir"],
                fun_weight_sha256=voice["funWeightSha256"], min_free_mib=1024, min_vram_mib=2300)
            # This probe measures actual capacity instead of rejecting estimated headroom.
            os.environ["SHADOW_VOICE_TEST_SKIP_MEMORY_CHECKS"] = "1"
            fun = FunProcess(configured, sf)
            monitor.roots.append(psutil.Process(fun.process.pid))
            result["funLoad"] = fun.receipt
            samples, rate = sf.read(str(args.audio), dtype="float32")
            if rate != 16000 or samples.ndim != 1:
                raise ValueError("Concurrent probe requires mono 16kHz")
        with (args.output / "native.stdout.json").open("wb") as stdout, (args.output / "native.stderr.log").open("wb") as stderr:
            started = time.monotonic()
            native = subprocess.Popen(command, stdout=stdout, stderr=stderr, creationflags=FLAGS)
            monitor.roots.append(psutil.Process(native.pid))
            if fun:
                result["funDecode"] = fun.decode(samples[:20 * 16000], "en")
                result["nativeStillRunningAtFunCompletion"] = native.poll() is None
            result["nativeExitCode"] = native.wait(timeout=900)
            result["nativeProcessSeconds"] = time.monotonic() - started
    except Exception as error:
        result["error"] = str(error)
    finally:
        if native and native.poll() is None:
            native.terminate()
            native.wait(timeout=10)
        if fun:
            fun.close()
        monitor.close()
        result["wallSeconds"] = time.monotonic() - begun
        result["resources"] = monitor.result()
        (args.output / "receipt.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key not in {"resources", "command"}}, indent=2))
    if result.get("nativeExitCode") != 0 or "error" in result:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
