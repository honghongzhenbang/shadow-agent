package com.shadowagent.voice.core;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Private durable archive. Upload receipts alone never authorize audio deletion. */
public final class RecordingStore {
    static final long MIN_FREE_BYTES = 256L * 1024 * 1024;
    static final long MAX_QUEUE_BYTES = 2L * 1024 * 1024 * 1024;
    private static final Object LOCK = new Object();
    private static final Set<String> RECOVERED = new HashSet<>();
    private static final Set<String> ACTIVE = new HashSet<>();
    private static final Set<String> CLAIMED = new HashSet<>();
    private static long version;
    private long statsVersion = -1;
    private Stats cachedStats;
    private final File root;
    private final File cache;
    private final String deviceId;

    public RecordingStore(Context context) {
        Context app = context.getApplicationContext();
        root = new File(app.getNoBackupFilesDir(), "voice-recordings");
        cache = new File(app.getCacheDir(), "voice-exports");
        deviceId = new AppSettings(app).deviceId();
        synchronized (LOCK) {
            try {
                ensureDirectory(root);
                if (!RECOVERED.contains(root.getAbsolutePath())) {
                    recoverAll();
                    RECOVERED.add(root.getAbsolutePath());
                }
            } catch (Exception e) { throw failure(e); }
        }
    }

    public JSONArray list() {
        synchronized (LOCK) {
            try {
                JSONArray rows = new JSONArray();
                for (File dir : directories()) {
                    JSONObject meta;
                    JSONObject state;
                    try {
                        meta = metadata(dir);
                        state = state(dir);
                    } catch (IOException invalid) {
                        meta = new JSONObject();
                        state = new JSONObject().put("state", "failed").put("lastError", "归档元数据损坏，原始文件已保留。");
                    }
                    File audio = new File(dir, "audio.wav");
                    if (!audio.exists()) audio = new File(dir, "audio.wav.part");
                    boolean available = audio.isFile() && !state.optBoolean("phoneAudioDeleted", false);
                    rows.put(new JSONObject().put("id", dir.getName())
                            .put("title", meta.optString("title", "录音片段"))
                            .put("recordedAt", meta.optString("recordedAt", ""))
                            .put("durationMs", meta.optLong("durationMs", 0))
                            .put("conversationId", meta.optString("conversationId", dir.getName()))
                            .put("sessionId", meta.optString("conversationId", dir.getName()))
                            .put("state", ACTIVE.contains(key(dir)) ? "recording" : state.optString("state", "failed"))
                            .put("sha256", meta.optString("sha256", ""))
                            .put("audioPath", available ? audio.getAbsolutePath() : JSONObject.NULL)
                            .put("audioAvailable", available)
                            .put("canPlay", available && !ACTIVE.contains(key(dir)))
                            .put("canExport", available && !ACTIVE.contains(key(dir)))
                            .put("processingStatus", state.optString("processingStatus", "pending"))
                            .put("retainAudio", state.optBoolean("retainAudio", false))
                            .put("phoneAudioDeleted", state.optBoolean("phoneAudioDeleted", false))
                            .put("audioDeleted", state.optBoolean("audioDeleted", false))
                            .put("cleanupAck", state.optBoolean("cleanupAck", false))
                            .put("cleanupAfterTranscription", Boolean.TRUE.equals(meta.opt("cleanupAfterTranscription")))
                            .put("manifestPath", new File(dir, "manifest.json").getAbsolutePath())
                            .put("lastError", state.optString("lastError", "")));
                }
                return rows;
            } catch (Exception e) { throw failure(e); }
        }
    }

    /** Explicit user deletion only. In-flight capture/upload/export cannot race deletion. */
    public boolean delete(String id) {
        synchronized (LOCK) {
            File dir = directory(id);
            if (!dir.exists() || ACTIVE.contains(key(dir)) || CLAIMED.contains(key(dir))) return false;
            try {
                File[] files = dir.listFiles();
                if (files == null) throw new IOException("Cannot enumerate recording.");
                for (File file : files) {
                    if (!file.isFile()) throw new IOException("Unexpected archive directory.");
                }
                for (File file : files) if (!file.delete()) throw new IOException("Cannot delete recording file.");
                if (!dir.delete()) throw new IOException("Cannot delete recording directory.");
                syncDirectory(root);
                version++;
                return true;
            } catch (Exception e) { throw failure(e); }
        }
    }

