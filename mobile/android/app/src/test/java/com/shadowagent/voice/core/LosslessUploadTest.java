package com.shadowagent.voice.core;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import static org.junit.Assert.*;

public final class LosslessUploadTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void roundTripAndCachedRetryKeepOriginalAndManifestExact() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 100000);
        byte[] original = Files.readAllBytes(upload.audio.toPath());
        String manifest = upload.manifest.toString();
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload first = LosslessUpload.prepare(upload, operation);
            assertEquals(upload.dir, first.file.getParentFile());
            assertEquals(first.size, first.file.length());
            assertEquals(RecordingStore.sha256(first.file), first.sha256);
            byte[] compressed = Files.readAllBytes(first.file.toPath());
            long modified = first.file.lastModified();
            try (GZIPInputStream input = new GZIPInputStream(new FileInputStream(first.file))) {
                assertArrayEquals(original, input.readAllBytes());
            }
            LosslessUpload second = LosslessUpload.prepare(upload, operation);
            assertEquals(first.sha256, second.sha256);
            assertArrayEquals(compressed, Files.readAllBytes(second.file.toPath()));
            assertEquals(modified, second.file.lastModified());
            assertArrayEquals(original, Files.readAllBytes(upload.audio.toPath()));
            assertEquals(manifest, upload.manifest.toString());
        }
    }

    @Test public void brokenTruncatedWrongContentAndExpansionCachesAreRebuilt() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload valid = LosslessUpload.prepare(upload, operation);
            byte[] expected = Files.readAllBytes(valid.file.toPath());
            byte[] corrupt = expected.clone();
            corrupt[corrupt.length - 8] ^= 1;
            for (byte[] bad : new byte[][]{new byte[]{1, 2}, corrupt,
                    java.util.Arrays.copyOf(expected, expected.length / 2), gzip(new byte[2044]), gzip(new byte[100000])}) {
                Files.write(valid.file.toPath(), bad);
                LosslessUpload repaired = LosslessUpload.prepare(upload, operation);
                assertArrayEquals(expected, Files.readAllBytes(repaired.file.toPath()));
            }
        }
    }

    @Test public void sourceMismatchAndSizeLimitsFailWithoutChangingOriginal() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        byte[] original = Files.readAllBytes(upload.audio.toPath());
        upload.manifest.put("sha256", "0".repeat(64));
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            assertThrows(IOException.class, () -> LosslessUpload.prepare(upload, operation));
            assertArrayEquals(original, Files.readAllBytes(upload.audio.toPath()));
            try (RandomAccessFile file = new RandomAccessFile(upload.audio, "rw")) { file.setLength(LosslessUpload.MAX_RAW_BYTES + 1); }
            assertThrows(IOException.class, () -> LosslessUpload.prepare(upload, operation));
            assertFalse(new File(upload.dir, "audio.wav.gz").exists());
        }
    }

    @Test public void oversizedCacheAndInterruptedTemporaryNeverBecomeTheUpload() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        File cached = new File(upload.dir, "audio.wav.gz");
        try (RandomAccessFile file = new RandomAccessFile(cached, "rw")) { file.setLength(LosslessUpload.MAX_COMPRESSED_BYTES + 1); }
        File interrupted = new File(upload.dir, "audio-upload-old.part");
        try (FileOutputStream output = new FileOutputStream(interrupted)) { output.write(new byte[]{1, 2, 3}); }
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload compressed = LosslessUpload.prepare(upload, operation);
            assertTrue(compressed.size < LosslessUpload.MAX_COMPRESSED_BYTES);
            guard.close();
            assertThrows(IOException.class, () -> LosslessUpload.prepare(upload, operation));
            assertTrue(upload.audio.isFile());
        }
    }

    private static byte[] gzip(byte[] raw) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (GZIPOutputStream output = new GZIPOutputStream(bytes)) { output.write(raw); }
        return bytes.toByteArray();
    }
}
