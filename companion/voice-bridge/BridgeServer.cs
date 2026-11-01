using System.Net;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace VoiceBridge;

internal static class BridgeServer
{
    public static WebApplication Build(BridgeOptions options, Pairing pairing, InboxStore store, int? testPort = null)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [], ContentRootPath = options.RepoRoot });
        builder.Configuration.Sources.Clear();
        builder.Logging.ClearProviders();
        if (testPort is null) builder.Logging.AddSimpleConsole(c => c.SingleLine = true);
        builder.WebHost.ConfigureKestrel(server =>
        {
            server.AddServerHeader = false;
            server.Limits.MaxRequestBodySize = Protocol.MaxRequestBytes;
            server.Limits.MaxRequestHeadersTotalSize = 16 * 1024;
            server.Limits.MaxConcurrentConnections = 32;
            server.Listen(IPAddress.Parse(options.ListenIp ?? "0.0.0.0"), testPort ?? 8787, listener =>
            {
                listener.Protocols = HttpProtocols.Http1AndHttp2;
                listener.UseHttps(https =>
                {
                    https.ServerCertificate = pairing.Certificate;
                    https.SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13;
                });
            });
        });
        var app = builder.Build();
        var expected = SHA256.HashData(Encoding.UTF8.GetBytes(pairing.Config.Token));
        app.Use(async (context, next) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!context.Request.IsHttps)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            var headers = context.Request.Headers.Authorization;
            var header = headers.Count == 1 ? headers[0] ?? "" : "";
            var bearer = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase);
            var supplied = SHA256.HashData(Encoding.UTF8.GetBytes(bearer ? header[7..] : ""));
            var authorized = CryptographicOperations.FixedTimeEquals(supplied, expected);
            if (!authorized || !bearer)
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                context.Response.Headers.WWWAuthenticate = "Bearer";
                await context.Response.WriteAsJsonAsync(new { ok = false, error = "Unauthorized." });
                return;
            }
            await next(context);
        });
        app.MapGet("/v1/health", () => Results.Json(new { ok = true, bridgeId = pairing.Config.BridgeId,
            processing = options.NoTranscribe ? "receive_only" : options.TranscribeOnly ? "local_transcription" : "agent_import",
            utc = Protocol.Utc(DateTimeOffset.UtcNow) }));
        app.MapPost("/v1/recordings/status", (Delegate)((HttpContext context) => RecordingStatusAsync(context, store, false)));
        app.MapPost("/v1/recordings/cleanup-ack", (Delegate)((HttpContext context) => RecordingStatusAsync(context, store, true)));
        app.MapPost("/v1/recordings", async (HttpContext context) =>
        {
            if (!await store.UploadSlots.WaitAsync(0, context.RequestAborted))
                return Results.Json(new { ok = false, error = "Receiver busy; retry later." }, statusCode: 503);
            try
            {
                var (manifest, audio) = await ReadUploadAsync(context.Request, context.RequestAborted);
                var receipt = await store.StoreAsync(manifest, audio, context.RequestAborted);
                return Results.Json(new { ok = true, receipt });
            }
            catch (ClientFault ex) { return Results.Json(new { ok = false, error = ex.Message }, statusCode: ex.Status); }
            catch (Microsoft.AspNetCore.Http.BadHttpRequestException ex) { return Results.Json(new { ok = false, error = "Invalid or oversized request." }, statusCode: ex.StatusCode); }
            catch (System.Text.Json.JsonException) { return Results.Json(new { ok = false, error = "Malformed manifest JSON." }, statusCode: 400); }
            catch (InvalidDataException) { return Results.Json(new { ok = false, error = "Malformed multipart request." }, statusCode: 400); }
            catch (IOException ex)
            {
                app.Logger.LogError("Recording not acknowledged: storage/read failure ({Type}).", ex.GetType().Name);
                return Results.Json(new { ok = false, error = "Could not durably store recording; retry later." }, statusCode: 503);
            }
            finally { store.UploadSlots.Release(); }
        });
        return app;
    }

    private static async Task<IResult> RecordingStatusAsync(HttpContext context, InboxStore store, bool cleanupAck)
    {
        try
        {
            var bytes = await CompressedAudio.ReadBoundedAsync(context.Request.Body, Protocol.MaxManifestBytes, context.RequestAborted);
            using var json = System.Text.Json.JsonDocument.Parse(bytes, new() { MaxDepth = 16 });
            return Results.Json(await store.StatusAsync(RecordingQuery.Parse(json.RootElement), cleanupAck, context.RequestAborted), Protocol.Json);
        }
        catch (ClientFault ex) { return Results.Json(new { ok = false, error = ex.Message }, statusCode: ex.Status); }
        catch (System.Text.Json.JsonException) { return Results.Json(new { ok = false, error = "Malformed query JSON." }, statusCode: 400); }
        catch (Microsoft.AspNetCore.Http.BadHttpRequestException ex)
        { return Results.Json(new { ok = false, error = "Invalid request." }, statusCode: ex.StatusCode); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        { return Results.Json(new { ok = false, error = "Recording state could not be verified; retry later." }, statusCode: 503); }
    }

    private static async Task<(RecordingManifest Manifest, byte[] Audio)> ReadUploadAsync(HttpRequest request, CancellationToken ct)
    {
        if (request.ContentLength > Protocol.MaxRequestBytes) throw new ClientFault(413, "Request too large.");
        if (!MediaTypeHeaderValue.TryParse(request.ContentType, out var type) ||
            !string.Equals(type.MediaType.Value, "multipart/form-data", StringComparison.OrdinalIgnoreCase))
            throw new ClientFault(415, "Use multipart/form-data with manifest and audio fields.");
        var boundary = HeaderUtilities.RemoveQuotes(type.Boundary).Value;
        if (string.IsNullOrEmpty(boundary) || boundary.Length > 128) throw new ClientFault(400, "Invalid multipart boundary.");
        var reader = new MultipartReader(boundary, request.Body) { HeadersCountLimit = 16, HeadersLengthLimit = 8192 };
        byte[]? manifest = null;
        byte[]? audio = null;
        var compressed = false;
        if (request.Headers.ContentEncoding.Count != 0) throw new ClientFault(415, "Encode only the audio multipart field.");
        while (await reader.ReadNextSectionAsync(ct) is { } section)
        {
            if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition) ||
                !string.Equals(disposition.DispositionType.Value, "form-data", StringComparison.OrdinalIgnoreCase))
                throw new ClientFault(400, "Invalid multipart disposition.");
            var name = HeaderUtilities.RemoveQuotes(disposition.Name).Value;
            var encodings = section.Headers is not null && section.Headers.TryGetValue(HeaderNames.ContentEncoding, out var encoding) ? encoding : default;
            if (name == "manifest" && manifest is null)
            {
                if (encodings.Count != 0) throw new ClientFault(415, "Manifest encoding is not supported.");
                manifest = await CompressedAudio.ReadBoundedAsync(section.Body, Protocol.MaxManifestBytes, ct);
            }
            else if (name == "audio" && audio is null)
            {
                compressed = encodings.Count == 1 && string.Equals(encodings[0], "gzip", StringComparison.OrdinalIgnoreCase);
                if (encodings.Count != 0 && !compressed) throw new ClientFault(415, "Unsupported audio encoding.");
                audio = await CompressedAudio.ReadBoundedAsync(section.Body, compressed ? Protocol.MaxCompressedBytes : Protocol.MaxAudioBytes, ct);
            }
            else throw new ClientFault(400, "Expected exactly one manifest field and one audio field.");
        }
        if (manifest is null || audio is null) throw new ClientFault(400, "Both manifest and audio are required.");
        var parsed = RecordingManifest.Parse(manifest);
        return (parsed, compressed ? await CompressedAudio.DecodeAsync(audio, ct) : audio);
    }
}
