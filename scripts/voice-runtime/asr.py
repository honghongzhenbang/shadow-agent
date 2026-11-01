"""One-shot local ASR and pause-delimited speaker clustering. Never records audio."""

import argparse
import json
import math
from pathlib import Path
import sys
import time
from types import SimpleNamespace

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runtime_common import (bootstrap, contained, deny_network, emit_error,
                            read_audio_manifest, sha256, write_json)
from recognition_windows import recognition_plan
from local_provider import LocalProvider, MossProvider
from audio_conditioning import bounded_gain
from streaming_deadline import audio_budget

SUPPORTED_FORMATS = {".wav": {"WAV", "WAVEX", "RF64"}, ".flac": {"FLAC"},
                     ".mp3": {"MP3"}, ".ogg": {"OGG"}, ".opus": {"OGG"}}


def validate_audio_path(path):
    if path.suffix.lower() not in SUPPORTED_FORMATS:
        raise ValueError("Unsupported audio extension. Use WAV/FLAC/MP3/OGG/Opus; M4A/AAC is not supported")
    if not path.is_file():
        raise ValueError("--audio must be an existing local file")


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True, type=Path,
                        help="Local audio file supported by libsndfile; no URLs")
    parser.add_argument("--continuation-audio", action="append", default=[], type=Path,
                        help="Ordered continuation part from the same standard recording package")
    parser.add_argument("--model-dir", required=True, type=Path,
                        help="Directory containing setup.py's manifest.json")
    parser.add_argument("--output", required=True,
                        help="json for stdout, or a destination .json path (main-process compatibility)")
    parser.add_argument("--output-file", type=Path,
                        help="Optional JSON copy (stdout still contains JSON)")
    parser.add_argument("--language", choices=["zh", "en", "ja", "ko", "yue", "auto"],
                        default="zh")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--diarization", choices=["vad-cluster", "none"],
                        default="vad-cluster")
    parser.add_argument("--cluster-threshold", type=float, default=0.5,
                        help="Cosine distance cutoff; larger merges more speakers")
    parser.add_argument("--max-seconds", type=float, default=43200)
    parser.add_argument("--asr-provider", choices=["auto-local", "sensevoice-local", "fun-asr-nano", "moss-local"], default="auto-local")
    parser.add_argument("--moss-python")
    parser.add_argument("--moss-model-dir", type=Path)
    parser.add_argument("--moss-upstream", type=Path)
    parser.add_argument("--moss-cache-dir", type=Path)
    parser.add_argument("--moss-max-seconds", type=float, default=60)
    parser.add_argument("--fun-python")
    parser.add_argument("--fun-model-dir", type=Path)
    parser.add_argument("--fun-weight-sha256")
    parser.add_argument("--fallback", choices=["sensevoice-local", "none"], default="sensevoice-local")
    parser.add_argument("--min-free-mib", type=int, default=1024)
    parser.add_argument("--min-vram-mib", type=int, default=2300)
    parser.add_argument("--max-gain-db", type=float, default=12.0,
                        help="Post-VAD ASR gain cap, 0 disables; original audio and voiceprints are unchanged")
    parser.add_argument("--asr-time-budget-factor", type=float, default=2.0,
                        help="Generative ASR deadline / input duration, 1-10; model loading excluded")
    args = parser.parse_args(argv)
    if not math.isfinite(args.moss_max_seconds) or not 5 <= args.moss_max_seconds <= 120:
        parser.error("--moss-max-seconds must be 5-120; 60 is the initial local window limit")
    if not 1 <= args.threads <= 16:
        parser.error("--threads must be between 1 and 16")
    if not math.isfinite(args.cluster_threshold) or not 0 < args.cluster_threshold < 2:
        parser.error("--cluster-threshold must be finite and between 0 and 2")
    if not math.isfinite(args.max_seconds) or not 0 < args.max_seconds <= 43200:
        parser.error("--max-seconds must be finite, positive and <= 43200")
    if args.min_free_mib < 256 or args.min_vram_mib < 512:
        parser.error("Resource reserves must remain positive (host >=256 MiB, CUDA >=512 MiB)")
    if not math.isfinite(args.max_gain_db) or not 0 <= args.max_gain_db <= 18:
        parser.error("--max-gain-db must be finite and between 0 and 18")
    try:
        audio_budget(1, args.asr_time_budget_factor)
    except ValueError as error:
        parser.error(str(error))
    if args.output != "json":
        if args.output_file or Path(args.output).suffix.lower() != ".json":
            parser.error("Use --output json [--output-file PATH] or --output PATH.json")
        args.output_file = Path(args.output)
    return args


