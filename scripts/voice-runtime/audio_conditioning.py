"""Bounded linear gain on an ASR view, never on original audio or voiceprints."""
import math


def bounded_gain(samples, np, max_gain_db=12.0, target_dbfs=-26.0, peak_limit=.95):
    if not math.isfinite(max_gain_db) or not 0 <= max_gain_db <= 18:
        raise ValueError('Gain must be finite and between 0 and 18 dB')
    if not math.isfinite(target_dbfs) or not -60 <= target_dbfs <= -6 or not 0 < peak_limit <= 1:
        raise ValueError('Invalid gain target or peak limit')
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim != 1 or not values.size or not np.isfinite(values).all():
        raise ValueError('Expected finite nonempty mono samples')
    peak = float(np.max(np.abs(values)))
    rms = float(np.sqrt(np.mean(values.astype(np.float64) ** 2)))
    factor = 1.0 if not rms or not peak else max(1.0, min(10 ** (max_gain_db / 20),
        10 ** (target_dbfs / 20) / rms, peak_limit / peak))
    return np.ascontiguousarray(values * factor, dtype=np.float32), {
        'gainDb': round(20 * math.log10(factor), 6), 'gainFactor': factor,
        'inputRmsDbfs': 20 * math.log10(rms) if rms else None,
        'peakBefore': peak, 'peakAfter': peak * factor,
        'policy': 'post-vad-asr-view-only'}
