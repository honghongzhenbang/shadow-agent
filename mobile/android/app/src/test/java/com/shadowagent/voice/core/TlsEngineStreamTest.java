package com.shadowagent.voice.core;

import org.junit.BeforeClass;
import org.junit.ClassRule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileInputStream;
import java.io.EOFException;
import java.io.FilterInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;

import static org.junit.Assert.*;

/** Ephemeral keys, synthetic bytes, loopback only. Uses a real JSSE socket as the TLS peer. */
public final class TlsEngineStreamTest {
    @ClassRule public static TemporaryFolder folder = new TemporaryFolder();
    private static Fixture valid;
    private static Fixture wrongSan;
    private static Fixture expired;
    private static Fixture future;

    @BeforeClass public static void fixtures() throws Exception {
        valid = fixture("valid", PairingFixture.NAME, "2000/01/01", 36500);
        wrongSan = fixture("wrong-san", "other-bridge.local", "2000/01/01", 36500);
        expired = fixture("expired", PairingFixture.NAME, "2000/01/01", 1);
        future = fixture("future", PairingFixture.NAME, "2100/01/01", 1);
    }

    @Test public void tls12And13HandleFragmentedRecordsLargeWritesAndCloseNotify() throws Exception {
        byte[] payload = new byte[180000];
        new Random(127).nextBytes(payload);
        for (String protocol : new String[]{"TLSv1.2", "TLSv1.3"}) {
            try (Loopback peer = new Loopback(valid, protocol, socket -> {
                byte[] received = socket.getInputStream().readNBytes(payload.length);
                assertArrayEquals(payload, received);
                socket.getOutputStream().write(received);
                socket.getOutputStream().flush();
            }); TlsEngineStream client = peer.client(valid.pin(), 43, 113)) {
                client.handshake();
                client.output().write(payload);
                assertArrayEquals(protocol, payload, client.input().readNBytes(payload.length));
                assertEquals(-1, client.input().read());
                peer.result.get(10, TimeUnit.SECONDS);
            }
        }
    }

    @Test public void postHandshakeServerDataAndSequentialApplicationFramesStayIntact() throws Exception {
        byte[] greeting = "synthetic-server-greeting".getBytes(StandardCharsets.US_ASCII);
        try (Loopback peer = new Loopback(valid, "TLSv1.3", socket -> {
            socket.getOutputStream().write(greeting);
            socket.getOutputStream().flush();
            BridgeFrames frames = new BridgeFrames(socket.getInputStream(), socket.getOutputStream());
            assertEquals("auth", frames.read().getString("op"));
            frames.write(BridgeFrames.object("ok", true, "bridgeId", PairingFixture.BRIDGE, "utc", "2026-10-16T00:00:00Z"));
            assertEquals("health", frames.read().getString("op"));
            frames.write(BridgeFrames.object("ok", true, "bridgeId", PairingFixture.BRIDGE, "utc", "2026-10-16T00:00:00Z"));
        }); TlsEngineStream client = peer.client(valid.pin(), 7, 17)) {
            client.handshake();
            assertArrayEquals(greeting, client.input().readNBytes(greeting.length));
            RfcommSession session = new RfcommSession(new BridgeFrames(client.input(), client.output()));
            session.authenticate("synthetic-token", PairingFixture.BRIDGE);
            session.health(PairingFixture.BRIDGE);
            peer.result.get(10, TimeUnit.SECONDS);
        }
    }

    @Test public void wrongPinSanAndCertificateDatesFailBeforeAnyAuthBytes() throws Exception {
        for (Fixture fixture : new Fixture[]{valid, wrongSan, expired, future}) {
            AtomicInteger received = new AtomicInteger();
            try (Loopback peer = new Loopback(fixture, "TLSv1.3", socket -> {
                int value = socket.getInputStream().read();
                if (value >= 0) received.incrementAndGet();
            }); TlsEngineStream client = peer.client(fixture == valid ? "0".repeat(64) : fixture.pin(), 19, 29)) {
                IOException error = assertThrows(IOException.class, () -> {
                    client.handshake();
                    client.output().write("auth-must-not-be-sent".getBytes(StandardCharsets.US_ASCII));
                });
                assertEquals(BridgeHealth.State.CERTIFICATE, BridgeHealth.classify(error));
                assertEquals(0, received.get());
            }
        }
    }