def load_models(directory, with_embedding):
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("provider") != "cpu":
        raise ValueError("Unsupported model manifest or provider")
    names = ["asr", "tokens", "vad"] + (["embedding"] if with_embedding else [])
    models = {}
    for name in names:
        entry = manifest["files"][name]
        path = contained(directory, entry["path"])
        if not path.is_file() or sha256(path) != entry["sha256"]:
            raise ValueError("Missing/corrupt model asset: " + name + "; rerun setup.py")
        models[name] = str(path)
    return manifest, models


def decode_audio(path, max_seconds, np, sf, soxr, frame_range=None):
    validate_audio_path(path)
    info = sf.info(str(path))
    if info.format not in SUPPORTED_FORMATS[path.suffix.lower()]:
        raise ValueError("Audio container does not match the supported file extension")
    if path.suffix.lower() == ".opus" and info.subtype != "OPUS":
        raise ValueError(".opus input must contain Ogg/Opus audio")
    if path.suffix.lower() == ".ogg" and info.subtype not in {"VORBIS", "OPUS"}:
        raise ValueError(".ogg input must contain Vorbis or Opus audio")
    if not 8000 <= info.samplerate <= 192000 or not 1 <= info.channels <= 8:
        raise ValueError("Audio must have 1-8 channels and sample rate 8000-192000 Hz")
    if info.frames <= 0 or info.frames / info.samplerate > max_seconds:
        raise ValueError("Audio is empty or exceeds --max-seconds")
    frames = info.frames if frame_range is None else frame_range[1] - frame_range[0]
    if frames * info.channels > 80_000_000:
        raise ValueError("Decoded input exceeds the 80 million sample memory limit")
    manifest = read_audio_manifest(path, info) if frame_range is None else None
    bounds = {} if frame_range is None else {"start": frame_range[0], "stop": frame_range[1]}
    samples, rate = sf.read(str(path), dtype="float32", always_2d=True, **bounds)
    if not np.isfinite(samples).all():
        raise ValueError("Audio contains NaN or infinite samples")
    warnings = []
    if samples.shape[1] > 1:
        warnings.append("CHANNELS_DOWNMIXED: arithmetic mean; channel identity is not retained")
    samples = np.mean(samples, axis=1, dtype=np.float32)
    if rate != 16000:
        samples = soxr.resample(samples, rate, 16000, quality="HQ")
        warnings.append("AUDIO_RESAMPLED: band-limited soxr HQ to 16000 Hz")
    if manifest and manifest.get("testOnly"):
        warnings.append("TEST_FIXTURE_ONLY: do not import into production evidence or identities")
    return np.ascontiguousarray(samples, dtype=np.float32), info, warnings


def _package_manifest(path):
    candidates = [Path(str(path) + ".manifest.json"), path.parent / "manifest.json"]
    for candidate in candidates:
        if candidate.is_file():
            value = json.loads(candidate.read_text(encoding="utf-8-sig"))
            if value.get("kind") == "voice-recording-package-part":
                if value.get("audioPath", value.get("audioFile")) != path.name:
                    raise ValueError("Recording package audio path mismatch")
                if value.get("sha256") != sha256(path):
                    raise ValueError("Recording package SHA-256 mismatch")
                return value
    return None


def _validate_package_chain(manifests, complete):
    if any(manifest is None for manifest in manifests):
        raise ValueError("Every continuation must be a standard recording package part")
    package_id = manifests[0].get("packageId")
    device_id = manifests[0].get("deviceId")
    base = manifests[0].get("partIndex")
    if not isinstance(base, int) or base < 0:
        raise ValueError("Recording package partIndex is invalid")
    previous = manifests[0].get("previousRecordingId")
    if complete and (base != 0 or previous is not None):
        raise ValueError("A complete recording package must start at part 0")
    for relative, manifest in enumerate(manifests):
        if manifest.get("packageId") != package_id or manifest.get("deviceId") != device_id:
            raise ValueError("Recording package parts belong to different packages or devices")
        if manifest.get("partIndex") != base + relative:
            raise ValueError("Recording package parts must be complete and ordered")
        if relative and manifest.get("previousRecordingId") != manifests[relative - 1].get("recordingId"):
            raise ValueError("Recording package predecessor chain is incomplete")
        if relative + 1 < len(manifests) and manifest.get("finalPart") is not False:
            raise ValueError("A nonterminal recording package part was marked final")
    if complete and manifests[-1].get("finalPart") is not True:
        raise ValueError("Recording package is incomplete; final part has not arrived")


