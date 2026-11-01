package com.shadowagent.voice.core;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class WavFileTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();

    @Test public void exactHeaderAndSamples() throws Exception {
        File file = temp.newFile();
        try (WavFile wav = new WavFile(file)) {
            wav.append(new byte[32000], 0, 32000);
            assertEquals(16000, wav.samples());
        }
        assertEquals(32044, file.length());
        byte[] header = new byte[44];
        try (RandomAccessFile reader = new RandomAccessFile(file, "r")) { reader.readFully(header); }
        ByteBuffer bytes = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(32036, bytes.getInt(4));
        assertEquals(1, bytes.getShort(20));
        assertEquals(1, bytes.getShort(22));
        assertEquals(16000, bytes.getInt(24));
        assertEquals(16, bytes.getShort(34));
        assertEquals(32000, bytes.getInt(40));
        assertEquals(16000, WavFile.recover(file));
    }
    @Test public void recoverUsesActualBytesNotStaleHeader() throws Exception {
        File file = temp.newFile();
        try (WavFile ignored = new WavFile(file)) { }
        try (RandomAccessFile partial = new RandomAccessFile(file, "rw")) {
            partial.seek(44); partial.write(new byte[3201]);
        }
        assertEquals(1600, WavFile.recover(file));
        assertEquals(3244, file.length());
        try (RandomAccessFile reader = new RandomAccessFile(file, "r")) {
            reader.seek(40);
            assertEquals(3200, Integer.reverseBytes(reader.readInt()));
        }
    }
    @Test public void noSamplesCannotInventDuration() throws Exception {
        File file = temp.newFile();
        try (WavFile ignored = new WavFile(file)) { }
        assertThrows(IOException.class, () -> WavFile.recover(file));
        assertEquals(44, file.length());
    }
    @Test public void refusesUnknownFormatWithoutModifyingIt() throws Exception {
        File file = temp.newFile();
        try (WavFile wav = new WavFile(file)) { wav.append(new byte[8], 0, 8); }
        try (RandomAccessFile corrupt = new RandomAccessFile(file, "rw")) { corrupt.seek(22); corrupt.write(2); }
        assertThrows(IOException.class, () -> WavFile.recover(file));
        assertEquals(52, file.length());
    }
    @Test public void segmentHasHardTwoMinuteBound() throws Exception {
        File file = temp.newFile();
        try (WavFile wav = new WavFile(file)) {
            byte[] data = new byte[(int) WavFile.MAX_SAMPLES * 2];
            wav.append(data, 0, data.length);
            assertThrows(IOException.class, () -> wav.append(new byte[2], 0, 2));
            assertEquals(1_920_000, wav.samples());
        }
        assertEquals(1_920_000, WavFile.recover(file));
    }
    @Test public void rejectsOversizedInterruptedChunk() throws Exception {
        File file = temp.newFile();
        try (WavFile ignored = new WavFile(file)) { }
        long length = 44 + WavFile.MAX_SAMPLES * 2 + 2;
        try (RandomAccessFile corrupt = new RandomAccessFile(file, "rw")) { corrupt.setLength(length); }
        assertThrows(IOException.class, () -> WavFile.recover(file));
        assertEquals(length, file.length());
    }
    @Test public void rejectsIncompleteWriteSample() throws Exception {
        File file = temp.newFile();
        try (WavFile wav = new WavFile(file)) {
            assertThrows(IOException.class, () -> wav.append(new byte[3], 0, 3));
            assertEquals(0, wav.samples());
        }
    }
    @Test public void neverOverwritesExistingAudio() throws Exception {
        File file = temp.newFile();
        try (WavFile wav = new WavFile(file)) { wav.append(new byte[4], 0, 4); }
        assertThrows(IOException.class, () -> new WavFile(file));
        assertEquals(48, file.length());
    }
}
