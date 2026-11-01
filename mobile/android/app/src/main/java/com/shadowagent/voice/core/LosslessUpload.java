package com.shadowagent.voice.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/** A disposable, validated cache; neither the WAV nor its manifest is rewritten. */
final class LosslessUpload {
    static final long MAX_RAW_BYTES = WavFile.HEADER_BYTES + WavFile.MAX_SAMPLES * 2;
    static final long MAX_COMPRESSED_BYTES = MAX_RAW_BYTES + 65_536;
    final File file;
    final long size;
    final String sha256;

    private LosslessUpload(File file, long size, String sha256) {
        this.file = file; this.size = size; this.sha256 = sha256;
    }

    static LosslessUpload prepare(RecordingStore.Upload upload, TransportGuard.Operation operation) throws IOException {
        operation.check();
        if (upload == null || !upload.dir.isDirectory() || !upload.audio.isFile()
                || upload.audio.length() <= WavFile.HEADER_BYTES || upload.audio.length() > MAX_RAW_BYTES
                || !upload.hash().matches("[0-9a-f]{64}"))
            throw new IOException("Invalid source recording for compression.");
        long rawSize = upload.audio.length();
        if (!upload.hash().equals(hash(upload.audio, MAX_RAW_BYTES, operation)))
            throw new IOException("Source recording hash mismatch.");
        File cached = new File(upload.dir, "audio.wav.gz");
        if (!validCache(cached, rawSize, upload.hash(), operation)) {
            File temporary = new File(upload.dir, "audio-upload.part");
            RecordingAudioCleanup.validateFile(upload.dir, temporary);
            try {
                try (FileInputStream input = new FileInputStream(upload.audio);
                     FileOutputStream output = new FileOutputStream(temporary);
                     GZIPOutputStream gzip = new GZIPOutputStream(output, 32768)) {
                    byte[] buffer = new byte[32768];
                    long copied = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        operation.check();
                        copied += count;
                        if (copied > rawSize) throw new IOException("Source recording changed during compression.");
                        gzip.write(buffer, 0, count);
                    }
                    if (copied != rawSize) throw new IOException("Source recording changed during compression.");
                    gzip.finish();
                    gzip.flush();
                    output.getFD().sync();
                }
                if (!validCache(temporary, rawSize, upload.hash(), operation))
                    throw new IOException("Compressed recording integrity check failed.");
                operation.check();
                Files.move(temporary.toPath(), cached.toPath(), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } finally { Files.deleteIfExists(temporary.toPath()); }
        }
        return new LosslessUpload(cached, cached.length(), hash(cached, MAX_COMPRESSED_BYTES, operation));
    }

    private static boolean validCache(File file, long rawSize, String rawHash, TransportGuard.Operation operation)
            throws IOException {
        if (!file.isFile() || file.length() == 0 || file.length() > MAX_COMPRESSED_BYTES) return false;
        boolean valid;
        try (InputStream raw = new FileInputStream(file); InputStream input = new GZIPInputStream(raw, 32768)) {
            MessageDigest digest = digest();
            byte[] buffer = new byte[32768];
            long bytes = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                operation.check();
                bytes += count;
                if (bytes > rawSize) return false;
                digest.update(buffer, 0, count);
            }
            valid = bytes == rawSize && rawHash.equals(RecordingStore.hex(digest.digest()));
        } catch (IOException invalid) { valid = false; }
        operation.check();
        return valid;
    }

    private static String hash(File file, long maximum, TransportGuard.Operation operation) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            MessageDigest digest = digest();
            byte[] buffer = new byte[32768];
            long bytes = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                operation.check();
                bytes += count;
                if (bytes > maximum) throw new IOException("Recording exceeds upload limit.");
                digest.update(buffer, 0, count);
            }
            return RecordingStore.hex(digest.digest());
        }
    }

    private static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 unavailable."); }
    }
}
