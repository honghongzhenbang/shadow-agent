using System.Buffers.Binary;
using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VoiceBridge;

internal static class RfcommFrames
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static async Task<JsonDocument?> ReadAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[4];
        if (await stream.ReadAsync(header.AsMemory(0, 1), ct) == 0) return null;
        await stream.ReadExactlyAsync(header.AsMemory(1), ct);
        var length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length == 0 || length > Protocol.MaxFrameBytes) throw new ClientFault(400, "Invalid frame size.");
        var data = new byte[(int)length];
        await stream.ReadExactlyAsync(data, ct);
        try { StrictUtf8.GetCharCount(data); }
        catch (DecoderFallbackException) { throw new ClientFault(400, "Invalid frame encoding."); }
        var document = JsonDocument.Parse(data, new JsonDocumentOptions { MaxDepth = 16 });
        try
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ClientFault(400, "Expected an object.");
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in document.RootElement.EnumerateObject())
                if (!names.Add(property.Name)) throw new ClientFault(400, "Duplicate frame property.");
            return document;
        }
        catch { document.Dispose(); throw; }
    }

    public static async Task WriteAsync<T>(Stream stream, T response, CancellationToken ct)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(response, Protocol.Json);
        if (data.Length > Protocol.MaxFrameBytes) throw new IOException("Response exceeds frame limit.");
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)data.Length);
        await stream.WriteAsync(header, ct);
        await stream.WriteAsync(data, ct);
        await stream.FlushAsync(ct);
    }

    public static string Text(JsonElement frame, string name)
    {
        if (!frame.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new ClientFault(400, "Missing string field.");
        return value.GetString()!;
    }

    public static long Integer(JsonElement frame, string name)
    {
        if (!frame.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var number))
            throw new ClientFault(400, "Missing integer field.");
        return number;
    }
}

internal sealed class RfcommTlsSession(Pairing pairing, ResumableUploadStore partials, Action<string> log,
    TimeSpan? idleTimeout = null)
{
    private readonly byte[] expectedToken = SHA256.HashData(Encoding.UTF8.GetBytes(pairing.Config.Token));

    public async Task RunAsync(Stream transport, CancellationToken ct)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lifetime.CancelAfter(TimeSpan.FromHours(1));
        using var shutdown = lifetime.Token.Register(transport.Dispose);
        using var tls = new SslStream(transport, leaveInnerStreamOpen: true);
        try
        {
            using var handshake = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            handshake.CancelAfter(TimeSpan.FromSeconds(15));
            await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
            {
                ServerCertificate = pairing.Certificate,
                ClientCertificateRequired = false,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                AllowRenegotiation = false
            }, handshake.Token);
            log($"RFCOMM TLS established; protocol={tls.SslProtocol}.");
            await ServeAuthenticatedStreamAsync(tls, lifetime.Token);
        }
        catch (Exception ex) when (ex is IOException or AuthenticationException or OperationCanceledException or ObjectDisposedException)
        { log($"RFCOMM TLS connection closed: {ex.GetType().Name}."); }
    }

    private async Task ServeAuthenticatedStreamAsync(SslStream tls, CancellationToken ct)
    {
        var authenticated = false;
        ResumableUpload? upload = null;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                deadline.CancelAfter(idleTimeout ?? TimeSpan.FromSeconds(60));
                using var request = await RfcommFrames.ReadAsync(tls, deadline.Token);
                if (request is null) return;
                var frame = request.RootElement;
                var op = RfcommFrames.Text(frame, "op");
                if (!authenticated)
                {
                    if (op != "auth" || !frame.TryGetProperty("token", out var token) || token.ValueKind != JsonValueKind.String ||
                        !CryptographicOperations.FixedTimeEquals(expectedToken, SHA256.HashData(Encoding.UTF8.GetBytes(token.GetString()!))))
                        throw new ClientFault(401, "Unauthorized.");
                    authenticated = true;
                    log("RFCOMM application authentication accepted.");
                    await HealthAsync(tls, deadline.Token);
                    continue;
                }
                switch (op)
                {
                    case "status":
                    case "cleanup_ack":
                        var status = await partials.StatusAsync(RecordingQuery.Parse(frame), op == "cleanup_ack", deadline.Token);
                        await RfcommFrames.WriteAsync(tls, status, deadline.Token);
                        break;
                    case "health":
                        await HealthAsync(tls, deadline.Token);
                        break;
                    case "begin":
                        if (upload is not null) throw new ClientFault(409, "One active begin per connection.");
                        if (!frame.TryGetProperty("manifest", out var manifest)) throw new ClientFault(400, "Missing manifest.");
                        var begin = await partials.BeginAsync(RecordingManifest.Parse(Encoding.UTF8.GetBytes(manifest.GetRawText())),
                            RfcommFrames.Text(frame, "compressedSha256"), RfcommFrames.Integer(frame, "compressedSize"), deadline.Token);
                        upload = begin.Upload;
                        if (begin.Receipt is not null) await RfcommFrames.WriteAsync(tls, new { ok = true, receipt = begin.Receipt }, deadline.Token);
                        else await RfcommFrames.WriteAsync(tls, new { ok = true, offset = upload!.Offset }, deadline.Token);
                        break;
                    case "chunk":
                        if (upload is null) throw new ClientFault(409, "Begin required.");
                        var offset = RfcommFrames.Integer(frame, "offset");
                        var length = RfcommFrames.Integer(frame, "length");
                        if (length is <= 0 or > Protocol.MaxChunkBytes) throw new ClientFault(400, "Invalid chunk length.");
                        if (offset != upload.Offset || length > upload.Metadata.CompressedSize - offset)
                            throw new ClientFault(409, "Chunk offset or size conflict.");
                        var chunk = new byte[(int)length];
                        await tls.ReadExactlyAsync(chunk, deadline.Token);
                        await upload.AppendAsync(offset, chunk, deadline.Token);
                        await RfcommFrames.WriteAsync(tls, new { ok = true, offset = upload.Offset }, deadline.Token);
                        break;
                    case "finish":
                        if (upload is null) throw new ClientFault(409, "Begin required.");
                        var receipt = await upload.FinishAsync(deadline.Token);
                        upload.Dispose();
                        upload = null;
                        await RfcommFrames.WriteAsync(tls, new { ok = true, receipt }, deadline.Token);
                        break;
                    default:
                        throw new ClientFault(400, "Unknown operation.");
                }
            }
        }
        catch (ClientFault ex) { await FailureAsync(tls, ex.Status, ct); }
        catch (JsonException) { await FailureAsync(tls, 400, ct); }
        catch (InvalidOperationException) { await FailureAsync(tls, 400, ct); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { await FailureAsync(tls, 408, ct); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log($"RFCOMM request not acknowledged: {ex.GetType().Name}.");
            await FailureAsync(tls, 503, ct);
        }
        finally { upload?.Dispose(); }
        // An error closes the stream: unread chunk bytes must never become JSON frames.
    }

    private Task HealthAsync(Stream stream, CancellationToken ct) => RfcommFrames.WriteAsync(stream,
        new { ok = true, bridgeId = pairing.Config.BridgeId, utc = Protocol.Utc(DateTimeOffset.UtcNow) }, ct);

    private static async Task FailureAsync(Stream stream, int status, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        try { await RfcommFrames.WriteAsync(stream, new { ok = false, status }, deadline.Token); }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException) { }
    }
}
