package com.shadowagent.voice.core;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.IOException;
import static org.junit.Assert.*;

public final class RecordingCompletionTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    static JSONObject response(RecordingStore.Upload upload, String status) throws Exception {
        return new JSONObject().put("ok", true).put("recordingId", upload.id()).put("sha256", upload.hash())
                .put("processingStatus", status).put("audioDeleted", false);
    }

    @Test public void onlyExactIdentityAndStrictCompletionFieldsAreAccepted() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        for (String field : new String[]{"recordingId", "sha256", "processingStatus", "ok", "audioDeleted", "phoneAudioDeleted", "retainAudio"}) {
            JSONObject wrong = response(upload, "completed").put(field, "wrong");
            assertThrows(IOException.class, () -> RecordingCompletion.validate(upload, wrong));
        }
        assertThrows(IOException.class, () -> RecordingCompletion.validate(upload, response(upload, "pending").put("audioDeleted", true)));
        assertTrue(upload.audio.exists());
    }

    @Test public void uploadReceiptIsNotCompletionAndNoStateImpliesPhoneDeletion() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        assertThrows(IOException.class, () -> RecordingCompletion.validate(upload, UploadFixture.receipt(upload)));
        for (String status : new String[]{"pending", "processing", "failed", "completed"}) {
            JSONObject proof = RecordingCompletion.validate(upload, response(upload, status));
            assertEquals(status, proof.getString("processingStatus"));
            assertFalse(proof.optBoolean("phoneAudioDeleted", false));
            assertTrue(upload.audio.exists());
        }
    }

    @Test public void ackIsSeparateAndEvidenceDoesNotCopyTranscriptOrUnboundedFields() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        JSONObject proof = RecordingCompletion.validate(upload, response(upload, "completed")
                .put("audioDeleted", true).put("phoneAudioDeleted", true).put("transcript", "private text"));
        assertTrue(proof.getBoolean("phoneAudioDeleted"));
        assertFalse(proof.has("transcript"));
        JSONObject request = RecordingCompletion.request(upload);
        assertEquals(4, request.length());
        assertTrue(request.getBoolean("supportsRetention"));
        assertEquals(upload.id(), request.getString("recordingId"));
        assertEquals(upload.hash(), request.getString("sha256"));
        assertEquals(upload.manifest.getString("deviceId"), request.getString("deviceId"));
    }

    @Test public void retentionFlagSurvivesProofValidation() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        assertTrue(RecordingCompletion.validate(upload, response(upload, "completed")
                .put("retainAudio", true)).getBoolean("retainAudio"));
        assertFalse(RecordingCompletion.validate(upload, response(upload, "completed")).getBoolean("retainAudio"));
        assertFalse(RecordingCompletion.permitsDeletion(response(upload, "completed").put("retainAudio", true), false));
        assertFalse(RecordingCompletion.permitsDeletion(response(upload, "completed"), true));
        assertFalse(RecordingCompletion.permitsDeletion(response(upload, "processing"), false));
        assertTrue(RecordingCompletion.permitsDeletion(response(upload, "completed"), false));
    }
}
