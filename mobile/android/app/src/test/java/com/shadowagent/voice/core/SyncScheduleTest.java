package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;

public final class SyncScheduleTest {
    @Test public void slowOrFailedCompletionStillYieldsToUpload() {
        AutoCaptureService.SyncSchedule schedule = new AutoCaptureService.SyncSchedule();
        assertTrue(schedule.completionFirst(0));
        // Completion may take longer than the old five-second dispatch interval.
        schedule.finished(true, 60_000);
        assertFalse(schedule.completionDue(64_999));
        assertTrue(schedule.completionDue(65_000));
        assertFalse(schedule.completionFirst(120_000));
        schedule.finished(false, 121_000);
        assertTrue(schedule.completionFirst(121_001));
    }

    @Test public void continuousUploadsCannotPostponeDueCompletion() {
        AutoCaptureService.SyncSchedule schedule = new AutoCaptureService.SyncSchedule();
        schedule.finished(true, 10_000);
        for (long now = 11_000; now < 15_000; now += 1000) {
            assertFalse(schedule.completionFirst(now));
            schedule.finished(false, now);
        }
        assertTrue(schedule.completionFirst(15_000));
    }

    @Test public void noQueuedUploadDoesNotPreventCompletionFallback() {
        AutoCaptureService.SyncSchedule schedule = new AutoCaptureService.SyncSchedule();
        schedule.finished(true, 10_000);
        assertFalse(schedule.completionFirst(15_000));
        // The worker may fall back to completion after an empty upload claim.
        assertTrue(schedule.completionDue(15_000));
        schedule.finished(true, 16_000);
        assertFalse(schedule.completionDue(20_999));
        assertTrue(schedule.completionDue(21_000));
    }

    @Test public void bothQueuesMakeProgressAcrossRepeatedSlowOperations() {
        AutoCaptureService.SyncSchedule schedule = new AutoCaptureService.SyncSchedule();
        long now = 0;
        for (int i = 0; i < 100; i++) {
            assertTrue(schedule.completionFirst(now));
            now += 45_000;
            schedule.finished(true, now);
            now += 10_000;
            assertFalse(schedule.completionFirst(now));
            schedule.finished(false, now + 30_000);
            now += 31_000;
        }
    }
}
