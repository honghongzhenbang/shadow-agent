package com.shadowagent.voice.core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Unauthenticated BLE data supplies routes only, never pairing credentials. */
final class BridgeIdentity {
    static final int MAX_BYTES = 2048;
    static final int MAX_ENDPOINTS = 4;
    static final String RFCOMM_UUID = "7f8d8f62-7147-4a92-a23b-0cb593d41210";

    static final class Routes {
        final List<String> endpoints;
        final String bluetoothAddress;
        Routes(List<String> endpoints, String bluetoothAddress) {
            this.endpoints = endpoints;
            this.bluetoothAddress = bluetoothAddress;
        }
    }

    static List<String> endpoints(byte[] bytes, String expectedBridgeId) {
        return parse(bytes, expectedBridgeId).endpoints;
    }

    static Routes parse(byte[] bytes, String expectedBridgeId) {
        try {
            if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES)
                throw new IllegalArgumentException();
            String raw = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            JSONObject identity = new JSONObject(raw);
            boolean hasBluetooth = identity.has("bluetoothAddress") || identity.has("rfcommServiceUuid");
            if (identity.length() != (hasBluetooth ? 5 : 3) || !(identity.get("schemaVersion") instanceof Number)
                    || identity.getDouble("schemaVersion") != 2
                    || !expectedBridgeId.equals(identity.get("bridgeId")))
                throw new IllegalArgumentException();
            JSONArray values = identity.getJSONArray("endpoints");
            if (values.length() > MAX_ENDPOINTS) throw new IllegalArgumentException();
            List<String> endpoints = new ArrayList<>();
            for (int i = 0; i < values.length(); i++) {
                Object value = values.get(i);
                if (!(value instanceof String)) throw new IllegalArgumentException();
                String endpoint = endpoint((String) value);
                if (!endpoints.contains(endpoint)) endpoints.add(endpoint);
            }
            String bluetoothAddress = null;
            if (hasBluetooth) {
                Object address = identity.get("bluetoothAddress");
                if (!(address instanceof String) || !((String) address).matches("(?:[0-9A-F]{2}:){5}[0-9A-F]{2}")
                        || "00:00:00:00:00:00".equals(address) || "FF:FF:FF:FF:FF:FF".equals(address)
                        || !RFCOMM_UUID.equals(identity.get("rfcommServiceUuid"))) throw new IllegalArgumentException();
                bluetoothAddress = (String) address;
            }
            return new Routes(Collections.unmodifiableList(endpoints), bluetoothAddress);
        } catch (Exception invalid) {
            // Do not retain or echo an untrusted payload, which could contain secrets.
            throw new IllegalArgumentException("蓝牙身份或局域网地址无效，请检查电脑接收端版本与配对。");
        }
    }

    static String endpoint(String value) {
        try {
            if (value == null || value.length() > 64) throw new IllegalArgumentException();
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || uri.getPort() != 8787
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !uri.getRawPath().isEmpty() || !AppSettings.isLanIpv4(uri.getHost())
                    || !value.equals("https://" + uri.getHost() + ":8787"))
                throw new IllegalArgumentException();
            return value;
        } catch (Exception invalid) {
            throw new IllegalArgumentException("电脑候选地址必须为 https://局域网IPv4:8787。");
        }
    }
}
