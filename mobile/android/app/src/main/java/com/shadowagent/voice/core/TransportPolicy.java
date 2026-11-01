package com.shadowagent.voice.core;

/** Route choice is independent of proximity and cannot turn a TLS failure into a fallback. */
final class TransportPolicy {
    enum Channel { LAN, BLUETOOTH }

    static boolean securityFailure(BridgeHealth.State state) {
        return state == BridgeHealth.State.CERTIFICATE || state == BridgeHealth.State.UNAUTHORIZED
                || state == BridgeHealth.State.WRONG_DEVICE;
    }

    static Channel select(BridgeHealth.State lan, BridgeHealth.State bluetooth) {
        if (securityFailure(lan) || securityFailure(bluetooth)) return null;
        if (lan == BridgeHealth.State.READY) return Channel.LAN;
        if (bluetooth == BridgeHealth.State.READY) return Channel.BLUETOOTH;
        return null;
    }

    static boolean shouldProbeBluetooth(boolean hasLan, BridgeHealth.State lan, BridgeHealth.State bluetooth) {
        if (securityFailure(lan) || securityFailure(bluetooth) || lan == BridgeHealth.State.READY) return false;
        return !hasLan || lan == BridgeHealth.State.UNREACHABLE || lan == BridgeHealth.State.FAILED
                || lan == BridgeHealth.State.INVALID_RESPONSE || bluetooth == BridgeHealth.State.READY;
    }

    static long bluetoothProbeAfterLanFailure(long scheduled, long now, BridgeHealth.State bluetooth) {
        return bluetooth == BridgeHealth.State.READY ? scheduled : Math.min(scheduled, now);
    }

    // Presentation only: an in-flight upload may outlive its health proof without authorizing another upload.
    static BridgeHealth.State displayState(boolean activeTransport, boolean hasBluetooth,
                                           BridgeHealth.State lan, BridgeHealth.State bluetooth) {
        if (activeTransport) return BridgeHealth.State.READY;
        return hasBluetooth && bluetooth != BridgeHealth.State.UNCHECKED ? bluetooth : lan;
    }
}
