package com.shadowagent.voice.core;

/** Adapter power is transport availability, not capture permission or user intent. */
final class BluetoothAvailability {
    private Boolean available;
    boolean update(boolean on) {
        boolean changed = available == null || available != on;
        available = on;
        return changed;
    }
}
