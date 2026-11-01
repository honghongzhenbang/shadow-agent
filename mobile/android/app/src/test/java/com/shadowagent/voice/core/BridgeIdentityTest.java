package com.shadowagent.voice.core;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.*;

public final class BridgeIdentityTest {
    private static byte[] identity(String bridge, String... endpoints) throws Exception {
        return new JSONObject().put("schemaVersion", 2).put("bridgeId", bridge)
                .put("endpoints", new JSONArray(Arrays.asList(endpoints))).toString().getBytes(StandardCharsets.UTF_8);
    }

    @Test public void acceptsNewIpWithoutChangingPairingSecrets() throws Exception {
        JSONObject pairing = PairingFixture.pairing();
        String before = pairing.toString();
        assertEquals(List.of(PairingFixture.FIRST), BridgeIdentity.endpoints(identity(PairingFixture.BRIDGE,
                PairingFixture.FIRST), pairing.getString("bridgeId")));
        assertEquals(List.of(PairingFixture.SECOND), BridgeIdentity.endpoints(identity(PairingFixture.BRIDGE,
                PairingFixture.SECOND), pairing.getString("bridgeId")));
        assertEquals(before, pairing.toString());
    }

    @Test public void allowsNoRouteWhilePcNetworkIsOffline() throws Exception {
        assertTrue(BridgeIdentity.endpoints(identity(PairingFixture.BRIDGE), PairingFixture.BRIDGE).isEmpty());
    }

    @Test public void bluetoothRouteCanWorkWithoutAnyLanAddress() throws Exception {
        JSONObject payload = new JSONObject(new String(identity(PairingFixture.BRIDGE), StandardCharsets.UTF_8))
                .put("bluetoothAddress", "12:34:56:78:9A:BC").put("rfcommServiceUuid", BridgeIdentity.RFCOMM_UUID);
        BridgeIdentity.Routes routes = BridgeIdentity.parse(payload.toString().getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE);
        assertTrue(routes.endpoints.isEmpty());
        assertEquals("12:34:56:78:9A:BC", routes.bluetoothAddress);
    }

    @Test public void rejectsIncompleteOrInvalidBluetoothRoute() throws Exception {
        for (String address : new String[]{"", "12:34:56:78:9a:bc", "00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "secret"}) {
            JSONObject payload = new JSONObject(new String(identity(PairingFixture.BRIDGE), StandardCharsets.UTF_8))
                    .put("bluetoothAddress", address).put("rfcommServiceUuid", BridgeIdentity.RFCOMM_UUID);
            assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.parse(payload.toString().getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE));
        }
        JSONObject missing = new JSONObject(new String(identity(PairingFixture.BRIDGE), StandardCharsets.UTF_8))
                .put("bluetoothAddress", "12:34:56:78:9A:BC");
        assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.parse(missing.toString().getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE));
        missing.put("rfcommServiceUuid", AppSettings.SERVICE_UUID);
        assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.parse(missing.toString().getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE));
    }

    @Test public void rejectsWrongIdentityAndLegacyPlainValue() throws Exception {
        byte[] wrong = identity("87654321-4321-8765-abcd-cba987654321", PairingFixture.FIRST);
        assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.endpoints(wrong, PairingFixture.BRIDGE));
        assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.endpoints(
                PairingFixture.BRIDGE.getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE));
    }

    @Test public void rejectsPublicDnsLoopbackAndNoncanonicalRoutes() throws Exception {
        for (String endpoint : new String[]{"https://8.8.8.8:8787", "https://127.0.0.1:8787", "http://192.168.1.2:8787",
                "https://192.168.1.2:443", "https://192.168.1.2:08787", "https://192.168.1.2:8787/",
                "https://192.168.1.2:8787/path", "https://192.168.1.2:8787?x=1", "https://192.168.1.2:8787#x",
                "https://name.local:8787", "https://user@192.168.1.2:8787", "https://192.168.001.2:8787",
                "https://[::1]:8787", "https://224.0.0.1:8787", "https://255.255.255.255:8787"}) {
            byte[] raw = identity(PairingFixture.BRIDGE, PairingFixture.FIRST, endpoint);
            assertThrows(endpoint, IllegalArgumentException.class, () -> BridgeIdentity.endpoints(raw, PairingFixture.BRIDGE));
        }
    }

    @Test public void limitsAndDeduplicatesCandidates() throws Exception {
        assertEquals(1, BridgeIdentity.endpoints(identity(PairingFixture.BRIDGE, PairingFixture.FIRST,
                PairingFixture.FIRST), PairingFixture.BRIDGE).size());
        byte[] tooMany = identity(PairingFixture.BRIDGE, PairingFixture.FIRST, PairingFixture.FIRST,
                PairingFixture.FIRST, PairingFixture.FIRST, PairingFixture.FIRST);
        assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.endpoints(tooMany, PairingFixture.BRIDGE));
        List<String> routes = BridgeIdentity.endpoints(identity(PairingFixture.BRIDGE, PairingFixture.FIRST), PairingFixture.BRIDGE);
        assertThrows(UnsupportedOperationException.class, () -> routes.add(PairingFixture.SECOND));
    }

    @Test public void rejectsCredentialsAndUnsupportedSchemaWithoutEchoingPayload() throws Exception {
        for (String key : new String[]{"token", "certificateSha256", "serverName", "serverUrl"}) {
            JSONObject payload = new JSONObject(new String(identity(PairingFixture.BRIDGE), StandardCharsets.UTF_8))
                    .put(key, "secret-not-for-diagnostics");
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
                    BridgeIdentity.endpoints(payload.toString().getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE));
            assertFalse(error.toString().contains("secret"));
            assertNull(error.getCause());
        }
        for (String raw : new String[]{"{\"schemaVersion\":1}", "{\"schemaVersion\":\"2\"}", "[]", "not json"})
            assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.endpoints(raw.getBytes(StandardCharsets.UTF_8), PairingFixture.BRIDGE));
    }

    @Test public void rejectsOversizedMissingAndMalformedUtf8Payloads() {
        for (byte[] raw : new byte[][]{null, new byte[0], new byte[BridgeIdentity.MAX_BYTES + 1], {(byte) 0xc3, 0x28}})
            assertThrows(IllegalArgumentException.class, () -> BridgeIdentity.endpoints(raw, PairingFixture.BRIDGE));
    }
}
