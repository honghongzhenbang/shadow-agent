"""Bounded joint-ASR windows and original-audio voiceprints, independent of file parts."""
import math
import time

from audio_conditioning import bounded_gain
from streaming_deadline import audio_budget

RATE = 16000


def moss_windows(intervals, sample_count, max_seconds=60):
    if not isinstance(max_seconds, (int, float)) or isinstance(max_seconds, bool) or not math.isfinite(max_seconds) or not 5 <= max_seconds <= 120:
        raise ValueError("MOSS window limit must be 5-120 seconds")
    maximum, padding, overlap = round(max_seconds * RATE), 3200, RATE
    previous = 0
    for start, end in intervals:
        if not 0 <= start < end <= sample_count or start < previous:
            raise ValueError("Invalid ordered VAD intervals")
        previous = end
    windows, cursor, forced, index = [], 0, False, 0
    while index < len(intervals):
        while index < len(intervals) and intervals[index][1] <= cursor:
            index += 1
        if index == len(intervals):
            break
        core_start = max(cursor, intervals[index][0] - padding)
        begin = max(0, core_start - overlap) if forced and core_start == cursor else core_start
        limit = min(sample_count, begin + maximum)
        last = index
        while last + 1 < len(intervals) and intervals[last + 1][0] < limit:
            last += 1
        if intervals[last][1] <= limit:
            end, next_forced = min(limit, intervals[last][1] + padding), False
        else:
            # Short gaps created by VAD's maximum-duration split are not pauses.
            pauses = [(a[1] + b[0]) // 2 for a, b in zip(intervals[index:last], intervals[index + 1:last + 1])
                      if b[0] - a[1] >= RATE // 2
                      and begin + min(40 * RATE, maximum * 2 // 3) <= (a[1] + b[0]) // 2 <= limit]
            end, next_forced = (pauses[-1], False) if pauses else (limit, True)
        windows.append({"start": begin, "end": end, "coreStart": core_start, "forcedStart": forced})
        cursor, forced = end, next_forced
    return windows


def project_segments(decoded, window, window_index):
    rows = decoded.get("segments")
    if not isinstance(rows, list) or (decoded.get("text", "").strip() and not rows):
        raise ValueError("MOSS output has no parsed transcript segments")
    result, duration = [], (window["end"] - window["start"]) / RATE
    for row in rows:
        start, end, label, text = (row.get(key) for key in ("start", "end", "speaker", "text"))
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end)) \
                or not 0 <= start < end <= duration + .02 or not isinstance(label, str) or not label \
                or not isinstance(text, str) or len(text) > 16000:
            raise ValueError("MOSS output contains invalid timestamps, labels or text")
        first = window["start"] + round(start * RATE)
        last = min(window["end"], window["start"] + round(end * RATE))
        if round(last / 16) <= round(first / 16):
            raise ValueError("MOSS segment is shorter than the saved timestamp precision")
        if last <= window["coreStart"] or not text.strip():
            continue
        result.append({"startMs": round(first / 16), "endMs": round(last / 16), "text": text.strip(),
            "speakerLabel": "window_%04d_%s" % (window_index, label), "asrProvider": "moss-local",
            "forcedStart": window["forcedStart"], "contextOverlapMs": max(0, round((window["coreStart"] - first) / 16)),
            "sourceWindow": {"index": window_index, "startMs": round(window["start"] / 16),
                "endMs": round(window["end"] / 16), "coreStartMs": round(window["coreStart"] / 16)}})
    return result


def exclusive_ranges(segment, segments):
    """Subtract differently labelled speech; never enroll a mixed-speaker interval."""
    ranges = [(round(segment["startMs"] * 16), round(segment["endMs"] * 16))]
    for other in segments:
        if other["speakerLabel"] == segment["speakerLabel"]:
            continue
        left, right = round(other["startMs"] * 16), round(other["endMs"] * 16)
        remaining = []
        for begin, end in ranges:
            if right <= begin or left >= end:
                remaining.append((begin, end))
            else:
                if begin < left:
                    remaining.append((begin, left))
                if right < end:
                    remaining.append((right, end))
        ranges = remaining
    return [(a, b) for a, b in ranges if b - a >= RATE]


def speaker_embeddings(samples, segments, runtime, args):
    np, speakers, warnings = runtime.np, [], []
    for label in dict.fromkeys(s["speakerLabel"] for s in segments):
        rows = [s for s in segments if s["speakerLabel"] == label]
        speaker = {"label": label}
        ranges = [pair for s in rows for pair in exclusive_ranges(s, segments)] if args.diarization != "none" else []
        vectors, weights, used_ranges = [], [], []
        # Merge overlapping same-label ranges so one acoustic interval is not counted twice.
        merged = []
        for begin, end in sorted(ranges):
            if merged and begin <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((begin, end))
        for begin, end in merged:
            extractor = runtime.get_extractor(args)
            stream = extractor.create_stream()
            stream.accept_waveform(sample_rate=RATE, waveform=samples[begin:end])
            stream.input_finished()
            if not extractor.is_ready(stream):
                continue
            vector = np.asarray(extractor.compute(stream), dtype=np.float32)
            norm = float(np.linalg.norm(vector))
            if not np.isfinite(vector).all() or norm < 1e-8:
                continue
            vectors.append(vector / norm)
            weights.append(end - begin)
            used_ranges.append({"startMs": round(begin / 16), "endMs": round(end / 16)})
        if vectors:
            mean = np.average(vectors, axis=0, weights=weights)
            norm = float(np.linalg.norm(mean))
            if math.isfinite(norm) and norm >= 1e-8:
                speaker.update(embedding=(mean / norm).tolist(), embeddingDimension=len(mean),
                    embeddingModel="3dspeaker-campplus-zh-cn-16k@sha256:" + runtime.manifest["files"]["embedding"]["sha256"],
                    embeddingRanges=used_ranges, speechDurationMs=round(sum(weights) / 16))
        if "embedding" not in speaker:
            warnings.append("SPEAKER_EMBEDDING_UNAVAILABLE: " + label)
        speakers.append(speaker)
    return speakers, warnings