def decode_recording_package(paths, max_seconds, np, sf, soxr, complete=True):
    """Rebuild physical parts before VAD/diarization; part edges are never semantic edges."""
    if not paths:
        raise ValueError("A recording package requires at least one audio part")
    manifests = [_package_manifest(path) for path in paths]
    if len(paths) > 1 or manifests[0] is not None:
        _validate_package_chain(manifests, complete)
    package_mode = all(manifest is not None for manifest in manifests)
    expected_samples = []
    if package_mode:
        for path, manifest in zip(paths, manifests):
            info = sf.info(str(path))
            if info.samplerate != 16000 or info.channels != 1:
                raise ValueError("Standard recording package parts must be 16000 Hz mono")
            if manifest.get("sampleRateHz") != 16000 or manifest.get("channels") != 1 or \
                    manifest.get("sampleCount") != info.frames:
                raise ValueError("Recording package sample metadata mismatch")
            expected_samples.append(info.frames)
        if sum(expected_samples) / 16000 > max_seconds:
            raise ValueError("Combined recording package exceeds --max-seconds")
        # One aggregate buffer plus the current part; do not retain all decoded parts and
        # concatenate a second full copy. The caller bounds the package window to five parts.
        combined = np.empty(sum(expected_samples), dtype=np.float32)
    else:
        combined = None
    warnings, offsets, cursor, legacy_parts = [], [], 0, []
    for index, (path, manifest) in enumerate(zip(paths, manifests)):
        samples, _, part_warnings = decode_audio(path, max_seconds, np, sf, soxr)
        warnings.extend(part_warnings)
        if package_mode:
            if len(samples) != expected_samples[index]:
                raise ValueError("Recording package decoded sample count mismatch")
            combined[cursor:cursor + len(samples)] = samples
        else:
            legacy_parts.append(samples)
        offsets.append({"recordingId": manifest.get("recordingId") if manifest else None,
                        "audioSha256": sha256(path), "partIndex": manifest.get("partIndex") if manifest else 0,
                        "startSample": cursor, "endSample": cursor + len(samples)})
        cursor += len(samples)
    if not package_mode:
        if cursor / 16000 > max_seconds:
            raise ValueError("Combined recording package exceeds --max-seconds")
        combined = legacy_parts[0] if len(legacy_parts) == 1 else np.concatenate(legacy_parts)
    samples = np.ascontiguousarray(combined, dtype=np.float32)
    info = SimpleNamespace(samplerate=16000, frames=len(samples), channels=1,
                           duration=len(samples) / 16000)
    if len(paths) > 1:
        warnings.append("PHYSICAL_PARTS_REASSEMBLED: VAD and ASR ran after lossless ordered concatenation")
    return samples, info, warnings, offsets


def create_vad(model, threads, sherpa, silence=0.5, maximum=20):
    config = sherpa.VadModelConfig()
    config.silero_vad.model = model
    config.silero_vad.min_silence_duration = silence
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = maximum
    config.sample_rate = 16000
    config.num_threads = threads
    config.provider = "cpu"
    if not config.validate():
        raise ValueError("Invalid VAD configuration")
    return sherpa.VoiceActivityDetector(config, buffer_size_in_seconds=maximum + silence + 10)


def speech_intervals(samples, model, threads, sherpa, np, detector=None):
    return streamed_speech_intervals([samples], len(samples), model, threads, sherpa, np, detector)


def streamed_speech_intervals(chunks, sample_count, model, threads, sherpa, np, detector=None):
    detector = detector if detector is not None else create_vad(model, threads, sherpa)
    detector.reset()
    step = detector.config.silero_vad.window_size
    intervals = []
    # Match PCM16 recording precision for VAD only. A low-level MP3 fixture was
    # missed with codec float noise but detected after this bounded conditioning.
    pending = np.empty(0, dtype=np.float32)

    def drain():
        while not detector.empty():
            segment = detector.front
            start = max(0, segment.start)
            end = min(sample_count, segment.start + len(segment.samples))
            if end > start:
                intervals.append((start, end))
                if len(intervals) > 10000:
                    raise ValueError("Recording exceeds 10000 speech turns; split into recording sessions")
            detector.pop()

    for samples in chunks:
        vad_samples = pcm16_precision(samples, np)
        if len(pending):
            vad_samples = np.concatenate((pending, vad_samples))
        complete = len(vad_samples) // step * step
        for start in range(0, complete, step):
            detector.accept_waveform(vad_samples[start:start + step])
            drain()
        pending = vad_samples[complete:].copy()
    if len(pending):
        detector.accept_waveform(np.pad(pending, (0, step - len(pending))))
        drain()
    detector.flush()
    drain()
    return intervals


def pcm16_precision(samples, np):
    return np.ascontiguousarray(np.clip(np.rint(samples * 32768), -32768, 32767) / 32768,
                                dtype=np.float32)


def normalize(vector, np):
    vector = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(vector).all() or not math.isfinite(norm) or norm < 1e-8:
        raise ValueError("Embedding is nonfinite or has zero norm")
    return vector / norm


