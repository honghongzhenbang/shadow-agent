package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.*;

public final class RecordingStorePolicyTest {
    @Test public void oldestCheckedWinsEvenWhenEarlierIdsHaveBecomeDueAgain() {
        long[] checked = new long[20];
        long now = 1_000_000;
        for (int expected = 0; expected < 60; expected++) {
            int selected = oldest(checked, now);
            assertEquals(expected % checked.length, selected);
            // Long/failed polls keep earlier IDs due; they must not monopolize selection.
            now += 60_000;
            checked[selected] = now;
            now += 1000;
        }
    }

    @Test public void cooldownAndBackwardClockDoNotStarveUnqueriedItems() {
        assertEquals(-1, RecordingStore.completionPriority(100_000, 129_999));
        assertEquals(100_000, RecordingStore.completionPriority(100_000, 130_000));
        assertEquals(0, RecordingStore.completionPriority(0, 1000));
        assertEquals(0, RecordingStore.completionPriority(200_000, 1000));
        assertEquals(1, oldest(new long[]{100_000, 0}, 110_000));
        assertEquals(-1, oldest(new long[]{100_000, 101_000}, 110_000));
    }

    @Test public void capacityThresholdHasDistinctRecoverableException() throws Exception {
        assertThrows(RecordingStore.CapacityException.class,
                () -> RecordingStore.checkCapacity(RecordingStore.MIN_FREE_BYTES - 1, 0));
        RecordingStore.checkCapacity(RecordingStore.MIN_FREE_BYTES, 0);
        long maximum = RecordingStore.MAX_QUEUE_BYTES - WavFile.MAX_SAMPLES * 2 - WavFile.HEADER_BYTES;
        RecordingStore.checkCapacity(Long.MAX_VALUE, maximum);
        assertThrows(RecordingStore.CapacityException.class,
                () -> RecordingStore.checkCapacity(Long.MAX_VALUE, maximum + 1));
        RecordingStore.checkCapacity(Long.MAX_VALUE, 0);
    }

    private static int oldest(long[] checked, long now) {
        int selected = -1;
        long oldest = Long.MAX_VALUE;
        for (int i = 0; i < checked.length; i++) {
            long priority = RecordingStore.completionPriority(checked[i], now);
            if (priority >= 0 && priority < oldest) { selected = i; oldest = priority; }
        }
        return selected;
    }
}