    public File exportZip(String id) {
        synchronized (LOCK) {
            File dir = directory(id);
            if (ACTIVE.contains(key(dir))) throw new IllegalStateException("此片段仍在录制，请停止录音后再导出。");
            try {
                if (state(dir).optBoolean("phoneAudioDeleted", false))
                    throw new IOException("Audio was cleaned after transcription.");
                File manifest = new File(dir, "manifest.json");
                File audio = new File(dir, "audio.wav");
                JSONObject data = readJson(manifest);
                verifyAudio(data, audio);
                ensureDirectory(cache);
                File zip = new File(cache, id + ".zip");
                File temp = new File(cache, id + ".zip.part");
                try (FileOutputStream output = new FileOutputStream(temp);
                     ZipOutputStream stream = new ZipOutputStream(output)) {
                    zipEntry(stream, "manifest.json", manifest);
                    zipEntry(stream, "audio.wav", audio);
                    stream.finish();
                    stream.flush();
                    output.getFD().sync();
                }
                // POSIX rename replaces a previous export atomically inside the private cache.
                Os.rename(temp.getAbsolutePath(), zip.getAbsolutePath());
                syncDirectory(cache);
                return zip;
            } catch (Exception e) { throw failure(e); }
        }
    }

    static final class Chunk {
        final File dir;
        final WavFile wav;
        final JSONObject metadata;
        Chunk(File dir, WavFile wav, JSONObject metadata) {
            this.dir = dir; this.wav = wav; this.metadata = metadata;
        }
    }

    Chunk begin(String conversationId, String packageId, int partIndex, String previousRecordingId) throws IOException {
        synchronized (LOCK) {
            checkCapacity();
            File dir = directory(UUID.randomUUID().toString());
            try {
                ensureDirectory(dir);
                String recordedAt = OffsetDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
                JSONObject metadata = new JSONObject().put("schemaVersion", 1)
                        .put("kind", "voice-recording-package-part").put("deviceId", deviceId)
                        .put("recordingId", dir.getName()).put("conversationId", conversationId)
                        .put("packageId", packageId).put("partIndex", partIndex)
                        .put("previousRecordingId", previousRecordingId == null ? JSONObject.NULL : previousRecordingId)
                        .put("finalPart", false)
                        .put("recordedAt", recordedAt).put("title", "录音 " + recordedAt)
                        .put("audioPath", "audio.wav").put("timeBasis", "device_clock")
                        .put("cleanupAfterTranscription", true)
                        .put("timeUncertaintyMs", JSONObject.NULL);
                writeJson(new File(dir, "capture.json"), metadata);
                setState(dir, "recording", "");
                WavFile wav = new WavFile(new File(dir, "audio.wav.part"));
                syncDirectory(dir);
                ACTIVE.add(key(dir));
                version++;
                return new Chunk(dir, wav, metadata);
            } catch (Exception e) { throw new IOException("无法建立持久录音片段，请检查手机存储。", e); }
        }
    }

    void finish(Chunk chunk, String interruption) throws IOException {
        finish(chunk, interruption, true);
    }

    void finish(Chunk chunk, String interruption, boolean finalPart) throws IOException {
        synchronized (LOCK) {
            try {
                chunk.wav.close();
                chunk.metadata.put("finalPart", finalPart);
                finalizeFiles(chunk.dir, chunk.metadata, interruption);
            } catch (Exception e) {
                try { setState(chunk.dir, "failed", "录音片段保存失败，原件已保留，下次启动时尝试恢复。"); }
                catch (Exception suppressed) { e.addSuppressed(suppressed); }
                throw new IOException("无法完成录音保存，原始片段已保留。", e);
            } finally { ACTIVE.remove(key(chunk.dir)); version++; }
        }
    }

    static final class Upload {
        final File dir;
        final File audio;
        final JSONObject manifest;
        Upload(File dir, JSONObject manifest) {
            this.dir = dir; this.audio = new File(dir, "audio.wav"); this.manifest = manifest;
        }
        String id() { return manifest.optString("recordingId"); }
        String hash() { return manifest.optString("sha256"); }
    }

