package com.shadowagent.voice.core;

import org.junit.Test;

import static com.shadowagent.voice.core.ProximityPolicy.Mode.AWAY;
import static com.shadowagent.voice.core.ProximityPolicy.Mode.NEAR;
import static com.shadowagent.voice.core.ProximityPolicy.Mode.WAITING;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class ProximityPolicyTest {
    @Test public void offlineReturnStaysStoppedThroughAddressRetriesAndRecovery() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        p.update(31_000, false, null, false);
        p.update(32_000, true, -60, false);
        assertEquals(NEAR, p.update(42_000, true, -60, false));
        for (long now = 43_000; now < 300_000; now += 5000) {
            assertEquals(NEAR, p.update(now, true, -60, false));
            assertFalse(p.canUpload(true, -60, false));
        }
        assertEquals(NEAR, p.update(310_000, true, -60, true));
        assertTrue(p.canUpload(true, -60, true));
    }

    private ProximityPolicy policy() { return new ProximityPolicy(-80, -65); }
    private ProximityPolicy established() {
        ProximityPolicy p = policy();
        assertEquals(NEAR, p.update(0, true, -65, true));
        assertEquals(NEAR, p.update(10_000, true, -65, true));
        return p;
    }

    @Test public void initialAbsenceNeverRecords() {
        ProximityPolicy p = policy();
        p.update(0, false, null, false);
        assertEquals(WAITING, p.update(3_600_000, false, null, false));
    }
    @Test public void initialWeakSignalNeverRecords() {
        ProximityPolicy p = policy();
        p.update(0, true, -90, true);
        assertEquals(WAITING, p.update(60_000, true, -90, true));
    }
    @Test public void untrustedBleCannotEstablishBaseline() {
        ProximityPolicy p = policy();
        p.update(0, false, -50, true);
        assertEquals(WAITING, p.update(60_000, false, -50, true));
    }
    @Test public void healthRequiredBeforeBaseline() {
        ProximityPolicy p = policy();
        p.update(0, true, -40, false);
        assertEquals(WAITING, p.update(60_000, true, -40, false));
    }
    @Test public void baselineArmsOnFirstAuthenticatedNearObservation() {
        ProximityPolicy p = policy();
        assertFalse(p.armed());
        assertEquals(NEAR, p.update(0, true, -65, true));
        assertTrue(p.armed());
        assertFalse(p.shouldRecord());
    }
    @Test public void healthLossDoesNotRevokeAnArmedBaseline() {
        ProximityPolicy p = policy();
        p.update(0, true, -60, true);
        p.update(9000, true, -60, false);
        assertEquals(NEAR, p.update(10_000, false, null, false));
        assertEquals(AWAY, p.update(30_000, false, null, false));
        assertTrue(p.armed());
        assertTrue(p.shouldRecord());
    }
    @Test public void weakBoundaryRequiresFifteenSeconds() {
        ProximityPolicy p = established();
        assertEquals(NEAR, p.update(11_000, true, -80, false));
        assertEquals(NEAR, p.update(25_999, true, -80, false));
        assertEquals(AWAY, p.update(26_000, true, -80, false));
    }
    @Test public void middleBandResetsWeakDwell() {
        ProximityPolicy p = established();
        p.update(11_000, true, -80, false);
        p.update(25_000, true, -79, false);
        assertEquals(NEAR, p.update(26_000, true, -80, false));
        assertEquals(NEAR, p.update(40_999, true, -80, false));
        assertEquals(AWAY, p.update(41_000, true, -80, false));
    }
    @Test public void disconnectRequiresTwentySeconds() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        assertEquals(NEAR, p.update(30_999, false, null, false));
        assertEquals(AWAY, p.update(31_000, false, null, false));
    }
    @Test public void reconnectResetsDisconnectDwell() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        p.update(29_000, true, -70, false);
        assertEquals(NEAR, p.update(30_000, false, null, false));
        assertEquals(NEAR, p.update(49_999, false, null, false));
        assertEquals(AWAY, p.update(50_000, false, null, false));
    }
    @Test public void weakThenDisconnectedDoesNotRestartDepartureTimer() {
        ProximityPolicy p = established();
        p.update(11_000, true, -90, false);
        p.update(25_000, false, null, false);
        assertEquals(NEAR, p.update(30_999, false, null, false));
        assertEquals(AWAY, p.update(31_000, false, null, false));
    }
    @Test public void alternatingWeakAndMissingSamplesCannotStarveCapture() {
        ProximityPolicy p = established();
        for (long now = 11_000; now < 31_000; now += 1000) {
            boolean connected = now % 2000 == 0;
            assertEquals(NEAR, p.update(now, connected, connected ? -90 : null, false));
            assertEquals(Math.min(connected ? 15_000 : 20_000, 31_000 - now), p.departureRemainingMs(now));
        }
        assertEquals(AWAY, p.update(31_000, true, -90, false));
        assertTrue(p.shouldRecord());
    }
    @Test public void shortDisconnectKeepsBaselineAndResetsCountdown() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        assertEquals(15_000, p.departureRemainingMs(16_000));
        assertEquals(NEAR, p.update(16_000, true, -60, false));
        assertEquals(-1, p.departureRemainingMs(16_000));
        assertTrue(p.armed());
        assertFalse(p.shouldRecord());
    }
    @Test public void authenticatedButNotNearStillCannotArm() {
        ProximityPolicy p = policy();
        assertEquals(WAITING, p.update(0, true, -66, true));
        assertEquals(WAITING, p.update(100_000, true, -66, true));
        assertEquals(-1, p.departureRemainingMs(100_000));
        assertFalse(p.armed());
    }
    @Test public void returnStopsCaptureWithoutNetworkAfterBaseline() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        p.update(31_000, false, null, false);
        p.update(32_000, true, -65, false);
        assertEquals(AWAY, p.update(41_999, true, -65, false));
        assertEquals(NEAR, p.update(42_000, true, -65, false));
        assertFalse(p.canUpload(true, -65, false));
        assertTrue(p.canUpload(true, -65, true));
    }
    @Test public void failedHealthDoesNotResetReturnDwell() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        p.update(31_000, false, null, false);
        p.update(32_000, true, -60, true);
        assertEquals(AWAY, p.update(41_000, true, -60, false));
        assertEquals(NEAR, p.update(42_000, true, -60, false));
    }
    @Test public void untrustedReturnDoesNotStopCapture() {
        ProximityPolicy p = established();
        p.update(11_000, false, null, false);
        p.update(31_000, false, null, false);
        assertEquals(AWAY, p.update(32_000, false, -40, true));
        assertEquals(AWAY, p.update(100_000, false, -40, true));
        assertFalse(p.canUpload(false, -40, true));
    }
    @Test public void uploadNeedsCurrentNearSignalAndHealth() {
        ProximityPolicy p = established();
        assertTrue(p.canUpload(true, -60, true));
        assertFalse(p.canUpload(true, -70, true));
        assertFalse(p.canUpload(true, null, true));
        assertFalse(p.canUpload(true, 127, true));
        assertFalse(p.canUpload(false, -60, true));
        assertFalse(p.canUpload(true, -60, false));
        assertFalse(policy().canUpload(true, -60, true));
        p.update(11_000, true, -90, false);
        p.update(26_000, true, -90, false);
        assertFalse(p.canUpload(true, -60, true));
    }
    @Test public void unverifiedRestartRequiresAuthenticatedBaseline() {
        established();
        ProximityPolicy restarted = policy();
        restarted.update(0, true, -40, false);
        assertEquals(WAITING, restarted.update(60_000, true, -40, false));
        assertFalse(restarted.canUpload(true, -40, false));
    }
    @Test public void verifiedOfflineRestartRecordsAfterBoundedObservation() {
        ProximityPolicy restarted = new ProximityPolicy(-80, -65, true);
        assertEquals(WAITING, restarted.update(1000, false, null, false));
        assertEquals(WAITING, restarted.update(20_999, false, null, false));
        assertEquals(AWAY, restarted.update(21_000, false, null, false));
        assertFalse(restarted.canUpload(false, null, false));
    }
    @Test public void verifiedRestartNearOfflineComputerStaysIdleButCannotUpload() {
        ProximityPolicy restarted = new ProximityPolicy(-80, -65, true);
        assertEquals(NEAR, restarted.update(1000, true, -50, false));
        assertEquals(NEAR, restarted.update(120_000, true, -50, false));
        assertFalse(restarted.shouldRecord());
        assertFalse(restarted.canUpload(true, -50, false));
    }
    @Test public void verifiedRestartWithWeakOrMissingSamplesCannotWaitForever() {
        ProximityPolicy restarted = new ProximityPolicy(-80, -65, true);
        for (int i = 0; i < 20; i++) {
            assertEquals(WAITING, restarted.update(i * 1000L, i % 2 == 0, i % 2 == 0 ? -90 : null, false));
        }
        assertEquals(AWAY, restarted.update(20_000, true, -90, false));
    }
    @Test public void shortReturnGapDoesNotChatter() {
        ProximityPolicy p = established();
        p.update(11_000, true, -80, false);
        p.update(26_000, true, -80, false);
        p.update(27_000, true, -60, true);
        p.update(36_000, true, -66, true);
        p.update(37_000, true, -60, true);
        assertEquals(AWAY, p.update(46_999, true, -60, true));
        assertEquals(NEAR, p.update(47_000, true, -60, true));
    }
    @Test public void missingOrInvalidRssiIsNotPresence() {
        ProximityPolicy p = established();
        p.update(11_000, true, null, true);
        assertEquals(AWAY, p.update(31_000, true, 127, true));
    }
    @Test public void healthFailureAloneDoesNotMeanDeparture() {
        ProximityPolicy p = established();
        p.update(11_000, true, -60, false);
        assertEquals(NEAR, p.update(120_000, true, -60, false));
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsEqualThresholds() { new ProximityPolicy(-65, -65); }
    @Test(expected = IllegalArgumentException.class) public void rejectsReversedThresholds() { new ProximityPolicy(-60, -80); }
    @Test(expected = IllegalArgumentException.class) public void rejectsPositiveReturn() { new ProximityPolicy(-80, 1); }
    @Test(expected = IllegalArgumentException.class) public void rejectsTimeGoingBackwards() {
        ProximityPolicy p = established(); p.update(9999, true, -60, true);
    }
}
