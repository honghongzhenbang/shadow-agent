package com.shadowagent.voice.core;

final class RetryBackoff {
    private int failures;
    long nextDelayMs() {
        long delay = 5000L << Math.min(failures, 6);
        failures = Math.min(6, failures + 1);
        return Math.min(300_000L, delay);
    }
    void reset() { failures = 0; }
}