def create_extractor(model, threads, sherpa):
    config = sherpa.SpeakerEmbeddingExtractorConfig(
        model=model, num_threads=threads, provider="cpu", debug=False)
    if not config.validate():
        raise ValueError("Invalid speaker embedding configuration")
    return sherpa.SpeakerEmbeddingExtractor(config)


def speaker_clusters(samples, intervals, model, model_hash, args, sherpa, np, extractor=None):
    extractor = extractor if extractor is not None else create_extractor(model, args.threads, sherpa)
    vectors, valid_indices = [], []
    labels = ["unknown"] * len(intervals)
    for i, (start, end) in enumerate(intervals):
        if end - start < 16000:
            continue
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples[start:end])
        stream.input_finished()
        if not extractor.is_ready(stream):
            continue
        vectors.append(normalize(extractor.compute(stream), np))
        valid_indices.append(i)
    if not vectors:
        return labels, [], ["EMBEDDING_UNAVAILABLE: speech shorter than 1 second or insufficient features"]
    # Use the engine's agglomerative clustering, not names or transcript heuristics.
    clusterer = sherpa.FastClustering(sherpa.FastClusteringConfig(
        num_clusters=-1, threshold=args.cluster_threshold))
    clusters = [0] if len(vectors) == 1 else clusterer(
        np.ascontiguousarray(vectors, dtype=np.float32))
    canonical, groups = {}, {}
    for i, vector, cluster in zip(valid_indices, vectors, clusters):
        label = canonical.setdefault(cluster, "speaker_%02d" % len(canonical))
        labels[i] = label
        groups.setdefault(label, []).append(vector)
    speakers = [{"label": label,
                 "embedding": normalize(np.mean(group, axis=0), np).tolist(),
                 "embeddingModel": "3dspeaker-campplus-zh-cn-16k@sha256:" + model_hash,
                 "embeddingDimension": int(extractor.dim)}
                for label, group in groups.items()]
    for speaker in speakers:
        speaker["speechDurationMs"] = sum(
            round((end-start)/16) for (start,end), label in zip(intervals, labels)
            if label == speaker["label"])
    warnings = []
    if "unknown" in labels:
        warnings.append("SHORT_SEGMENT_SPEAKER_UNKNOWN: no identity or neighboring label inferred")
    return labels, speakers, warnings


class AsrRuntime:
    """Single-worker cache. No heavy inference model is loaded until speech exists."""

    def __init__(self, args):
        bootstrap()
        deny_network()
        import numpy as np
        import sherpa_onnx as sherpa
        import soundfile as sf
        import soxr
        if sherpa.__version__ != "1.13.8":
            raise RuntimeError("Unexpected sherpa-onnx version; rerun setup.py")
        self.np, self.sherpa, self.sf, self.soxr = np, sherpa, sf, soxr
        self.key = (str(args.model_dir.resolve()), args.threads, args.language, args.diarization)
        self.moss_key = tuple(str(getattr(args, key, None)) for key in (
            "asr_provider", "moss_python", "moss_model_dir", "moss_upstream", "moss_cache_dir", "moss_max_seconds", "asr_time_budget_factor"))
        self.manifest, self.models = load_models(args.model_dir, args.diarization == "vad-cluster")
        self.detector = create_vad(self.models["vad"], args.threads, sherpa,
            maximum=args.moss_max_seconds + 2 if args.asr_provider == "moss-local" else 20)
        self.recognizer = self.extractor = None
        self.loads = {"asr": 0, "embedding": 0}
        self.provider = MossProvider(args, sf) if args.asr_provider == "moss-local" else \
            LocalProvider(args, lambda samples: self.decode_sense(args, samples), sf)

    def release_heavy(self):
        self.recognizer = self.extractor = None
        self.provider.close()

    def decode_sense(self, args, samples):
        recognizer = self.get_recognizer(args)
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        return {"text": stream.result.text.strip(),
                "language": getattr(stream.result, "lang", "").replace("<|", "").replace("|>", "")}

    def verify_asset(self, name):
        if sha256(Path(self.models[name])) != self.manifest["files"][name]["sha256"]:
            raise ValueError("Model changed while listener was running: " + name + "; restart after setup")

    def get_extractor(self, args):
        if self.extractor is None:
            self.verify_asset("embedding")
            self.extractor = create_extractor(self.models["embedding"], args.threads, self.sherpa)
            self.loads["embedding"] += 1
        return self.extractor

    def get_recognizer(self, args):
        if self.recognizer is None:
            self.verify_asset("asr")
            self.verify_asset("tokens")
            self.recognizer = self.sherpa.OfflineRecognizer.from_sense_voice(
                model=self.models["asr"], tokens=self.models["tokens"], num_threads=args.threads,
                language="" if args.language == "auto" else args.language,
                use_itn=True, debug=False, provider="cpu")
            self.loads["asr"] += 1
        return self.recognizer