    Upload claimNext() throws IOException {
        synchronized (LOCK) {
            try {
                for (File dir : directories()) {
                    if (ACTIVE.contains(key(dir)) || CLAIMED.contains(key(dir))) continue;
                    if (!"queued".equals(state(dir).optString("state"))) continue;
                    JSONObject manifest = readJson(new File(dir, "manifest.json"));
                    Upload upload = new Upload(dir, manifest);
                    try { verifyAudio(manifest, upload.audio); }
                    catch (IOException invalid) {
                        setState(dir, "failed", invalid.getMessage());
                        version++;
                        continue;
                    }
                    setState(dir, "uploading", "");
                    CLAIMED.add(key(dir));
                    version++;
                    return upload;
                }
                return null;
            } catch (Exception e) { throw new IOException("无法读取上传队列，原始片段已保留。", e); }
        }
    }

    void acknowledge(Upload upload, JSONObject receipt) throws IOException {
        synchronized (LOCK) {
            try {
                if (!CLAIMED.contains(key(upload.dir)))
                    throw new IOException("Receipt does not match the claimed recording and hash.");
                ReceiptValidator.validate(upload.id(), upload.hash(), receipt.optString("recordingId"),
                        receipt.optString("sha256"), receipt.optString("storedAt"));
                writeJson(new File(upload.dir, "state.json"), new JSONObject().put("state", "sent")
                        .put("lastError", "").put("receipt", receipt));
                CLAIMED.remove(key(upload.dir));
                version++;
            } catch (Exception e) { throw new IOException("Cannot persist validated receipt.", e); }
        }
    }

    void retry(Upload upload, String error) throws IOException {
        synchronized (LOCK) {
            try { setState(upload.dir, "queued", error); }
            finally { CLAIMED.remove(key(upload.dir)); version++; }
        }
    }

    /** Shares CLAIMED with uploads; callers must release in a finally block. */
    Upload claimCompletion(long now) throws IOException {
        synchronized (LOCK) {
            Upload oldest = null;
            long oldestChecked = Long.MAX_VALUE;
            for (File dir : directories()) {
                if (ACTIVE.contains(key(dir)) || CLAIMED.contains(key(dir))) continue;
                JSONObject state = state(dir);
                String phase = state.optString("state");
                if (!"sent".equals(phase) && !"cleaned".equals(phase)) continue;
                JSONObject manifest = readJson(new File(dir, "manifest.json"));
                if (!Boolean.TRUE.equals(manifest.opt("cleanupAfterTranscription"))) continue;
                if (state.optBoolean("cleanupAck", false) && state.optBoolean("audioDeleted", false)) continue;
                if (state.optBoolean("retainAudio", false) && "completed".equals(state.optString("processingStatus"))) continue;
                long checked = state.optLong("completionCheckedAt", 0);
                long priority = completionPriority(checked, now);
                if (priority < 0 || priority >= oldestChecked) continue;
                if (!dir.getName().equals(manifest.opt("recordingId"))
                        || !deviceId.equals(manifest.opt("deviceId"))) throw new IOException("Invalid recording identity.");
                oldest = new Upload(dir, manifest);
                oldestChecked = priority;
            }
            if (oldest != null) CLAIMED.add(key(oldest.dir));
            return oldest;
        }
    }

    /** -1 is cooling down; otherwise the oldest checked time wins, not directory order. */
    static long completionPriority(long checked, long now) {
        if (checked <= 0 || checked > now) return 0;
        return now - checked < 30_000 ? -1 : checked;
    }

    /** Save completion evidence before any irreversible deletion; safe to replay after a crash. */
    boolean complete(Upload recording, JSONObject response) throws IOException {
        synchronized (LOCK) {
            requireCompletionClaim(recording);
            JSONObject proof = RecordingCompletion.validate(recording, response);
            JSONObject state = state(recording.dir);
            try {
                // Never downgrade a persisted completed proof on an older response.
                if ("completed".equals(state.optString("processingStatus"))
                        && !"completed".equals(proof.optString("processingStatus"))) throw BridgeFrames.invalid();
                state.put("processingStatus", proof.getString("processingStatus"))
                        .put("retainAudio", state.optBoolean("retainAudio", false) || proof.optBoolean("retainAudio", false))
                        .put("audioDeleted", proof.getBoolean("audioDeleted"))
                        .put("completionReceipt", proof).put("lastError", "");
                writeJson(new File(recording.dir, "state.json"), state);
                version++;
                if (!RecordingCompletion.permitsDeletion(proof, state.optBoolean("retainAudio", false))) return false;
                RecordingAudioCleanup.validateFile(recording.dir, recording.audio);
                if (recording.audio.exists()) verifyAudio(recording.manifest, recording.audio);
                RecordingAudioCleanup.delete(root, recording.dir);
                syncDirectory(recording.dir);
                state.put("state", "cleaned").put("phoneAudioDeleted", true);
                writeJson(new File(recording.dir, "state.json"), state);
                version++;
                return true;
            } catch (JSONException invalid) { throw new IOException(invalid); }
        }
    }

