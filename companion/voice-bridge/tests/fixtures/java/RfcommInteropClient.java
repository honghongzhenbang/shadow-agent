package com.shadowagent.voice.core;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.Closeable;
import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;

/** Desktop JVM interoperability only; uses the unchanged Android protocol classes, not Android APIs. */
public final class RfcommInteropClient {
    public static void main(String[] args) throws Exception {
        JSONObject config = new JSONObject(Files.readString(Path.of(args[0])));
        JSONObject pairing = AppSettings.validatePairing(config.getJSONObject("pairing").toString());
        int port = config.getInt("port");
        require(port != 8787 && port != 25576 && port > 0, "Expected an isolated test port.");
        JSONObject result = new JSONObject();
        result.put("wrongPinRejected", rejected(pairing, port, "0".repeat(64), pairing.getString("serverName"), false));
        result.put("wrongSanRejected", rejected(pairing, port, pairing.getString("certificateSha256"), "other-bridge.local", false));
        result.put("wrongTokenRejected", rejected(pairing, port, pairing.getString("certificateSha256"), pairing.getString("serverName"), true));
        JSONArray uploads = new JSONArray();
        JSONArray cases = config.getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject item = cases.getJSONObject(i);
            File directory = new File(item.getString("directory"));
            JSONObject manifest = new JSONObject(Files.readString(new File(directory, "manifest.json").toPath()));
            RecordingStore.Upload upload = new RecordingStore.Upload(directory, manifest);
            String originalHash = RecordingStore.sha256(upload.audio);
            String protocol = item.getString("protocol");
            JSONObject receipt;
            String cipher;
            LosslessUpload compressed;
            try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(30000);
                 Connection connection = new Connection(pairing, port, protocol, pairing.getString("certificateSha256"), pairing.getString("serverName"))) {
                operation.attach(connection);
                compressed = LosslessUpload.prepare(upload, operation);
                require(compressed.size > BridgeFrames.MAX_CHUNK_BYTES, "Fixture must exercise multiple chunks.");
                connection.session.authenticate(pairing.getString("token"), pairing.getString("bridgeId"));
                connection.session.health(pairing.getString("bridgeId"));
                receipt = connection.session.upload(upload, compressed, operation);
                require(protocol.equals(connection.engine.getSession().getProtocol()), "TLS protocol changed.");
                cipher = connection.engine.getSession().getCipherSuite();
            }
            // Reconnect with the same identity to exercise the persisted-receipt begin path.
            try (TransportGuard guard = new TransportGuard(); TransportGuard.Operation operation = guard.begin(30000);
                 Connection connection = new Connection(pairing, port, protocol, pairing.getString("certificateSha256"), pairing.getString("serverName"))) {
                operation.attach(connection);
                connection.session.authenticate(pairing.getString("token"), pairing.getString("bridgeId"));
                JSONObject duplicate = connection.session.upload(upload, compressed, operation);
                require(receipt.similar(duplicate), "Receipt changed on retry.");
            }
            require(originalHash.equals(RecordingStore.sha256(upload.audio)), "Original audio was modified.");
            uploads.put(new JSONObject().put("protocol", protocol).put("cipher", cipher)
                    .put("rawBytes", upload.audio.length()).put("compressedBytes", compressed.size)
                    .put("receipt", receipt).put("duplicateReceipt", true));
        }
        result.put("uploads", uploads);
        System.out.println(result);
    }

    private static boolean rejected(JSONObject pairing, int port, String pin, String name, boolean badToken) throws Exception {
        try (Connection connection = new Connection(pairing, port, "TLSv1.2", pin, name)) {
            if (badToken) connection.session.authenticate("synthetic-wrong-token", pairing.getString("bridgeId"));
            throw new AssertionError("Expected identity rejection.");
        } catch (IOException error) {
            require(BridgeHealth.classify(error) == (badToken ? BridgeHealth.State.UNAUTHORIZED : BridgeHealth.State.CERTIFICATE),
                    "Unexpected rejection category.");
            return true;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class Connection implements Closeable {
        final SSLEngine engine;
        final TlsEngineStream tls;
        final RfcommSession session;

        Connection(JSONObject pairing, int port, String protocol, String pin, String name) throws Exception {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{PinnedBridgeTls.trustManager(pin, name)}, null);
            engine = context.createSSLEngine(pairing.getString("serverName"), -1);
            engine.setUseClientMode(true);
            engine.setEnabledProtocols(new String[]{protocol});
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 5000);
                socket.setSoTimeout(10000);
                socket.setTcpNoDelay(true);
                // Arbitrary reads ensure neither peer depends on TCP/TLS record boundaries.
                FilterInputStream fragmented = new FilterInputStream(socket.getInputStream()) {
                    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                        return in.read(bytes, offset, Math.min(length, 113));
                    }
                };
                tls = new TlsEngineStream(engine, fragmented, socket.getOutputStream(), socket);
                tls.handshake();
                session = new RfcommSession(new BridgeFrames(tls.input(), tls.output()));
            } catch (Exception failure) { socket.close(); throw failure; }
        }

        @Override public void close() throws IOException { tls.close(); }
    }
}
