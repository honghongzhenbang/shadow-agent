package com.shadowagent.voice.core;

/** Main-thread GATT gate; identity refresh and RSSI must never overlap. */
final class GattOperations {
    enum Kind { CONNECT, DISCOVER, IDENTITY, RSSI }
    static final long IDENTITY_INTERVAL_MS = 15_000;
    private Kind pending;
    private long deadline;
    private long nextIdentity;
    private long nextRssi;

    void begin(Kind kind, long now) {
        if (pending != null) throw new IllegalStateException("GATT operation already pending.");
        pending = kind;
        deadline = now + (kind == Kind.CONNECT || kind == Kind.DISCOVER ? 20_000 : 10_000);
    }

    boolean complete(Kind kind, long now) {
        if (pending != kind || expired(now)) return false;
        pending = null;
        if (kind == Kind.IDENTITY) nextIdentity = now + IDENTITY_INTERVAL_MS;
        if (kind == Kind.RSSI) nextRssi = now + 5000;
        return true;
    }

    Kind poll(long now) {
        if (pending != null) return null;
        if (now >= nextIdentity) return Kind.IDENTITY;
        return now >= nextRssi ? Kind.RSSI : null;
    }

    boolean expired(long now) { return pending != null && now >= deadline; }
    void clear() { pending = null; deadline = 0; nextIdentity = 0; nextRssi = 0; }
}
