package com.shadowagent.voice.core;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;

import static org.junit.Assert.*;

public final class RfcommSessionTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void statusAndCleanupAckUseExactRecordingIdentityWithoutAudioTransfer() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        for (boolean acknowledge : new boolean[]{false, true}) {
            ByteArrayOutputStream wire = new ByteArrayOutputStream();
            JSONObject response = RecordingCompletionTest.response(upload, "completed").put("phoneAudioDeleted", acknowledge);
            assertEquals("completed", session(wire, response).completion(upload, acknowledge).getString("processingStatus"));
            ByteArrayInputStream input = new ByteArrayInputStream(wire.toByteArray());
            JSONObject request = new BridgeFrames(input, new ByteArrayOutputStream()).read();
            assertEquals(acknowledge ? "cleanup_ack" : "status", request.getString("op"));
            assertEquals(upload.id(), request.getString("recordingId"));
            assertEquals(upload.hash(), request.getString("sha256"));
            assertEquals(upload.manifest.getString("deviceId"), request.getString("deviceId"));
            assertEquals(5, request.length());
            assertTrue(request.getBoolean("supportsRetention"));
            assertEquals(0, input.available());
            assertTrue(upload.audio.exists());
        }
    }

    @Test public void oldReceiverAndMismatchedCompletionCannotAuthorizeDeletion() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        for (JSONObject response : new JSONObject[]{new JSONObject().put("ok", false).put("status", 400),
                RecordingCompletionTest.response(upload, "completed").put("sha256", "wrong")}) {
            assertThrows(IOException.class, () -> session(new ByteArrayOutputStream(), response).completion(upload, false));
            assertTrue(upload.audio.exists());
        }
    }

    @Test public void interruptedUploadBeginsAgainAtPersistedOffsetWithExactRemainingBytes() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 100000);
        String original = upload.manifest.toString();
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload compressed = LosslessUpload.prepare(upload, operation);
            ByteArrayOutputStream failedWire = new ByteArrayOutputStream();
            RfcommSession first = session(failedWire, ok("offset", 0), ok("offset", 32768));
            assertThrows(EOFException.class, () -> first.upload(upload, compressed, operation));
            LosslessUpload resumed = LosslessUpload.prepare(upload, operation);
            assertEquals(compressed.sha256, resumed.sha256);
            ByteArrayOutputStream responses = new ByteArrayOutputStream();
            BridgeFrames server = new BridgeFrames(new ByteArrayInputStream(new byte[0]), responses);
            server.write(ok("offset", 32768));
            for (long offset = 32768; offset < resumed.size; ) {
                offset = Math.min(offset + 32768, resumed.size);
                server.write(ok("offset", offset));
            }
            server.write(ok("receipt", UploadFixture.receipt(upload)));
            ByteArrayOutputStream wire = new ByteArrayOutputStream();
            RfcommSession second = new RfcommSession(new BridgeFrames(new ByteArrayInputStream(responses.toByteArray()), wire));
            assertEquals(upload.id(), second.upload(upload, resumed, operation).getString("recordingId"));
            ByteArrayInputStream requests = new ByteArrayInputStream(wire.toByteArray());
            BridgeFrames reader = new BridgeFrames(requests, new ByteArrayOutputStream());
            JSONObject begin = reader.read();
            assertEquals("begin", begin.getString("op"));
            assertEquals(original, begin.getJSONObject("manifest").toString());
            assertEquals(resumed.sha256, begin.getString("compressedSha256"));
            assertEquals(resumed.size, begin.getLong("compressedSize"));
            ByteArrayOutputStream transferred = new ByteArrayOutputStream();
            for (long offset = 32768; offset < resumed.size; ) {
                JSONObject chunk = reader.read();
                assertEquals("chunk", chunk.getString("op"));
                assertEquals(offset, chunk.getLong("offset"));
                int length = chunk.getInt("length");
                assertTrue(length > 0 && length <= 32768);
                transferred.write(requests.readNBytes(length));
                offset += length;
            }
            assertArrayEquals(Arrays.copyOfRange(Files.readAllBytes(resumed.file.toPath()), 32768, (int) resumed.size),
                    transferred.toByteArray());
            assertEquals("finish", reader.read().getString("op"));
            assertEquals(-1, requests.read());
            assertEquals(original, upload.manifest.toString());
            assertTrue(upload.audio.exists());
        }
    }

    @Test public void receiptLostOrAlreadyArchivedDoesNotRetransmitAudio() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload compressed = LosslessUpload.prepare(upload, operation);
            ByteArrayOutputStream wire = new ByteArrayOutputStream();
            session(wire, ok("receipt", UploadFixture.receipt(upload))).upload(upload, compressed, operation);
            ByteArrayInputStream requests = new ByteArrayInputStream(wire.toByteArray());
            assertEquals("begin", new BridgeFrames(requests, wire).read().getString("op"));
            assertEquals(0, requests.available());
            wire.reset();
            session(wire, ok("offset", compressed.size), ok("receipt", UploadFixture.receipt(upload))).upload(upload, compressed, operation);
            requests = new ByteArrayInputStream(wire.toByteArray());
            BridgeFrames frames = new BridgeFrames(requests, wire);
            assertEquals("begin", frames.read().getString("op"));
            assertEquals("finish", frames.read().getString("op"));
            assertEquals(0, requests.available());
        }
    }

    @Test public void badOffsetsAndNonContiguousAcknowledgementsStopBeforeFinish() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 50000);
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload compressed = LosslessUpload.prepare(upload, operation);
            for (Object offset : new Object[]{-1, compressed.size + 1, "0", 0.5, JSONObject.NULL}) {
                ByteArrayOutputStream wire = new ByteArrayOutputStream();
                assertThrows(IOException.class, () -> session(wire, ok("offset", offset)).upload(upload, compressed, operation));
                ByteArrayInputStream requests = new ByteArrayInputStream(wire.toByteArray());
                new BridgeFrames(requests, wire).read();
                assertEquals(0, requests.available());
            }
            for (int offset : new int[]{0, 32767, 32769})
                assertThrows(IOException.class, () -> session(new ByteArrayOutputStream(), ok("offset", 0), ok("offset", offset))
                        .upload(upload, compressed, operation));
        }
    }

    @Test public void exactReceiptIdentityTypesAndStoredTimeAreRequiredOnBothPaths() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(5000)) {
            LosslessUpload compressed = LosslessUpload.prepare(upload, operation);
            for (String field : new String[]{"recordingId", "sha256", "storedAt", "deviceId"}) {
                JSONObject receipt = UploadFixture.receipt(upload).put(field, "wrong");
                assertThrows(IOException.class, () -> session(new ByteArrayOutputStream(), ok("receipt", receipt))
                        .upload(upload, compressed, operation));
                assertThrows(IOException.class, () -> session(new ByteArrayOutputStream(), ok("offset", compressed.size), ok("receipt", receipt))
                        .upload(upload, compressed, operation));
            }
        }
    }

    @Test public void authFailureNeverSendsBeginOrBinaryAndIdentityCannotBeCoerced() throws Exception {
        ByteArrayOutputStream wire = new ByteArrayOutputStream();
        JSONObject failure = new JSONObject().put("ok", false).put("status", 401).put("error", "test-secret");
        IOException denied = assertThrows(IOException.class, () -> session(wire, failure).authenticate("test-token", PairingFixture.BRIDGE));
        assertEquals(BridgeHealth.State.UNAUTHORIZED, BridgeHealth.classify(denied));
        ByteArrayInputStream sent = new ByteArrayInputStream(wire.toByteArray());
        assertEquals("auth", new BridgeFrames(sent, wire).read().getString("op"));
        assertEquals(0, sent.available());
        JSONObject wrong = new JSONObject().put("ok", true).put("bridgeId", "other").put("utc", "2026-10-16T00:00:00Z");
        IOException identity = assertThrows(IOException.class, () -> session(wire, wrong).authenticate("test-token", PairingFixture.BRIDGE));
        assertEquals(BridgeHealth.State.WRONG_DEVICE, BridgeHealth.classify(identity));
        JSONObject valid = wrong.put("bridgeId", PairingFixture.BRIDGE);
        session(wire, valid, valid).authenticate("test-token", PairingFixture.BRIDGE);
        session(wire, valid).health(PairingFixture.BRIDGE);
    }

    private static JSONObject ok(String key, Object value) throws Exception {
        return new JSONObject().put("ok", true).put(key, value);
    }

    private static RfcommSession session(ByteArrayOutputStream output, JSONObject... responses) throws Exception {
        ByteArrayOutputStream input = new ByteArrayOutputStream();
        BridgeFrames frames = new BridgeFrames(new ByteArrayInputStream(new byte[0]), input);
        for (JSONObject response : responses) frames.write(response);
        return new RfcommSession(new BridgeFrames(new ByteArrayInputStream(input.toByteArray()), output));
    }
}