def _run_paths(args, runtime, audio_paths, complete=True, decoded=None, prepared_intervals=None):
    total_start = time.perf_counter()
    runtime = runtime if runtime is not None else AsrRuntime(args)
    if runtime.key != (str(args.model_dir.resolve()), args.threads, args.language, args.diarization):
        raise ValueError("A cached runtime cannot change models, threads, language or diarization")
    np, sherpa, sf, soxr = runtime.np, runtime.sherpa, runtime.sf, runtime.soxr
    manifest, models = runtime.manifest, runtime.models
    with_embedding = args.diarization == "vad-cluster"
    started = time.perf_counter()
    samples, info, warnings, source_packages = decoded if decoded is not None else decode_recording_package(
        audio_paths, args.max_seconds, np, sf, soxr, complete=complete)
    decode_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    intervals = prepared_intervals if prepared_intervals is not None else speech_intervals(
        samples, models["vad"], args.threads, sherpa, np, runtime.detector)
    speakers = []
    if with_embedding and intervals:
        labels, speakers, extra = speaker_clusters(samples, intervals, models["embedding"],
                                                   manifest["files"]["embedding"]["sha256"],
                                                   args, sherpa, np, runtime.get_extractor(args))
        warnings.extend(extra)
    else:
        labels = ["unknown"] * len(intervals)
    diarization_ms = (time.perf_counter() - started) * 1000
    windows = recognition_plan(intervals, labels, len(samples))
    warnings.append("COARSE_TIMESTAMPS: bounded recognition windows, not word alignment")
    if with_embedding:
        warnings.append("LIMITED_DIARIZATION: acoustic clustering of VAD turns; no within-turn speaker-change or overlap detection")
        warnings.append("SPEAKER_LABELS_NOT_IDENTITIES: recording-local clusters; embedding similarities are review candidates only")
    else:
        warnings.append("DIARIZATION_DISABLED: unknown labels do not assert one or multiple speakers")
    if not intervals:
        warnings.append("NO_SPEECH_DETECTED")
    asr_start = time.perf_counter()
    segments, languages, partial_results = [], set(), []
    def recognize(start, end, purpose="core"):
        view = samples[start:end]
        conditioning = {"gainDb": 0, "policy": "post-vad-asr-view-only"}
        max_gain_db = getattr(args, "max_gain_db", 12)
        if max_gain_db:
            view, conditioning = bounded_gain(view, np, max_gain_db)
        decoded = runtime.provider.decode(view, start, purpose)
        return {**decoded, "conditioning": conditioning}
    def preserve_partial(decoded, start, end, purpose):
        partial_results.append({"startMs": round(start / 16), "endMs": round(end / 16),
            "text": decoded["text"], "asrProvider": decoded["engine"], "purpose": purpose,
            "stopReason": decoded["stopReason"], "budgetSeconds": decoded["budgetSeconds"],
            "budgetFactor": decoded.get("budgetFactor", 1),
            "tokens": decoded.get("tokens"), "maxNewTokens": decoded.get("maxNewTokens"),
            "elapsedSeconds": decoded.get("seconds"), "conditioning": decoded.get("conditioning")})
    if intervals:
        for i, window in enumerate(windows):
            start, end, label = window["start"], window["end"], window["label"]
            decoded = recognize(start, end)
            if decoded.get("completion") == "partial":
                preserve_partial(decoded, start, end, "core")
                continue
            text, lang = decoded["text"], decoded.get("language", "")
            boundary = None
            if window["overlapSamples"]:
                try:
                    contextual = recognize(window["inputStart"], end, "boundary-candidate")
                    if contextual.get("completion") == "partial":
                        preserve_partial(contextual, window["inputStart"], end, "boundary-candidate")
                        raise RuntimeError("Boundary candidate incomplete")
                    boundary = {"text": contextual["text"], "startMs": round(window["inputStart"] / 16),
                                "endMs": round(end / 16), "overlapMs": round(window["overlapSamples"] / 16),
                                "policy": "core-text-with-context-candidate-not-word-aligned"}
                except RuntimeError:
                    warnings.append("BOUNDARY_CONTEXT_UNAVAILABLE: core transcript retained; inspect original audio")
            if lang:
                languages.add(lang)
            if any(character.isalnum() for character in text):
                segments.append({"id": "segment_%04d" % i,
                                 "startMs": round(start * 1000 / 16000),
                                 "endMs": min(round(end * 1000 / 16000), round(info.duration * 1000)),
                                 "text": text, "speakerLabel": label,
                                 "asrProvider": decoded["engine"], "forcedStart": window["forcedStart"],
                                 "conditioning": decoded["conditioning"],
                                 "boundaryContext": boundary})
    used = {segment["speakerLabel"] for segment in segments}
    speakers = [s for s in speakers if s["label"] in used]
    if "unknown" in used:
        speakers.append({"label": "unknown"})
    if partial_results:
        warnings.append("ASR_PARTIAL: time or output budget reached; unfinished text retained separately")
    result = {
        "schemaVersion": 1,
        "engine": "+".join(sorted(runtime.provider.used)) or "local-no-speech",
        "model": "local-voice-v2",
        "language": args.language if args.language != "auto" else
                    (next(iter(languages)) if len(languages) == 1 else "mixed" if languages else "und"),
        "durationMs": round(info.duration * 1000),
        "audio": {"sampleRateHz": info.samplerate, "sampleCount": info.frames,
                  "channels": info.channels},
        "segments": segments,
        "completion": "partial" if partial_results else "complete",
        "partialResults": partial_results,
        "segmentation": {"policy": "speaker-bounded-core-context-v2", "vadTurns": len(intervals),
                         "recognitionWindows": len(windows), "maxWindowMs": 35000,
                         "maxOverlapMs": 1000, "speakerEmbeddingUsesOriginalTurns": True,
                         "mergeGapMs": 1200, "paddingMs": 200,
                         "crossFileContext": len(audio_paths) > 1,
                         "physicalParts": len(audio_paths)},
        "sourcePackages": source_packages,
        "speakers": speakers,
        "timings": {"decodeMs": round(decode_ms, 3),
                    "asrMs": round((time.perf_counter() - asr_start) * 1000, 3),
                    "diarizationMs": round(diarization_ms, 3),
                    "totalMs": round((time.perf_counter() - total_start) * 1000, 3)},
        "warnings": warnings,
        "diarization": {"mode": args.diarization, "speakerChangeDetection": False,
                        "overlapDetection": False, "clusterThreshold": args.cluster_threshold},
    }
    return result


