package com.shadowagent.voice.core;

import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** The watchdog owns only its operation's resource, never a later connection. */
final class TransportGuard implements Closeable {
    static final long HEALTH_MS = 30_000;
    static final long UPLOAD_MS = 30 * 60_000;
    static final long IDLE_MS = 60_000;
    private Operation active;
    private boolean closed;

    synchronized Operation begin(long totalMs) throws IOException {
        return begin(totalMs, IDLE_MS);
    }

    synchronized Operation begin(long totalMs, long idleMs) throws IOException {
        if (closed) throw new IOException("Transport is stopped.");
        if (active != null) throw new IOException("Transport operation already in progress.");
        if (totalMs <= 0 || idleMs <= 0) throw new IllegalArgumentException("Invalid transport deadline.");
        active = new Operation(totalMs, idleMs);
        active.watchdog.scheduleWithFixedDelay(active::expire, 25, 25, TimeUnit.MILLISECONDS);
        return active;
    }

    @Override public void close() {
        Operation operation;
        synchronized (this) { closed = true; operation = active; }
        if (operation != null) operation.stop(false);
    }

    final class Operation implements Closeable {
        private final long started = System.nanoTime();
        private final long totalNs;
        private final long idleNs;
        private final Thread worker = Thread.currentThread();
        private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "voice-transport-deadline");
            thread.setDaemon(true);
            return thread;
        });
        private volatile long progressAt = started;
        private volatile long phaseEnds;
        private boolean stopped;
        private boolean timedOut;
        private Closeable resource;

        Operation(long totalMs, long idleMs) {
            totalNs = TimeUnit.MILLISECONDS.toNanos(totalMs);
            idleNs = TimeUnit.MILLISECONDS.toNanos(idleMs);
        }

        void phase(long milliseconds) throws IOException {
            check();
            phaseEnds = milliseconds == 0 ? 0 : System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(milliseconds);
        }

        void attach(Closeable value) throws IOException {
            synchronized (this) {
                if (!stopped) {
                    if (resource != null) throw new IOException("Transport resource already registered.");
                    resource = value;
                    return;
                }
            }
            try { value.close(); } catch (IOException ignored) { }
            check();
        }

        void check() throws IOException {
            expire();
            synchronized (this) {
                if (timedOut) throw new SocketTimeoutException("Transport deadline exceeded.");
                if (stopped) throw new InterruptedIOException("Transport cancelled.");
            }
        }

        void progress() throws IOException {
            check();
            progressAt = System.nanoTime();
        }

        InputStream input(InputStream input) {
            return new FilterInputStream(input) {
                @Override public int read() throws IOException {
                    check();
                    int result = in.read();
                    if (result >= 0) progress();
                    return result;
                }
                @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                    check();
                    int count = in.read(bytes, offset, length);
                    if (count > 0) progress();
                    return count;
                }
            };
        }

        OutputStream output(OutputStream output) {
            return new FilterOutputStream(output) {
                @Override public void write(int value) throws IOException {
                    check(); out.write(value); progress();
                }
                @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                    check(); out.write(bytes, offset, length); progress();
                }
            };
        }

        private void expire() {
            long now = System.nanoTime();
            long phase = phaseEnds;
            if (now - started >= totalNs || now - progressAt >= idleNs || (phase != 0 && now - phase >= 0))
                stop(true);
            else if (worker.isInterrupted()) stop(false);
        }

        private void stop(boolean timeout) {
            Closeable value;
            synchronized (this) {
                if (stopped) return;
                stopped = true;
                timedOut = timeout;
                value = resource;
                resource = null;
            }
            watchdog.shutdownNow();
            if (value != null) try { value.close(); } catch (IOException ignored) { }
        }

        @Override public void close() {
            stop(false);
            synchronized (TransportGuard.this) { if (active == this) active = null; }
        }
    }
}
