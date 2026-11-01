using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal sealed class RfcommTestHost : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stop = new();
    private readonly List<Task> connections = new();
    private readonly object gate = new();
    private readonly Task accept;
    public Pairing Pairing { get; }
    public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

    public RfcommTestHost(Pairing pairing, ResumableUploadStore partials, TimeSpan? idleTimeout = null)
    {
        Pairing = pairing;
        var protocol = new RfcommTlsSession(pairing, partials, _ => { }, idleTimeout);
        listener.Start();
        accept = AcceptAsync(protocol);
    }

    private async Task AcceptAsync(RfcommTlsSession protocol)
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(stop.Token);
                lock (gate) connections.Add(RunAsync(client, protocol));
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private async Task RunAsync(TcpClient client, RfcommTlsSession protocol)
    {
        using (client)
        using (var network = client.GetStream())
        using (var duplex = new DuplexStream(network, network))
            await protocol.RunAsync(duplex, stop.Token);
    }

    public async Task DrainAsync()
    {
        Task[] current;
        lock (gate) current = connections.ToArray();
        await Task.WhenAll(current).WaitAsync(TimeSpan.FromSeconds(10));
    }

    public async Task<RfcommTestClient> ConnectAsync(string? pin = null, string? serverName = null)
    {
        var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, Port);
        var ssl = new SslStream(client.GetStream(), false, (_, certificate, _, _) =>
        {
            if (certificate is null) return false;
            using var cert = new X509Certificate2(certificate);
            return VoiceBridge.Pairing.MatchesServerName(cert, serverName ?? Pairing.Config.ServerName) &&
                cert.NotBefore.ToUniversalTime() <= DateTime.UtcNow && DateTime.UtcNow < cert.NotAfter.ToUniversalTime() &&
                VoiceBridge.Pairing.Fingerprint(cert) == (pin ?? Pairing.Config.CertificateSha256);
        });
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = serverName ?? Pairing.Config.ServerName,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13
            }, deadline.Token);
            return new(client, ssl);
        }
        catch { ssl.Dispose(); client.Dispose(); throw; }
    }

    public async Task<RfcommTestClient> AuthorizedAsync()
    {
        var client = await ConnectAsync();
        try
        {
            var auth = await client.RequestAsync(new { op = "auth", token = Pairing.Config.Token });
            Check.Equal(true, auth["ok"]!.GetValue<bool>());
            Check.Equal(Pairing.Config.BridgeId, auth["bridgeId"]!.GetValue<string>());
            Check.True(DateTimeOffset.TryParse(auth["utc"]!.GetValue<string>(), out _));
            return client;
        }
        catch { client.Dispose(); throw; }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        await accept;
        listener.Stop();
        await DrainAsync();
        stop.Dispose();
    }
}

internal sealed class RfcommTestClient(TcpClient client, SslStream tls) : IDisposable
{
    public SslStream Stream { get; } = tls;

    public async Task<JsonObject> ReadAsync()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var frame = await RfcommFrames.ReadAsync(Stream, deadline.Token);
        Check.True(frame is not null, "Expected response frame, not EOF.");
        return JsonNode.Parse(frame!.RootElement.GetRawText())!.AsObject();
    }

    public async Task SendAsync<T>(T request)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await RfcommFrames.WriteAsync(Stream, request, deadline.Token);
    }

    public async Task<JsonObject> RequestAsync<T>(T request) { await SendAsync(request); return await ReadAsync(); }

    public Task<JsonObject> BeginAsync(JsonObject manifest, byte[] compressed, string? hash = null) =>
        RequestAsync(new { op = "begin", manifest, compressedSha256 = hash ?? Fixtures.Hash(compressed), compressedSize = compressed.Length });

    public async Task<JsonObject> ChunkAsync(int offset, ReadOnlyMemory<byte> data)
    {
        await SendAsync(new { op = "chunk", offset, length = data.Length });
        await Stream.WriteAsync(data);
        await Stream.FlushAsync();
        return await ReadAsync();
    }

    public async Task UploadChunksAsync(byte[] compressed, int offset = 0)
    {
        while (offset < compressed.Length)
        {
            var length = Math.Min(Protocol.MaxChunkBytes, compressed.Length - offset);
            var reply = await ChunkAsync(offset, compressed.AsMemory(offset, length));
            offset += length;
            Check.Equal((long)offset, reply["offset"]!.GetValue<long>());
        }
    }

    public void Dispose() { Stream.Dispose(); client.Dispose(); }
}
