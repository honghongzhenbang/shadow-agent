"""ASR windows are views of original speaker turns, never new voiceprint samples."""
import math


def recognition_plan(intervals, labels, sample_count, rate=16000,
                     max_seconds=35, gap_seconds=1.2, padding_seconds=0.2,
                     overlap_seconds=1):
    if len(intervals) != len(labels):
        raise ValueError("Each VAD interval needs a speaker label")
    values = (max_seconds, gap_seconds, padding_seconds, overlap_seconds)
    if not all(math.isfinite(v) for v in values) or not 0 < max_seconds <= 35:
        raise ValueError("ASR input limit must be positive and at most 35 seconds")
    maximum, gap, padding, overlap = [int(v * rate) for v in values]
    if min(gap, padding, overlap, sample_count) < 0 or maximum <= 2 * padding + overlap:
        raise ValueError("Invalid recognition window limits")
    regions = []
    previous_end = 0
    for (start, end), label in zip(intervals, labels):
        if not 0 <= start < end <= sample_count or start < previous_end:
            raise ValueError("VAD intervals must be ordered, disjoint and inside the audio")
        previous_end = end
        if regions and label != "unknown" and regions[-1][2] == label and start - regions[-1][1] <= gap:
            regions[-1][3].append((regions[-1][1], start))
            regions[-1][1] = end
        else:
            regions.append([start, end, label, []])
    result = []
    for region_index, (begin, finish, label, pauses) in enumerate(regions):
        start, forced = begin, False
        while start < finish:
            context = min(overlap, start - begin) if forced and label != "unknown" else 0
            limit = maximum - 2 * padding - context
            stop = min(finish, start + limit)
            next_forced = stop < finish
            if next_forced:
                candidates = [(a + b) // 2 for a, b in pauses if b > a and start < (a + b) // 2 <= stop]
                preferred = [p for p in candidates if 20 * rate <= p - start <= 30 * rate]
                if preferred or candidates:
                    stop = (preferred or candidates)[-1]
                    next_forced = False
                elif finish - stop < 3 * rate:
                    stop = start + (finish - start) // 2
            left = begin if start > begin else (0 if region_index == 0 else (regions[region_index - 1][1] + begin) // 2)
            right = finish if stop < finish else (sample_count if region_index + 1 == len(regions) else (finish + regions[region_index + 1][0]) // 2)
            core_start = max(left, start - padding) if start == begin else start
            core_end = min(right, stop + padding) if stop == finish else stop
            input_start = max(begin, core_start - context) if context else core_start
            result.append({"start": core_start, "end": core_end, "inputStart": input_start,
                           "inputEnd": core_end, "label": label, "forcedStart": forced,
                           "overlapSamples": core_start - input_start})
            start, forced = stop, next_forced
    assert all(w["inputEnd"] - w["inputStart"] <= maximum for w in result)
    return result


def recognition_windows(intervals, labels, sample_count, rate=16000,
                        max_seconds=35, gap_seconds=1.2, padding_seconds=0.2):
    return [(w["start"], w["end"], w["label"]) for w in recognition_plan(
        intervals, labels, sample_count, rate, max_seconds, gap_seconds, padding_seconds)]