    @Test public void closingFromAnotherThreadUnblocksReadWithoutWaitingForPeer() throws Exception {
        CountDownLatch serverReady = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (Loopback peer = new Loopback(valid, "TLSv1.2", socket -> {
            serverReady.countDown();
            assertTrue(release.await(10, TimeUnit.SECONDS));
        }); TlsEngineStream client = peer.client(valid.pin(), 4096, 4096)) {
            client.handshake();
            assertTrue(serverReady.await(3, TimeUnit.SECONDS));
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                CountDownLatch reading = new CountDownLatch(1);
                Future<?> result = worker.submit(() -> {
                    reading.countDown();
                    assertThrows(IOException.class, () -> client.input().read());
                });
                assertTrue(reading.await(3, TimeUnit.SECONDS));
                client.close();
                result.get(3, TimeUnit.SECONDS);
            } finally { release.countDown(); worker.shutdownNow(); }
        } finally { release.countDown(); }
    }

    @Test public void abruptEofIsNotAcceptedAsCleanTlsClose() throws Exception {
        CountDownLatch abort = new CountDownLatch(1);
        try (Loopback peer = new Loopback(valid, "TLSv1.2", socket -> {
            socket.getOutputStream().write(42);
            socket.getOutputStream().flush();
            assertTrue(abort.await(5, TimeUnit.SECONDS));
        }); TlsEngineStream client = peer.client(valid.pin(), 4096, 4096)) {
            client.handshake();
            assertEquals(42, client.input().read());
            // Simulate transport EOF while the TLS peer is still waiting, without close_notify.
            peer.eof = true;
            EOFException error = assertThrows(EOFException.class, () -> client.input().read());
            assertEquals(BridgeHealth.State.FAILED, BridgeHealth.classify(error));
            abort.countDown();
        } finally { abort.countDown(); }
    }

    private interface Handler { void run(SSLSocket socket) throws Exception; }

    private static final class Loopback implements AutoCloseable {
        final SSLServerSocket listener;
        final ExecutorService worker = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "synthetic-tls-peer"); thread.setDaemon(true); return thread;
        });
        final Future<?> result;
        volatile SSLSocket accepted;
        volatile boolean eof;
        Socket raw;

        Loopback(Fixture fixture, String protocol, Handler handler) throws Exception {
            listener = (SSLServerSocket) fixture.context.getServerSocketFactory().createServerSocket(0, 1, InetAddress.getLoopbackAddress());
            listener.setEnabledProtocols(new String[]{protocol});
            result = worker.submit(() -> {
                try (SSLSocket socket = (SSLSocket) listener.accept()) {
                    accepted = socket;
                    socket.setSoTimeout(5000);
                    socket.setTcpNoDelay(true);
                    socket.startHandshake();
                    handler.run(socket);
                    return null;
                }
            });
        }

        TlsEngineStream client(String pin, int readFragment, int writeFragment) throws Exception {
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{PinnedBridgeTls.trustManager(pin, PairingFixture.NAME)}, null);
            SSLEngine engine = context.createSSLEngine(PairingFixture.NAME, -1);
            engine.setUseClientMode(true);
            raw = new Socket(InetAddress.getLoopbackAddress(), listener.getLocalPort());
            raw.setSoTimeout(5000);
            raw.setTcpNoDelay(true);
            InputStream input = new FilterInputStream(raw.getInputStream()) {
                @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                    if (eof) return -1;
                    return in.read(bytes, offset, Math.min(length, readFragment));
                }
            };
            OutputStream output = new FilterOutputStream(raw.getOutputStream()) {
                @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                    while (length > 0) {
                        int count = Math.min(length, writeFragment);
                        out.write(bytes, offset, count);
                        offset += count; length -= count;
                    }
                }
            };
            return new TlsEngineStream(engine, input, output, raw::close);
        }

        @Override public void close() throws Exception {
            if (raw != null) raw.close();
            if (accepted != null) accepted.close();
            listener.close();
            result.cancel(true);
            worker.shutdownNow();
            assertTrue(worker.awaitTermination(3, TimeUnit.SECONDS));
        }
    }

    private static final class Fixture {
        final SSLContext context;
        final X509Certificate certificate;
        Fixture(SSLContext context, X509Certificate certificate) { this.context = context; this.certificate = certificate; }
        String pin() throws Exception { return PinnedBridgeTls.sha256(certificate); }
    }

    private static Fixture fixture(String name, String san, String start, int days) throws Exception {
        File store = new File(folder.getRoot(), name + ".p12");
        String keytool = new File(System.getProperty("java.home"), "bin/keytool"
                + (System.getProperty("os.name").startsWith("Windows") ? ".exe" : "")).getAbsolutePath();
        String password = "synthetic-test-only";
        File log = folder.newFile(name + ".keytool.log");
        Process process = null;
        try {
            process = new ProcessBuilder(keytool, "-genkeypair", "-alias", "loopback", "-keyalg", "RSA",
                    "-keysize", "2048", "-storetype", "PKCS12", "-keystore", store.getAbsolutePath(),
                    "-storepass", password, "-keypass", password, "-dname", "CN=synthetic-loopback",
                    "-ext", "SAN=dns:" + san, "-startdate", start, "-validity", Integer.toString(days), "-noprompt")
                    .redirectErrorStream(true).redirectOutput(log).start();
            if (!process.waitFor(30, TimeUnit.SECONDS))
                throw new IOException("Synthetic certificate generation timed out.");
            assertEquals("Synthetic keytool fixture failed", 0, process.exitValue());
        } finally {
            if (process != null && process.isAlive()) { process.destroyForcibly(); process.waitFor(); }
            Files.deleteIfExists(log.toPath());
        }
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (FileInputStream input = new FileInputStream(store)) { keys.load(input, password.toCharArray()); }
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(keys, password.toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(managers.getKeyManagers(), null, null);
        return new Fixture(context, (X509Certificate) keys.getCertificate("loopback"));
    }
}