def _windowed_package(args, runtime, audio_paths):
    """Bound memory while preserving context around every physical part boundary."""
    window_parts, overlap_parts = 5, 2
    step = window_parts - overlap_parts
    manifests = [_package_manifest(path) for path in audio_paths]
    _validate_package_chain(manifests, complete=True)
    full_sources, cursor = [], 0
    for path, manifest in zip(audio_paths, manifests):
        samples = manifest.get("sampleCount")
        if not isinstance(samples, int) or samples <= 0:
            raise ValueError("Recording package sampleCount is invalid")
        full_sources.append({"recordingId": manifest.get("recordingId"), "audioSha256": sha256(path),
                             "partIndex": manifest.get("partIndex"), "startSample": cursor,
                             "endSample": cursor + samples})
        cursor += samples
    segments, speakers, warnings, languages, partial_results = [], [], [], set(), []
    timing = {"decodeMs": 0.0, "asrMs": 0.0, "diarizationMs": 0.0, "totalMs": 0.0}
    batch_count = 0
    for start in range(0, len(audio_paths), step):
        end = min(len(audio_paths), start + window_parts)
        batch = _run_paths(args, runtime, audio_paths[start:end], complete=False)
        batch_count += 1
        global_offset = full_sources[start]["startSample"]
        lower = 0 if start == 0 else full_sources[start + 1]["startSample"]
        upper = cursor if end == len(audio_paths) else full_sources[end - 1]["startSample"]
        window_index = batch_count - 1
        for partial in batch.get("partialResults", []):
            midpoint = global_offset + (partial["startMs"] + partial["endMs"]) * 8
            if lower <= midpoint < upper:
                partial_results.append({**partial,
                    "startMs": partial["startMs"] + round(global_offset / 16),
                    "endMs": partial["endMs"] + round(global_offset / 16)})
        def global_label(label):
            if label == "unknown":
                return "unknown"
            suffix = int(label.rsplit("_", 1)[-1])
            return "speaker_%05d" % (window_index * 100 + suffix)
        used = set()
        for segment in batch["segments"]:
            begin = global_offset + round(segment["startMs"] * 16)
            finish = global_offset + round(segment["endMs"] * 16)
            midpoint = (begin + finish) // 2
            if midpoint < lower or midpoint >= upper:
                continue
            label = global_label(segment["speakerLabel"])
            used.add(label)
            shifted = {**segment, "id": "", "startMs": round(begin / 16), "endMs": round(finish / 16),
                       "speakerLabel": label}
            if shifted.get("boundaryContext"):
                shifted["boundaryContext"] = {**shifted["boundaryContext"],
                    "startMs": shifted["boundaryContext"]["startMs"] + round(global_offset / 16),
                    "endMs": shifted["boundaryContext"]["endMs"] + round(global_offset / 16)}
            segments.append(shifted)
        for speaker in batch["speakers"]:
            label = global_label(speaker["label"])
            if label in used and not any(existing["label"] == label for existing in speakers):
                speakers.append({**speaker, "label": label})
        warnings.extend(batch["warnings"])
        if batch["language"] != "und":
            languages.add(batch["language"])
        for name in timing:
            timing[name] += batch["timings"][name]
        if end == len(audio_paths):
            break
    segments.sort(key=lambda item: (item["startMs"], item["endMs"]))
    for index, segment in enumerate(segments):
        segment["id"] = "segment_%04d" % index
    if any(segment["speakerLabel"] == "unknown" for segment in segments) and not any(
            speaker["label"] == "unknown" for speaker in speakers):
        speakers.append({"label": "unknown"})
    warnings = list(dict.fromkeys(warnings + [
        "BOUNDED_PACKAGE_WINDOWS: physical parts were reassembled in overlapping windows before semantic segmentation"
    ]))
    return {
        "schemaVersion": 1, "engine": "+".join(sorted(runtime.provider.used)) or "local-no-speech",
        "model": "local-voice-v2",
        "language": next(iter(languages)) if len(languages) == 1 else "mixed" if languages else "und",
        "durationMs": round(cursor / 16),
        "audio": {"sampleRateHz": 16000, "sampleCount": cursor, "channels": 1},
        "segments": segments,
        "completion": "partial" if partial_results else "complete",
        "partialResults": partial_results,
        "segmentation": {"policy": "pause-grouped-windowed-v1", "vadTurns": None,
                         "recognitionWindows": len(segments), "maxWindowMs": 35000,
                         "mergeGapMs": 1200, "paddingMs": 200, "crossFileContext": True,
                         "physicalParts": len(audio_paths), "processingWindowParts": window_parts,
                         "overlapParts": overlap_parts, "processingWindows": batch_count},
        "sourcePackages": full_sources, "speakers": speakers,
        "timings": {name: round(value, 3) for name, value in timing.items()},
        "warnings": warnings,
        "diarization": {"mode": args.diarization, "speakerChangeDetection": False,
                        "overlapDetection": False, "clusterThreshold": args.cluster_threshold},
    }


