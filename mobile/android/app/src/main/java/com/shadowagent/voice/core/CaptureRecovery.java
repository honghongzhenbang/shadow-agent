package com.shadowagent.voice.core;

/** Main-thread retry authority. Old recorder completions cannot override a newer user action. */
final class CaptureRecovery {
    private long generation;
    private boolean allowed;
    private long retryAt;
    private int failures;
    private long healthySince = -1;

    void resume() { generation++; allowed = true; reset(); }
    void suspend() { generation++; allowed = false; reset(); }
    long generation() { return generation; }
    boolean current(long token) { return allowed && generation == token; }
    boolean ready(long now) { return allowed && now >= retryAt; }
    long remaining(long now) { return Math.max(0, retryAt - now); }
    void failed(long token, long now) {
        if (!current(token)) return;
        retryAt = now + Math.min(60_000L, 5000L << failures);
        failures = Math.min(failures + 1, 4);
        healthySince = -1;
    }
    void observe(boolean recording, long now) {
        if (!recording) { healthySince = -1; return; }
        if (healthySince < 0) healthySince = now;
        if (now - healthySince >= 30_000) { failures = 0; retryAt = 0; }
    }
    private void reset() { retryAt = 0; failures = 0; healthySince = -1; }
}
