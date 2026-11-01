package com.shadowagent.voice.core;

import org.junit.Test;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.SocketTimeoutException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;

public final class TransportGuardTest {
    @Test public void rejectsOverlapButAllowsSequentialOperationsUntilClosed() throws Exception {
        try (TransportGuard guard = new TransportGuard()) {
            try (TransportGuard.Operation first = guard.begin(5000)) {
                assertThrows(IOException.class, () -> guard.begin(5000));
            }
            try (TransportGuard.Operation second = guard.begin(5000)) { second.check(); }
            guard.close();
            assertThrows(IOException.class, () -> guard.begin(5000));
        }
    }

    @Test public void crossThreadCloseAbortsResourceAndLateRegistration() throws Exception {
        TransportGuard guard = new TransportGuard();
        try (TransportGuard.Operation operation = guard.begin(5000)) {
            CountDownLatch aborted = new CountDownLatch(1);
            operation.attach(aborted::countDown);
            Thread closer = new Thread(guard::close);
            closer.start();
            assertTrue(aborted.await(2, TimeUnit.SECONDS));
            closer.join(2000);
            assertFalse(closer.isAlive());
            assertThrows(InterruptedIOException.class, operation::check);
        }
        try (TransportGuard other = new TransportGuard(); TransportGuard.Operation operation = other.begin(5000)) {
            other.close();
            AtomicBoolean closed = new AtomicBoolean();
            assertThrows(IOException.class, () -> operation.attach(() -> closed.set(true)));
            assertTrue(closed.get());
        }
    }

    @Test public void idleDeadlineClosesBlockedIoAndReportsTimeout() throws Exception {
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000, 150)) {
            CountDownLatch closed = new CountDownLatch(1);
            operation.attach(closed::countDown);
            assertTrue(closed.await(2, TimeUnit.SECONDS));
            assertThrows(SocketTimeoutException.class, operation::check);
        }
    }

    @Test public void progressExtendsIdleButNeverTheOverallDeadline() throws Exception {
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(650, 400)) {
            CountDownLatch closed = new CountDownLatch(1);
            operation.attach(closed::countDown);
            for (int i = 0; i < 5; i++) { Thread.sleep(90); operation.progress(); }
            assertEquals(1, closed.getCount());
            assertTrue(closed.await(2, TimeUnit.SECONDS));
            assertThrows(SocketTimeoutException.class, operation::check);
        }
        assertTrue(TransportGuard.UPLOAD_MS >= 30 * 60_000);
        assertTrue(TransportGuard.IDLE_MS > 20_000);
    }

    @Test public void phaseTimeoutAndOldGenerationCannotCloseNewOperation() throws Exception {
        try (TransportGuard guard = new TransportGuard()) {
            try (TransportGuard.Operation first = guard.begin(5000)) {
                CountDownLatch closed = new CountDownLatch(1);
                first.attach(closed::countDown);
                first.phase(100);
                assertTrue(closed.await(2, TimeUnit.SECONDS));
                assertThrows(SocketTimeoutException.class, first::check);
            }
            try (TransportGuard.Operation second = guard.begin(5000)) {
                AtomicBoolean closed = new AtomicBoolean();
                second.attach(() -> closed.set(true));
                Thread.sleep(200);
                second.check();
                assertFalse(closed.get());
            }
        }
    }
}
