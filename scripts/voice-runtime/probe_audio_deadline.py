"""Read-only real ASR deadline probe, including native worker descendants."""
import argparse
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import time

sys.dont_write_bytecode = True
from local_provider import FunProcess, StreamingAsrProcess
from runtime_common import sha256, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ids", nargs="+", required=True)
    parser.add_argument('--moss-model', type=Path)
    parser.add_argument('--moss-upstream', type=Path)
    parser.add_argument('--asr-time-budget-factor', type=float, default=2.0)
    parser.add_argument('--test-stop-after-seconds', type=float,
                        help='Fault injection: shorten only this probe request deadline')
    args = parser.parse_args()
    if args.test_stop_after_seconds is not None and not 0 < args.test_stop_after_seconds <= 120:
        parser.error('test-stop-after-seconds must be in (0, 120]')
    args.output.mkdir(parents=True, exist_ok=False)
    import soundfile as sf
    import psutil
    settings = json.loads(args.config.read_text(encoding="utf-8-sig"))["voice"]
    config = SimpleNamespace(fun_python=settings["funPython"], fun_model_dir=settings["funModelDir"],
        fun_weight_sha256=settings["funWeightSha256"], min_free_mib=1024, min_vram_mib=2300,
        asr_time_budget_factor=args.asr_time_budget_factor)
    inputs = {i["id"]: i for i in json.loads(args.inputs.read_text(encoding="utf-8-sig"))["inputs"]}
    fingerprints = {name: sha256(Path(__file__).with_name(name)) for name in
        ("fun_worker.py", "local_provider.py", "streaming_deadline.py", "probe_audio_deadline.py", 'moss_deadline_worker.py')}
    class MossProcess(StreamingAsrProcess):
        engine = 'moss-experimental'
        max_seconds = 120
        def __init__(self):
            self.budget_factor = args.asr_time_budget_factor
            self._start([config.fun_python, '-I', '-B', str(Path(__file__).with_name('moss_deadline_worker.py')),
                '--model-dir', str(args.moss_model), '--upstream', str(args.moss_upstream),
                '--cache', str((args.output / 'modules').resolve()), '--parent-pid', str(os.getpid())], sf)
    rows = []
    for identity in args.ids:
        item = inputs[identity]
        if sha256(item["audio"]) != item["sha256"]:
            raise ValueError("Audio changed")
        samples, rate = sf.read(item["audio"], dtype="float32")
        if rate != 16000:
            raise ValueError("Expected 16kHz")
        worker, tracked = None, []
        try:
            cold = time.monotonic()
            worker = MossProcess() if args.moss_model else FunProcess(config, sf)
            loaded_seconds = time.monotonic() - cold
            process = worker.process
            root = psutil.Process(process.pid)
            tracked = [root, *root.children(recursive=True)]
            identities = [{"pid": p.pid, "createdAt": p.create_time(), "name": p.name()} for p in tracked]
            not_after = time.monotonic() + args.test_stop_after_seconds if args.test_stop_after_seconds else None
            result = worker.decode(samples, "zh", not_after=not_after)
            rows.append({"id": identity, "audioSha256": item["sha256"], "audioSeconds": len(samples)/rate,
                "coldReadySeconds": loaded_seconds, "loaded": worker.receipt,
                "faultInjectionStopSeconds": args.test_stop_after_seconds, **result})
        finally:
            if worker:
                worker.close()
        rows[-1]["processExited"] = process.poll() is not None
        rows[-1]["trackedWorkerProcesses"] = identities
        rows[-1]["immediateListedPids"] = [p.pid for p in tracked if p.is_running()]
        # Windows can still list a terminating process. Check its exit signal,
        # and account for this wait separately rather than hiding cleanup time.
        exit_started = time.monotonic()
        _, alive = psutil.wait_procs(tracked, timeout=10)
        rows[-1]["exitConfirmationSeconds"] = time.monotonic() - exit_started
        rows[-1]["remainingWorkerPids"] = [p.pid for p in alive]
        write_json(args.output / "results.private.json", {"rows": rows, "sourceHashes": fingerprints})
        if rows[-1]["remainingWorkerPids"]:
            for p in reversed(tracked):
                if p.is_running():
                    p.kill()
            psutil.wait_procs(tracked, timeout=10)
            raise RuntimeError('Worker descendants survived cleanup; failed evidence retained')
        if args.test_stop_after_seconds and result.get('stopReason') != 'audio_duration_deadline':
            raise RuntimeError('Injected deadline was not exercised; evidence retained')
        print(json.dumps({k: v for k, v in rows[-1].items() if k not in {"text", "loaded"}}), flush=True)
    if any(sha256(Path(__file__).with_name(name)) != digest for name, digest in fingerprints.items()):
        raise RuntimeError("Tested code changed during inference")


if __name__ == "__main__":
    main()
