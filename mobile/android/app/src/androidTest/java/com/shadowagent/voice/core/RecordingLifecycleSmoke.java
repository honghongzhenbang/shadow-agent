package com.shadowagent.voice.core;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import java.io.File;
import java.util.UUID;
import org.json.JSONObject;

/** Synthetic silence in a separate private fixture directory, never a microphone. */
public final class RecordingLifecycleSmoke {
    public static int run(Context target) throws Exception {
        String scope = "lifecycle-" + UUID.randomUUID();
        File fixture = new File(target.getCacheDir(), scope);
        if (!fixture.mkdirs()) throw new AssertionError("fixture directory");
        Context context = new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getNoBackupFilesDir() { return fixture; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return super.getSharedPreferences(scope + name, mode); }
        };
        RecordingStore store = new RecordingStore(context);
        RecordingStore.Chunk chunk = store.begin("isolated-session");
        chunk.wav.append(new byte[3200], 0, 3200); store.finish(chunk, "");
        RecordingStore.Upload upload = store.claimNext();
        require(upload != null, "claim synthetic audio");
        store.acknowledge(upload, new JSONObject().put("recordingId", upload.id()).put("sha256", upload.hash()).put("storedAt", "2026-10-17T00:00:00Z"));
        require(upload.audio.isFile(), "upload receipt must retain audio");
        RecordingStore.Upload completion = store.claimCompletion(System.currentTimeMillis());
        require(completion != null, "new recordings opt in");
        JSONObject proof = new JSONObject().put("ok", true).put("recordingId", upload.id()).put("sha256", upload.hash())
            .put("processingStatus", "failed").put("audioDeleted", false);
        require(!store.complete(completion, proof) && upload.audio.isFile(), "failure retains original");
        proof.put("processingStatus", "completed").put("sha256", "0".repeat(64));
        boolean rejected = false;
        try { store.complete(completion, proof); } catch (java.io.IOException expected) { rejected = true; }
        require(rejected && upload.audio.isFile(), "mismatched proof cannot delete");
        proof.put("sha256", upload.hash()).put("audioDeleted", true);
        require(store.complete(completion, proof) && !upload.audio.exists(), "completed proof cleans original");
        require(new File(upload.dir, "manifest.json").isFile(), "identity retained");
        store.acknowledgeCleanup(completion, proof.put("phoneAudioDeleted", true));
        store.releaseCompletion(completion, System.currentTimeMillis(), "");
        JSONObject row = new RecordingStore(context).list().getJSONObject(0);
        require(row.getBoolean("phoneAudioDeleted") && row.getBoolean("cleanupAck") && !row.getBoolean("audioAvailable"), "cleanup durable and playback unavailable");
        require(store.claimCompletion(System.currentTimeMillis() + 60000) == null, "fully acknowledged cleanup not repeated");
        require(store.claimNext() == null, "cleaned audio not reuploaded");
        boolean exportRejected = false;
        try { store.exportZip(upload.id()); } catch (IllegalStateException expected) { exportRejected = true; }
        require(exportRejected, "cleaned record cannot export");
        store.delete(upload.id());
        return 10;
    }
    private static void require(boolean value, String label) { if (!value) throw new AssertionError(label); }
}
