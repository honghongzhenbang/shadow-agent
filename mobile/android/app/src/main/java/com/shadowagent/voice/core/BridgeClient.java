package com.shadowagent.voice.core;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.UUID;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;

/** No global TLS changes, redirects, DNS, proxy, cloud fallback, or response-body error logging. */
public final class BridgeClient implements RecordingTransport {
    private final String baseUrl;
    private final String bridgeId;
    private final String token;
    private final SSLSocketFactory sockets;
    private final HostnameVerifier hostnameVerifier;
    private final TransportGuard operations = new TransportGuard();
    private final ConnectionFactory connections;

    public BridgeClient(JSONObject pairing, String endpoint) throws Exception {
        this(pairing, endpoint, url -> (HttpsURLConnection) new URL(url).openConnection(Proxy.NO_PROXY));
    }

    interface ConnectionFactory { HttpsURLConnection open(String url) throws IOException; }

    BridgeClient(JSONObject pairing, String endpoint, ConnectionFactory connections) throws Exception {
        this.connections = connections;
        JSONObject valid = AppSettings.validatePairing(pairing.toString());
        baseUrl = BridgeIdentity.endpoint(endpoint);
        bridgeId = valid.getString("bridgeId");
        token = valid.getString("token");
        String serverName = valid.getString("serverName");
        TrustManager trust = PinnedBridgeTls.trustManager(valid.getString("certificateSha256"), serverName);
        hostnameVerifier = PinnedBridgeTls.hostnameVerifier(serverName);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[]{trust}, new SecureRandom());
        sockets = tls.getSocketFactory();
    }

    @Override public void health() throws IOException {
        try (TransportGuard.Operation operation = operations.begin(TransportGuard.HEALTH_MS)) {
            try {
                HttpsURLConnection connection = open("/v1/health", operation);
                connection.setRequestMethod("GET");
                BridgeFrames.identity(response(connection, operation), bridgeId);
                operation.check();
            } catch (IOException error) { operation.check(); throw error; }
        }
    }

    @Override public JSONObject upload(RecordingStore.Upload upload) throws IOException {
        try (TransportGuard.Operation operation = operations.begin(TransportGuard.UPLOAD_MS)) {
            try { return upload(upload, LosslessUpload.prepare(upload, operation), operation); }
            catch (IOException error) { operation.check(); throw error; }
        }
    }

    private JSONObject upload(RecordingStore.Upload upload, LosslessUpload compressed, TransportGuard.Operation operation)
            throws IOException {
        String boundary = "voice-" + UUID.randomUUID();
        byte[] manifest = upload.manifest.toString().getBytes(StandardCharsets.UTF_8);
        byte[] first = ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"manifest\"; filename=\"manifest.json\""
                + "\r\nContent-Type: application/json; charset=utf-8\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] second = ("\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\""
                + "\r\nContent-Type: audio/wav\r\nContent-Encoding: gzip\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] last = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII);
        HttpsURLConnection connection = open("/v1/recordings", operation);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        connection.setFixedLengthStreamingMode(first.length + (long) manifest.length + second.length + compressed.size + last.length);
        try (OutputStream output = operation.output(connection.getOutputStream()); FileInputStream audio = new FileInputStream(compressed.file)) {
            output.write(first);
            output.write(manifest);
            output.write(second);
            byte[] buffer = new byte[32768];
            int count;
            while ((count = audio.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            output.write(last);
        }
        JSONObject receipt = BridgeFrames.receipt(response(connection, operation), upload);
        operation.check();
        return receipt;
    }

    @Override public JSONObject status(RecordingStore.Upload recording) throws IOException {
        return completion("/v1/recordings/status", recording);
    }

    @Override public JSONObject cleanupAck(RecordingStore.Upload recording) throws IOException {
        return completion("/v1/recordings/cleanup-ack", recording);
    }

    private JSONObject completion(String path, RecordingStore.Upload recording) throws IOException {
        try (TransportGuard.Operation operation = operations.begin(TransportGuard.HEALTH_MS)) {
            try {
                HttpsURLConnection connection = open(path, operation);
                byte[] body = RecordingCompletion.request(recording).toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = operation.output(connection.getOutputStream())) { output.write(body); }
                JSONObject result = RecordingCompletion.validate(recording, response(connection, operation));
                operation.check();
                return result;
            } catch (IOException error) { operation.check(); throw error; }
        }
    }

    private HttpsURLConnection open(String path, TransportGuard.Operation operation) throws IOException {
        operation.check();
        if (!"/v1/health".equals(path) && !"/v1/recordings".equals(path)
                && !"/v1/recordings/status".equals(path) && !"/v1/recordings/cleanup-ack".equals(path))
            throw new IOException("Invalid bridge endpoint.");
        HttpsURLConnection connection = connections.open(baseUrl + path);
        operation.attach(connection::disconnect);
        connection.setSSLSocketFactory(sockets);
        connection.setHostnameVerifier(hostnameVerifier);
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout((int) TransportGuard.IDLE_MS);
        connection.setUseCaches(false);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        return connection;
    }

    private JSONObject response(HttpsURLConnection connection, TransportGuard.Operation operation) throws IOException {
        int code = connection.getResponseCode();
        if (code == 401 || code == 403) throw BridgeHealth.failure(BridgeHealth.State.UNAUTHORIZED);
        if (code < 200 || code >= 300) throw BridgeHealth.failure(BridgeHealth.State.INVALID_RESPONSE);
        operation.progress();
        try (InputStream input = operation.input(connection.getInputStream()); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (bytes.size() + read > 65536) throw BridgeHealth.failure(BridgeHealth.State.INVALID_RESPONSE);
                bytes.write(buffer, 0, read);
            }
            return BridgeFrames.parse(bytes.toByteArray());
        }
    }

    @Override public void close() { operations.close(); }
}