def transcribe_moss(args, runtime, samples, intervals, info, warnings, sources):
    started = time.perf_counter()
    windows = moss_windows(intervals, len(samples), args.moss_max_seconds)
    segments, partials, speakers = [], [], []
    for index, window in enumerate(windows):
        begin, end = window["start"], window["end"]
        conditioning = None
        before = time.perf_counter()
        decoded = None
        try:
            view, conditioning = bounded_gain(samples[begin:end], runtime.np, args.max_gain_db)
            decoded = runtime.provider.decode(view, begin)
            if decoded.get("completion") != "partial":
                rows = project_segments(decoded, window, index)
                for row in rows:
                    row["conditioning"] = conditioning
                try:
                    people, notes = speaker_embeddings(samples, rows, runtime, args)
                except Exception as error:
                    people = [{"label": label} for label in dict.fromkeys(s["speakerLabel"] for s in rows)]
                    notes = ["VOICEPRINT_EXTRACTION_FAILED: " + str(error)]
                for person in people:
                    person["acousticScope"] = "moss-window-%d" % index
                speakers.extend(people)
                warnings.extend(notes)
                segments.extend(rows)
                continue
        except Exception as error:
            # Keep earlier completed windows and this attempt instead of discarding the recording.
            decoded = {**(decoded or {}), "stopReason": "invalid_model_output" if decoded else "worker_error",
                       "error": str(error)}
            runtime.provider.close()
        partials.append({"startMs": round(begin / 16), "endMs": round(end / 16),
            "text": decoded.get("text", ""), "asrProvider": "moss-local", "purpose": "core",
            "stopReason": decoded["stopReason"], "budgetSeconds": audio_budget((end - begin) / RATE, args.asr_time_budget_factor),
            "budgetFactor": args.asr_time_budget_factor, "elapsedSeconds": time.perf_counter() - before,
            "tokens": decoded.get("tokens"), "maxNewTokens": decoded.get("maxNewTokens"),
            "error": decoded.get("error"), "conditioning": conditioning})
        if decoded["stopReason"] == "worker_error":
            # Runtime/configuration failure cannot be repaired by repeating every remaining window.
            for remaining in windows[index + 1:]:
                first, last = remaining["start"], remaining["end"]
                partials.append({"startMs": round(first / 16), "endMs": round(last / 16), "text": "",
                    "asrProvider": "moss-local", "purpose": "core", "stopReason": "worker_error",
                    "error": "Not attempted after worker failure", "budgetFactor": args.asr_time_budget_factor,
                    "budgetSeconds": audio_budget((last - first) / RATE, args.asr_time_budget_factor)})
            break
    segments.sort(key=lambda s: (s["startMs"], s["endMs"]))
    for index, segment in enumerate(segments):
        segment["id"] = "segment_%04d" % index
    warnings.extend(["SPEAKER_LABELS_NOT_IDENTITIES: MOSS labels are local to one inference window",
        "MODEL_TIMESTAMPS: predicted segment ranges, not verified word alignment",
        "MOSS_BOUNDARY_CONTEXT: context-only segments excluded; straddling text retained with contextOverlapMs"])
    if not intervals:
        warnings.append("NO_SPEECH_DETECTED")
    if partials:
        warnings.append("ASR_PARTIAL: incomplete raw output retained separately")
    return {"schemaVersion": 1, "engine": "moss-local" if windows else "local-no-speech", "model": "moss-transcribe-diarize-0.9b",
        "language": "und" if args.language == "auto" else args.language,
        "durationMs": round(info.duration * 1000),
        "audio": {"sampleRateHz": info.samplerate, "sampleCount": info.frames, "channels": info.channels},
        "segments": segments, "speakers": speakers, "sourcePackages": sources,
        "completion": "partial" if partials else "complete", "partialResults": partials, "warnings": list(dict.fromkeys(warnings)),
        "segmentation": {"policy": "moss-pause-windows-v1", "maxWindowMs": round(args.moss_max_seconds * 1000),
            "maxOverlapMs": 1000, "vadTurns": len(intervals), "recognitionWindows": len(windows),
            "speakerEmbeddingUsesOriginalTurns": True},
        "diarization": {"mode": "moss-joint", "speakerChangeDetection": True, "overlapDetection": True,
                        "voiceprintExtraction": args.diarization != "none"},
        "timings": {"decodeMs": 0, "diarizationMs": 0, "asrMs": round((time.perf_counter() - started) * 1000, 3),
                    "totalMs": round((time.perf_counter() - started) * 1000, 3)}}
