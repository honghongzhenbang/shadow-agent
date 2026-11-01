package com.shadowagent.voice.core;

import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.*;

/** Construction/closed-client checks do not open any socket. */
public final class BridgeClientTest {
    @Test public void cannotConstructClientForPublicOrUnvalidatedRoute() throws Exception {
        for (String route : new String[]{"https://8.8.8.8:8787", "http://192.168.1.20:8787", "https://evil.local:8787"})
            assertThrows(IllegalArgumentException.class, () -> new BridgeClient(PairingFixture.pairing(), route));
    }

    @Test public void closedClientCannotLaunchLateHealthRequest() throws Exception {
        try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST)) {
            client.close();
            assertThrows(IOException.class, client::health);
        }
    }
}
