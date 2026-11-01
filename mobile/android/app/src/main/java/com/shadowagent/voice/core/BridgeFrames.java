package com.shadowagent.voice.core;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;

/** v1: unsigned big-endian JSON length, followed by UTF-8; binary chunks are separate. */
final class BridgeFrames {
    static final int MAX_JSON_BYTES = 65536;
    static final int MAX_CHUNK_BYTES = 32768;
    private final DataInputStream input;
    private final DataOutputStream output;

    BridgeFrames(InputStream input, OutputStream output) {
        this.input = new DataInputStream(input); this.output = new DataOutputStream(output);
    }

    void write(JSONObject value) throws IOException {
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > MAX_JSON_BYTES) throw invalid();
        output.writeInt(bytes.length);
        output.write(bytes);
        output.flush();
    }

    void chunk(long offset, byte[] bytes, int count) throws IOException {
        if (offset < 0 || count <= 0 || count > MAX_CHUNK_BYTES || count > bytes.length) throw invalid();
        write(object("op", "chunk", "offset", offset, "length", count));
        output.write(bytes, 0, count);
        output.flush();
    }

    JSONObject read() throws IOException {
        int length = input.readInt();
        if (length <= 0 || length > MAX_JSON_BYTES) throw invalid();
        byte[] bytes = new byte[length];
        input.readFully(bytes);
        return parse(bytes);
    }

    static JSONObject parse(byte[] bytes) throws IOException {
        if (bytes.length == 0 || bytes.length > MAX_JSON_BYTES) throw invalid();
        try {
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            // Bound nesting before the platform JSON parser can recurse on untrusted input.
            int depth = 0;
            boolean quoted = false, escaped = false;
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (c == '\\') escaped = true;
                    else if (c == '"') quoted = false;
                } else if (c == '"') quoted = true;
                else if (c == '{' || c == '[') { if (++depth > 64) throw invalid(); }
                else if (c == '}' || c == ']') depth--;
            }
            JSONTokener parser = new JSONTokener(text);
            Object value = parser.nextValue();
            if (!(value instanceof JSONObject) || parser.nextClean() != 0) throw invalid();
            return (JSONObject) value;
        } catch (JSONException | CharacterCodingException invalid) { throw invalid(); }
    }

    JSONObject response() throws IOException {
        JSONObject value = read();
        requireOk(value);
        return value;
    }

    static void requireOk(JSONObject value) throws IOException {
        if (Boolean.TRUE.equals(value.opt("ok"))) return;
        if (!Boolean.FALSE.equals(value.opt("ok"))) throw invalid();
        long status = integer(value, "status", 599);
        if (status == 401 || status == 403) throw BridgeHealth.failure(BridgeHealth.State.UNAUTHORIZED);
        throw invalid();
    }

    static long integer(JSONObject value, String name, long maximum) throws IOException {
        Object number = value.opt(name);
        if (!(number instanceof Integer) && !(number instanceof Long)) throw invalid();
        long result = ((Number) number).longValue();
        if (result < 0 || result > maximum) throw invalid();
        return result;
    }

    static void identity(JSONObject value, String bridgeId) throws IOException {
        requireOk(value);
        if (!bridgeId.equals(value.opt("bridgeId"))) throw BridgeHealth.failure(BridgeHealth.State.WRONG_DEVICE);
        Object utc = value.opt("utc");
        if (!(utc instanceof String)) throw invalid();
        try { OffsetDateTime.parse((String) utc); }
        catch (RuntimeException invalid) { throw invalid(); }
    }

    static JSONObject receipt(JSONObject response, RecordingStore.Upload upload) throws IOException {
        requireOk(response);
        JSONObject receipt = response.optJSONObject("receipt");
        if (receipt == null || !(receipt.opt("recordingId") instanceof String)
                || !(receipt.opt("sha256") instanceof String) || !(receipt.opt("storedAt") instanceof String))
            throw invalid();
        ReceiptValidator.validate(upload.id(), upload.hash(), (String) receipt.opt("recordingId"),
                (String) receipt.opt("sha256"), (String) receipt.opt("storedAt"));
        if (receipt.has("deviceId") && !upload.manifest.optString("deviceId").equals(receipt.opt("deviceId")))
            throw invalid();
        return receipt;
    }

    static JSONObject object(Object... fields) throws IOException {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1]);
            return result;
        } catch (JSONException invalid) { throw invalid(); }
    }

    static IOException invalid() { return BridgeHealth.failure(BridgeHealth.State.INVALID_RESPONSE); }
}
