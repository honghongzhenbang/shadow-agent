"""Rerun the existing production Fun worker on frozen short comparison audio."""
import argparse
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace

from runtime_common import sha256


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    import soundfile as sf
    import psutil
    from local_provider import FunProcess
    from probe_diarization import Monitor
    voice = json.loads(args.config.read_text(encoding="utf-8-sig"))["voice"]
    configured = SimpleNamespace(fun_python=voice["funPython"], fun_model_dir=voice["funModelDir"],
        fun_weight_sha256=voice["funWeightSha256"], min_free_mib=1024, min_vram_mib=2300)
    os.environ["SHADOW_VOICE_TEST_SKIP_MEMORY_CHECKS"] = "1"
    monitor = Monitor()
    fun = None
    records = []
    started = time.perf_counter()
    try:
        fun = FunProcess(configured, sf)
        monitor.roots.append(psutil.Process(fun.process.pid))
        records.append({"event": "loaded", "coldReadySeconds": time.perf_counter() - started, **fun.receipt})
        with (args.output / "results.jsonl").open("w", encoding="utf-8") as output:
            output.write(json.dumps(records[0]) + "\n")
            for item in json.loads(args.inputs.read_text(encoding="utf-8"))["inputs"]:
                if item["seconds"] > 35:
                    continue
                if sha256(item["audio"]) != item["sha256"]:
                    raise ValueError("Audio fingerprint changed")
                audio, rate = sf.read(item["audio"], dtype="float32")
                if rate != 16000 or audio.ndim != 1:
                    raise ValueError("Expected mono 16kHz")
                record = {"event": "transcript", "id": item["id"], "audioSha256": item["sha256"],
                          "audioSeconds": item["seconds"], **fun.decode(audio, "zh")}
                records.append(record)
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
                output.flush()
                print(json.dumps({k: v for k, v in record.items() if k != "text"}), flush=True)
    finally:
        if fun:
            fun.close()
        monitor.close()
        (args.output / "receipt.json").write_text(json.dumps({"records": records,
            "wallSeconds": time.perf_counter() - started, "resources": monitor.result(),
            "inputsSha256": sha256(args.inputs), "probeSha256": sha256(__file__)}, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
