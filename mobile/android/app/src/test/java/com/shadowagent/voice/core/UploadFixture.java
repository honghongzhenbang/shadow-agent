package com.shadowagent.voice.core;

import org.json.JSONObject;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.util.Random;

final class UploadFixture {
    static RecordingStore.Upload recording(TemporaryFolder folder, int bytes) throws Exception {
        File dir = folder.newFolder();
        File audio = new File(dir, "audio.wav");
        byte[] pcm = new byte[bytes];
        new Random(716).nextBytes(pcm);
        try (WavFile wav = new WavFile(audio)) { wav.append(pcm, 0, pcm.length); }
        JSONObject manifest = new JSONObject().put("schemaVersion", 1).put("deviceId", "synthetic-device")
                .put("recordingId", "synthetic-recording").put("sha256", RecordingStore.sha256(audio))
                .put("recordedAt", "2026-10-16T00:00:00Z").put("audioPath", "audio.wav");
        return new RecordingStore.Upload(dir, manifest);
    }

    static JSONObject receipt(RecordingStore.Upload upload) throws Exception {
        return new JSONObject().put("recordingId", upload.id()).put("sha256", upload.hash())
                .put("storedAt", "2026-10-16T00:01:00Z");
    }

    private UploadFixture() { }
}
