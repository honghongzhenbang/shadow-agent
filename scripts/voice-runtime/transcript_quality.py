"""Conservative decoder-failure screening, not an ASR accuracy score."""
import re


def issues(text, reached_eos=True):
    problems = []
    compact = "".join(c for c in text if c.isalnum())
    if not compact:
        problems.append("empty_speech_text")
    if not reached_eos:
        problems.append("decoder_limit_without_eos")
    for width in range(1, 21):
        for match in re.finditer(r"(.{%d})\1{7,}" % width, compact):
            if len(match.group()) >= max(20, len(compact) * 0.2):
                problems.append("suspected_decoder_repetition")
                return problems
    return problems
