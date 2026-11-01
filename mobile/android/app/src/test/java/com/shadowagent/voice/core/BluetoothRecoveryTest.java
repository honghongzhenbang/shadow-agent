package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;

public final class BluetoothRecoveryTest {
    @Test public void offOnEdgesDropOnceAndReacquireScannerOnce() {
        BluetoothAvailability adapter = new BluetoothAvailability();
        assertTrue(adapter.update(true));
        assertFalse(adapter.update(true));
        assertTrue(adapter.update(false));
        for (int i = 0; i < 100; i++) assertFalse(adapter.update(false));
        assertTrue(adapter.update(true));
        assertFalse(adapter.update(true));
    }

    @Test public void startsPoweredOffThenRecovers() {
        BluetoothAvailability adapter = new BluetoothAvailability();
        assertTrue(adapter.update(false));
        assertFalse(adapter.update(false));
        assertTrue(adapter.update(true));
    }

    @Test public void adapterOffPreservesArmingAndCaptureAuthorityThenReturnDebounces() {
        ProximityPolicy policy = new ProximityPolicy(-80, -65, true);
        CaptureRecovery capture = new CaptureRecovery();
        capture.resume();
        policy.update(0, true, -60, true);
        policy.update(1000, false, null, false);
        assertEquals(ProximityPolicy.Mode.AWAY, policy.update(21_000, false, null, false));
        assertTrue(capture.ready(21_000));
        assertTrue(policy.armed());
        assertEquals(ProximityPolicy.Mode.AWAY, policy.update(22_000, true, -60, false));
        assertEquals(ProximityPolicy.Mode.NEAR, policy.update(32_000, true, -60, false));
        assertFalse(policy.canUpload(true, -60, false));
        assertTrue(policy.canUpload(true, -60, true));
    }

    @Test public void bluetoothOnCannotOverridePauseOrCreateUnverifiedAuthority() {
        CaptureRecovery capture = new CaptureRecovery();
        capture.resume();
        capture.suspend();
        BluetoothAvailability adapter = new BluetoothAvailability();
        adapter.update(false);
        assertTrue(adapter.update(true));
        assertFalse(capture.ready(60_000));
        ProximityPolicy policy = new ProximityPolicy(-80, -65);
        policy.update(0, false, null, false);
        assertEquals(ProximityPolicy.Mode.WAITING, policy.update(60_000, true, -60, false));
    }
}
