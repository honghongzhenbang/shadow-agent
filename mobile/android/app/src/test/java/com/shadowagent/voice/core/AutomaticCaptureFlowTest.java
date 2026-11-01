package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;

/** Replay service inputs without Bluetooth, a microphone, a network or a real recording store. */
public final class AutomaticCaptureFlowTest {
    @Test public void authenticatedBluetoothThenImmediateDepartureRecordsAndReturnsOffline() {
        ProximityPolicy proximity = new ProximityPolicy(-80, -65);
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        bluetooth.complete(bluetooth.begin(), 30_000, BridgeHealth.State.READY);
        boolean authenticated = TransportPolicy.select(BridgeHealth.State.UNREACHABLE,
                bluetooth.state(30_000)) != null;
        assertEquals(ProximityPolicy.Mode.NEAR, proximity.update(30_000, true, -50, authenticated));
        assertTrue(proximity.armed());

        // Link loss revokes transport proof, not the established capture session.
        bluetooth.connectionChanged();
        proximity.update(31_000, false, null, bluetooth.ready(31_000));
        assertFalse(proximity.shouldRecord());
        proximity.update(50_999, false, null, bluetooth.ready(50_999));
        assertFalse(proximity.shouldRecord());
        proximity.update(51_000, false, null, bluetooth.ready(51_000));
        assertTrue(proximity.shouldRecord());
        assertFalse(proximity.canUpload(false, null, false));
        assertEquals(ProximityPolicy.Mode.AWAY, proximity.update(3_600_000, false, null, false));

        // Return stops capture even when both upload routes are down.
        proximity.update(3_601_000, true, -50, false);
        assertTrue(proximity.shouldRecord());
        proximity.update(3_611_000, true, -50, false);
        assertFalse(proximity.shouldRecord());
        assertFalse(proximity.canUpload(true, -50, false));
        bluetooth.complete(bluetooth.begin(), 3_612_000, BridgeHealth.State.READY);
        assertTrue(proximity.canUpload(true, -50, bluetooth.ready(3_612_000)));
    }

    @Test public void delayedOldConnectionProofCannotArmNewSession() {
        ProximityPolicy proximity = new ProximityPolicy(-80, -65);
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        int request = bluetooth.begin();
        bluetooth.connectionChanged();
        bluetooth.complete(request, 1000, BridgeHealth.State.READY);
        proximity.update(1000, true, -50, bluetooth.ready(1000));
        proximity.update(100_000, false, null, false);
        assertFalse(proximity.armed());
        assertFalse(proximity.shouldRecord());
    }

    @Test public void repeatedTripsDoNotNeedAnotherOnlineBaseline() {
        ProximityPolicy proximity = new ProximityPolicy(-80, -65);
        proximity.update(0, true, -50, true);
        for (int i = 0; i < 20; i++) {
            long start = 1000 + i * 40_000L;
            proximity.update(start, true, -90, false);
            proximity.update(start + 15_000, true, -90, false);
            assertTrue(proximity.shouldRecord());
            proximity.update(start + 16_000, true, -50, false);
            proximity.update(start + 26_000, true, -50, false);
            assertFalse(proximity.shouldRecord());
            assertTrue(proximity.armed());
        }
        assertFalse(new ProximityPolicy(-80, -65).armed());
    }
}
