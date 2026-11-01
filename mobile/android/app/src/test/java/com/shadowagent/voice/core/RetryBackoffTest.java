package com.shadowagent.voice.core;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public final class RetryBackoffTest {
    @Test public void retriesAreBounded() {
        RetryBackoff backoff = new RetryBackoff();
        long[] expected = {5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000};
        for (long delay : expected) assertEquals(delay, backoff.nextDelayMs());
        for (int i = 0; i < 1000; i++) assertEquals(300000, backoff.nextDelayMs());
    }
    @Test public void successfulDeliveryResetsBackoff() {
        RetryBackoff backoff = new RetryBackoff();
        backoff.nextDelayMs(); backoff.nextDelayMs(); backoff.reset();
        assertEquals(5000, backoff.nextDelayMs());
    }
}
