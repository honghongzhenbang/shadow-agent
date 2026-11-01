package com.shadowagent.voice.core;

import org.junit.Test;

import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.X509TrustManager;

import static org.junit.Assert.*;

/** Real synthetic X.509 public certificates only; no network, pairing secrets, or microphone. */
public final class PinnedBridgeTlsTest {
    private X509Certificate certificate(String fixture) throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/tls/" + fixture + ".pem")) {
            assertNotNull(input);
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
    }

    private SSLSession session(X509Certificate leaf) {
        return (SSLSession) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{SSLSession.class},
                (proxy, method, arguments) -> {
                    if (method.getName().equals("getPeerCertificates")) {
                        if (leaf == null) throw new SSLPeerUnverifiedException("No peer.");
                        return new Certificate[]{leaf};
                    }
                    throw new UnsupportedOperationException(method.getName());
                });
    }

    @Test public void samePinnedDnsIdentityAuthenticatesChangingIpRoutes() throws Exception {
        X509Certificate leaf = certificate("valid");
        X509TrustManager trust = PinnedBridgeTls.trustManager(PinnedBridgeTls.sha256(leaf), PairingFixture.NAME);
        trust.checkServerTrusted(new X509Certificate[]{leaf}, "RSA");
        HostnameVerifier verifier = PinnedBridgeTls.hostnameVerifier(PairingFixture.NAME);
        assertTrue(verifier.verify("192.168.1.20", session(leaf)));
        assertTrue(verifier.verify("10.0.0.30", session(leaf)));
    }

    @Test public void wrongPinIsRejectedEvenWithCorrectSan() throws Exception {
        X509Certificate leaf = certificate("valid");
        X509TrustManager trust = PinnedBridgeTls.trustManager("0".repeat(64), PairingFixture.NAME);
        assertThrows(CertificateException.class, () -> trust.checkServerTrusted(new X509Certificate[]{leaf}, "RSA"));
    }

    @Test public void correctPinCannotBypassWrongSanWildcardOrCnOnly() throws Exception {
        for (String fixture : new String[]{"wrong-san", "wildcard", "cn-only"}) {
            X509Certificate leaf = certificate(fixture);
            X509TrustManager trust = PinnedBridgeTls.trustManager(PinnedBridgeTls.sha256(leaf), PairingFixture.NAME);
            assertThrows(fixture, CertificateException.class, () -> trust.checkServerTrusted(new X509Certificate[]{leaf}, "RSA"));
            assertFalse(PinnedBridgeTls.hostnameVerifier(PairingFixture.NAME).verify("192.168.1.20", session(leaf)));
        }
    }

    @Test public void correctPinAndSanCannotBypassCertificateValidity() throws Exception {
        for (String fixture : new String[]{"expired", "future"}) {
            X509Certificate leaf = certificate(fixture);
            assertTrue(PinnedBridgeTls.hasExactDnsSan(leaf, PairingFixture.NAME));
            X509TrustManager trust = PinnedBridgeTls.trustManager(PinnedBridgeTls.sha256(leaf), PairingFixture.NAME);
            assertThrows(CertificateException.class, () -> trust.checkServerTrusted(new X509Certificate[]{leaf}, "RSA"));
        }
    }

    @Test public void missingPeerAndSuffixNamesNeverAuthenticate() throws Exception {
        X509Certificate leaf = certificate("valid");
        assertFalse(PinnedBridgeTls.hostnameVerifier(PairingFixture.NAME).verify("192.168.1.20", session(null)));
        assertFalse(PinnedBridgeTls.hostnameVerifier(PairingFixture.NAME + ".evil").verify("192.168.1.20", session(leaf)));
        X509TrustManager trust = PinnedBridgeTls.trustManager(PinnedBridgeTls.sha256(leaf), PairingFixture.NAME);
        assertThrows(CertificateException.class, () -> trust.checkServerTrusted(null, "RSA"));
        assertThrows(CertificateException.class, () -> trust.checkServerTrusted(new X509Certificate[0], "RSA"));
        assertThrows(CertificateException.class, () -> trust.checkClientTrusted(new X509Certificate[]{leaf}, "RSA"));
    }
}
