package com.shadowagent.voice.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** One attempt per candidate per round; unchanged BLE refreshes do not reset the retry budget. */
final class EndpointCandidates {
    static final long RETRY_MS = 30_000;
    private List<String> endpoints = Collections.emptyList();
    private int selected;
    private int failures;

    boolean update(List<String> next) {
        if (next.size() > BridgeIdentity.MAX_ENDPOINTS) throw new IllegalArgumentException();
        List<String> valid = new ArrayList<>();
        for (String value : next) {
            String endpoint = BridgeIdentity.endpoint(value);
            if (!valid.contains(endpoint)) valid.add(endpoint);
        }
        // A different enumeration order does not change the available routes or invalidate TLS proof.
        if (valid.size() == endpoints.size() && valid.containsAll(endpoints)) return false;
        endpoints = Collections.unmodifiableList(valid);
        selected = 0;
        failures = 0;
        return true;
    }

    String current() { return endpoints.isEmpty() ? null : endpoints.get(selected); }

    long failed() {
        if (endpoints.isEmpty()) return RETRY_MS;
        selected = (selected + 1) % endpoints.size();
        if (++failures < endpoints.size()) return 1000;
        failures = 0;
        return RETRY_MS;
    }

    void succeeded() { failures = 0; }
}
