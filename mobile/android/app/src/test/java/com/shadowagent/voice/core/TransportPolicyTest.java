package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;

public final class TransportPolicyTest {
    @Test public void prefersLanEvenWhenBluetoothIsReady() {
        assertEquals(TransportPolicy.Channel.LAN, TransportPolicy.select(BridgeHealth.State.READY, BridgeHealth.State.READY));
        assertFalse(TransportPolicy.shouldProbeBluetooth(true, BridgeHealth.State.READY, BridgeHealth.State.READY));
    }
    @Test public void offlineLanUsesAuthenticatedBluetooth() {
        assertEquals(TransportPolicy.Channel.BLUETOOTH, TransportPolicy.select(BridgeHealth.State.UNREACHABLE, BridgeHealth.State.READY));
        assertTrue(TransportPolicy.shouldProbeBluetooth(true, BridgeHealth.State.UNREACHABLE, BridgeHealth.State.UNCHECKED));
        assertTrue(TransportPolicy.shouldProbeBluetooth(false, BridgeHealth.State.UNCHECKED, BridgeHealth.State.UNCHECKED));
    }
    @Test public void triesLanBeforeFirstBluetoothConnection() {
        assertFalse(TransportPolicy.shouldProbeBluetooth(true, BridgeHealth.State.UNCHECKED, BridgeHealth.State.UNCHECKED));
        assertFalse(TransportPolicy.shouldProbeBluetooth(true, BridgeHealth.State.CHECKING, BridgeHealth.State.UNCHECKED));
        assertNull(TransportPolicy.select(BridgeHealth.State.UNCHECKED, BridgeHealth.State.UNCHECKED));
    }
    @Test public void noSecurityDowngradeInEitherDirection() {
        for (BridgeHealth.State failure : new BridgeHealth.State[]{BridgeHealth.State.CERTIFICATE,
                BridgeHealth.State.UNAUTHORIZED, BridgeHealth.State.WRONG_DEVICE}) {
            assertNull(TransportPolicy.select(failure, BridgeHealth.State.READY));
            assertNull(TransportPolicy.select(BridgeHealth.State.READY, failure));
            assertFalse(TransportPolicy.shouldProbeBluetooth(true, failure, BridgeHealth.State.UNCHECKED));
        }
    }
    @Test public void expiredHealthDoesNotEstablishBaselineOrUpload() {
        BridgeHealth bluetooth = new BridgeHealth();
        bluetooth.complete(bluetooth.begin(), 1000, BridgeHealth.State.READY);
        assertEquals(TransportPolicy.Channel.BLUETOOTH, TransportPolicy.select(BridgeHealth.State.UNREACHABLE, bluetooth.state(1001)));
        assertNull(TransportPolicy.select(BridgeHealth.State.UNREACHABLE, bluetooth.state(17000)));
    }
    @Test public void oldConnectionResponseCannotRestoreBluetoothReadiness() {
        BridgeHealth bluetooth = new BridgeHealth();
        int request = bluetooth.begin();
        bluetooth.connectionChanged();
        bluetooth.complete(request, 1000, BridgeHealth.State.READY);
        assertNull(TransportPolicy.select(BridgeHealth.State.UNREACHABLE, bluetooth.state(1000)));
    }
    @Test public void noPairingIsNotAuthorization() {
        assertNull(TransportPolicy.select(BridgeHealth.State.UNREACHABLE, BridgeHealth.State.NEEDS_PAIRING));
        assertEquals(TransportPolicy.Channel.LAN, TransportPolicy.select(BridgeHealth.State.READY, BridgeHealth.State.NEEDS_PAIRING));
    }

    @Test public void bluetoothFreshnessIsBoundedAndRevokedOnDisconnect() {
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        bluetooth.complete(bluetooth.begin(), 1000, BridgeHealth.State.READY);
        assertTrue(bluetooth.ready(40_000));
        assertFalse(bluetooth.ready(46_001));
        bluetooth.connectionChanged();
        assertFalse(bluetooth.ready(40_001));
    }

    @Test public void bluetoothCanEstablishBaselineWithoutLanButNotWithoutProof() {
        ProximityPolicy proximity = new ProximityPolicy(-80, -65);
        assertEquals(ProximityPolicy.Mode.WAITING, proximity.update(0, true, -50, false));
        boolean ready = TransportPolicy.select(BridgeHealth.State.UNREACHABLE, BridgeHealth.State.READY) != null;
        assertEquals(ProximityPolicy.Mode.NEAR, proximity.update(1000, true, -50, ready));
        assertEquals(ProximityPolicy.Mode.NEAR, proximity.update(11000, true, -50, ready));
        assertTrue(proximity.canUpload(true, -50, ready));
    }

