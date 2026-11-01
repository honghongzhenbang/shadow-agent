package com.shadowagent.voice.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.List;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.X509TrustManager;

/** Trust is fixed at pairing time; the IP in a BLE route is not a certificate identity. */
final class PinnedBridgeTls {
    static X509TrustManager trustManager(String pin, String serverName) {
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificates are not used.");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("Missing server certificate.");
                try {
                    chain[0].checkValidity();
                    if (!MessageDigest.isEqual(pin.getBytes(StandardCharsets.US_ASCII),
                            sha256(chain[0]).getBytes(StandardCharsets.US_ASCII)))
                        throw new CertificateException("Server certificate pin mismatch.");
                    // Also enforce SAN here: some HTTPS stacks skip a custom verifier when IP SAN matches.
                    if (!hasExactDnsSan(chain[0], serverName)) throw new CertificateException("Server DNS SAN mismatch.");
                } catch (CertificateException e) { throw e; }
                catch (Exception e) { throw new CertificateException("Cannot validate pinned certificate."); }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
    }

    static HostnameVerifier hostnameVerifier(String serverName) {
        return (ignoredRouteHost, session) -> {
            try {
                java.security.cert.Certificate[] peer = session.getPeerCertificates();
                return peer.length > 0 && peer[0] instanceof X509Certificate
                        && hasExactDnsSan((X509Certificate) peer[0], serverName);
            } catch (Exception invalid) { return false; }
        };
    }

    static boolean hasExactDnsSan(X509Certificate certificate, String serverName) throws CertificateException {
        Collection<List<?>> names = certificate.getSubjectAlternativeNames();
        if (names == null) return false;
        for (List<?> entry : names) {
            if (entry != null && entry.size() >= 2 && Integer.valueOf(2).equals(entry.get(0))
                    && entry.get(1) instanceof String && serverName.equalsIgnoreCase((String) entry.get(1))) return true;
        }
        return false;
    }

    static String sha256(X509Certificate certificate) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest) result.append(Character.forDigit((value & 0xff) >>> 4, 16))
                .append(Character.forDigit(value & 15, 16));
        return result.toString();
    }
}