    void acknowledgeCleanup(Upload recording, JSONObject response) throws IOException {
        synchronized (LOCK) {
            requireCompletionClaim(recording);
            JSONObject proof = RecordingCompletion.validate(recording, response);
            JSONObject state = state(recording.dir);
            if (!state.optBoolean("phoneAudioDeleted", false) || !"completed".equals(proof.opt("processingStatus")))
                throw BridgeFrames.invalid();
            try {
                // An omitted phoneAudioDeleted is not an acknowledgement; retry later.
                state.put("cleanupAck", Boolean.TRUE.equals(proof.opt("phoneAudioDeleted")))
                        .put("audioDeleted", proof.getBoolean("audioDeleted"));
                writeJson(new File(recording.dir, "state.json"), state);
                version++;
            } catch (JSONException invalid) { throw new IOException(invalid); }
        }
    }

    void releaseCompletion(Upload recording, long now, String warning) throws IOException {
        synchronized (LOCK) {
            try {
                requireCompletionClaim(recording);
                JSONObject state = state(recording.dir);
                state.put("completionCheckedAt", now).put("lastError", warning);
                writeJson(new File(recording.dir, "state.json"), state);
            } catch (JSONException invalid) { throw new IOException(invalid); }
            finally { CLAIMED.remove(key(recording.dir)); version++; }
        }
    }

    private void requireCompletionClaim(Upload recording) throws IOException {
        RecordingAudioCleanup.validateDirectory(root, recording.dir);
        JSONObject manifest = readJson(new File(recording.dir, "manifest.json"));
        String phase = state(recording.dir).optString("state");
        if (!CLAIMED.contains(key(recording.dir)) || ACTIVE.contains(key(recording.dir))
                || (!"sent".equals(phase) && !"cleaned".equals(phase))
                || !Boolean.TRUE.equals(manifest.opt("cleanupAfterTranscription"))
                || !recording.id().equals(recording.dir.getName())
                || !recording.id().equals(manifest.opt("recordingId"))
                || !recording.hash().equals(manifest.opt("sha256"))
                || !deviceId.equals(manifest.opt("deviceId"))) throw new IOException("Cleanup is not authorized.");
    }

    static final class Stats {
        final int queuedCount;
        final long queuedBytes;
        final int processingCount, completedCount, cleanupPendingCount, cleanedCount, failedCount;
        Stats(int queuedCount, long queuedBytes, int processing, int completed, int cleanup, int cleaned, int failed) {
            this.queuedCount = queuedCount; this.queuedBytes = queuedBytes;
            processingCount = processing; completedCount = completed; cleanupPendingCount = cleanup;
            cleanedCount = cleaned; failedCount = failed;
        }
    }

    Stats stats() {
        synchronized (LOCK) {
            if (statsVersion == version && cachedStats != null) return cachedStats;
            try {
                int count = 0;
                long bytes = 0;
                int processing = 0, completed = 0, cleanup = 0, cleaned = 0, failed = 0;
                for (File dir : directories()) {
                    JSONObject detail = state(dir);
                    String state = detail.optString("state", "failed");
                    String status = detail.optString("processingStatus", "pending");
                    if ("sent".equals(state) && !"completed".equals(status) && !"failed".equals(status)) processing++;
                    if ("failed".equals(status) || "failed".equals(state)) failed++;
                    if ("completed".equals(status)) {
                        completed++;
                        if (!detail.optBoolean("phoneAudioDeleted", false) || !detail.optBoolean("cleanupAck", false)
                                || !detail.optBoolean("audioDeleted", false)) cleanup++;
                    }
                    if (detail.optBoolean("phoneAudioDeleted", false)) cleaned++;
                    if (!"sent".equals(state) && !"cleaned".equals(state)) {
                        if (!ACTIVE.contains(key(dir))) count++;
                        // Reserve the full bounded chunk while it is active, including PCM not flushed yet.
                        bytes += ACTIVE.contains(key(dir)) ? WavFile.MAX_SAMPLES * 2 + WavFile.HEADER_BYTES
                                : new File(dir, "audio.wav").length() + new File(dir, "audio.wav.part").length();
                    }
                }
                cachedStats = new Stats(count, bytes, processing, completed, cleanup, cleaned, failed);
                statsVersion = version;
                return cachedStats;
            } catch (Exception e) { throw failure(e); }
        }
    }

