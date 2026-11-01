package com.shadowagent.voice.core;

/** Pure elapsed-realtime policy. Inputs must be fresh, identity-verified BLE observations. */
public final class ProximityPolicy {
    public enum Mode { WAITING, NEAR, AWAY }
    public static final long LEAVE_WEAK_MS = 15_000;
    public static final long LEAVE_DISCONNECTED_MS = 20_000;
    public static final long RETURN_MS = 10_000;
    public static final long STARTUP_OBSERVATION_MS = 20_000;
    private final int leave;
    private final int near;
    private Mode mode = Mode.WAITING;
    private long weakSince = -1;
    private long departureSince = -1;
    private long nearSince = -1;
    private long lastNow = -1;
    private final boolean verifiedBinding;
    private long observingSince = -1;

    public ProximityPolicy(int leaveRssi, int returnRssi) {
        this(leaveRssi, returnRssi, false);
    }

    public ProximityPolicy(int leaveRssi, int returnRssi, boolean verifiedBinding) {
        validateThresholds(leaveRssi, returnRssi);
        leave = leaveRssi;
        near = returnRssi;
        this.verifiedBinding = verifiedBinding;
    }

    public static void validateThresholds(int leave, int near) {
        if (leave < -127 || near > -1 || leave >= near)
            throw new IllegalArgumentException("信号阈值必须满足 -127 <= 离开阈值 < 返回阈值 <= -1。");
    }

    public Mode update(long now, boolean connected, Integer rssi, boolean authenticatedHealth) {
        if (now < 0 || now < lastNow) throw new IllegalArgumentException("Monotonic time required.");
        lastNow = now;
        boolean observed = observed(connected, rssi);
        // Initial arming is an authenticated near observation, not a second return dwell.
        if (mode == Mode.WAITING) {
            if (observingSince < 0) observingSince = now;
            if (observed && rssi >= near && (authenticatedHealth || verifiedBinding)) mode = Mode.NEAR;
            else if (verifiedBinding && now - observingSince >= STARTUP_OBSERVATION_MS) mode = Mode.AWAY;
            return mode;
        }
        // Once armed, transport loss cannot revoke departure detection or prevent a return.
        boolean returning = observed && rssi >= near;
        nearSince = returning ? (nearSince < 0 ? now : nearSince) : -1;
        if (mode == Mode.AWAY) {
            if (nearSince >= 0 && now - nearSince >= RETURN_MS) {
                mode = Mode.NEAR;
                weakSince = departureSince = -1;
            }
            return mode;
        }
        boolean weak = observed && rssi <= leave;
        // Weak RSSI and missing samples are both departure evidence. Alternating them
        // must not postpone capture forever; a stable weak signal may trigger sooner.
        departureSince = weak || !observed ? (departureSince < 0 ? now : departureSince) : -1;
        weakSince = weak ? (weakSince < 0 ? now : weakSince) : -1;
        if (departureRemainingMs(now) == 0) {
            mode = Mode.AWAY;
            nearSince = -1;
        }
        return mode;
    }

    public Mode mode() { return mode; }
    public boolean armed() { return mode != Mode.WAITING; }
    public boolean shouldRecord() { return mode == Mode.AWAY; }

    /** -1 means no departure candidate; otherwise remaining debounce time. */
    public long departureRemainingMs(long now) {
        if (mode != Mode.NEAR || departureSince < 0) return -1;
        long remaining = LEAVE_DISCONNECTED_MS - (now - departureSince);
        if (weakSince >= 0) remaining = Math.min(remaining, LEAVE_WEAK_MS - (now - weakSince));
        return Math.max(0, remaining);
    }

    public boolean canUpload(boolean connected, Integer rssi, boolean authenticatedHealth) {
        return mode == Mode.NEAR && observed(connected, rssi) && rssi >= near && authenticatedHealth;
    }

    private static boolean observed(boolean connected, Integer rssi) {
        return connected && rssi != null && rssi >= -127 && rssi <= 20;
    }
}
