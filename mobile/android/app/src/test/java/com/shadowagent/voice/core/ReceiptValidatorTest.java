package com.shadowagent.voice.core;

import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.assertThrows;

public final class ReceiptValidatorTest {
    private static final String ID = "10000000-0000-4000-8000-000000000001";
    private static final String HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    private static final String TIME = "2026-10-15T19:00:00+08:00";

    @Test public void exactReceiptAccepted() throws Exception { ReceiptValidator.validate(ID, HASH, ID, HASH, TIME); }
    @Test public void anotherRecordingRejected() {
        assertThrows(IOException.class, () -> ReceiptValidator.validate(ID, HASH, "other", HASH, TIME));
    }
    @Test public void anotherHashRejected() {
        assertThrows(IOException.class, () -> ReceiptValidator.validate(ID, HASH, ID, "0".repeat(64), TIME));
    }
    @Test public void hashMustMatchExactlyIncludingCase() {
        assertThrows(IOException.class, () -> ReceiptValidator.validate(ID, HASH, ID, HASH.toUpperCase(java.util.Locale.ROOT), TIME));
    }
    @Test public void missingOrUnzonedTimeRejected() {
        assertThrows(IOException.class, () -> ReceiptValidator.validate(ID, HASH, ID, HASH, null));
        assertThrows(IOException.class, () -> ReceiptValidator.validate(ID, HASH, ID, HASH, "2026-10-15T19:00:00"));
    }
    @Test public void malformedExpectedHashCannotMatchByAccident() {
        assertThrows(IOException.class, () -> ReceiptValidator.validate(ID, "", ID, "", TIME));
    }
}
