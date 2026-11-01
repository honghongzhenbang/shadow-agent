package com.shadowagent.voice.core;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class AppSettingsValidationTest {
    @Test public void schemaTwoPinsIdentityWithoutAnyStoredRoute() throws Exception {
        JSONObject valid = AppSettings.validatePairing(PairingFixture.pairing().toString());
        assertEquals(2, valid.getInt("schemaVersion"));
        assertEquals(PairingFixture.NAME, valid.getString("serverName"));
        assertFalse(valid.has("serverUrl"));
        assertFalse(valid.has("endpoints"));
    }

    @Test public void schemaOneRequiresExplicitUpgrade() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> AppSettings.validatePairing("{\"schemaVersion\":1}"));
        assertTrue(error.getMessage().contains("schemaVersion=2"));
        assertTrue(error.getMessage().contains("升级"));
    }

    @Test public void rejectsMismatchedNameWildcardOldUrlAndNonUuidIdentity() throws Exception {
        for (String name : new String[]{"voice-other.local", "*.local", PairingFixture.NAME + ".evil", "192.168.1.20"}) {
            JSONObject pair = PairingFixture.pairing().put("serverName", name);
            assertThrows(IllegalArgumentException.class, () -> AppSettings.validatePairing(pair.toString()));
        }
        JSONObject pair = PairingFixture.pairing().put("serverUrl", PairingFixture.FIRST);
        assertThrows(IllegalArgumentException.class, () -> AppSettings.validatePairing(pair.toString()));
        pair.remove("serverUrl");
        pair.put("bridgeId", "not-a-uuid");
        assertThrows(IllegalArgumentException.class, () -> AppSettings.validatePairing(pair.toString()));
    }

    @Test public void rejectsMalformedCredentialsAndUnsupportedVersion() throws Exception {
        for (String key : new String[]{"schemaVersion", "token", "certificateSha256", "serviceUuid", "identityCharacteristicUuid"}) {
            JSONObject pair = PairingFixture.pairing().put(key, "invalid\nvalue");
            assertThrows(IllegalArgumentException.class, () -> AppSettings.validatePairing(pair.toString()));
        }
    }

    @Test public void acceptsOnlyLiteralPrivateLanAddresses() {
        for (String host : new String[]{"10.0.0.2", "192.168.1.2", "172.16.0.2", "172.31.255.2", "169.254.1.2"})
            assertTrue(host, AppSettings.isLanIpv4(host));
    }
    @Test public void rejectsCloudLoopbackDnsAndAmbiguousIpForms() {
        for (String host : new String[]{"8.8.8.8", "127.0.0.1", "172.15.0.2", "172.32.0.2", "localhost",
                "192.168.1.2.evil.invalid", "192.168.001.2", "192.168.1.256", "10.1.2", "::1", "2130706433", ""})
            assertFalse(host, AppSettings.isLanIpv4(host));
        assertFalse(AppSettings.isLanIpv4(null));
    }
}