    void checkCapacity() throws IOException {
        checkCapacity(root.getUsableSpace(), stats().queuedBytes);
    }

    static void checkCapacity(long availableBytes, long queuedBytes) throws CapacityException {
        if (availableBytes < MIN_FREE_BYTES)
            throw new CapacityException("手机剩余存储低于 256 MiB，采集受阻；同步和清理仍可继续。");
        if (queuedBytes > MAX_QUEUE_BYTES - WavFile.MAX_SAMPLES * 2 - WavFile.HEADER_BYTES)
            throw new CapacityException("未确认录音队列已达到 2 GiB 限额，采集受阻；同步和清理仍可继续。");
    }

    static final class CapacityException extends IOException {
        CapacityException(String message) { super(message); }
    }

    void recoverInterrupted() throws IOException {
        synchronized (LOCK) { recoverAll(); }
    }

    private void recoverAll() throws IOException {
        File[] archived = directories();
        Map<String, Integer> lastPart = new HashMap<>();
        for (File dir : archived) {
            try {
                JSONObject meta = metadata(dir);
                if ("voice-recording-package-part".equals(meta.optString("kind"))) {
                    String packageId = meta.optString("packageId");
                    int index = meta.optInt("partIndex", -1);
                    if (validId(packageId) && index >= 0)
                        lastPart.put(packageId, Math.max(lastPart.getOrDefault(packageId, -1), index));
                }
            } catch (Exception ignored) { /* The per-directory recovery pass marks it failed. */ }
        }
        for (File dir : archived) {
            if (ACTIVE.contains(key(dir)) || CLAIMED.contains(key(dir))) continue;
            try {
                if (new File(dir, "manifest.json").exists()) {
                    String state = state(dir).optString("state");
                    if (!"sent".equals(state) && !"cleaned".equals(state) && !"failed".equals(state) && !"queued".equals(state))
                        setState(dir, "queued", "上次传输中断，原始录音已保留，等待重试。");
                } else if (new File(dir, "capture.json").exists()) {
                    JSONObject capture = readJson(new File(dir, "capture.json"));
                    if ("voice-recording-package-part".equals(capture.optString("kind"))) {
                        String packageId = capture.optString("packageId");
                        capture.put("finalPart", capture.optInt("partIndex", -1) ==
                                lastPart.getOrDefault(packageId, -2));
                    }
                    finalizeFiles(dir, capture, "录音曾中断，已按实际保存的 PCM 样本恢复片段。");
                } else {
                    setState(dir, "failed", "录音元数据不完整，原始文件已保留。");
                }
            } catch (Exception e) {
                setState(dir, "failed", "中断片段无法安全恢复，原始文件已保留。");
            }
        }
        version++;
    }

    private void finalizeFiles(File dir, JSONObject meta, String interruption) throws Exception {
        File part = new File(dir, "audio.wav.part");
        File audio = new File(dir, "audio.wav");
        File source = audio.exists() ? audio : part;
        long samples = WavFile.recover(source);
        if (!audio.exists()) {
            Os.rename(part.getAbsolutePath(), audio.getAbsolutePath());
            syncDirectory(dir);
        }
        meta.put("sampleRateHz", WavFile.RATE).put("sampleCount", samples).put("channels", 1)
                .put("durationMs", samples * 1000.0 / WavFile.RATE).put("sha256", sha256(audio))
                .put("captureInterrupted", !interruption.isEmpty());
        writeJson(new File(dir, "manifest.json"), meta);
        setState(dir, "queued", interruption);
    }

