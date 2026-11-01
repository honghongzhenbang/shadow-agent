using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;

namespace VoiceBridge.Tests;

internal static class Check
{
    public static void True(bool condition, string message = "Assertion failed")
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    public static void Equal<T>(T expected, T actual, string? message = null) =>
        True(EqualityComparer<T>.Default.Equals(expected, actual), message ?? $"Expected {expected}, got {actual}.");

    public static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); }
        catch (T) { return; }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }
}

internal sealed class TestRoot : IDisposable
{
    private static string TestBase => Path.Combine(FindArtifactsRoot(), "test-data");
    public string Root { get; } = Path.Combine(TestBase, "t-" + Guid.NewGuid().ToString("N"));
    public string Runtime => Path.Combine(Root, "runtime", "voice");
    public TestRoot() => Directory.CreateDirectory(Root);
    public BridgeOptions Options => new("--serve", Root, Runtime, null, true, Path.Combine(Root, "isolated.sqlite"), "node", "127.0.0.1");

    public void Dispose()
    {
        Check.True(Paths.IsWithin(TestBase, Root) && Path.GetFileName(Root).StartsWith("t-", StringComparison.Ordinal));
        Paths.RejectLinks(Root);
        Directory.Delete(Root, recursive: true);
    }

    private static string FindArtifactsRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (directory.Name == "voice-014-backend") return directory.FullName;
            // SDK artifacts output is bin/<project>/<configuration>; keep child working directories below MAX_PATH.
            if (directory.Name == "bin" && directory.Parent is { } artifacts && Directory.Exists(Path.Combine(artifacts.FullName, "obj")))
                return artifacts.FullName;
        }
        return AppContext.BaseDirectory;
    }
}

internal sealed class EndpointFixture : IAsyncDisposable
{
    private readonly RuntimeLease lease;
    public Pairing Pairing { get; }
    public InboxStore Store { get; }
    public WebApplication App { get; }
    public HttpClient Client { get; private set; } = null!;
    public TestRoot Root { get; }

    private EndpointFixture(TestRoot root, Action<string>? beforeCommit)
    {
        Root = root;
        lease = new RuntimeLease(root.Runtime);
        Pairing = VoiceBridge.Pairing.Setup(root.Runtime, null);
        Store = new InboxStore(root.Runtime, beforeCommit);
        App = BridgeServer.Build(root.Options, Pairing, Store, testPort: 0);
    }

    public static async Task<EndpointFixture> StartAsync(TestRoot root, Action<string>? beforeCommit = null)
    {
        var f = new EndpointFixture(root, beforeCommit);
        try
        {
            await f.App.StartAsync();
            f.Client = f.NewClient();
            return f;
        }
        catch { await f.DisposeAsync(); throw; }
    }

    public HttpClient NewClient(string? pin = null, bool authenticated = true, string? serverName = null)
    {
        var handler = new HttpClientHandler
        {
            UseProxy = false,
            ServerCertificateCustomValidationCallback = (_, cert, _, errors) => cert is not null &&
                VoiceBridge.Pairing.MatchesServerName(cert, serverName ?? Pairing.Config.ServerName) &&
                cert.NotBefore.ToUniversalTime() <= DateTime.UtcNow && DateTime.UtcNow < cert.NotAfter.ToUniversalTime() &&
                string.Equals(VoiceBridge.Pairing.Fingerprint(cert), pin ?? Pairing.Config.CertificateSha256, StringComparison.Ordinal)
        };
        var client = new HttpClient(handler) { BaseAddress = new Uri(App.Urls.Single()), Timeout = TimeSpan.FromSeconds(30) };
        if (authenticated) client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Pairing.Config.Token);
        return client;
    }

    public async Task<(int Status, JsonObject Body)> UploadAsync(JsonObject manifest, byte[]? audio = null,
        string fileName = "recording.wav", bool chunked = false, bool manifestFile = false, string? audioEncoding = null)
    {
        using var multipart = new MultipartFormDataContent();
        var json = new StringContent(manifest.ToJsonString(), Encoding.UTF8, "application/json");
        if (manifestFile) multipart.Add(json, "manifest", "manifest.json");
        else multipart.Add(json, "manifest");
        var audioContent = new ByteArrayContent(audio ?? Fixtures.Wave());
        if (audioEncoding is not null) audioContent.Headers.ContentEncoding.Add(audioEncoding);
        multipart.Add(audioContent, "audio", fileName);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/v1/recordings");
        request.Content = chunked ? new ChunkedContent(await multipart.ReadAsByteArrayAsync(), multipart.Headers.ContentType!) : multipart;
        using var response = await Client.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        Check.True(text.Length != 0, $"Upload returned HTTP {(int)response.StatusCode} without JSON.");
        return ((int)response.StatusCode, JsonNode.Parse(text)!.AsObject());
    }

    public async ValueTask DisposeAsync()
    {
        Client?.Dispose();
        await App.StopAsync();
        await App.DisposeAsync();
        Store.Dispose();
        Pairing.Dispose();
        lease.Dispose();
    }

    private sealed class ChunkedContent : HttpContent
    {
        private readonly byte[] bytes;
        public ChunkedContent(byte[] bytes, MediaTypeHeaderValue type)
        {
            this.bytes = bytes;
            Headers.ContentType = type;
        }
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => stream.WriteAsync(bytes).AsTask();
    }
}

internal static class Fixtures
{
    public static byte[] Wave(int samples = 1600, byte value = 0)
    {
        var bytes = new byte[44 + samples * 2];
        "RIFF"u8.CopyTo(bytes);
        U32(bytes, 4, (uint)bytes.Length - 8);
        "WAVEfmt "u8.CopyTo(bytes.AsSpan(8));
        U32(bytes, 16, 16);
        U16(bytes, 20, 1);
        U16(bytes, 22, 1);
        U32(bytes, 24, 16000);
        U32(bytes, 28, 32000);
        U16(bytes, 32, 2);
        U16(bytes, 34, 16);
        "data"u8.CopyTo(bytes.AsSpan(36));
        U32(bytes, 40, (uint)samples * 2);
        bytes.AsSpan(44).Fill(value);
        return bytes;
    }

    public static JsonObject Manifest(byte[]? wave = null) => new()
    {
        ["deviceId"] = Guid.NewGuid().ToString("D"), ["recordingId"] = Guid.NewGuid().ToString("D"),
        ["conversationId"] = Guid.NewGuid().ToString("D"), ["recordedAt"] = "2026-10-15T09:00:00+08:00",
        ["sha256"] = Hash(wave ?? Wave()), ["sampleRateHz"] = 16000,
        ["sampleCount"] = ((wave ?? Wave()).Length - 44) / 2, ["channels"] = 1,
        ["durationMs"] = ((wave ?? Wave()).Length - 44) / 32.0, ["timeBasis"] = "device_clock",
        ["timeUncertaintyMs"] = 100, ["testOnly"] = true
    };

    public static RecordingManifest Parse(JsonObject manifest) => RecordingManifest.Parse(Encoding.UTF8.GetBytes(manifest.ToJsonString()));
    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    public static void U16(byte[] bytes, int at, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(at, 2), value);
    public static void U32(byte[] bytes, int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(at, 4), value);
}
