package com.shadowagent.voice.core;

import org.json.JSONObject;

import java.io.IOException;
import java.io.RandomAccessFile;

/** This protocol only runs inside a successfully authenticated TLS stream. */
final class RfcommSession {
    private final BridgeFrames frames;

    RfcommSession(BridgeFrames frames) { this.frames = frames; }

    void authenticate(String token, String bridgeId) throws IOException {
        frames.write(BridgeFrames.object("op", "auth", "token", token));
        BridgeFrames.identity(frames.response(), bridgeId);
    }

    void health(String bridgeId) throws IOException {
        frames.write(BridgeFrames.object("op", "health"));
        BridgeFrames.identity(frames.response(), bridgeId);
    }

    JSONObject completion(RecordingStore.Upload recording, boolean acknowledge) throws IOException {
        JSONObject request = RecordingCompletion.request(recording);
        try { request.put("op", acknowledge ? "cleanup_ack" : "status"); }
        catch (org.json.JSONException invalid) { throw BridgeFrames.invalid(); }
        frames.write(request);
        return RecordingCompletion.validate(recording, frames.response());
    }

    JSONObject upload(RecordingStore.Upload upload, LosslessUpload compressed, TransportGuard.Operation operation)
            throws IOException {
        frames.write(BridgeFrames.object("op", "begin", "manifest", upload.manifest,
                "compressedSha256", compressed.sha256, "compressedSize", compressed.size));
        JSONObject begun = frames.response();
        if (begun.has("receipt")) return BridgeFrames.receipt(begun, upload);
        long offset = BridgeFrames.integer(begun, "offset", compressed.size);
        try (RandomAccessFile input = new RandomAccessFile(compressed.file, "r")) {
            if (input.length() != compressed.size) throw new IOException("Compressed cache changed during upload.");
            input.seek(offset);
            byte[] buffer = new byte[BridgeFrames.MAX_CHUNK_BYTES];
            while (offset < compressed.size) {
                operation.check();
                int count = (int) Math.min(buffer.length, compressed.size - offset);
                input.readFully(buffer, 0, count);
                frames.chunk(offset, buffer, count);
                long persisted = BridgeFrames.integer(frames.response(), "offset", compressed.size);
                if (persisted != offset + count) throw BridgeFrames.invalid();
                offset = persisted;
            }
        }
        frames.write(BridgeFrames.object("op", "finish"));
        return BridgeFrames.receipt(frames.response(), upload);
    }
}
