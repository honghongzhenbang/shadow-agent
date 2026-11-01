"""Isolated, offline MOSS probe using the pinned official processor and parser."""
import argparse
import copy
from dataclasses import asdict
import gc
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import time
import traceback

from runtime_common import sha256
from moss_attention_probe import backend_context, process_memory, trace_attention


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--attention", choices=["sdpa", "eager", "flash_attention_2"], default="eager")
    parser.add_argument("--sdpa-backend", choices=["auto", "flash", "efficient", "math", "cudnn"], default="auto")
    parser.add_argument("--trace-kernels", action="store_true", help="Diagnostic only, exclude from timing comparisons")
    parser.add_argument("--encoder-batch-size", type=int, default=0)
    args = parser.parse_args()
    if args.sdpa_backend != "auto" and args.attention != "sdpa":
        parser.error("A forced SDPA backend requires --attention sdpa")
    args.output.mkdir(parents=True, exist_ok=False)
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS="2", MKL_NUM_THREADS="2")
    os.environ["HF_MODULES_CACHE"] = str((args.output / "modules").resolve())
    sys.path.insert(0, str(args.upstream.resolve()))
    from probe_diarization import Monitor
    import psutil
    monitor = Monitor()
    started = time.perf_counter()
    records = []
    stages = []
    kernel_trace = []
    environment = {"python": sys.executable, "attention": args.attention, "sdpaBackend": args.sdpa_backend,
                   "traceKernels": args.trace_kernels, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    def stage(name):
        stages.append({"stage": name, "elapsedSeconds": time.perf_counter() - started,
                       **process_memory(psutil.Process())})
    stage("before_torch")
    exit_code = 0
    try:
        import torch
        stage("after_torch_import")
        import transformers
        import soundfile as sf
        from transformers import AutoModelForCausalLM, AutoProcessor
        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import build_transcription_messages, prepare_inputs
        stage("after_runtime_imports")
        def deny(event, details):
            if event in {"socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.bind",
                         "socket.sendto", "socket.sendmsg", "urllib.Request"}:
                raise RuntimeError("MOSS local probe forbids network access")
        sys.addaudithook(deny)
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("CUDA BF16 required; no silent CPU fallback")
        environment.update(torch=torch.__version__, cuda=torch.version.cuda,
            capability=torch.cuda.get_device_capability(), flashCompiled=torch.backends.cuda.is_flash_attention_available(),
            flashPackage=importlib.util.find_spec("flash_attn") is not None,
            powerScheme=subprocess.check_output(["powercfg", "/getactivescheme"], text=True, errors="replace").strip(),
            driver=subprocess.check_output(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                text=True, timeout=15).strip())
        stage("after_cuda_init")
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        manifest = json.loads((args.model / "verified-files.json").read_text(encoding="utf-8"))
        for entry in manifest["files"]:
            if sha256(args.model / entry["name"]) != entry["sha256"]:
                raise ValueError("Model file integrity mismatch: " + entry["name"])
        if not any(entry["name"].endswith(".safetensors") for entry in manifest["files"]):
            raise ValueError("Incomplete model download manifest")
        loading = time.perf_counter()
        processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True, local_files_only=True)
        stage("after_processor")
        model = AutoModelForCausalLM.from_pretrained(args.model, trust_remote_code=True, local_files_only=True,
            dtype=torch.bfloat16, device_map="cuda", attn_implementation=args.attention).eval()
        if any(p.device.type != "cuda" for p in model.parameters()):
            raise RuntimeError("Unexpected CPU offload")
        if args.encoder_batch_size:
            from moss_runtime import install_encoder_microbatch
            install_encoder_microbatch(model, args.encoder_batch_size)
        stage("after_model")
        loaded = {"event": "loaded", "loadSeconds": time.perf_counter() - loading,
                  "coldReadySeconds": time.perf_counter() - started, "gpu": torch.cuda.get_device_name(0),
                  "torch": torch.__version__, "transformers": transformers.__version__, "dtype": "bfloat16",
                  "attention": args.attention, "revision": manifest["revision"], "noCpuOffload": True,
                  "sdpaBackend": args.sdpa_backend, "traceKernels": args.trace_kernels,
                  "encoderBatchSize": args.encoder_batch_size or None,
                  "allocatedBytes": torch.cuda.memory_allocated(), "reservedBytes": torch.cuda.memory_reserved()}
        loaded["moduleAttention"] = {name: getattr(getattr(model.config, name), "_attn_implementation", None)
                                     for name in ("audio_config", "text_config")}
        loaded["upstreamRevision"] = subprocess.check_output(
            ["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip()
        loaded["upstreamDirty"] = bool(subprocess.check_output(
            ["git", "-C", str(args.upstream), "status", "--porcelain"], text=True).strip())
        with (args.output / "results.jsonl").open("w", encoding="utf-8") as output:
            def emit(row):
                row["sampledDeviceUsedPeakMiB"] = max((s["usedMiB"] for s in monitor.gpu), default=None)
                records.append(row)
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                os.fsync(output.fileno())
                print(json.dumps({k: v for k, v in row.items() if k not in {"text", "segments"}}, ensure_ascii=False), flush=True)
            emit(loaded)
            inputs = json.loads(args.inputs.read_text(encoding="utf-8-sig"))["inputs"]
            for item in inputs[:args.limit]:
                audio = Path(item["audio"])
                info = sf.info(str(audio))
                if sha256(audio) != item["sha256"]:
                    raise ValueError("Audio fingerprint changed")
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
                begin = time.perf_counter()
                host_index = len(monitor.samples)
                gpu_index = len(monitor.gpu)
                row = {"event": "transcript", "id": item["id"], "audioSha256": item["sha256"],
                       "audioSeconds": info.duration, "maxNewTokens": max(512, round(info.duration * 18)),
                       "memoryBefore": process_memory(psutil.Process())}
                batch = generated = new = None
                try:
                    messages = build_transcription_messages(audio)
                    with torch.inference_mode(), torch.amp.autocast("cuda", dtype=torch.bfloat16), \
                            backend_context(torch, args.sdpa_backend), trace_attention(torch, args.trace_kernels, kernel_trace):
                        batch = prepare_inputs(processor, messages, device=torch.device("cuda:0")).to("cuda:0")
                        prompt_length = int(batch["attention_mask"][0].sum())
                        config = copy.deepcopy(model.generation_config)
                        config.do_sample = False
                        config.max_new_tokens = row["maxNewTokens"]
                        generated = model.generate(**batch, generation_config=config)
                    new = generated[0][prompt_length:]
                    eos = config.eos_token_id if isinstance(config.eos_token_id, list) else [config.eos_token_id]
                    text = processor.tokenizer.decode(new, skip_special_tokens=True).strip()
                    segments = [asdict(s) for s in parse_transcript(text)]
                    row.update(text=text, segments=segments, promptTokens=prompt_length, tokens=int(new.numel()),
                        reachedEos=bool(new.numel() and int(new[-1]) in eos),
                        outOfBounds=sum(s["start"] < 0 or s["end"] > info.duration + 0.2 for s in segments),
                        speakerCount=len({s["speaker"] for s in segments}))
                except Exception as error:
                    row.update(error=str(error), errorType=type(error).__name__, traceback=traceback.format_exc())
                    exit_code = 1
                try:
                    torch.cuda.synchronize()
                    row.update(gpuAllocatedPeakBytes=torch.cuda.max_memory_allocated(),
                               gpuReservedPeakBytes=torch.cuda.max_memory_reserved())
                except Exception as error:
                    row.update(cudaError=str(error), cudaTraceback=traceback.format_exc())
                    exit_code = 1
                row.update(seconds=time.perf_counter() - begin, processRssBytes=psutil.Process().memory_info().rss)
                row.update(memoryAfter=process_memory(psutil.Process()),
                    sampledCaseRssPeakBytes=max((sum(s["rss"].values()) for s in monitor.samples[host_index:]), default=0),
                    sampledCasePrivatePeakBytes=max((sum(s.get("privateBytes", {}).values())
                        for s in monitor.samples[host_index:]), default=0),
                    sampledCaseDevicePeakMiB=max((s["usedMiB"] for s in monitor.gpu[gpu_index:]), default=None))
                emit(row)
                del batch, generated, new
                gc.collect()
                if row.get("error") or row.get("cudaError"):
                    break
    except Exception as error:
        records.append({"event": "fatal", "error": str(error), "traceback": traceback.format_exc()})
        print(traceback.format_exc(), flush=True)
        exit_code = 1
    finally:
        monitor.close()
        (args.output / "receipt.json").write_text(json.dumps({"records": records,
            "wallSeconds": time.perf_counter() - started, "resources": monitor.result(),
            "environment": environment, "memoryStages": stages, "attentionTrace": kernel_trace,
            "inputsSha256": sha256(args.inputs), "probeSha256": sha256(__file__), "exitCode": exit_code},
            ensure_ascii=False, indent=2), encoding="utf-8")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
