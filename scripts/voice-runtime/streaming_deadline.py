"""Single-request monotonic deadlines and token snapshots, independent of ASR text."""
import math
import time


def audio_budget(seconds, factor=2.0):
    if isinstance(factor, bool) or not isinstance(factor, (int, float)) or not math.isfinite(factor) or not 1 <= factor <= 10:
        raise ValueError("ASR time budget factor must be finite and between 1 and 10")
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("Audio duration must be finite and positive")
    return seconds * factor


def generation_status(*, expired, tokens, max_tokens, reached_eos):
    reason = "audio_duration_deadline" if expired else (
        "output_token_limit" if tokens >= max_tokens and not reached_eos else None)
    return {"completion": "partial" if reason else "complete", "stopReason": reason,
            "tokens": tokens, "maxNewTokens": max_tokens, "reachedEos": reached_eos}


class AudioDeadline:
    def __init__(self, seconds, *, started=None, clock=time.monotonic):
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError("Audio duration must be finite and positive")
        self.clock = clock
        self.started = clock() if started is None else started
        self.seconds = seconds
        self.ends = self.started + seconds

    def remaining(self):
        return max(0.0, self.ends - self.clock())

    def expired(self):
        return self.clock() >= self.ends


class TranscriptStreamer:
    """Keep each pre-deadline token snapshot; do not infer semantic validity."""
    def __init__(self, decode, publish, deadline):
        self.decode, self.publish, self.deadline = decode, publish, deadline
        self.prompt_pending = True
        self.tokens = []
        self.text = ""

    def put(self, value):
        if self.prompt_pending:
            self.prompt_pending = False
            return
        if self.deadline.expired():
            return
        values = value.tolist()
        if values and isinstance(values[0], list):
            if len(values) != 1:
                raise ValueError("Streaming ASR supports one request at a time")
            values = values[0]
        self.tokens.extend(values)
        self.text = self.decode(self.tokens).rstrip("\ufffd")
        self.publish({"event": "progress", "text": self.text, "tokens": len(self.tokens)})

    def end(self):
        # Final completion is a separate worker message, never inferred from this callback.
        pass
