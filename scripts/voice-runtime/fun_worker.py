"""Private offline JSONL worker; run in a separately provisioned CUDA environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from streaming_deadline import AudioDeadline, TranscriptStreamer, audio_budget, generation_status


def watch_parent(parent, terminate=os._exit, interval=1):
    # psutil.Process.is_running also detects PID reuse. Never leave a CUDA worker orphaned.
    def watch():
        while parent.is_running():
            time.sleep(interval)
        terminate(70)
    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    return thread


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--weight-sha256", required=True)
    parser.add_argument("--min-free-mib", type=int, default=1024)
    parser.add_argument("--min-vram-mib", type=int, default=2300)
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    skip_memory_checks = os.environ.get("SHADOW_VOICE_TEST_SKIP_MEMORY_CHECKS") == "1"
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS="2", MKL_NUM_THREADS="2")
    def deny(event, details):
        if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.gethostbyname",
                     "socket.gethostbyaddr", "socket.bind", "socket.sendto", "socket.sendmsg", "urllib.Request"}:
            raise RuntimeError("Local voice inference forbids network access")
    sys.addaudithook(deny)
    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)
    try:
        import psutil
        watch_parent(psutil.Process(args.parent_pid))
        # OS releases this lock even after a crash; independent jobs cannot both load CUDA.
        import msvcrt
        lock = open(Path(tempfile.gettempdir()) / "shadow-voice-fun-cuda.lock", "a+b")
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        # Measured loading headroom plus the requested desktop reserve.
        host_available_before = psutil.virtual_memory().available
        if not skip_memory_checks and host_available_before < (args.min_free_mib + 3000) * 1024 ** 2:
            raise RuntimeError("Insufficient host memory for Fun loading and desktop reserve")
        import torch
        import soundfile as sf
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, StoppingCriteria, StoppingCriteriaList
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("CUDA BF16 unavailable; no implicit CPU/FP16 fallback")
        gpu_available_before = torch.cuda.mem_get_info()[0]
        if not skip_memory_checks and gpu_available_before < args.min_vram_mib * 1024 ** 2:
            raise RuntimeError("Insufficient free CUDA memory")
        digest = hashlib.sha256()
        with (args.model_dir / "model.safetensors").open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != args.weight_sha256.lower():
            raise RuntimeError("Fun weight SHA mismatch")
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        probe = torch.ones((64, 64), device="cuda", dtype=torch.bfloat16)
        assert float((probe @ probe)[0, 0]) == 64
        del probe
        started = time.perf_counter()
        processor = AutoProcessor.from_pretrained(args.model_dir, local_files_only=True, trust_remote_code=False)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(args.model_dir, local_files_only=True,
            trust_remote_code=False, dtype=torch.bfloat16, device_map="cuda", attn_implementation="eager").eval()
        if any(p.device.type != "cuda" for p in model.parameters()):
            raise RuntimeError("Unexpected CPU offload")
        emit({"ready": True, "loadSeconds": time.perf_counter() - started,
              "model": "Fun-ASR-Nano-2512-hf", "weightSha256": digest.hexdigest(),
              "gpu": torch.cuda.get_device_name(0), "dtype": "bfloat16",
              "memoryChecksSkipped": skip_memory_checks, "hostAvailableBeforeBytes": host_available_before,
              "gpuAvailableBeforeBytes": gpu_available_before})
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("close"):
                break
            if not skip_memory_checks and psutil.virtual_memory().available < args.min_free_mib * 1024 ** 2:
                raise RuntimeError("Desktop memory reserve reached")
            samples, rate = sf.read(request["audio"], dtype="float32")
            if rate != 16000 or samples.ndim != 1 or not 0 < len(samples) <= 35 * rate:
                raise ValueError("Expected mono 16kHz audio of at most 35 seconds")
            request_id = request["requestId"]
            seconds = len(samples) / rate
            # Parent and child use the same host monotonic clock; the parent also
            # stops a worker blocked in preprocessing or a non-returning CUDA call.
            factor = request["budgetFactor"]
            deadline = AudioDeadline(audio_budget(seconds, factor), started=float(request["startedMonotonic"]))
            deadline.ends = min(deadline.ends, float(request["deadlineMonotonic"]))
            started = time.perf_counter()
            streamer = TranscriptStreamer(
                lambda ids: processor.tokenizer.decode(ids, skip_special_tokens=True),
                lambda row: emit({**row, "requestId": request_id}), deadline)
            class StopAtDeadline(StoppingCriteria):
                def __call__(self, input_ids, scores, **kwargs):
                    return deadline.expired()
            inputs = processor.apply_transcription_request(audio=samples, language=request.get("language", "zh"),
                processor_kwargs={"return_tensors": "pt", "audio_kwargs": {"sampling_rate": rate}})
            inputs = {k: v.to(device="cuda", dtype=torch.bfloat16) if v.is_floating_point() else v.to("cuda")
                      for k, v in inputs.items()}
            with torch.inference_mode():
                output = model.generate(**inputs, max_new_tokens=512, do_sample=False, num_beams=1,
                    streamer=streamer, stopping_criteria=StoppingCriteriaList([StopAtDeadline()]))
            new = output[:, inputs["input_ids"].shape[1]:]
            eos = model.generation_config.eos_token_id
            eos = eos if isinstance(eos, list) else [eos]
            expired = deadline.expired()
            status = generation_status(expired=expired, tokens=int(new.shape[-1]), max_tokens=512,
                reached_eos=bool(new.shape[-1] and int(new[0, -1]) in eos))
            emit({"event": "result", "requestId": request_id,
                  "text": streamer.text if expired else processor.batch_decode(new, skip_special_tokens=True)[0].strip(),
                  **status,
                  "budgetSeconds": deadline.seconds, "budgetFactor": factor,
                  "seconds": time.perf_counter() - started,
                  "engine": "fun-asr-nano", "gpuReservedPeakBytes": torch.cuda.max_memory_reserved(),
                  "processRssBytes": psutil.Process().memory_info().rss})
            del inputs, output, new
    except Exception as error:
        emit({"error": str(error), "errorType": type(error).__name__})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