    private File[] directories() throws IOException {
        File[] dirs = root.listFiles(f -> f.isDirectory() && validId(f.getName()));
        if (dirs == null) throw new IOException("Cannot read recording archive.");
        for (File dir : dirs) RecordingAudioCleanup.validateDirectory(root, dir);
        Arrays.sort(dirs, Comparator.comparing(File::getName));
        return dirs;
    }
    private File directory(String id) {
        if (!validId(id)) throw new IllegalArgumentException("录音片段标识无效。");
        return new File(root, id);
    }
    private static boolean validId(String id) {
        return id != null && id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }
    private static String key(File dir) { return dir.getAbsolutePath(); }
    private static JSONObject metadata(File dir) throws IOException {
        File manifest = new File(dir, "manifest.json");
        if (!manifest.exists()) manifest = new File(dir, "capture.json");
        return manifest.exists() ? readJson(manifest) : new JSONObject();
    }
    private static JSONObject state(File dir) throws IOException {
        File file = new File(dir, "state.json");
        return file.exists() ? readJson(file) : new JSONObject();
    }
    private static void setState(File dir, String state, String error) throws IOException {
        try {
            writeJson(new File(dir, "state.json"), new JSONObject().put("state", state)
                    .put("lastError", error == null ? "" : error));
        } catch (JSONException e) { throw new IOException(e); }
    }
    static JSONObject readJson(File file) throws IOException {
        RecordingAudioCleanup.validateFile(file.getParentFile(), file);
        RecordingAudioCleanup.validateFile(file.getParentFile(), new File(file.getPath() + ".bak"));
        RecordingAudioCleanup.validateFile(file.getParentFile(), new File(file.getPath() + ".new"));
        try (FileInputStream in = new AtomicFile(file).openRead()) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) {
                if (bytes.size() + read > 65536) throw new IOException("Archive metadata is oversized.");
                bytes.write(buffer, 0, read);
            }
            return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
        } catch (JSONException e) { throw new IOException("Invalid archive metadata.", e); }
    }
    static void writeJson(File file, JSONObject value) throws IOException {
        RecordingAudioCleanup.validateFile(file.getParentFile(), file);
        RecordingAudioCleanup.validateFile(file.getParentFile(), new File(file.getPath() + ".bak"));
        RecordingAudioCleanup.validateFile(file.getParentFile(), new File(file.getPath() + ".new"));
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            output.write(value.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
            atomic.finishWrite(output);
            output = null;
            syncDirectory(file.getParentFile());
        } catch (Exception e) {
            if (output != null) atomic.failWrite(output);
            throw new IOException("Cannot persist recording metadata.", e);
        }
    }
    private static void ensureDirectory(File dir) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create private archive directory.");
        syncDirectory(dir.getParentFile());
    }
    private static void syncDirectory(File dir) throws IOException {
        FileDescriptor fd = null;
        try {
            if (!dir.isDirectory()) throw new IOException("归档目录不存在。");
            fd = Os.open(dir.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            Os.fsync(fd);
        } catch (Exception e) { throw new IOException("Cannot sync archive directory.", e); }
        finally {
            if (fd != null) try { Os.close(fd); } catch (Exception ignored) { }
        }
    }
    static String sha256(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[32768];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
            return hex(digest.digest());
        } catch (Exception e) { throw new IOException("Cannot hash audio.", e); }
    }
    static String hex(byte[] bytes) {
        char[] chars = "0123456789abcdef".toCharArray();
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) output.append(chars[(b & 255) >>> 4]).append(chars[b & 15]);
        return output.toString();
    }
    private static void verifyAudio(JSONObject manifest, File audio) throws IOException {
        RecordingAudioCleanup.validateFile(audio.getParentFile(), audio);
        if (!audio.isFile() || audio.length() <= WavFile.HEADER_BYTES
                || audio.length() > WavFile.HEADER_BYTES + WavFile.MAX_SAMPLES * 2
                || !sha256(audio).equals(manifest.optString("sha256")))
            throw new IOException("录音文件完整性检查失败，原始文件已保留。");
    }
    private static void zipEntry(ZipOutputStream out, String name, File file) throws IOException {
        out.putNextEntry(new ZipEntry(name));
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) out.write(buffer, 0, count);
        }
        out.closeEntry();
    }
    private static IllegalStateException failure(Exception e) {
        return new IllegalStateException("录音归档操作失败，请检查存储空间或文件完整性。", e);
    }
}
