package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;

public final class CaptureRecoveryTest {
    @Test public void requiresExplicitResumeAndRetriesWithCappedBackoff() {
        CaptureRecovery recovery = new CaptureRecovery();
        assertFalse(recovery.ready(0));
        recovery.resume();
        assertTrue(recovery.ready(0));
        long now = 0;
        for (long expected : new long[]{5000, 10_000, 20_000, 40_000, 60_000, 60_000}) {
            recovery.failed(recovery.generation(), now);
            assertEquals(expected, recovery.remaining(now));
            assertFalse(recovery.ready(now + expected - 1));
            now += expected;
            assertTrue(recovery.ready(now));
        }
    }

    @Test public void pauseCancelsPendingRetryAndRejectsLateCompletion() {
        CaptureRecovery recovery = new CaptureRecovery();
        recovery.resume();
        long old = recovery.generation();
        recovery.failed(old, 0);
        recovery.suspend();
        recovery.failed(old, 100);
        assertFalse(recovery.current(old));
        assertFalse(recovery.ready(100_000));
        assertEquals(0, recovery.remaining(100_000));
    }

    @Test public void resumedGenerationCannotBeBlockedByOldRecorderFailure() {
        CaptureRecovery recovery = new CaptureRecovery();
        recovery.resume();
        long old = recovery.generation();
        recovery.suspend();
        recovery.resume();
        recovery.failed(old, 100);
        assertTrue(recovery.ready(100));
        assertFalse(recovery.current(old));
    }

    @Test public void revokedPermissionNeverSelfResumesEvenWithDataOrLateFailure() {
        CaptureRecovery recovery = new CaptureRecovery();
        recovery.resume();
        long old = recovery.generation();
        recovery.suspend();
        recovery.observe(true, 0);
        recovery.observe(true, 60_000);
        recovery.failed(old, 100_000);
        assertFalse(recovery.ready(Long.MAX_VALUE));
    }

    @Test public void briefRecoveryDoesNotResetBackoffButStableAudioDoes() {
        CaptureRecovery recovery = new CaptureRecovery();
        recovery.resume();
        long token = recovery.generation();
        recovery.failed(token, 0);
        recovery.observe(true, 5000);
        recovery.observe(false, 6000);
        recovery.failed(token, 6000);
        assertEquals(10_000, recovery.remaining(6000));
        recovery.observe(true, 16_000);
        recovery.observe(true, 45_999);
        recovery.failed(token, 45_999);
        assertEquals(20_000, recovery.remaining(45_999));
        recovery.observe(true, 66_000);
        recovery.observe(true, 96_000);
        recovery.failed(token, 96_000);
        assertEquals(5000, recovery.remaining(96_000));
    }
}
