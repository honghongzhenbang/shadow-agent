package com.shadowagent.voice.core;

import org.junit.Test;
import static com.shadowagent.voice.core.GattOperations.Kind.*;
import static org.junit.Assert.*;

public final class GattOperationsTest {
    private GattOperations connected() {
        GattOperations operations = new GattOperations();
        operations.begin(CONNECT, 0);
        assertTrue(operations.complete(CONNECT, 100));
        operations.begin(DISCOVER, 100);
        assertTrue(operations.complete(DISCOVER, 200));
        operations.begin(IDENTITY, 200);
        assertTrue(operations.complete(IDENTITY, 300));
        return operations;
    }

    @Test public void refreshesIdentityOnSameSessionAndSerializesWithRssi() {
        GattOperations operations = connected();
        assertEquals(RSSI, operations.poll(300));
        operations.begin(RSSI, 300);
        assertNull(operations.poll(301));
        assertThrows(IllegalStateException.class, () -> operations.begin(IDENTITY, 301));
        assertTrue(operations.complete(RSSI, 400));
        assertEquals(IDENTITY, operations.poll(15_300));
        operations.begin(IDENTITY, 15_300);
        assertNull(operations.poll(15_301));
        assertFalse(operations.complete(RSSI, 15_400));
        assertTrue(operations.complete(IDENTITY, 15_500));
        assertEquals(RSSI, operations.poll(15_500));
        operations.begin(RSSI, 15_500);
        assertTrue(operations.complete(RSSI, 15_600));
        assertEquals(IDENTITY, operations.poll(30_500));
    }

    @Test public void pendingRssiDefersRefreshUntilItCompletes() {
        GattOperations operations = connected();
        operations.begin(RSSI, 15_000);
        assertNull(operations.poll(15_300));
        assertTrue(operations.complete(RSSI, 16_000));
        assertEquals(IDENTITY, operations.poll(16_000));
    }

    @Test public void deadlineRejectsLateCallbackAndDisconnectClearsPendingWork() {
        GattOperations operations = connected();
        operations.begin(IDENTITY, 15_300);
        assertFalse(operations.expired(25_299));
        assertTrue(operations.expired(25_300));
        assertFalse(operations.complete(IDENTITY, 25_300));
        operations.clear();
        assertFalse(operations.expired(40_000));
        assertFalse(operations.complete(IDENTITY, 40_000));
        operations.begin(CONNECT, 40_000);
        assertFalse(operations.complete(IDENTITY, 40_100));
        assertTrue(operations.complete(CONNECT, 40_200));
    }
}