    @Test public void lanFailuresKeepFreshBluetoothProbeSchedule() {
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        bluetooth.complete(bluetooth.begin(), 1000, BridgeHealth.State.READY);
        long scheduled = 21_000;
        scheduled = TransportPolicy.bluetoothProbeAfterLanFailure(scheduled, 10_000, bluetooth.state(10_000));
        assertEquals(21_000, scheduled);
        scheduled = TransportPolicy.bluetoothProbeAfterLanFailure(scheduled, 15_000, bluetooth.state(15_000));
        assertEquals(21_000, scheduled);
        bluetooth.begin();
        assertEquals(21_000, TransportPolicy.bluetoothProbeAfterLanFailure(scheduled, 16_000, bluetooth.state(16_000)));
    }

    @Test public void lanFailureAdvancesBluetoothProbeOnlyAfterProofExpires() {
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        bluetooth.complete(bluetooth.begin(), 1000, BridgeHealth.State.READY);
        assertEquals(60_000, TransportPolicy.bluetoothProbeAfterLanFailure(60_000, 46_000, bluetooth.state(46_000)));
        assertEquals(46_001, TransportPolicy.bluetoothProbeAfterLanFailure(60_000, 46_001, bluetooth.state(46_001)));
        assertEquals(40_000, TransportPolicy.bluetoothProbeAfterLanFailure(40_000, 46_001, bluetooth.state(46_001)));
    }

    @Test public void lanFailureAdvancesBluetoothProbeAfterProofIsRevoked() {
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        bluetooth.complete(bluetooth.begin(), 1000, BridgeHealth.State.READY);
        bluetooth.connectionChanged();
        assertEquals(2000, TransportPolicy.bluetoothProbeAfterLanFailure(21_000, 2000, bluetooth.state(2000)));
        bluetooth.complete(bluetooth.begin(), 3000, BridgeHealth.State.UNREACHABLE);
        assertEquals(4000, TransportPolicy.bluetoothProbeAfterLanFailure(18_000, 4000, bluetooth.state(4000)));
    }

    @Test public void displayedBluetoothStateMatchesPairingAndProbeFailures() {
        for (BridgeHealth.State state : new BridgeHealth.State[]{BridgeHealth.State.NEEDS_PAIRING,
                BridgeHealth.State.CHECKING, BridgeHealth.State.UNREACHABLE, BridgeHealth.State.INVALID_RESPONSE,
                BridgeHealth.State.FAILED, BridgeHealth.State.CERTIFICATE, BridgeHealth.State.UNAUTHORIZED,
                BridgeHealth.State.WRONG_DEVICE}) {
            assertEquals(state, TransportPolicy.displayState(false, true, BridgeHealth.State.UNREACHABLE, state));
        }
    }

    @Test public void displayedStateUsesLanWithoutBluetoothObservation() {
        for (BridgeHealth.State state : BridgeHealth.State.values()) {
            assertEquals(state, TransportPolicy.displayState(false, false, state, BridgeHealth.State.NEEDS_PAIRING));
            assertEquals(state, TransportPolicy.displayState(false, true, state, BridgeHealth.State.UNCHECKED));
        }
    }

    @Test public void displayedReadyStateFollowsTheSelectedTransport() {
        assertEquals(BridgeHealth.State.READY, TransportPolicy.displayState(true, true,
                BridgeHealth.State.READY, BridgeHealth.State.NEEDS_PAIRING));
        assertEquals(BridgeHealth.State.READY, TransportPolicy.displayState(true, true,
                BridgeHealth.State.UNREACHABLE, BridgeHealth.State.READY));
    }

    @Test public void ongoingUploadDisplayDoesNotExtendExpiredProof() {
        BridgeHealth bluetooth = new BridgeHealth(45_000);
        bluetooth.complete(bluetooth.begin(), 1000, BridgeHealth.State.READY);
        BridgeHealth.State expired = bluetooth.state(46_001);
        assertEquals(BridgeHealth.State.READY,
                TransportPolicy.displayState(true, true, BridgeHealth.State.UNREACHABLE, expired));
        assertNull(TransportPolicy.select(BridgeHealth.State.UNREACHABLE, expired));
        assertEquals(BridgeHealth.State.UNREACHABLE,
                TransportPolicy.displayState(false, true, BridgeHealth.State.UNREACHABLE, expired));
    }
}
