using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace VoiceBridge;

internal sealed record PairingConfig(int SchemaVersion, string BridgeId, string ServiceUuid,
    string IdentityCharacteristicUuid, string ServerName, string Token, string CertificateSha256);

internal sealed class Pairing(PairingConfig config, X509Certificate2 certificate) : IDisposable
{
    public PairingConfig Config { get; } = config;
    public X509Certificate2 Certificate { get; } = certificate;

    public static string ConfigPath(string runtimeRoot) => Path.Combine(runtimeRoot, "bridge", "pairing.json");

    public static Pairing Setup(string root, string? bridgeId)
    {
        var destination = Path.Combine(root, "bridge");
        if (Directory.Exists(destination))
        {
            var existing = Load(root);
            if (bridgeId is not null && Protocol.Uuid(bridgeId, "bridgeId") != existing.Config.BridgeId)
            {
                existing.Dispose();
                throw new InvalidOperationException("Pairing already exists; changing identity requires an explicit new pairing directory and phone re-pairing.");
            }
            return existing;
        }
        var id = Protocol.Uuid(bridgeId ?? Guid.NewGuid().ToString("D"), "bridgeId");
        var serverName = ServerName(id);
        using var rsa = RSA.Create(3072);
        var request = new CertificateRequest($"CN=Voice Bridge {id}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName(serverName);
        request.CertificateExtensions.Add(san.Build());
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(2));
        var pairing = new PairingConfig(2, id, Protocol.ServiceUuid, Protocol.IdentityCharacteristicUuid,
            serverName, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(), Fingerprint(certificate));
        var temporary = Path.Combine(root, ".bridge-" + Guid.NewGuid().ToString("N") + ".staging");
        Paths.PrivateDirectory(temporary);
        try
        {
            DurableFiles.WriteNew(Path.Combine(temporary, "certificate.pfx"), certificate.Export(X509ContentType.Pfx, ""));
            DurableFiles.WriteJsonNew(Path.Combine(temporary, "pairing.json"), pairing);
            DurableFiles.Move(temporary, destination);
        }
        finally { DurableFiles.RemoveStage(temporary, "certificate.pfx", "pairing.json"); }
        return Load(root);
    }

    public static PairingConfig LoadConfig(string root)
    {
        var config = DurableFiles.ReadJson<PairingConfig>(ConfigPath(root));
        if (config.SchemaVersion != 2 || config.BridgeId != Protocol.Uuid(config.BridgeId, "bridgeId") ||
            config.ServiceUuid != Protocol.ServiceUuid || config.IdentityCharacteristicUuid != Protocol.IdentityCharacteristicUuid ||
            config.ServerName != ServerName(config.BridgeId) ||
            !IsHex(config.Token, 64) || !IsHex(config.CertificateSha256, 64)) throw new IOException("Invalid pairing configuration.");
        return config;
    }

    public static Pairing Load(string root)
    {
        var config = LoadConfig(root);
        var certPath = Path.Combine(root, "bridge", "certificate.pfx");
        Paths.RejectLinks(certPath);
        // Windows Schannel cannot use EphemeralKeySet. UserKeySet is cleaned up on disposal;
        // the only intentionally persisted key is the ACL-protected PFX, not a trusted-root install.
        var certificate = new X509Certificate2(certPath, "", X509KeyStorageFlags.UserKeySet);
        if (!certificate.HasPrivateKey || !string.Equals(Fingerprint(certificate), config.CertificateSha256, StringComparison.OrdinalIgnoreCase) ||
            DateTime.UtcNow < certificate.NotBefore.ToUniversalTime() || DateTime.UtcNow >= certificate.NotAfter.ToUniversalTime() ||
            !MatchesServerName(certificate, config.ServerName))
        {
            certificate.Dispose();
            throw new IOException("Pairing certificate is missing its key, expired, or does not match the saved pin; re-pair explicitly.");
        }
        return new(config, certificate);
    }

    internal static bool IsHex(string? value, int length) => value is not null && value.Length == length && value.All(Uri.IsHexDigit);
    internal static string ServerName(string bridgeId) => "voice-" + Protocol.Uuid(bridgeId, "bridgeId") + ".local";
    internal static bool MatchesServerName(X509Certificate2 certificate, string serverName)
    {
        var san = certificate.Extensions["2.5.29.17"];
        return san is not null && new X509SubjectAlternativeNameExtension(san.RawData).EnumerateDnsNames()
            .Any(name => string.Equals(name, serverName, StringComparison.OrdinalIgnoreCase));
    }
    internal static string Fingerprint(X509Certificate2 cert) => Convert.ToHexString(SHA256.HashData(cert.RawData)).ToLowerInvariant();
    public void Dispose() => Certificate.Dispose();
}
