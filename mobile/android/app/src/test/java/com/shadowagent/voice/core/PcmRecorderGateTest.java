package com.shadowagent.voice.core;

import org.junit.Test;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.*;

/** Tests the production start/stop lock with synthetic IO, never Android audio. */
public final class PcmRecorderGateTest {
    @Test public void pauseBeforeStartPreventsMicrophoneAction() throws Exception {
        PcmRecorder.StartStopGate gate = new PcmRecorder.StartStopGate();
        AtomicBoolean started = new AtomicBoolean();
        gate.stop(() -> { });
        assertFalse(gate.start(() -> started.set(true)));
        assertFalse(started.get());
        assertTrue(gate.stopping());
    }

    @Test public void pauseDuringStartWaitsForIoThenStopsAndCannotRestart() throws Exception {
        PcmRecorder.StartStopGate gate = new PcmRecorder.StartStopGate();
        AtomicBoolean active = new AtomicBoolean();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), stopRequested = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> start = workers.submit(() -> gate.start(() -> {
                entered.countDown();
                try { if (!release.await(3, TimeUnit.SECONDS)) throw new IOException("Synthetic start timeout"); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException(interrupted); }
                active.set(true);
            }));
            assertTrue(entered.await(3, TimeUnit.SECONDS));
            Future<?> stop = workers.submit(() -> { stopRequested.countDown(); gate.stop(() -> active.set(false)); });
            assertTrue(stopRequested.await(3, TimeUnit.SECONDS));
            assertFalse(stop.isDone());
            release.countDown();
            assertTrue(start.get(3, TimeUnit.SECONDS));
            stop.get(3, TimeUnit.SECONDS);
            assertFalse(active.get());
            assertFalse(gate.start(() -> active.set(true)));
            assertFalse(active.get());
        } finally {
            release.countDown();
            workers.shutdownNow();
            assertTrue(workers.awaitTermination(3, TimeUnit.SECONDS));
        }
    }

    @Test public void failedStartReleasesLockSoStopCanFinish() throws Exception {
        PcmRecorder.StartStopGate gate = new PcmRecorder.StartStopGate();
        assertThrows(IOException.class, () -> gate.start(() -> { throw new IOException("Synthetic failure"); }));
        AtomicBoolean stopped = new AtomicBoolean();
        gate.stop(() -> stopped.set(true));
        assertTrue(stopped.get());
        assertFalse(gate.start(() -> fail("Stopped recorder must not restart")));
    }
}
