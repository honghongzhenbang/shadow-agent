package com.shadowagent.voice.core;

import org.junit.Test;
import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;

import static com.shadowagent.voice.core.BridgeHealth.State.*;
import static org.junit.Assert.*;

public final class BridgeHealthTest {
    @Test public void olderCheckCannotOverwriteNewerCheckOnSameClient() {
        BridgeHealth health = new BridgeHealth();
        int old = health.begin();
        int newer = health.begin();
        health.complete(newer, 1000, UNREACHABLE);
        health.complete(old, 2000, READY);
        assertFalse(health.ready(2000));
        assertEquals(UNREACHABLE, health.state(2000));
    }

    @Test public void readinessExpiresAndNeverSurvivesReconnect() {
        BridgeHealth health = new BridgeHealth();
        assertEquals(UNCHECKED, health.state(0));
        int request = health.begin();
        assertEquals(CHECKING, health.state(0));
        health.complete(request, 100, READY);
        assertFalse(health.ready(99));
        assertTrue(health.ready(15_100));
        assertFalse(health.ready(15_101));
        assertEquals(UNCHECKED, health.state(15_101));
        health.connectionChanged();
        assertFalse(health.ready(100));
    }

    @Test public void oldResponseCannotAuthenticateNewConnection() {
        BridgeHealth health = new BridgeHealth();
        int old = health.begin();
        health.connectionChanged();
        health.complete(old, 1000, READY);
        assertEquals(UNCHECKED, health.state(1000));
        int current = health.begin();
        health.complete(current, 2000, READY);
        health.complete(old, 3000, UNAUTHORIZED);
        assertEquals(READY, health.state(3000));
    }

    @Test public void backgroundCheckKeepsFreshProofButFailureRevokesIt() {
        BridgeHealth health = new BridgeHealth();
        health.complete(health.begin(), 1000, READY);
        int next = health.begin();
        assertEquals(READY, health.state(5000));
        health.complete(next, 6000, UNREACHABLE);
        assertFalse(health.ready(6000));
        assertEquals(UNREACHABLE, health.state(6000));
        health.complete(health.begin(), 7000, READY);
        assertTrue(health.ready(7000));
    }

    @Test public void networkFailureClassificationDoesNotGuessVpn() {
        assertEquals(UNREACHABLE, BridgeHealth.classify(new SocketTimeoutException("secret")));
        assertEquals(UNREACHABLE, BridgeHealth.classify(new ConnectException("secret")));
        assertEquals(UNREACHABLE, BridgeHealth.classify(new NoRouteToHostException("secret")));
        assertEquals(FAILED, BridgeHealth.classify(new IOException("secret")));
        assertFalse(BridgeHealth.warning(UNREACHABLE).contains("secret"));
    }

    @Test public void tlsAndProtocolErrorsHaveSeparateCategories() {
        assertEquals(CERTIFICATE, BridgeHealth.classify(new SSLHandshakeException("secret")));
        assertEquals(CERTIFICATE, BridgeHealth.classify(new SSLPeerUnverifiedException("secret")));
        for (BridgeHealth.State state : new BridgeHealth.State[]{UNAUTHORIZED, WRONG_DEVICE, INVALID_RESPONSE}) {
            assertEquals(state, BridgeHealth.classify(new IOException("secret", BridgeHealth.failure(state))));
            assertFalse(BridgeHealth.label(state).isEmpty());
            assertFalse(BridgeHealth.warning(state).isEmpty());
        }
        assertEquals("", BridgeHealth.warning(READY));
    }

    @Test(expected = IllegalArgumentException.class) public void requestCannotFinishInPendingState() {
        BridgeHealth health = new BridgeHealth();
        health.complete(health.begin(), 0, CHECKING);
    }
}
