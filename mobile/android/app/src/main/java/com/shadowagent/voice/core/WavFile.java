package com.shadowagent.voice.core;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Own-format WAV only. Never infers time from file timestamps or wall-clock elapsed time. */
final class WavFile implements AutoCloseable {
    static final int RATE = 16_000;
    static final int HEADER_BYTES = 44;
    static final long MAX_SAMPLES = RATE * 120L;
    private final RandomAccessFile file;
    private long samples;

    WavFile(File path) throws IOException {
        file = new RandomAccessFile(path, "rw");
        if (file.length() != 0) {
            file.close();
            throw new IOException("Refusing to overwrite existing audio.");
        }
        try {
            file.write(header(0));
            file.getFD().sync();
        } catch (IOException e) {
            file.close();
            throw e;
        }
    }

    void append(byte[] pcm, int offset, int length) throws IOException {
        if (length < 0 || (length & 1) != 0 || samples + length / 2L > MAX_SAMPLES)
            throw new IOException("PCM block exceeds segment bounds.");
        file.write(pcm, offset, length);
        samples += length / 2L;
    }
    long samples() { return samples; }
    void sync() throws IOException { file.getFD().sync(); }
    @Override public void close() throws IOException {
        try {
            file.seek(0);
            file.write(header(samples * 2));
            file.getFD().sync();
        } finally { file.close(); }
    }

    static long recover(File path) throws IOException {
        try (RandomAccessFile file = new RandomAccessFile(path, "rw")) {
            long length = file.length();
            if (length < HEADER_BYTES || length > HEADER_BYTES + MAX_SAMPLES * 2)
                throw new IOException("Incomplete or oversized audio header.");
            byte[] actual = new byte[HEADER_BYTES];
            file.readFully(actual);
            byte[] expected = header(0);
            for (int i = 0; i < HEADER_BYTES; i++) {
                if ((i >= 4 && i < 8) || i >= 40) continue;
                if (actual[i] != expected[i]) throw new IOException("Unrecognized PCM WAV format.");
            }
            long samples = (length - HEADER_BYTES) / 2;
            if (samples == 0) throw new IOException("Interrupted before any complete audio sample was saved.");
            file.setLength(HEADER_BYTES + samples * 2);
            file.seek(0);
            file.write(header(samples * 2));
            file.getFD().sync();
            return samples;
        }
    }

    private static byte[] header(long dataBytes) {
        ByteBuffer b = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt((int) (36 + dataBytes));
        b.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1);
        b.putShort((short) 1).putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt((int) dataBytes);
        return b.array();
    }
}
