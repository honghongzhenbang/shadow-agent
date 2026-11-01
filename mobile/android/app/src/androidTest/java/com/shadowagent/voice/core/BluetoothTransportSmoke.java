package com.shadowagent.voice.core;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Arrays;
import java.util.Random;
import java.util.UUID;
import java.util.zip.GZIPInputStream;

/** Explicit debug-only interoperability check. No activity, microphone, BLE discovery, or app settings import. */
public final class BluetoothTransportSmoke {
    public static void run(Context context, String pairingFile, String address, Bundle result) throws Exception {
        result.putString("stage", "input");
        require("com.shadowagent.voice.debug".equals(context.getPackageName())
                && (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0, "debug target required");
        require(pairingFile != null && pairingFile.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}\\.json"), "private pairing filename required");
        require(address != null && address.matches("(?:[0-9A-F]{2}:){5}[0-9A-F]{2}"), "explicit Bluetooth address required");
        File files = context.getFilesDir().getCanonicalFile();
        File input = new File(files, pairingFile).getCanonicalFile();
        require(files.equals(input.getParentFile()) && input.isFile() && input.length() <= 16_384, "private pairing file required");
        JSONObject pairing = AppSettings.validatePairing(RecordingStore.readJson(input).toString());

        result.putString("stage", "health");
        long started = SystemClock.elapsedRealtime();
        try (BluetoothBridgeClient client = new BluetoothBridgeClient(context, pairing, address)) { client.health(); }
        result.putLong("healthMs", SystemClock.elapsedRealtime() - started);

        result.putString("stage", "fixture");
        File temporary = Files.createTempDirectory(context.getCacheDir().toPath(), "bluetooth-smoke-").toFile();
        String preferences = "bluetooth_smoke_" + UUID.randomUUID();
        Context isolated = new ContextWrapper(context) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getNoBackupFilesDir() { return new File(temporary, "no-backup"); }
            @Override public File getCacheDir() { return new File(temporary, "cache"); }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return context.getSharedPreferences(preferences, mode);
            }
        };
        RecordingStore store = null;
        RecordingStore.Upload claimed = null;
        try {
            store = new RecordingStore(isolated);
            RecordingStore.Chunk chunk = store.begin(UUID.randomUUID().toString());
            try {
                chunk.metadata.put("testOnly", true).put("title", "TEST_ONLY synthetic Bluetooth multichunk");
                byte[] samples = new byte[WavFile.RATE * 2 * 15];
                Random random = new Random(14);
                for (int i = 0; i < samples.length; i += 2) {
                    int sample = random.nextInt(4096) - 2048;
                    samples[i] = (byte) sample;
                    samples[i + 1] = (byte) (sample >> 8);
                }
                chunk.wav.append(samples, 0, samples.length);
            } finally { store.finish(chunk, ""); }
            claimed = store.claimNext();
            require(claimed != null && claimed.id().equals(chunk.dir.getName())
                    && claimed.manifest.getBoolean("testOnly"), "synthetic isolated candidate required");
            byte[] original = Files.readAllBytes(claimed.audio.toPath());
            File manifest = new File(claimed.dir, "manifest.json");
            byte[] metadata = Files.readAllBytes(manifest.toPath());
            result.putBoolean("testOnly", true);
            result.putString("recordingId", claimed.id());
            result.putString("sha256", claimed.hash());
            result.putLong("audioBytes", original.length);

            result.putString("stage", "upload");
            started = SystemClock.elapsedRealtime();
            JSONObject receipt;
            try (BluetoothBridgeClient client = new BluetoothBridgeClient(context, pairing, address)) {
                receipt = client.upload(claimed);
            }
            result.putLong("uploadMs", SystemClock.elapsedRealtime() - started);
            ReceiptValidator.validate(claimed.id(), claimed.hash(), receipt.optString("recordingId"),
                    receipt.optString("sha256"), receipt.optString("storedAt"));
            File gzip = new File(claimed.dir, "audio.wav.gz");
            require(gzip.isFile() && gzip.length() < original.length, "synthetic upload must use gzip cache");
            require(gzip.length() > 2L * 32 * 1024, "real Bluetooth test must cross multiple protocol chunks");
            result.putLong("gzipBytes", gzip.length());
            byte[] decoded = new byte[original.length];
            try (DataInputStream stream = new DataInputStream(new GZIPInputStream(new FileInputStream(gzip)))) {
                stream.readFully(decoded);
                require(stream.read() == -1 && Arrays.equals(original, decoded), "gzip must preserve original WAV bytes");
            }

            // Simulate a lost local acknowledgement, then retry the same persisted identity on a new TLS connection.
            result.putString("stage", "duplicate");
            String id = claimed.id(), hash = claimed.hash();
            store.retry(claimed, "TEST_ONLY receipt retry");
            claimed = null;
            store = new RecordingStore(isolated);
            claimed = store.claimNext();
            require(claimed != null && id.equals(claimed.id()) && hash.equals(claimed.hash())
                    && claimed.manifest.getBoolean("testOnly"), "retry must retain synthetic identity");
            started = SystemClock.elapsedRealtime();
            JSONObject duplicate;
            try (BluetoothBridgeClient client = new BluetoothBridgeClient(context, pairing, address)) {
                duplicate = client.upload(claimed);
            }
            result.putLong("duplicateMs", SystemClock.elapsedRealtime() - started);
            ReceiptValidator.validate(id, hash, duplicate.optString("recordingId"),
                    duplicate.optString("sha256"), duplicate.optString("storedAt"));
            require(receipt.getString("storedAt").equals(duplicate.getString("storedAt")), "duplicate must return original receipt");

            result.putString("stage", "acknowledge");
            store.acknowledge(claimed, duplicate);
            claimed = null;
            require(Arrays.equals(original, Files.readAllBytes(new File(chunk.dir, "audio.wav").toPath()))
                    && Arrays.equals(metadata, Files.readAllBytes(manifest.toPath())), "original WAV and manifest must be unchanged");
            require("sent".equals(RecordingStore.readJson(new File(chunk.dir, "state.json")).getString("state")),
                    "validated receipt must be durable");
            result.putString("storedAt", duplicate.getString("storedAt"));
            result.putString("stage", "cleanup");
        } finally {
            try {
                if (claimed != null && store != null) store.retry(claimed, "TEST_ONLY cleanup");
            } finally {
                try { context.deleteSharedPreferences(preferences); }
                finally { deleteTemporary(temporary.toPath()); }
            }
        }
        result.putString("stage", "complete");
    }

    private static void deleteTemporary(Path root) throws IOException {
        Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                if (error != null) throw error;
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void require(boolean condition, String check) {
        if (!condition) throw new AssertionError(check);
    }

    private BluetoothTransportSmoke() { }
}
