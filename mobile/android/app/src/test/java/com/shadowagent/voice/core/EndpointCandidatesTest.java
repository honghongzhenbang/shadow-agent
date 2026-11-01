package com.shadowagent.voice.core;

import org.junit.Test;
import java.util.Collections;
import java.util.List;
import static org.junit.Assert.*;

public final class EndpointCandidatesTest {
    @Test public void eachCandidateIsTriedOnceThenCooldownEvenAcrossRefreshes() {
        EndpointCandidates routes = new EndpointCandidates();
        assertNull(routes.current());
        assertTrue(routes.update(List.of(PairingFixture.FIRST, PairingFixture.SECOND)));
        assertEquals(PairingFixture.FIRST, routes.current());
        assertEquals(1000, routes.failed());
        assertEquals(PairingFixture.SECOND, routes.current());
        assertFalse(routes.update(List.of(PairingFixture.SECOND, PairingFixture.FIRST)));
        assertEquals(PairingFixture.SECOND, routes.current());
        assertEquals(EndpointCandidates.RETRY_MS, routes.failed());
        assertEquals(PairingFixture.FIRST, routes.current());
    }

    @Test public void changedIpOrDisconnectDropsOldHealthAndLateSuccess() {
        EndpointCandidates routes = new EndpointCandidates();
        BridgeHealth health = new BridgeHealth();
        routes.update(List.of(PairingFixture.FIRST));
        health.complete(health.begin(), 100, BridgeHealth.State.READY);
        int oldRequest = health.begin();
        if (routes.update(List.of(PairingFixture.SECOND))) health.connectionChanged();
        assertFalse(health.ready(1000));
        assertEquals(PairingFixture.SECOND, routes.current());
        int newRequest = health.begin();
        health.complete(oldRequest, 2000, BridgeHealth.State.READY);
        assertFalse(health.ready(2000));
        health.complete(newRequest, 3000, BridgeHealth.State.READY);
        assertTrue(health.ready(3000));
        if (routes.update(Collections.emptyList())) health.connectionChanged();
        health.complete(newRequest, 4000, BridgeHealth.State.READY);
        assertNull(routes.current());
        assertFalse(health.ready(4000));
    }

    @Test public void changedCandidatesResetBudgetButSuccessKeepsWorkingRoute() {
        EndpointCandidates routes = new EndpointCandidates();
        routes.update(List.of(PairingFixture.FIRST, PairingFixture.SECOND));
        routes.failed();
        routes.succeeded();
        assertEquals(PairingFixture.SECOND, routes.current());
        assertEquals(1000, routes.failed());
        assertTrue(routes.update(List.of(PairingFixture.SECOND)));
        assertEquals(PairingFixture.SECOND, routes.current());
        assertEquals(EndpointCandidates.RETRY_MS, routes.failed());
    }

    @Test public void rejectsInvalidRoutesAndExcessCandidates() {
        EndpointCandidates routes = new EndpointCandidates();
        assertThrows(IllegalArgumentException.class, () -> routes.update(List.of("https://8.8.8.8:8787")));
        assertThrows(IllegalArgumentException.class, () -> routes.update(Collections.nCopies(5, PairingFixture.FIRST)));
    }
}
