package com.shadowagent.voice.core;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.*;

public final class BridgeFramesTest {
    @Test public void bigEndianLengthIsUtf8ByteLengthAndFramesStaySeparated() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        BridgeFrames frames = new BridgeFrames(new ByteArrayInputStream(new byte[0]), output);
        JSONObject value = new JSONObject().put("op", "health").put("test", "\u4f60\u597d");
        frames.write(value);
        frames.write(new JSONObject().put("op", "finish"));
        byte[] wire = output.toByteArray();
        assertEquals(value.toString().getBytes(StandardCharsets.UTF_8).length, ByteBuffer.wrap(wire).getInt());
        BridgeFrames reader = new BridgeFrames(new ByteArrayInputStream(wire), output);
        assertEquals(value.toString(), reader.read().toString());
        assertEquals("finish", reader.read().getString("op"));
    }

    @Test public void exactFrameLimitAcceptedAndOversizedWriteIsAtomic() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        BridgeFrames frames = new BridgeFrames(new ByteArrayInputStream(new byte[0]), output);
        JSONObject value = new JSONObject().put("x", "x".repeat(BridgeFrames.MAX_JSON_BYTES - 8));
        frames.write(value);
        assertEquals(BridgeFrames.MAX_JSON_BYTES + 4, output.size());
        value.put("x", "x".repeat(BridgeFrames.MAX_JSON_BYTES - 7));
        assertThrows(IOException.class, () -> frames.write(value));
        assertEquals(BridgeFrames.MAX_JSON_BYTES + 4, output.size());
    }

    @Test public void zeroNegativeOversizedTruncatedAndInvalidUtf8FramesFail() throws Exception {
        for (int length : new int[]{0, -1, 65537, Integer.MAX_VALUE}) {
            byte[] bytes = ByteBuffer.allocate(4).putInt(length).array();
            assertThrows(IOException.class, () -> new BridgeFrames(new ByteArrayInputStream(bytes), new ByteArrayOutputStream()).read());
        }
        for (byte[] bytes : new byte[][]{{0, 0}, {0, 0, 0, 2, '{'}, {0, 0, 0, 1, (byte) 0xff}})
            assertThrows(IOException.class, () -> new BridgeFrames(new ByteArrayInputStream(bytes), new ByteArrayOutputStream()).read());
        for (String json : new String[]{"[]", "null", "{} {}", "{", "{\"x\":" + "[".repeat(65) + "0" + "]".repeat(65) + "}"})
            assertThrows(IOException.class, () -> BridgeFrames.parse(json.getBytes(StandardCharsets.UTF_8)));
    }

    @Test public void chunksHaveRawBinaryPayloadAndStrictBounds() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        BridgeFrames frames = new BridgeFrames(new ByteArrayInputStream(new byte[0]), output);
        byte[] chunk = new byte[32768];
        chunk[0] = 42;
        frames.chunk(32768, chunk, chunk.length);
        DataInputStream wire = new DataInputStream(new ByteArrayInputStream(output.toByteArray()));
        int length = wire.readInt();
        JSONObject header = BridgeFrames.parse(wire.readNBytes(length));
        assertEquals(32768, header.getInt("offset"));
        assertEquals(32768, header.getInt("length"));
        assertArrayEquals(chunk, wire.readNBytes(32768));
        assertEquals(-1, wire.read());
        for (int count : new int[]{0, -1, 32769}) assertThrows(IOException.class, () -> frames.chunk(0, chunk, count));
        assertThrows(IOException.class, () -> frames.chunk(-1, chunk, 1));
    }

    @Test public void offsetsCannotBeCoercedAndErrorsAreRedactedAndClassified() throws Exception {
        for (Object value : new Object[]{"1", true, 1.5, -1, Long.MAX_VALUE, JSONObject.NULL}) {
            JSONObject response = new JSONObject().put("offset", value);
            assertThrows(IOException.class, () -> BridgeFrames.integer(response, "offset", 100));
        }
        assertEquals(100, BridgeFrames.integer(new JSONObject().put("offset", 100), "offset", 100));
        for (int status : new int[]{401, 403, 409, 413, 500}) {
            JSONObject value = new JSONObject().put("ok", false).put("status", status).put("error", "secret-must-not-escape");
            IOException error = assertThrows(IOException.class, () -> BridgeFrames.requireOk(value));
            assertFalse(error.toString().contains("secret-must-not-escape"));
            assertNull(error.getCause());
            assertEquals(status == 401 || status == 403 ? BridgeHealth.State.UNAUTHORIZED : BridgeHealth.State.INVALID_RESPONSE,
                    BridgeHealth.classify(error));
        }
        assertThrows(IOException.class, () -> BridgeFrames.requireOk(new JSONObject().put("ok", "true")));
    }
}
