package com.shadowagent.voice.core;

import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;

import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLEngineResult;
import javax.net.ssl.SSLException;

/** Blocking, sequential standard TLS over an arbitrary duplex byte stream. */
final class TlsEngineStream implements Closeable {
    private static final int MAX_BUFFER = 256 * 1024;
    private static final ByteBuffer EMPTY = ByteBuffer.allocate(0).asReadOnlyBuffer();
    private final SSLEngine engine;
    private final InputStream wireInput;
    private final OutputStream wireOutput;
    private final Closeable transport;
    private ByteBuffer incoming;
    private ByteBuffer outgoing;
    private ByteBuffer plaintext;
    private volatile boolean closed;
    private boolean handshaken;

    TlsEngineStream(SSLEngine engine, InputStream input, OutputStream output, Closeable transport) throws IOException {
        this.engine = engine; wireInput = input; wireOutput = output; this.transport = transport;
        incoming = allocate(engine.getSession().getPacketBufferSize());
        outgoing = allocate(engine.getSession().getPacketBufferSize());
        plaintext = allocate(engine.getSession().getApplicationBufferSize());
        plaintext.flip();
    }

    void handshake() throws IOException {
        checkOpen();
        if (handshaken) return;
        engine.beginHandshake();
        driveHandshake();
        if (engine.isInboundDone() || engine.isOutboundDone()) throw new SSLException("TLS handshake closed.");
        handshaken = true;
    }

    private void driveHandshake() throws IOException {
        while (true) {
            checkOpen();
            SSLEngineResult.HandshakeStatus status = engine.getHandshakeStatus();
            switch (status) {
                case NOT_HANDSHAKING:
                case FINISHED:
                    return;
                case NEED_TASK:
                    Runnable task;
                    boolean ran = false;
                    while ((task = engine.getDelegatedTask()) != null) { task.run(); ran = true; checkOpen(); }
                    if (!ran) throw new SSLException("TLS task made no progress.");
                    break;
                case NEED_WRAP:
                    wrap(EMPTY.duplicate());
                    break;
                case NEED_UNWRAP:
                    unwrap(false);
                    break;
                default:
                    // NEED_UNWRAP_AGAIN is not an enum constant on every supported Android API.
                    if ("NEED_UNWRAP_AGAIN".equals(status.name())) unwrap(true);
                    else throw new SSLException("Unsupported TLS handshake state.");
            }
        }
    }

    private SSLEngineResult wrap(ByteBuffer source) throws IOException {
        while (true) {
            checkOpen();
            outgoing.clear();
            SSLEngineResult result = engine.wrap(source, outgoing);
            outgoing.flip();
            if (outgoing.hasRemaining()) {
                wireOutput.write(outgoing.array(), outgoing.position(), outgoing.remaining());
                wireOutput.flush();
            }
            if (result.getStatus() == SSLEngineResult.Status.BUFFER_OVERFLOW) {
                outgoing = allocate(nextSize(outgoing.capacity(), engine.getSession().getPacketBufferSize()));
                continue;
            }
            if (result.getStatus() == SSLEngineResult.Status.CLOSED && !source.hasRemaining() && engine.isInboundDone())
                return result;
            if (result.getStatus() != SSLEngineResult.Status.OK) throw new SSLException("TLS output closed or invalid.");
            if (result.bytesConsumed() == 0 && result.bytesProduced() == 0
                    && result.getHandshakeStatus() == SSLEngineResult.HandshakeStatus.NEED_WRAP)
                throw new SSLException("TLS output made no progress.");
            return result;
        }
    }

