package com.shadowagent.voice.core;

import android.content.Context;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

/** Synthetic PCM only. Never invokes AudioRecord, BLE, or the production knowledge database. */
public final class TransportSmoke {
    private static final String TEST_ENDPOINT = "https://10.0.2.2:8787";
    private static int checks;
    public static int run(Context context, String path) throws Exception {
        checks = 0;
        JSONObject pairing = new JSONObject(new String(Files.readAllBytes(new File(path).toPath()), StandardCharsets.UTF_8));
        pairing = AppSettings.validatePairing(pairing.toString());
        RecordingStore store = new RecordingStore(context);
        ProximityPolicy policy = new ProximityPolicy(-80, -65);
        try (BridgeClient client = new BridgeClient(pairing, TEST_ENDPOINT)) { client.health(); }
        policy.update(0, true, -60, true);
        require(policy.update(10_000, true, -60, true) == ProximityPolicy.Mode.NEAR, "authenticated initial baseline");
        policy.update(11_000, false, null, false);
        require(policy.update(31_000, false, null, false) == ProximityPolicy.Mode.AWAY, "departure chooses capture");
        RecordingStore.Chunk chunk = store.begin(UUID.randomUUID().toString());
        require(!store.delete(chunk.dir.getName()), "cannot delete active capture");
        byte[] silence = new byte[32000];
        chunk.wav.append(silence, 0, silence.length);
        chunk.metadata.put("testOnly", true);
        policy.update(32_000, true, -60, false);
        require(policy.update(42_000, true, -60, false) == ProximityPolicy.Mode.NEAR, "return stops capture without network");
        store.finish(chunk, "");
        require(!policy.canUpload(true, -60, false), "network outage keeps upload queued");
        RecordingStore.Upload upload = store.claimNext();
        require(upload != null && upload.id().equals(chunk.dir.getName()), "persistent upload candidate");
        require(!store.delete(upload.id()), "cannot delete in-flight upload");
        JSONObject wrongToken = new JSONObject(pairing.toString()).put("token", "invalid-token-for-test-only");
        boolean failedUpload = false;
        try (BridgeClient client = new BridgeClient(wrongToken, TEST_ENDPOINT)) { client.upload(upload); }
        catch (IOException expected) { failedUpload = BridgeHealth.classify(expected) == BridgeHealth.State.UNAUTHORIZED; }
        require(failedUpload, "rejected upload classified without losing original");
        store.retry(upload, "test-only failed transfer");
        store = new RecordingStore(context);
        RecordingStore.Upload retry = store.claimNext();
        require(retry != null && retry.id().equals(upload.id()) && retry.hash().equals(upload.hash()), "durable retry has same identity and content");
        upload = retry;
        try (BridgeClient client = new BridgeClient(pairing, TEST_ENDPOINT)) {
            client.health();
            require(policy.canUpload(true, -60, true), "network recovery permits upload without manual capture");
            JSONObject receipt = client.upload(upload);
            JSONObject duplicate = client.upload(upload);
            require(receipt.getString("storedAt").equals(duplicate.getString("storedAt")), "duplicate returns original receipt");
            boolean rejected = false;
            JSONObject invalid = new JSONObject(receipt.toString()).put("sha256", "0".repeat(64));
            try { store.acknowledge(upload, invalid); } catch (IOException expected) { rejected = true; }
            require(rejected, "wrong receipt must not acknowledge");
            store.acknowledge(upload, receipt);
            require(upload.audio.isFile(), "ack retains original");
            require(store.exportZip(upload.id()).length() > 0, "export creates ZIP");
        }
        JSONObject wrongPin = new JSONObject(pairing.toString()).put("certificateSha256", "0".repeat(64));
        boolean pinRejected = false;
        try (BridgeClient client = new BridgeClient(wrongPin, TEST_ENDPOINT)) { client.health(); }
        catch (IOException expected) { pinRejected = BridgeHealth.classify(expected) == BridgeHealth.State.CERTIFICATE; }
        require(pinRejected, "wrong certificate rejected");
        boolean tokenRejected = false;
        try (BridgeClient client = new BridgeClient(wrongToken, TEST_ENDPOINT)) { client.health(); }
        catch (IOException expected) { tokenRejected = BridgeHealth.classify(expected) == BridgeHealth.State.UNAUTHORIZED; }
        require(tokenRejected, "wrong credential rejected");
        String otherBridge = "87654321-4321-8765-abcd-cba987654321";
        JSONObject wrongIdentity = new JSONObject(pairing.toString()).put("bridgeId", otherBridge)
                .put("serverName", "voice-" + otherBridge + ".local");
        boolean identityRejected = false;
        try (BridgeClient client = new BridgeClient(wrongIdentity, TEST_ENDPOINT)) { client.health(); }
        catch (IOException expected) { identityRejected = BridgeHealth.classify(expected) == BridgeHealth.State.CERTIFICATE; }
        require(identityRejected, "wrong paired name rejected before HTTP");
        require(store.delete(upload.id()), "explicit deletion after upload");
        return checks;
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
        checks++;
    }
}
