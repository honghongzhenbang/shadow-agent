using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace VoiceBridge.Tests;

internal static class BridgeDiagnosticsTests
{
    private const string ResponseSecret = "private-response-marker-must-not-be-printed";
    public static readonly (string Name, Func<Task> Run)[] Cases =
    [
        ("check: stable DNS identity over loopback, proxy bypass, no private-key read or runtime/ACL changes", ReadOnlySuccess),
        ("check: missing, malformed and invalid private pairing", PairingFailures),
        ("check: schema 2 exact ServerName constraints and legacy schema rejection", PairingIdentityFailures),
        ("check: TLS pin, exact DNS SAN, expired and future certificates", TlsFailures),
        ("check: wrong credentials and health identity", IdentityFailures),
        ("check: malformed/oversized health and redirects are rejected without disclosure", HealthFailures),
        ("check: refused connection and bounded TLS/header/body waits", ReachabilityFailures),
        ("check: CLI scope, structured errors and no implicit setup", EntryPoint)
    ];

    private static async Task ReadOnlySuccess()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        Check.Equal(2, f.Pairing.Config.SchemaVersion);
        Check.Equal($"voice-{f.Pairing.Config.BridgeId}.local", f.Pairing.Config.ServerName);
        var san = new X509SubjectAlternativeNameExtension(f.Pairing.Certificate.Extensions["2.5.29.17"]!.RawData);
        Check.True(san.EnumerateDnsNames().Contains(f.Pairing.Config.ServerName));
        Check.True(!san.EnumerateIPAddresses().Any(), "The stable certificate must not depend on a routing IP SAN.");
        // The receiver already loaded its certificate. Check must work without reading the stored PFX.
        var keyPath = Path.Combine(root.Runtime, "bridge", "certificate.pfx");
        File.WriteAllText(keyPath, ResponseSecret);
        var before = Snapshot(root.Runtime);
        var originalProxy = HttpClient.DefaultProxy;
        var rejectingProxy = new RejectingProxy();
        DiagnosticReport report;
        try
        {
            HttpClient.DefaultProxy = rejectingProxy;
            using var lockedKey = new FileStream(keyPath, FileMode.Open, FileAccess.Read, FileShare.None);
            report = await BridgeDiagnostics.RunAsync(root.Runtime, Port(f));
        }
        finally { HttpClient.DefaultProxy = originalProxy; }
        Check.Equal(0, rejectingProxy.Calls, "Check must bypass the HTTP proxy entirely.");
        Check.Equal("passed", report.Status);
        Check.True(report.Stages.All(stage => stage.Status == "passed"));
        AssertStage(report, "localAddress", "passed", "loopback_only");
        Check.True(report.Stages.Single(stage => stage.Stage == "localAddress").Message.Contains("does not prove phone reachability"));
        AssertStage(report, "tlsIdentity", "passed", "server_name_verified");
        Check.True(report.Stages.All(stage => stage.Stage != "tlsIpHostname"));
        AssertStage(report, "health", "passed", "bridge_id_verified");
        Check.Equal(BridgeDiagnostics.TimeoutMs, report.TimeoutMs);
        Check.Equal(before, Snapshot(root.Runtime));
        Check.Equal(0, f.Store.Entries().Count());
        Check.True(!File.Exists(root.Options.Database));
        AssertRedacted(report, f.Pairing.Config);
        File.Delete(keyPath);
        var missingBefore = Snapshot(root.Runtime);
        var missingKey = await BridgeDiagnostics.RunAsync(root.Runtime, Port(f));
        Check.Equal("passed", missingKey.Status, "Check must also work when the private-key file is missing.");
        Check.Equal(missingBefore, Snapshot(root.Runtime));
        AssertRedacted(missingKey, f.Pairing.Config);
        await Check.ThrowsAsync<IOException>(() => Task.Run(() => { using var lease = new RuntimeLease(root.Runtime); }));
    }

    private static async Task PairingFailures()
    {
        using var root = new TestRoot();
        AssertStage(await BridgeDiagnostics.RunAsync(root.Runtime), "pairing", "failed", "pairing_missing");
        Check.True(!Directory.Exists(root.Runtime), "Check must not create a missing runtime directory.");
        using var pairing = Pairing.Setup(root.Runtime, null);
        var path = Pairing.ConfigPath(root.Runtime);
        File.WriteAllText(path, "{\"token\":\"" + ResponseSecret + "\",broken}");
        var malformed = await BridgeDiagnostics.RunAsync(root.Runtime);
        AssertStage(malformed, "pairing", "failed", "pairing_unreadable_or_invalid");
        AssertRedacted(malformed, pairing.Config);
        foreach (var config in new[]
        {
            pairing.Config with { BridgeId = ResponseSecret }, pairing.Config with { Token = "invalid" },
            pairing.Config with { CertificateSha256 = "invalid" }, pairing.Config with { SchemaVersion = 1 },
            pairing.Config with { SchemaVersion = 3 }, pairing.Config with { ServiceUuid = Guid.NewGuid().ToString("D") },
            pairing.Config with { IdentityCharacteristicUuid = Guid.NewGuid().ToString("D") }
        })
        {
            DurableFiles.ReplaceJson(path, config);
            var report = await BridgeDiagnostics.RunAsync(root.Runtime);
            AssertStage(report, "pairing", "failed", "pairing_unreadable_or_invalid");
            AssertStage(report, "https", "skipped", "not_checked");
            AssertRedacted(report, config);
        }
    }

    private static async Task PairingIdentityFailures()
    {
        using var root = new TestRoot();
        await using var host = await HealthHost.StartAsync(root, (context, config) =>
            context.Response.WriteAsJsonAsync(new { ok = true, bridgeId = config.BridgeId, utc = Protocol.Utc(DateTimeOffset.UtcNow) }));
        var serverName = host.Config.ServerName;
        foreach (var name in new[]
        {
            "", "localhost", "127.0.0.1", "0.0.0.0", $"voice-{Guid.NewGuid():D}.local", "*.local",
            serverName.ToUpperInvariant(), serverName + ".", serverName + ".invalid", serverName + ":8787",
            "https://" + serverName + ":8787", " " + serverName, ResponseSecret, null!
        })
        {
            var config = host.Config with { ServerName = name };
            Save(root, config);
            var before = Snapshot(root.Runtime);
            var invalid = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port);
            AssertStage(invalid, "pairing", "failed", "pairing_unreadable_or_invalid");
            AssertStage(invalid, "https", "skipped", "not_checked");
            AssertRedacted(invalid, config);
            Check.Equal(before, Snapshot(root.Runtime));
        }
        var legacy = JsonSerializer.SerializeToNode(host.Config, Protocol.Json)!.AsObject();
        legacy["schemaVersion"] = 1;
        legacy.Remove("serverName");
        legacy["serverUrl"] = "https://192.168.254.1:8787";
        File.WriteAllText(Pairing.ConfigPath(root.Runtime), legacy.ToJsonString(Protocol.Json));
        var legacyBefore = Snapshot(root.Runtime);
        var oldSchema = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port);
        AssertStage(oldSchema, "pairing", "failed", "pairing_unreadable_or_invalid");
        AssertStage(oldSchema, "https", "skipped", "not_checked");
        AssertRedacted(oldSchema, host.Config);
        Check.Equal(legacyBefore, Snapshot(root.Runtime), "Check must never migrate or regenerate old pairing.");
        Check.Equal(0, host.Requests, "Invalid pairing must be rejected before an HTTP request.");
        Save(root, host.Config);
        var valid = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port);
        Check.Equal("passed", valid.Status);
        AssertStage(valid, "tlsIdentity", "passed", "server_name_verified");
        Check.Equal(1, host.Requests, "A stable DNS identity must work over the fixed loopback route.");
    }

    private static async Task TlsFailures()
    {
        using (var root = new TestRoot())
        {
            await using var host = await HealthHost.StartAsync(root, (context, config) =>
                context.Response.WriteAsJsonAsync(new { ok = true, bridgeId = config.BridgeId, utc = Protocol.Utc(DateTimeOffset.UtcNow) }));
            Save(root, host.Config with { CertificateSha256 = new string('0', 64) });
            var mismatch = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port);
            AssertStage(mismatch, "tlsPin", "failed", "pin_mismatch");
            AssertStage(mismatch, "tlsValidity", "passed", "certificate_current");
            AssertStage(mismatch, "tlsIdentity", "passed", "server_name_verified");
            AssertStage(mismatch, "authentication", "skipped", "not_checked");
            Check.Equal(0, host.Requests, "A wrong pin must prevent sending the bearer credential even with a matching DNS SAN.");
            AssertRedacted(mismatch, host.Config);
            Save(root, host.Config with { CertificateSha256 = host.Config.CertificateSha256.ToUpperInvariant() });
            Check.Equal("passed", (await BridgeDiagnostics.RunAsync(root.Runtime, host.Port)).Status);
            Check.Equal(1, host.Requests);
        }
        foreach (var kind in new[] { "hostname", "hostname-with-ip", "wildcard", "cn-only", "ip-only", "expired", "future" })
        {
            using var root = new TestRoot();
            await using var host = await HealthHost.StartAsync(root, (context, config) =>
                context.Response.WriteAsJsonAsync(new { ok = true, bridgeId = config.BridgeId, utc = Protocol.Utc(DateTimeOffset.UtcNow) }), kind);
            var report = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port);
            AssertStage(report, "tlsPin", "passed", "pin_verified");
            var invalidDate = kind is "expired" or "future";
            AssertStage(report, invalidDate ? "tlsValidity" : "tlsIdentity", "failed",
                !invalidDate ? "server_name_mismatch" : kind == "expired" ? "certificate_expired" : "certificate_not_yet_valid");
            AssertStage(report, invalidDate ? "tlsIdentity" : "tlsValidity", "passed",
                invalidDate ? "server_name_verified" : "certificate_current");
            AssertStage(report, "authentication", "skipped", "not_checked");
            Check.Equal(0, host.Requests, "TLS rejection must precede sending the bearer credential.");
            AssertRedacted(report, host.Config);
        }
    }

    private static async Task IdentityFailures()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        var wrongToken = new string(f.Pairing.Config.Token[0] == 'a' ? 'b' : 'a', 64);
        Save(root, f.Pairing.Config with { Token = wrongToken });
        var credentials = await BridgeDiagnostics.RunAsync(root.Runtime, Port(f));
        AssertStage(credentials, "authentication", "failed", "credentials_rejected");
        AssertStage(credentials, "health", "skipped", "not_checked");
        AssertRedacted(credentials, f.Pairing.Config);
        Check.True(!JsonSerializer.Serialize(credentials, Protocol.Json).Contains(wrongToken));
        using var identityRoot = new TestRoot();
        await using var host = await HealthHost.StartAsync(identityRoot, (context, _) =>
            context.Response.WriteAsJsonAsync(new { ok = true, bridgeId = Guid.NewGuid().ToString("D"), utc = Protocol.Utc(DateTimeOffset.UtcNow) }));
        var identity = await BridgeDiagnostics.RunAsync(identityRoot.Runtime, host.Port);
        AssertStage(identity, "tlsIdentity", "passed", "server_name_verified");
        AssertStage(identity, "authentication", "passed", "credentials_accepted");
        AssertStage(identity, "health", "failed", "bridge_id_mismatch");
        AssertRedacted(identity, host.Config);
        Check.Equal(0, f.Store.Entries().Count());
    }

    private static async Task HealthFailures()
    {
        foreach (var kind in new[] { "invalid", "false", "missing", "secret-id", "missing-time", "invalid-time", "unzoned-time", "oversize", "chunked-oversize", "redirect", "unavailable", "forbidden" })
        {
            using var root = new TestRoot();
            await using var host = await HealthHost.StartAsync(root, async (context, config) =>
            {
                if (kind == "redirect")
                {
                    context.Response.StatusCode = 302;
                    context.Response.Headers.Location = "/redirected?token=" + ResponseSecret;
                }
                if (kind == "unavailable") context.Response.StatusCode = 503;
                if (kind == "forbidden") context.Response.StatusCode = 403;
                var body = kind switch
                {
                    "false" => JsonSerializer.Serialize(new { ok = false, bridgeId = config.BridgeId, secret = ResponseSecret }),
                    "missing" => "{\"ok\":true}",
                    "secret-id" => JsonSerializer.Serialize(new { ok = true, bridgeId = ResponseSecret }),
                    "missing-time" => JsonSerializer.Serialize(new { ok = true, bridgeId = config.BridgeId }),
                    "invalid-time" => JsonSerializer.Serialize(new { ok = true, bridgeId = config.BridgeId, utc = ResponseSecret }),
                    "unzoned-time" => JsonSerializer.Serialize(new { ok = true, bridgeId = config.BridgeId, utc = "2026-10-16T01:00:00" }),
                    "oversize" or "chunked-oversize" => new string('x', BridgeDiagnostics.MaxHealthBytes + 1) + ResponseSecret,
                    _ => ResponseSecret
                };
                if (kind == "oversize") context.Response.ContentLength = Encoding.UTF8.GetByteCount(body);
                if (kind == "chunked-oversize") await context.Response.StartAsync();
                await context.Response.WriteAsync(body);
            });
            var report = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port);
            var code = kind switch
            {
                "secret-id" => "bridge_id_mismatch", "oversize" or "chunked-oversize" => "health_too_large",
                "redirect" => "redirect_refused", "unavailable" => "unexpected_http_status", "forbidden" => "credentials_rejected",
                _ => "invalid_health"
            };
            AssertStage(report, kind == "forbidden" ? "authentication" : "health", "failed", code);
            Check.Equal(1, host.Requests, "Check sends one GET only and never follows redirects.");
            AssertRedacted(report, host.Config);
        }
    }

    private static async Task ReachabilityFailures()
    {
        using (var root = new TestRoot())
        {
            using var pairing = Pairing.Setup(root.Runtime, null);
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            var report = await BridgeDiagnostics.RunAsync(root.Runtime, port);
            AssertStage(report, "https", "failed", "connection_failed");
            AssertStage(report, "tlsPin", "skipped", "not_checked");
            AssertRedacted(report, pairing.Config);
            listener.Start();
            try
            {
                port = ((IPEndPoint)listener.LocalEndpoint).Port;
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var watch = Stopwatch.StartNew();
                var checking = BridgeDiagnostics.RunAsync(root.Runtime, port, timeoutMs: 1500);
                using var silentPeer = await listener.AcceptTcpClientAsync(deadline.Token);
                var stalled = await checking;
                Check.True(watch.Elapsed < TimeSpan.FromSeconds(5), "TLS negotiation must also have a finite deadline.");
                AssertStage(stalled, "https", "failed", "timeout");
                AssertStage(stalled, "tlsPin", "skipped", "not_checked");
                AssertRedacted(stalled, pairing.Config);
            }
            finally { listener.Stop(); }
        }
        foreach (var headersSent in new[] { false, true })
        {
            using var root = new TestRoot();
            await using var host = await HealthHost.StartAsync(root, async (context, _) =>
            {
                if (headersSent)
                {
                    await context.Response.StartAsync();
                    await context.Response.WriteAsync("{");
                    await context.Response.Body.FlushAsync();
                }
                try { await Task.Delay(TimeSpan.FromSeconds(10), context.RequestAborted); }
                catch (OperationCanceledException) { }
            });
            var watch = Stopwatch.StartNew();
            var report = await BridgeDiagnostics.RunAsync(root.Runtime, host.Port, timeoutMs: 1500);
            Check.True(watch.Elapsed < TimeSpan.FromSeconds(5), "Health headers and body must share one finite deadline.");
            AssertStage(report, headersSent ? "health" : "https", "failed", "timeout");
            AssertRedacted(report, host.Config);
        }
    }

    private static async Task EntryPoint()
    {
        using var root = new TestRoot();
        Check.Equal("--check", BridgeOptions.Parse(["--check", "--repo-root", root.Root]).Mode);
        foreach (var extra in new[]
        {
            new[] { "--serve" }, new[] { "--setup" }, new[] { "--probe" }, new[] { "--check" }, new[] { "--no-transcribe" },
            new[] { "--listen-ip", "127.0.0.1" }, new[] { "--server-url", "https://127.0.0.1:8787" },
            new[] { "--bridge-id", Guid.NewGuid().ToString("D") }, new[] { "--database", "unused.sqlite" }, new[] { "--node", "node" }
        })
            await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeOptions.Parse(["--check", "--repo-root", root.Root, .. extra])));
        foreach (var extra in new[] { Array.Empty<string>(), new[] { "--" + ResponseSecret } })
        {
            using var output = new StringWriter();
            using var error = new StringWriter();
            var stdout = Console.Out;
            var stderr = Console.Error;
            int exit;
            try
            {
                Console.SetOut(output);
                Console.SetError(error);
                exit = await VoiceBridge.Program.Main(["--check", "--repo-root", root.Root, .. extra]);
            }
            finally { Console.SetOut(stdout); Console.SetError(stderr); }
            Check.Equal(1, exit);
            Check.Equal("", error.ToString());
            Check.True(!output.ToString().Contains(ResponseSecret));
            using var result = JsonDocument.Parse(output.ToString());
            Check.Equal("failed", result.RootElement.GetProperty("status").GetString());
            Check.True(!Directory.Exists(root.Runtime));
        }
        using var lease = new RuntimeLease(root.Runtime);
        var leased = await BridgeDiagnostics.RunAsync(root.Runtime);
        AssertStage(leased, "pairing", "failed", "pairing_missing");
        Check.True(!Directory.Exists(Path.Combine(root.Runtime, "bridge")));
    }

    private static int Port(EndpointFixture fixture) => fixture.Client.BaseAddress!.Port;
    private static void Save(TestRoot root, PairingConfig config) => DurableFiles.ReplaceJson(Pairing.ConfigPath(root.Runtime), config);

    private static void AssertStage(DiagnosticReport report, string name, string status, string code)
    {
        var result = report.Stages.Single(stage => stage.Stage == name);
        Check.Equal(status, result.Status, $"{name}: expected {status}, got {result.Status}/{result.Code}.");
        Check.Equal(code, result.Code);
        if (status == "failed") Check.Equal("failed", report.Status);
    }

    private static void AssertRedacted(DiagnosticReport report, PairingConfig config)
    {
        var json = JsonSerializer.Serialize(report, Protocol.Json);
        Check.True(!json.Contains(ResponseSecret));
        if (config.Token.Length == 64) Check.True(!json.Contains(config.Token));
        Check.True(!json.Contains("PRIVATE KEY") && !json.Contains("\"token\":"));
        Check.Equal("local_pc_only", report.Scope);
        Check.Equal("direct_https_no_proxy_no_redirect", report.Transport);
    }

    private static string Snapshot(string root)
    {
        var directories = Directory.EnumerateDirectories(root, "*", SearchOption.AllDirectories).Prepend(root).Order()
            .Select(path => path + "|" + new DirectoryInfo(path).GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All));
        var files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Order().Select(path =>
            path + "|" + File.GetLastWriteTimeUtc(path).Ticks + "|" +
            (Path.GetFileName(path) == ".bridge.lock" ? "leased" : Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))));
        return string.Join("\n", directories.Concat(files));
    }

    private sealed class RejectingProxy : IWebProxy
    {
        public int Calls { get; private set; }
        public ICredentials? Credentials { get; set; }
        public Uri GetProxy(Uri destination) { Calls++; throw new InvalidOperationException(ResponseSecret); }
        public bool IsBypassed(Uri host) { Calls++; throw new InvalidOperationException(ResponseSecret); }
    }

    private sealed class HealthHost(WebApplication app, X509Certificate2 certificate, PairingConfig config) : IAsyncDisposable
    {
        public PairingConfig Config { get; } = config;
        public int Port => new Uri(app.Urls.Single()).Port;
        public int Requests { get; private set; }

        public static async Task<HealthHost> StartAsync(TestRoot root, Func<HttpContext, PairingConfig, Task> respond, string certificateKind = "valid")
        {
            var bridgeId = Guid.NewGuid().ToString("D");
            var serverName = $"voice-{bridgeId}.local";
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=" + serverName, rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            if (certificateKind != "cn-only")
            {
                var san = new SubjectAlternativeNameBuilder();
                if (certificateKind != "ip-only")
                    san.AddDnsName(certificateKind switch
                    {
                        "hostname" or "hostname-with-ip" => $"voice-{Guid.NewGuid():D}.local",
                        "wildcard" => "*.local",
                        _ => serverName
                    });
                if (certificateKind is "ip-only" or "hostname-with-ip") san.AddIpAddress(IPAddress.Loopback);
                request.CertificateExtensions.Add(san.Build());
            }
            var now = DateTimeOffset.UtcNow;
            using var generated = request.CreateSelfSigned(certificateKind == "future" ? now.AddDays(1) : now.AddDays(-2),
                certificateKind == "expired" ? now.AddDays(-1) : now.AddDays(2));
            var certificate = new X509Certificate2(generated.Export(X509ContentType.Pfx, ""), "", X509KeyStorageFlags.UserKeySet);
            var config = new PairingConfig(2, bridgeId, Protocol.ServiceUuid, Protocol.IdentityCharacteristicUuid,
                serverName, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(), Pairing.Fingerprint(certificate));
            Paths.PrivateDirectory(Path.Combine(root.Runtime, "bridge"));
            DurableFiles.WriteJsonNew(Pairing.ConfigPath(root.Runtime), config);
            var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [], ContentRootPath = root.Root });
            builder.Configuration.Sources.Clear();
            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel(server => server.Listen(IPAddress.Loopback, 0, listener => listener.UseHttps(certificate)));
            var app = builder.Build();
            var host = new HealthHost(app, certificate, config);
            app.Run(async context =>
            {
                host.Requests++;
                Check.Equal("GET", context.Request.Method);
                Check.Equal("/v1/health", context.Request.Path.Value);
                Check.Equal("127.0.0.1", context.Request.Host.Host);
                Check.Equal(IPAddress.Loopback, context.Connection.LocalIpAddress);
                Check.True(context.Request.Headers.Authorization.ToString() == "Bearer " + config.Token);
                await respond(context, config);
            });
            try { await app.StartAsync(); return host; }
            catch { await host.DisposeAsync(); throw; }
        }

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
            certificate.Dispose();
        }
    }
}
