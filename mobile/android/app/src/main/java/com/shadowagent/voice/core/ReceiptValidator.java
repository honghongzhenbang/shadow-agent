package com.shadowagent.voice.core;

import java.io.IOException;
import java.time.OffsetDateTime;

/** Shared by HTTP acceptance and the durable sent-state transition. */
final class ReceiptValidator {
    static void validate(String expectedId, String expectedHash, String actualId, String actualHash, String storedAt)
            throws IOException {
        if (expectedId == null || expectedId.isEmpty() || expectedHash == null || !expectedHash.matches("[0-9a-f]{64}")
                || !expectedId.equals(actualId) || !expectedHash.equals(actualHash))
            throw new IOException("电脑回执的录音标识或 SHA-256 不匹配，原件已保留。");
        try { OffsetDateTime.parse(storedAt); }
        catch (RuntimeException e) { throw new IOException("电脑回执的存储时间无效，原件已保留。"); }
    }
    private ReceiptValidator() { }
}
