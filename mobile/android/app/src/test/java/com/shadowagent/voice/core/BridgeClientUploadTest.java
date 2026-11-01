package com.shadowagent.voice.core;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.cert.Certificate;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;

import javax.net.ssl.HttpsURLConnection;

import static org.junit.Assert.*;

/** In-memory HTTPS doubles only: verifies the exact multipart body without any network. */
public final class BridgeClientUploadTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void completionUsesPinnedAuthenticatedPostWithExactIdentityAndNoAudio() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        for (boolean ack : new boolean[]{false, true}) {
            FakeConnection connection = new FakeConnection(RecordingCompletionTest.response(upload, "completed")
                    .put("phoneAudioDeleted", ack));
            try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST, url -> {
                assertEquals(PairingFixture.FIRST + (ack ? "/v1/recordings/cleanup-ack" : "/v1/recordings/status"), url);
                return connection;
            })) {
                JSONObject proof = ack ? client.cleanupAck(upload) : client.status(upload);
                assertEquals("completed", proof.getString("processingStatus"));
            }
            JSONObject request = new JSONObject(connection.body.toString(StandardCharsets.UTF_8));
            assertEquals(4, request.length());
            assertTrue(request.getBoolean("supportsRetention"));
            assertEquals(upload.id(), request.getString("recordingId"));
            assertEquals(upload.hash(), request.getString("sha256"));
            assertEquals(upload.manifest.getString("deviceId"), request.getString("deviceId"));
            assertEquals("POST", connection.getRequestMethod());
            assertEquals("Bearer " + PairingFixture.pairing().getString("token"), connection.getRequestProperty("Authorization"));
            assertNotNull(connection.getSSLSocketFactory());
            assertFalse(connection.getInstanceFollowRedirects());
            assertTrue(connection.disconnected);
            assertTrue(upload.audio.exists());
        }
    }

    @Test public void missingStatusEndpointRetainsOriginalAndClientCanStillUpload() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        FakeConnection unsupported = new FakeConnection(new JSONObject());
        unsupported.status = 404;
        FakeConnection accepted = new FakeConnection(new JSONObject().put("ok", true).put("receipt", UploadFixture.receipt(upload)));
        try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST,
                url -> url.endsWith("/status") ? unsupported : accepted)) {
            assertThrows(IOException.class, () -> client.status(upload));
            assertEquals(upload.id(), client.upload(upload).getString("recordingId"));
            assertTrue(upload.audio.exists());
        }
    }

    @Test public void audioPartIsGzipWhileOriginalManifestAndFixedBodyLengthStayExact() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 100000);
        byte[] original = Files.readAllBytes(upload.audio.toPath());
        String manifest = upload.manifest.toString();
        FakeConnection connection = new FakeConnection(new JSONObject().put("ok", true).put("receipt", UploadFixture.receipt(upload)));
        try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST, url -> connection)) {
            assertEquals(upload.id(), client.upload(upload).getString("recordingId"));
        }
        byte[] body = connection.body.toByteArray();
        assertEquals(body.length, connection.bodyLength());
        assertTrue(connection.disconnected);
        assertEquals("POST", connection.getRequestMethod());
        assertNull(connection.getRequestProperty("Content-Encoding"));
        assertFalse(connection.getInstanceFollowRedirects());
        String text = new String(body, StandardCharsets.ISO_8859_1);
        assertTrue(text.contains("Content-Encoding: gzip\r\n"));
        String manifestHeader = "Content-Type: application/json; charset=utf-8\r\n\r\n";
        int manifestStart = text.indexOf(manifestHeader) + manifestHeader.length();
        byte[] expectedManifest = manifest.getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(expectedManifest, Arrays.copyOfRange(body, manifestStart, manifestStart + expectedManifest.length));
        String header = "Content-Type: audio/wav\r\nContent-Encoding: gzip\r\n\r\n";
        int start = text.indexOf(header) + header.length();
        String boundary = connection.getRequestProperty("Content-Type").split("boundary=", 2)[1];
        int end = body.length - ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII).length;
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(body, start, end - start))) {
            assertArrayEquals(original, gzip.readAllBytes());
        }
        assertArrayEquals(original, Files.readAllBytes(upload.audio.toPath()));
        assertEquals(manifest, upload.manifest.toString());
    }

    @Test public void rejectedOrMalformedReceiptsDoNotBecomeSuccess() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        for (String field : new String[]{"recordingId", "sha256", "storedAt", "deviceId"}) {
            FakeConnection connection = new FakeConnection(new JSONObject().put("ok", true)
                    .put("receipt", UploadFixture.receipt(upload).put(field, "wrong")));
            try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST, url -> connection)) {
                assertThrows(IOException.class, () -> client.upload(upload));
                assertTrue(connection.disconnected);
                assertTrue(upload.audio.exists());
            }
        }
        for (int status : new int[]{401, 403, 302, 500}) {
            FakeConnection connection = new FakeConnection(new JSONObject());
            connection.status = status;
            try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST, url -> connection)) {
                IOException error = assertThrows(IOException.class, client::health);
                assertEquals(status == 401 || status == 403 ? BridgeHealth.State.UNAUTHORIZED : BridgeHealth.State.INVALID_RESPONSE,
                        BridgeHealth.classify(error));
                assertFalse(connection.readBody);
            }
        }
    }

    @Test public void oversizedAndMalformedHealthBodiesAreBounded() throws Exception {
        for (byte[] body : new byte[][]{new byte[65537], new byte[]{(byte) 0xff}, "{}{}".getBytes(StandardCharsets.US_ASCII)}) {
            FakeConnection connection = new FakeConnection(new JSONObject());
            connection.response = body;
            try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST, url -> connection)) {
                assertEquals(BridgeHealth.State.INVALID_RESPONSE, BridgeHealth.classify(assertThrows(IOException.class, client::health)));
            }
        }
    }

    @Test public void sameClientRejectsOverlapAndCloseCancelsBlockedUpload() throws Exception {
        RecordingStore.Upload upload = UploadFixture.recording(folder, 2000);
        FakeConnection connection = new FakeConnection(new JSONObject());
        connection.blockOutput = true;
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (BridgeClient client = new BridgeClient(PairingFixture.pairing(), PairingFixture.FIRST, url -> connection)) {
            Future<?> uploadResult = worker.submit(() -> assertThrows(IOException.class, () -> client.upload(upload)));
            assertTrue(connection.outputEntered.await(3, TimeUnit.SECONDS));
            assertThrows(IOException.class, client::health);
            assertThrows(IOException.class, () -> client.upload(upload));
            client.close();
            uploadResult.get(3, TimeUnit.SECONDS);
            assertTrue(connection.disconnected);
            assertTrue(upload.audio.isFile());
        } finally { worker.shutdownNow(); assertTrue(worker.awaitTermination(3, TimeUnit.SECONDS)); }
    }

    private static final class FakeConnection extends HttpsURLConnection {
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        final CountDownLatch outputEntered = new CountDownLatch(1);
        final CountDownLatch aborted = new CountDownLatch(1);
        byte[] response;
        int status = 200;
        volatile boolean disconnected;
        boolean readBody;
        boolean blockOutput;

        FakeConnection(JSONObject response) throws Exception {
            super(new URL(PairingFixture.FIRST));
            this.response = response.toString().getBytes(StandardCharsets.UTF_8);
        }

        long bodyLength() { return fixedContentLengthLong; }
        @Override public int getResponseCode() { return status; }
        @Override public InputStream getInputStream() { readBody = true; return new ByteArrayInputStream(response); }
        @Override public OutputStream getOutputStream() throws IOException {
            outputEntered.countDown();
            if (blockOutput) {
                try { if (!aborted.await(5, TimeUnit.SECONDS)) throw new IOException("Synthetic blocking write timed out."); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                throw new IOException("Synthetic connection cancelled.");
            }
            return body;
        }
        @Override public void disconnect() { disconnected = true; aborted.countDown(); }
        @Override public void connect() { }
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { return "synthetic"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
    }
}
