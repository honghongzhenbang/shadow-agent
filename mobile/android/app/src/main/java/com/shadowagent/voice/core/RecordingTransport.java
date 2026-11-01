package com.shadowagent.voice.core;

import org.json.JSONObject;

import java.io.Closeable;
import java.io.IOException;

/** One operation at a time. Closing cancels active IO and permanently stops this client. */
public interface RecordingTransport extends Closeable {
    void health() throws IOException;
    JSONObject upload(RecordingStore.Upload upload) throws IOException;
    default JSONObject status(RecordingStore.Upload recording) throws IOException {
        throw new IOException("Completion status is not supported.");
    }
    default JSONObject cleanupAck(RecordingStore.Upload recording) throws IOException {
        throw new IOException("Cleanup acknowledgement is not supported.");
    }
}
