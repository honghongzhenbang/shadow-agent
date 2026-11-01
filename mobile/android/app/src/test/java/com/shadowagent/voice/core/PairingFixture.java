package com.shadowagent.voice.core;

import org.json.JSONObject;

final class PairingFixture {
    static final String BRIDGE = "12345678-1234-5678-9abc-123456789abc";
    static final String NAME = "voice-" + BRIDGE + ".local";
    static final String FIRST = "https://192.168.1.20:8787";
    static final String SECOND = "https://10.0.0.30:8787";

    static JSONObject pairing() throws Exception {
        return new JSONObject().put("schemaVersion", 2).put("bridgeId", BRIDGE)
                .put("serviceUuid", AppSettings.SERVICE_UUID).put("identityCharacteristicUuid", AppSettings.IDENTITY_UUID)
                .put("serverName", NAME).put("token", "test-only-no-real-credential")
                .put("certificateSha256", "a".repeat(64));
    }
}
