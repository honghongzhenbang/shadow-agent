package com.shadowagent.voice.core;

import org.json.JSONObject;
import java.io.IOException;

/** Small, strictly typed evidence shared by HTTPS, RFCOMM and durable cleanup. */
final class RecordingCompletion {
    static boolean permitsDeletion(JSONObject proof, boolean retainedPreviously) {
        return "completed".equals(proof.optString("processingStatus"))
                && !retainedPreviously && !proof.optBoolean("retainAudio", false);
    }

    static JSONObject request(RecordingStore.Upload recording) throws IOException {
        return BridgeFrames.object("deviceId", recording.manifest.optString("deviceId"),
                "recordingId", recording.id(), "sha256", recording.hash(), "supportsRetention", true);
    }

    static JSONObject validate(RecordingStore.Upload recording, JSONObject response) throws IOException {
        BridgeFrames.requireOk(response);
        if (!recording.id().equals(response.opt("recordingId"))
                || !recording.hash().equals(response.opt("sha256"))
                || !recording.hash().matches("[0-9a-f]{64}")
                || !(response.opt("audioDeleted") instanceof Boolean)
                || (response.has("phoneAudioDeleted") && !(response.opt("phoneAudioDeleted") instanceof Boolean))
                || (response.has("retainAudio") && !(response.opt("retainAudio") instanceof Boolean)))
            throw BridgeFrames.invalid();
        Object status = response.opt("processingStatus");
        if (!"pending".equals(status) && !"processing".equals(status)
                && !"failed".equals(status) && !"completed".equals(status)) throw BridgeFrames.invalid();
        if (!"completed".equals(status) && Boolean.TRUE.equals(response.opt("audioDeleted"))) throw BridgeFrames.invalid();
        JSONObject result = BridgeFrames.object("ok", true, "recordingId", recording.id(), "sha256", recording.hash(),
                "processingStatus", status, "audioDeleted", response.opt("audioDeleted"),
                "retainAudio", Boolean.TRUE.equals(response.opt("retainAudio")));
        if (response.has("phoneAudioDeleted")) {
            try { result.put("phoneAudioDeleted", response.opt("phoneAudioDeleted")); }
            catch (org.json.JSONException invalid) { throw BridgeFrames.invalid(); }
        }
        return result;
    }
}