class AudioWindowReader:
    """A bounded, sample-addressable view; no full-recording PCM allocation."""

    def __init__(self, args, runtime):
        self.args, self.runtime = args, runtime
        self.source = runtime.sf.info(str(args.audio))
        self.decode_ms, self.warnings = 0, []
        if self.source.frames <= 0 or self.source.duration > args.max_seconds:
            raise ValueError("Audio is empty or exceeds recording duration limit")
        read_audio_manifest(args.audio, self.source)

    def __len__(self):
        return round(self.source.duration * 16000)

    def __getitem__(self, bounds):
        start, stop, step = bounds.indices(len(self))
        if step != 1 or stop <= start:
            raise ValueError("Audio windows must be nonempty, contiguous ranges")
        rate = self.source.samplerate
        first, last = math.floor(start * rate / 16000), min(self.source.frames, math.ceil(stop * rate / 16000))
        began = time.perf_counter()
        samples, _, notes = decode_audio(self.args.audio, self.args.max_seconds, self.runtime.np,
            self.runtime.sf, self.runtime.soxr, (first, last))
        offset = round(start - first * 16000 / rate)
        samples = samples[offset:offset + stop - start]
        if len(samples) < stop - start:
            samples = self.runtime.np.pad(samples, (0, stop - start - len(samples)))
        self.decode_ms += (time.perf_counter() - began) * 1000
        self.warnings = list(dict.fromkeys(self.warnings + notes))
        return samples

    def chunks(self):
        # High-rate multichannel sources also stay below decode_audio's input memory cap.
        seconds = min(300, 79_000_000 // (self.source.samplerate * self.source.channels))
        size = max(1, seconds) * 16000
        for start in range(0, len(self), size):
            yield self[start:min(len(self), start + size)]


def _long_file(args, runtime):
    started = time.perf_counter()
    reader = AudioWindowReader(args, runtime)
    # VAD state and its partial frame survive file-read boundaries. Only the final
    # recording boundary flushes it; embeddings and ASR then read original ranges.
    intervals = streamed_speech_intervals(reader.chunks(), len(reader), runtime.models["vad"],
        args.threads, runtime.sherpa, runtime.np, runtime.detector)
    vad_ms = (time.perf_counter() - started) * 1000 - reader.decode_ms
    info = SimpleNamespace(samplerate=16000, frames=len(reader), channels=1, duration=len(reader) / 16000)
    result = _run_paths(args, runtime, [args.audio], decoded=(reader, info, [], []), prepared_intervals=intervals)
    result["segmentation"].update(streamedFile=True, maxReadBlockSeconds=300)
    result["timings"]["decodeMs"] = round(reader.decode_ms, 3)
    result["timings"]["diarizationMs"] += round(vad_ms, 3)
    result["timings"]["totalMs"] = round((time.perf_counter() - started) * 1000, 3)
    result["warnings"] = list(dict.fromkeys(result["warnings"] + reader.warnings + [
        "BOUNDED_FILE_READS: continuous VAD across read blocks; original ranges used for speaker embeddings and ASR"]))
    return result


def run(args, runtime=None):
    audio_paths = [args.audio, *getattr(args, "continuation_audio", [])]
    runtime = runtime if runtime is not None else AsrRuntime(args)
    if getattr(args, "asr_provider", None) == "moss-local":
        return _moss_streamed(args, runtime, audio_paths)
    if len(audio_paths) == 1 and runtime.sf.info(str(args.audio)).duration > 300:
        return _long_file(args, runtime)
    if len(audio_paths) <= 5:
        return _run_paths(args, runtime, audio_paths)
    return _windowed_package(args, runtime, audio_paths)


def _moss_streamed(args, runtime, paths):
    from continuous_audio import ContinuousAudio
    from moss_pipeline import transcribe_moss
    if runtime.key != (str(args.model_dir.resolve()), args.threads, args.language, args.diarization) or \
            runtime.moss_key != tuple(str(getattr(args, key, None)) for key in (
                "asr_provider", "moss_python", "moss_model_dir", "moss_upstream", "moss_cache_dir", "moss_max_seconds", "asr_time_budget_factor")):
        raise ValueError("Cached MOSS runtime configuration changed; close it before reconfiguration")
    start = time.perf_counter()
    manifests = [_package_manifest(path) for path in paths]
    if len(paths) > 1 or manifests[0] is not None:
        _validate_package_chain(manifests, complete=True)
    with ContinuousAudio(paths, manifests, args.max_seconds, runtime, validate_audio_path, SUPPORTED_FORMATS) as reader:
        vad_start = time.perf_counter()
        intervals = streamed_speech_intervals(reader.chunks(), len(reader), runtime.models["vad"],
            args.threads, runtime.sherpa, runtime.np, runtime.detector)
        vad_seconds = time.perf_counter() - vad_start
        info = SimpleNamespace(samplerate=16000, frames=len(reader), channels=1, duration=len(reader)/16000)
        result = transcribe_moss(args, runtime, reader, intervals, info, list(reader.warnings), reader.sources)
        result["segmentation"].update(streamedFile=True, physicalParts=len(paths), crossFileContext=len(paths) > 1)
        result["timings"]["diarizationMs"] = round(vad_seconds * 1000, 3)
        result["timings"]["totalMs"] = round((time.perf_counter() - start) * 1000, 3)
        return result


def main(argv=None):
    args = arguments(argv)
    runtime = None
    try:
        for audio in [args.audio, *args.continuation_audio]:
            validate_audio_path(audio)
        if len({audio.resolve() for audio in [args.audio, *args.continuation_audio]}) != 1 + len(args.continuation_audio):
            raise ValueError("Recording package audio paths must be unique")
        if args.output_file and any(args.output_file.resolve() == audio.resolve()
                                    for audio in [args.audio, *args.continuation_audio]):
            raise ValueError("JSON output cannot overwrite input audio")
        if args.output_file and args.output_file.exists():
            raise ValueError("Refusing to overwrite an existing result; choose a new --output path")
        runtime = AsrRuntime(args)
        result = run(args, runtime)
        result["asrAttemptCount"] = len(runtime.provider.attempts)
        result["asrDiagnosticsPath"] = str(args.output_file) + ".attempts.json" if args.output_file else None
        result["providerPolicy"] = {"requested": args.asr_provider,
            "fallback": "none" if args.asr_provider == "moss-local" else args.fallback,
            "cloudAllowed": False, "maxInputSeconds": args.moss_max_seconds if args.asr_provider == "moss-local" else 35}
        if args.output_file:
            write_json(args.output_file, result)
        print(json.dumps({"resultPath": str(args.output_file), "engine": result["engine"], "segments": len(result["segments"])}
                         if args.output_file else result, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as exc:
        emit_error(exc)
        return 1
    finally:
        if runtime:
            runtime.release_heavy()
            if args.output_file:
                write_json(Path(str(args.output_file) + ".attempts.json"), {"attempts": runtime.provider.attempts})


if __name__ == "__main__":
    sys.exit(main())