    private SSLEngineResult unwrap(boolean again) throws IOException {
        while (true) {
            checkOpen();
            if (!again && incoming.position() == 0) receive();
            incoming.flip();
            plaintext.compact();
            SSLEngineResult result;
            try { result = engine.unwrap(incoming, plaintext); }
            finally { incoming.compact(); plaintext.flip(); }
            switch (result.getStatus()) {
                case BUFFER_OVERFLOW:
                    ByteBuffer larger = allocate(nextSize(plaintext.capacity(), engine.getSession().getApplicationBufferSize()));
                    larger.put(plaintext).flip();
                    plaintext = larger;
                    break;
                case BUFFER_UNDERFLOW:
                    receive();
                    again = false;
                    break;
                case CLOSED:
                    return result;
                case OK:
                    if (result.bytesConsumed() == 0 && result.bytesProduced() == 0
                            && result.getHandshakeStatus() == SSLEngineResult.HandshakeStatus.NOT_HANDSHAKING)
                        throw new SSLException("TLS input made no progress.");
                    return result;
                default:
                    throw new SSLException("Invalid TLS input state.");
            }
        }
    }

    private void receive() throws IOException {
        if (!incoming.hasRemaining()) {
            ByteBuffer larger = allocate(nextSize(incoming.capacity(), engine.getSession().getPacketBufferSize()));
            incoming.flip(); larger.put(incoming); incoming = larger;
        }
        checkOpen();
        int count = wireInput.read(incoming.array(), incoming.position(), incoming.remaining());
        if (count < 0) {
            // Still reject truncation, but do not misclassify a lost radio link as a bad certificate.
            try { engine.closeInbound(); } catch (SSLException truncated) { }
            throw new EOFException("TLS transport ended before close notification.");
        }
        if (count == 0) throw new IOException("Transport input made no progress.");
        incoming.position(incoming.position() + count);
    }

    InputStream input() {
        return new InputStream() {
            @Override public int read() throws IOException {
                byte[] one = new byte[1];
                return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
            }
            @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                checkBounds(bytes, offset, length);
                if (length == 0) return 0;
                handshake();
                while (!plaintext.hasRemaining()) {
                    driveHandshake();
                    if (plaintext.hasRemaining()) break;
                    if (engine.isInboundDone()) return -1;
                    unwrap(false);
                }
                int count = Math.min(length, plaintext.remaining());
                plaintext.get(bytes, offset, count);
                return count;
            }
            @Override public void close() throws IOException { TlsEngineStream.this.close(); }
        };
    }

    OutputStream output() {
        return new OutputStream() {
            @Override public void write(int value) throws IOException { write(new byte[]{(byte) value}); }
            @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                checkBounds(bytes, offset, length);
                handshake();
                ByteBuffer source = ByteBuffer.wrap(bytes, offset, length);
                while (source.hasRemaining()) {
                    driveHandshake();
                    SSLEngineResult result = wrap(source);
                    if (result.bytesConsumed() == 0 && result.bytesProduced() == 0
                            && result.getHandshakeStatus() == SSLEngineResult.HandshakeStatus.NOT_HANDSHAKING)
                        throw new SSLException("TLS write made no progress.");
                }
                driveHandshake();
            }
            @Override public void flush() throws IOException { checkOpen(); wireOutput.flush(); }
            @Override public void close() throws IOException { TlsEngineStream.this.close(); }
        };
    }

    private static ByteBuffer allocate(int size) throws SSLException {
        if (size <= 0 || size > MAX_BUFFER) throw new SSLException("TLS buffer exceeds limit.");
        return ByteBuffer.allocate(size);
    }

    private static void checkBounds(byte[] bytes, int offset, int length) {
        if (offset < 0 || length < 0 || offset > bytes.length - length) throw new IndexOutOfBoundsException();
    }

    private static int nextSize(int old, int suggested) throws SSLException {
        int size = Math.max(old * 2, suggested);
        if (size > MAX_BUFFER) throw new SSLException("TLS buffer exceeds limit.");
        return size;
    }

    private void checkOpen() throws IOException {
        if (closed || Thread.currentThread().isInterrupted()) throw new IOException("TLS stream cancelled.");
    }

    @Override public void close() throws IOException {
        // Abort the underlying blocking IO first; cancellation must not wait for close_notify.
        closed = true;
        transport.close();
    }
}
