using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace VoiceBridge;

internal sealed record DiagnosticStage(string Stage, string Status, string Code, string Message, string Suggestion);

internal sealed record DiagnosticReport(string Status, int TimeoutMs, IReadOnlyList<DiagnosticStage> Stages)
{
    public string Mode => "check";
    public string Scope => "local_pc_only";
    public string Transport => "direct_https_no_proxy_no_redirect";
    public string[] Limitations =>
    [
        "Local-PC success does not prove phone connectivity, BLE discovery, screen-off capture, upload or transcription.",
        "HTTP proxies are bypassed, not VPN/TUN routing. Proxy presence alone is not evidence of a VPN fault.",
        "Reads existing pairing only: no runtime lease, private-key import, ACL/network changes, microphone, upload or database access."
    ];
}

internal static class BridgeDiagnostics
{
    internal const int TimeoutMs = 5000;
    internal const int MaxHealthBytes = 4096;
    private static readonly string[] StageOrder =
        ["pairing", "localAddress", "https", "tlsPin", "tlsValidity", "tlsIdentity", "authentication", "health"];

    // Only isolated tests may replace the port/deadline. The production CLI always targets local loopback.
    public static async Task<DiagnosticReport> RunAsync(string runtimeRoot, int? testPort = null, int timeoutMs = TimeoutMs)
    {
        if (timeoutMs is < 1 or > TimeoutMs || testPort is < 1 or > 65535) throw new ArgumentOutOfRangeException();
        var stages = new List<DiagnosticStage>();
        DiagnosticStage[] tls = [];
        DiagnosticReport Finish() => Report(stages.Concat(tls), timeoutMs);

        PairingConfig config;
        try
        {
            config = Pairing.LoadConfig(runtimeRoot);
            stages.Add(Pass("pairing", "pairing_valid", "Existing pairing configuration is readable and valid; private key was not opened."));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException or
            JsonException or ArgumentException or ClientFault)
        {
            var missing = ex is FileNotFoundException or DirectoryNotFoundException;
            stages.Add(Fail("pairing", missing ? "pairing_missing" : "pairing_unreadable_or_invalid",
                "Existing pairing could not be read or validated.",
                "Verify --runtime-root and the current user's access to bridge/pairing.json. Do not print its contents or silently regenerate pairing."));
            return Finish();
        }

        var uri = new UriBuilder(Uri.UriSchemeHttps, "127.0.0.1", testPort ?? 8787).Uri;
        stages.Add(Pass("localAddress", "loopback_only",
            "The check targets this PC's 127.0.0.1 loopback only; success does not prove phone reachability or LAN binding."));
        using var handler = new HttpClientHandler
        {
            UseProxy = false,
            AllowAutoRedirect = false,
            UseCookies = false,
            MaxResponseHeadersLength = 8,
            CheckCertificateRevocationList = false,
            ServerCertificateCustomValidationCallback = (_, certificate, _, _) =>
            {
                tls = ValidateCertificate(certificate, config.CertificateSha256, config.ServerName);
                return tls.All(stage => stage.Status == "passed");
            }
        };
        using var client = new HttpClient(handler) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        using var deadline = new CancellationTokenSource(timeoutMs);
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(uri, "/v1/health"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        var stage = "https";
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            stages.Add(Pass("https", "direct_https_response", "A direct HTTPS response was received without an HTTP proxy or redirect."));
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                stages.Add(Fail("authentication", "credentials_rejected", "The health endpoint rejected the saved credential.",
                    "Confirm the running receiver uses the same private pairing directory. Re-import the correct pairing explicitly; never paste the token into logs."));
                return Finish();
            }
            if (response.StatusCode != HttpStatusCode.OK)
            {
                var redirect = (int)response.StatusCode is >= 300 and < 400;
                stages.Add(Fail("health", redirect ? "redirect_refused" : "unexpected_http_status",
                    $"The health endpoint returned HTTP {(int)response.StatusCode}; the response body was not read.",
                    "Verify the local loopback listener is the intended receiver and inspect its status. Redirects are never followed."));
                return Finish();
            }
            stages.Add(Pass("authentication", "credentials_accepted", "The health endpoint returned HTTP 200 for the saved credential."));
            stage = "health";
            using var health = await ReadHealthAsync(response.Content, deadline.Token);
            var body = health.RootElement;
            if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True ||
                !body.TryGetProperty("bridgeId", out var bridgeId) || bridgeId.ValueKind != JsonValueKind.String)
                stages.Add(Fail("health", "invalid_health", "The response is not a successful bridge health object.",
                    "Confirm the listener is the expected Voice Bridge version; response contents are deliberately omitted."));
            else if (!string.Equals(bridgeId.GetString(), config.BridgeId, StringComparison.Ordinal))
                stages.Add(Fail("health", "bridge_id_mismatch", "The health bridgeId does not match the saved pairing.",
                    "Confirm the correct receiver and runtime directory before explicitly re-pairing. Do not upload to this identity."));
            else if (!body.TryGetProperty("utc", out var utc) || utc.ValueKind != JsonValueKind.String ||
                !utc.TryGetDateTimeOffset(out _) || !HasTimeZone(utc.GetString()!))
                stages.Add(Fail("health", "invalid_health", "The health response lacks a valid timestamp with a time zone.",
                    "Confirm the receiver's protocol version; the Android client requires the same health timestamp."));
            else
                stages.Add(Pass("health", "bridge_id_verified", "Health reports ok=true, the expected bridgeId and a valid zoned timestamp. No recording was sent."));
        }
        catch (OperationCanceledException)
        {
            stages.Add(Fail(stage, "timeout", "The bounded HTTPS/health deadline expired.",
                "Check receiver responsiveness on local loopback port 8787. Inspect routing or filtering only with evidence; do not infer a VPN fault from proxy presence."));
        }
        catch (HttpRequestException)
        {
            var rejected = tls.Any(result => result.Status == "failed");
            stages.Add(Fail(stage, rejected ? "tls_rejected" : "connection_failed",
                rejected ? "TLS verification rejected the peer certificate; no HTTP credential was sent." : "The direct HTTPS request could not complete.",
                rejected ? "Resolve the failed TLS checks below; never disable pin, validity or stable DNS identity verification." :
                    "Confirm the receiver accepts local loopback connections on port 8787 (production default: 0.0.0.0:8787). This failure alone does not identify VPN or firewall as the cause."));
        }
        catch (JsonException)
        {
            stages.Add(Fail("health", "invalid_health", "The health response is not valid bounded JSON.",
                "Confirm the expected receiver and inspect its local status; response contents are deliberately omitted."));
        }
        catch (InvalidDataException)
        {
            stages.Add(Fail(stage, "health_too_large",
                "The health response could not be safely read within the size limit.",
                "Confirm the expected receiver and retry after checking its status; response contents are deliberately omitted."));
        }
        catch (IOException)
        {
            stages.Add(Fail(stage, "response_read_failed", "The health response could not be completely read.",
                "Check receiver responsiveness and retry; response contents are deliberately omitted."));
        }
        return Finish();
    }

    private static bool HasTimeZone(string value) => value.EndsWith('Z') ||
        (value.Length >= 6 && value[^6] is '+' or '-' && value[^3] == ':');

    private static DiagnosticStage[] ValidateCertificate(X509Certificate2? certificate, string pin, string serverName)
    {
        if (certificate is null)
            return [Fail("tlsPin", "certificate_missing", "The peer supplied no certificate.", "Verify the intended receiver's HTTPS listener.")];
        var now = DateTime.UtcNow;
        var pinMatches = string.Equals(Pairing.Fingerprint(certificate), pin, StringComparison.OrdinalIgnoreCase);
        var valid = now >= certificate.NotBefore.ToUniversalTime() && now < certificate.NotAfter.ToUniversalTime();
        var matchesIdentity = false;
        try
        {
            // Loopback is only the route. The pin replaces public-chain trust, and the exact stable DNS SAN
            // replaces URL-host matching; both identity and validity remain mandatory before sending credentials.
            matchesIdentity = Pairing.MatchesServerName(certificate, serverName);
        }
        catch (CryptographicException) { }
        return
        [
            pinMatches ? Pass("tlsPin", "pin_verified", "The peer certificate SHA-256 matches the saved pin.") :
                Fail("tlsPin", "pin_mismatch", "The peer certificate does not match the saved pin.", "Verify receiver identity and re-pair explicitly if its certificate was intentionally changed."),
            valid ? Pass("tlsValidity", "certificate_current", "The peer certificate is within its validity period according to the PC clock.") :
                Fail("tlsValidity", now < certificate.NotBefore.ToUniversalTime() ? "certificate_not_yet_valid" : "certificate_expired",
                    "The peer certificate is outside its validity period.", "Verify the PC clock. An expired or replaced certificate requires deliberate re-pairing, not bypassed validation."),
            matchesIdentity ? Pass("tlsIdentity", "server_name_verified", "The peer certificate DNS SAN exactly matches the saved stable ServerName.") :
                Fail("tlsIdentity", "server_name_mismatch", "The peer certificate DNS SAN does not exactly match the saved stable ServerName.",
                    "Verify the saved bridge identity and receiver certificate; loopback routing never replaces DNS identity verification.")
        ];
    }

    private static async Task<JsonDocument> ReadHealthAsync(HttpContent content, CancellationToken ct)
    {
        if (content.Headers.ContentLength > MaxHealthBytes) throw new InvalidDataException();
        using var stream = await content.ReadAsStreamAsync(ct);
        var bytes = new byte[MaxHealthBytes + 1];
        var length = 0;
        while (length < bytes.Length)
        {
            var read = await stream.ReadAsync(bytes.AsMemory(length), ct);
            if (read == 0) return JsonDocument.Parse(bytes.AsMemory(0, length), new JsonDocumentOptions { MaxDepth = 16 });
            length += read;
        }
        throw new InvalidDataException();
    }

    internal static DiagnosticReport EntryFailure(bool invalidOptions) => Report(
        [Fail(invalidOptions ? "arguments" : "check", invalidOptions ? "invalid_options" : "check_failed", "The read-only check could not start or complete.",
            "Use --check with only --repo-root/--runtime-root as needed. Verify local access and the isolated build; no raw exception or private data is printed.")], TimeoutMs);

    private static DiagnosticReport Report(IEnumerable<DiagnosticStage> results, int timeoutMs)
    {
        var stages = results.ToArray();
        var passed = !stages.Any(result => result.Status == "failed") &&
            StageOrder.All(name => stages.Any(result => result.Stage == name && result.Status == "passed"));
        return new(passed ? "passed" : "failed", timeoutMs,
            stages.Where(result => !StageOrder.Contains(result.Stage)).Concat(StageOrder.Select(name =>
                stages.FirstOrDefault(result => result.Stage == name) ?? new DiagnosticStage(name, "skipped", "not_checked",
                    "Not checked because an earlier prerequisite failed.", "Resolve the failed stage before retrying."))).ToArray());
    }

    private static DiagnosticStage Pass(string stage, string code, string message) => new(stage, "passed", code, message, "None.");
    private static DiagnosticStage Fail(string stage, string code, string message, string suggestion) => new(stage, "failed", code, message, suggestion);
}
