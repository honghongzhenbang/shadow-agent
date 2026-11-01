using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal static class DualTransportTests
{
    public static readonly (string Name, Func<Task> Run)[] Cases =
    [
        ("dual: lossless gzip, CRC/truncation rejection and bounded decompression", GzipTest),
        ("dual: HTTPS gzip multipart, streamed limits and uncompressed compatibility", HttpsGzipTest),
        ("dual: durable partial restart, uncommitted tail and exact resume", DurableResumeTest),
        ("dual: partial identity conflict, quota, free-space reserve, TTL and leases", LimitsTest),
        ("dual: archive storage reserve and idempotency under disk pressure", ArchiveSpaceTest),
        ("dual: restart cleanup, corrupted partial metadata and isolated queue", PartialRecoveryTest),
        ("dual: TLS pin, SAN, expired/future certificate and auth-before-audio", TlsSecurityTest),
        ("dual: TLS roundtrip, canonical archive and cross-channel receipt recovery", RoundtripTest),
        ("dual: TLS reconnect, interrupted chunk and lost chunk acknowledgement", ReconnectTest),
        ("dual: malformed frames, duplicate fields and strict operation order", FrameTest),
        ("dual: chunk offsets, chunk bounds, incomplete finish and single begin", ChunkTest),
        ("dual: compressed hash, gzip, WAV hash/structure and decompression bomb", InvalidFinishTest),
        ("dual: commit failure never acknowledges and retries without retransmission", CommitFailureTest),
        ("dual: shared HTTPS/RFCOMM admission and cross-channel race", AdmissionTest),
        ("dual: idle timeout/cancellation releases upload leases", TimeoutTest),
        ("dual: optional BLE identity, long-read snapshots and unchanged pairing", DiscoveryTest),
        ("dual: probe CLI isolation and unchanged processing options", OptionsTest)
    ];

    private static byte[] Gzip(byte[] audio)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true)) gzip.Write(audio);
        return output.ToArray();
    }

    private static byte[] RandomWave()
    {
        var audio = Fixtures.Wave(75000);
        new Random(14).NextBytes(audio.AsSpan(44));
        return audio;
    }

    private static async Task Fault(int status, Func<Task> run)
    {
        try { await run(); }
        catch (ClientFault ex) { Check.Equal(status, ex.Status); return; }
        throw new InvalidOperationException($"Expected ClientFault {status}.");
    }

    private static void Failure(JsonObject response, int status)
    {
        Check.Equal(false, response["ok"]!.GetValue<bool>());
        Check.Equal(status, response["status"]!.GetValue<int>());
        Check.Equal(2, response.Count, "Failure must contain only ok/status, never request or private content.");
    }

    private static async Task GzipTest()
    {
        var wave = RandomWave();
        var zipped = Gzip(wave);
        Check.True(wave.SequenceEqual(await CompressedAudio.DecodeAsync(zipped, CancellationToken.None)));
        foreach (var invalid in new[] { Array.Empty<byte>(), zipped[..10], zipped[..^1], zipped[..^8], Encoding.ASCII.GetBytes("not a gzip payload"), zipped.Concat(new byte[5]).ToArray() })
            await Fault(400, () => CompressedAudio.DecodeAsync(invalid, CancellationToken.None));
        foreach (var at in new[] { 0, 2, zipped.Length - 8, zipped.Length - 4 })
        {
            var invalid = zipped.ToArray();
            invalid[at] ^= 1;
            await Fault(400, () => CompressedAudio.DecodeAsync(invalid, CancellationToken.None));
        }
        await Fault(413, () => CompressedAudio.DecodeAsync(new byte[Protocol.MaxCompressedBytes + 1], CancellationToken.None));
        await Fault(413, () => CompressedAudio.DecodeAsync(Gzip(new byte[Protocol.MaxAudioBytes + 1]), CancellationToken.None));
        var maximum = Fixtures.Wave((Protocol.MaxAudioBytes - 44) / 2);
        Check.True(maximum.SequenceEqual(await CompressedAudio.DecodeAsync(Gzip(maximum), CancellationToken.None)));
    }

    private static async Task HttpsGzipTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        var wave = RandomWave();
        var manifest = Fixtures.Manifest(wave);
        var first = await f.UploadAsync(manifest, Gzip(wave), chunked: true, manifestFile: true, audioEncoding: "gzip");
        Check.Equal(200, first.Status);
        Check.Equal(first.Body["receipt"]!.ToJsonString(), (await f.UploadAsync(manifest, wave)).Body["receipt"]!.ToJsonString());
        Check.True(wave.SequenceEqual(File.ReadAllBytes(Path.Combine(f.Store.Entries().Single(), "audio.wav"))));
        Check.Equal(200, (await f.UploadAsync(manifest, Gzip(wave), audioEncoding: "GZIP")).Status);
        Check.Equal(415, (await f.UploadAsync(manifest, Gzip(wave), audioEncoding: "br")).Status);
        Check.Equal(400, (await f.UploadAsync(Fixtures.Manifest(), Gzip(wave)[..^8], audioEncoding: "gzip")).Status);
        Check.Equal(413, (await f.UploadAsync(Fixtures.Manifest(), Gzip(new byte[Protocol.MaxAudioBytes + 1]), audioEncoding: "gzip")).Status);
        Check.Equal(413, (await f.UploadAsync(Fixtures.Manifest(), new byte[Protocol.MaxCompressedBytes + 1], audioEncoding: "gzip", chunked: true)).Status);
        using var content = new MultipartFormDataContent();
        var json = new StringContent(manifest.ToJsonString());
        json.Headers.ContentEncoding.Add("gzip");
        content.Add(json, "manifest");
        content.Add(new ByteArrayContent(Gzip(wave)), "audio");
        using (var response = await f.Client.PostAsync("/v1/recordings", content)) Check.Equal(415, (int)response.StatusCode);
        Check.Equal(1, f.Store.Entries().Count());
    }

    private static async Task DurableResumeTest()
    {
        using var root = new TestRoot();
        var wave = RandomWave();
        var zipped = Gzip(wave);
        var manifest = Fixtures.Parse(Fixtures.Manifest(wave));
        using (var inbox = new InboxStore(root.Runtime))
        using (var partials = new ResumableUploadStore(root.Runtime, inbox, beforeProgressCommit: _ => throw new IOException("Injected progress failure")))
        using (var upload = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!)
        {
            await Check.ThrowsAsync<IOException>(() => upload.AppendAsync(0, zipped.AsMemory(0, 1024), CancellationToken.None));
            Check.Equal(0L, upload.Offset);
            Check.Equal(1024L, new FileInfo(Path.Combine(upload.Directory, "compressed.part")).Length);
            Check.Equal(0, inbox.Entries().Count());
        }
        using (var inbox = new InboxStore(root.Runtime))
        using (var partials = new ResumableUploadStore(root.Runtime, inbox))
        using (var upload = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!)
        {
            Check.Equal(0L, upload.Offset);
            Check.Equal(0L, new FileInfo(Path.Combine(upload.Directory, "compressed.part")).Length);
            await upload.AppendAsync(0, zipped.AsMemory(0, Protocol.MaxChunkBytes), CancellationToken.None);
        }
        RecordingReceipt receipt;
        using (var inbox = new InboxStore(root.Runtime))
        using (var partials = new ResumableUploadStore(root.Runtime, inbox))
        using (var upload = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!)
        {
            Check.Equal((long)Protocol.MaxChunkBytes, upload.Offset);
            while (upload.Offset < zipped.Length)
                await upload.AppendAsync(upload.Offset, zipped.AsMemory((int)upload.Offset, (int)Math.Min(Protocol.MaxChunkBytes, zipped.Length - upload.Offset)), CancellationToken.None);
            receipt = await upload.FinishAsync(CancellationToken.None);
            Check.True(wave.SequenceEqual(File.ReadAllBytes(Path.Combine(inbox.Entries().Single(), "audio.wav"))));
            Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
        }
        using (var inbox = new InboxStore(root.Runtime))
        using (var partials = new ResumableUploadStore(root.Runtime, inbox))
        {
            var repeated = await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None);
            Check.Equal(receipt, repeated.Receipt);
            Check.True(repeated.Upload is null);
        }
    }

    private static async Task LimitsTest()
    {
        using var root = new TestRoot();
        using var inbox = new InboxStore(root.Runtime);
        var now = DateTimeOffset.UtcNow;
        var free = long.MaxValue;
        var zipped = Gzip(Fixtures.Wave());
        var manifest = Fixtures.Parse(Fixtures.Manifest());
        using var partials = new ResumableUploadStore(root.Runtime, inbox, new(zipped.Length * 2, 3, 100, TimeSpan.FromMinutes(1)), () => now, () => free);
        var first = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!;
        await Fault(409, () => partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None));
        first.Dispose();
        await Fault(409, () => partials.BeginAsync(manifest with { Title = "different" }, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None));
        await Fault(409, () => partials.BeginAsync(manifest, new string('a', 64), zipped.Length, CancellationToken.None));
        await Fault(400, () => partials.BeginAsync(manifest, new string('A', 64), zipped.Length, CancellationToken.None));
        await Fault(413, () => partials.BeginAsync(manifest, Fixtures.Hash(zipped), Protocol.MaxCompressedBytes + 1L, CancellationToken.None));
        var secondManifest = manifest with { RecordingId = Guid.NewGuid().ToString("D") };
        using (var second = (await partials.BeginAsync(secondManifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!) { }
        await Fault(507, () => partials.BeginAsync(manifest with { RecordingId = Guid.NewGuid().ToString("D") }, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None));
        using (var active = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!)
        {
            now = now.AddMinutes(2);
            await partials.SweepAsync(CancellationToken.None);
            Check.Equal(1, Directory.EnumerateDirectories(partials.Root).Count());
        }
        await partials.SweepAsync(CancellationToken.None);
        Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
        free = 100;
        await Fault(507, () => partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None));
        Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
        free = long.MaxValue;
        using var fresh = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!;
        free = 0;
        await Fault(507, () => fresh.AppendAsync(0, zipped, CancellationToken.None));
        Check.Equal(0L, fresh.Offset);
    }

    private static async Task ArchiveSpaceTest()
    {
        using var root = new TestRoot();
        var free = 0L;
        using var inbox = new InboxStore(root.Runtime, freeBytes: () => free);
        var manifest = Fixtures.Parse(Fixtures.Manifest());
        await Fault(507, () => inbox.StoreAsync(manifest, Fixtures.Wave(), CancellationToken.None));
        Check.Equal(0, inbox.Entries().Count());
        free = long.MaxValue;
        var receipt = await inbox.StoreAsync(manifest, Fixtures.Wave(), CancellationToken.None);
        free = 0;
        Check.Equal(receipt, await inbox.StoreAsync(manifest, Fixtures.Wave(), CancellationToken.None));
        Check.Equal(receipt, await inbox.FindReceiptAsync(manifest, CancellationToken.None));
    }

    private static async Task PartialRecoveryTest()
    {
        using var root = new TestRoot();
        using var inbox = new InboxStore(root.Runtime);
        var manifest = Fixtures.Parse(Fixtures.Manifest());
        var zipped = Gzip(Fixtures.Wave());
        var now = DateTimeOffset.UtcNow;
        string directory;
        using (var partials = new ResumableUploadStore(root.Runtime, inbox, new(MaxFiles: 1, Retention: TimeSpan.FromMinutes(1)), () => now))
        {
            using (var upload = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!)
            {
                await upload.AppendAsync(0, zipped.AsMemory(0, 20), CancellationToken.None);
                directory = upload.Directory;
            }
            await Fault(507, () => partials.BeginAsync(manifest with { RecordingId = Guid.NewGuid().ToString("D") }, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None));
            Check.Equal(0, inbox.Entries().Count());
            // Simulate a power interruption during progress replacement and a corrupt payload.
            File.WriteAllText(Path.Combine(directory, "progress.json.crash.tmp"), "partial metadata");
            File.WriteAllBytes(Path.Combine(directory, "compressed.part"), [1]);
        }
        using (var partials = new ResumableUploadStore(root.Runtime, inbox, new(Retention: TimeSpan.FromMinutes(1)), () => now))
        {
            Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
            using (var upload = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!)
                Check.Equal(0L, upload.Offset);
            var orphan = Path.Combine(partials.Root, "." + Guid.NewGuid().ToString("N") + ".staging");
            Directory.CreateDirectory(orphan);
            File.WriteAllText(Path.Combine(orphan, "upload.json"), "unfinished");
        }
        now = now.AddMinutes(2);
        using (var partials = new ResumableUploadStore(root.Runtime, inbox, new(Retention: TimeSpan.FromMinutes(1)), () => now))
            Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
        Check.Equal(0, inbox.Entries().Count());
    }

    private static async Task TlsSecurityTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime);
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        await using (var host = new RfcommTestHost(pairing, partials))
        {
            await Check.ThrowsAsync<AuthenticationException>(() => host.ConnectAsync(pin: new string('0', 64)));
            await Check.ThrowsAsync<AuthenticationException>(() => host.ConnectAsync(serverName: "wrong-identity.local"));
            foreach (var request in new object[] { new { op = "health" }, new { op = "begin", manifest = Fixtures.Manifest() }, new { op = "auth", token = "wrong-secret" } })
            {
                using var client = await host.ConnectAsync();
                Failure(await client.RequestAsync(request), 401);
            }
            using var authorized = await host.AuthorizedAsync();
            Check.Equal(true, (await authorized.RequestAsync(new { op = "health" }))["ok"]!.GetValue<bool>());
            Failure(await authorized.RequestAsync(new { op = "auth", token = pairing.Config.Token }), 400);
        }
        foreach (var future in new[] { false, true })
        {
            using var rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=isolated-test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var san = new SubjectAlternativeNameBuilder();
            san.AddDnsName(pairing.Config.ServerName);
            request.CertificateExtensions.Add(san.Build());
            var from = DateTimeOffset.UtcNow.AddDays(future ? 1 : -3);
            using var issued = request.CreateSelfSigned(from, from.AddDays(1));
            using var invalid = new Pairing(pairing.Config with { CertificateSha256 = Pairing.Fingerprint(issued) },
                new X509Certificate2(issued.Export(X509ContentType.Pfx), "", X509KeyStorageFlags.UserKeySet));
            await using var host = new RfcommTestHost(invalid, partials);
            await Check.ThrowsAsync<AuthenticationException>(() => host.ConnectAsync());
        }
        Check.Equal(0, inbox.Entries().Count());
        Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
    }

    private static async Task RoundtripTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        using var partials = new ResumableUploadStore(root.Runtime, f.Store);
        await using var host = new RfcommTestHost(f.Pairing, partials);
        var wave = RandomWave();
        var manifest = Fixtures.Manifest(wave);
        var zipped = Gzip(wave);
        string receipt;
        using (var client = await host.AuthorizedAsync())
        {
            Check.Equal(0L, (await client.BeginAsync(manifest, zipped))["offset"]!.GetValue<long>());
            await client.UploadChunksAsync(zipped);
            var progress = DurableFiles.ReadJson<PartialProgress>(Path.Combine(Directory.EnumerateDirectories(partials.Root).Single(), "progress.json"));
            Check.Equal((long)zipped.Length, progress.Offset);
            var result = await client.RequestAsync(new { op = "finish" });
            receipt = result["receipt"]!.ToJsonString();
            Check.Equal(true, result["ok"]!.GetValue<bool>());
        }
        await host.DrainAsync();
        Check.Equal(receipt, (await f.UploadAsync(manifest, Gzip(wave), audioEncoding: "gzip")).Body["receipt"]!.ToJsonString());
        using (var client = await host.AuthorizedAsync())
            Check.Equal(receipt, (await client.BeginAsync(manifest, zipped))["receipt"]!.ToJsonString());
        Check.Equal(1, f.Store.Entries().Count());
        Check.Equal("pending", f.Store.ReadQueue(f.Store.Entries().Single()).Status);
        Check.True(wave.SequenceEqual(File.ReadAllBytes(Path.Combine(f.Store.Entries().Single(), "audio.wav"))));
        var lanFirst = Fixtures.Manifest();
        var lanReceipt = (await f.UploadAsync(lanFirst)).Body["receipt"]!.ToJsonString();
        using (var client = await host.AuthorizedAsync())
            Check.Equal(lanReceipt, (await client.BeginAsync(lanFirst, Gzip(Fixtures.Wave())))["receipt"]!.ToJsonString());
        using (var client = await host.AuthorizedAsync())
        {
            var conflict = manifest.DeepClone().AsObject();
            conflict["title"] = "must not replace archived metadata";
            Failure(await client.BeginAsync(conflict, zipped), 409);
        }
    }

    private static async Task ReconnectTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime);
        var wave = RandomWave();
        var manifest = Fixtures.Manifest(wave);
        var zipped = Gzip(wave);
        using (var partials = new ResumableUploadStore(root.Runtime, inbox))
        await using (var host = new RfcommTestHost(pairing, partials))
        {
            using (var client = await host.AuthorizedAsync())
            {
                await client.BeginAsync(manifest, zipped);
                await client.SendAsync(new { op = "chunk", offset = 0, length = 1024 });
                await client.Stream.WriteAsync(zipped.AsMemory(0, 10));
            }
            await host.DrainAsync();
            using (var client = await host.AuthorizedAsync())
            {
                Check.Equal(0L, (await client.BeginAsync(manifest, zipped))["offset"]!.GetValue<long>());
                await client.SendAsync(new { op = "chunk", offset = 0, length = 1024 });
                await client.Stream.WriteAsync(zipped.AsMemory(0, 1024));
                var progress = Path.Combine(Directory.EnumerateDirectories(partials.Root).Single(), "progress.json");
                await UntilAsync(() => ReadProgressWithoutBlockingRename(progress).Offset == 1024);
                // Drop the ACK rather than reading it; begin must still recover 1024.
            }
            await host.DrainAsync();
        }
        using (var partials = new ResumableUploadStore(root.Runtime, inbox))
        await using (var host = new RfcommTestHost(pairing, partials))
        {
            using (var client = await host.AuthorizedAsync())
            {
                Check.Equal(1024L, (await client.BeginAsync(manifest, zipped))["offset"]!.GetValue<long>());
                await client.UploadChunksAsync(zipped, 1024);
                await client.SendAsync(new { op = "finish" });
                await UntilAsync(() => inbox.Entries().Any());
                // Simulate losing the terminal receipt after atomic publication.
            }
            await host.DrainAsync();
            using var retry = await host.AuthorizedAsync();
            Check.True((await retry.BeginAsync(manifest, zipped))["receipt"] is not null);
            Check.Equal(1, inbox.Entries().Count());
        }
    }

    private static async Task FrameTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime);
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        await using var host = new RfcommTestHost(pairing, partials);
        foreach (var payload in new[] { "[]", "{", "{\"op\":\"health\",\"op\":\"auth\"}", "{\"op\":12}", "{\"op\":\"unknown\"}", "{\"op\":\"\\uD800\"}" })
        {
            using var client = await host.AuthorizedAsync();
            await RawFrame(client, Encoding.UTF8.GetBytes(payload));
            Failure(await client.ReadAsync(), 400);
        }
        foreach (var size in new uint[] { 0, Protocol.MaxFrameBytes + 1, uint.MaxValue })
        {
            using var client = await host.AuthorizedAsync();
            var header = new byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(header, size);
            await client.Stream.WriteAsync(header);
            Failure(await client.ReadAsync(), 400);
        }
        using (var client = await host.AuthorizedAsync())
        {
            await RawFrame(client, Encoding.ASCII.GetBytes("{\"op\":\"").Concat(new byte[] { 0xff }).Concat(Encoding.ASCII.GetBytes("\"}")).ToArray());
            Failure(await client.ReadAsync(), 400);
        }
        using (var client = await host.ConnectAsync())
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { op = "auth", token = pairing.Config.Token });
            await RawFrame(client, bytes, fragmented: true);
            Check.Equal(true, (await client.ReadAsync())["ok"]!.GetValue<bool>());
            var exact = Encoding.UTF8.GetBytes("{\"op\":\"health\",\"padding\":\"" + new string('a', Protocol.MaxFrameBytes - 28) + "\"}");
            Check.Equal(Protocol.MaxFrameBytes, exact.Length);
            await RawFrame(client, exact);
            Check.Equal(true, (await client.ReadAsync())["ok"]!.GetValue<bool>());
        }
        Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
    }

    private static async Task RawFrame(RfcommTestClient client, byte[] payload, bool fragmented = false)
    {
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(header, (uint)payload.Length);
        if (!fragmented) { await client.Stream.WriteAsync(header); await client.Stream.WriteAsync(payload); return; }
        foreach (var value in header.Concat(payload)) await client.Stream.WriteAsync(new byte[] { value });
    }

    private static async Task ChunkTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime);
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        await using var host = new RfcommTestHost(pairing, partials);
        var zipped = Gzip(RandomWave());
        foreach (var (offset, length, status) in new (long, long, int)[] { (-1, 1, 409), (1, 1, 409), (0, 0, 400), (0, 32769, 400), (0, long.MaxValue, 400) })
        {
            using var client = await host.AuthorizedAsync();
            await client.BeginAsync(Fixtures.Manifest(RandomWave()), zipped);
            Failure(await client.RequestAsync(new { op = "chunk", offset, length }), status);
        }
        using (var client = await host.AuthorizedAsync()) Failure(await client.RequestAsync(new { op = "finish" }), 409);
        using (var client = await host.AuthorizedAsync()) Failure(await client.RequestAsync(new { op = "chunk", offset = 0, length = 1 }), 409);
        using (var client = await host.AuthorizedAsync())
        {
            await client.BeginAsync(Fixtures.Manifest(RandomWave()), zipped);
            Failure(await client.RequestAsync(new { op = "finish" }), 409);
        }
        using (var client = await host.AuthorizedAsync())
        {
            var manifest = Fixtures.Manifest(RandomWave());
            await client.BeginAsync(manifest, zipped);
            Failure(await client.BeginAsync(manifest, zipped), 409);
        }
        using (var client = await host.AuthorizedAsync())
        {
            var shortZip = Gzip(Fixtures.Wave());
            await client.BeginAsync(Fixtures.Manifest(), shortZip);
            Failure(await client.RequestAsync(new { op = "chunk", offset = 0, length = shortZip.Length + 1 }), 409);
        }
        Check.Equal(0, inbox.Entries().Count());
    }

    private static async Task InvalidFinishTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime);
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        await using var host = new RfcommTestHost(pairing, partials);
        foreach (var mode in new[] { "compressed-hash", "gzip", "wav-hash", "wav-structure", "metadata", "bomb" })
        {
            var wave = Fixtures.Wave();
            if (mode == "wav-structure") wave[0] = 0;
            var manifest = Fixtures.Manifest(wave);
            if (mode == "wav-hash") manifest["sha256"] = new string('0', 64);
            if (mode == "metadata") manifest["sampleCount"] = 1500;
            var zipped = Gzip(mode == "bomb" ? new byte[Protocol.MaxAudioBytes + 1] : wave);
            if (mode == "gzip") zipped[^8] ^= 1;
            using (var client = await host.AuthorizedAsync())
            {
                await client.BeginAsync(manifest, zipped, mode == "compressed-hash" ? new string('0', 64) : null);
                await client.UploadChunksAsync(zipped);
                Failure(await client.RequestAsync(new { op = "finish" }), mode == "bomb" ? 413 : 400);
            }
            await host.DrainAsync();
            Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
        }
        Check.Equal(0, inbox.Entries().Count());
    }

    private static async Task CommitFailureTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        var fail = true;
        using var inbox = new InboxStore(root.Runtime, _ => { if (fail) throw new IOException("Private injected failure."); });
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        await using var host = new RfcommTestHost(pairing, partials);
        var manifest = Fixtures.Manifest();
        var zipped = Gzip(Fixtures.Wave());
        using (var client = await host.AuthorizedAsync())
        {
            await client.BeginAsync(manifest, zipped);
            await client.UploadChunksAsync(zipped);
            Failure(await client.RequestAsync(new { op = "finish" }), 503);
        }
        await host.DrainAsync();
        Check.Equal(0, inbox.Entries().Count());
        fail = false;
        using var retry = await host.AuthorizedAsync();
        Check.Equal((long)zipped.Length, (await retry.BeginAsync(manifest, zipped))["offset"]!.GetValue<long>());
        Check.True((await retry.RequestAsync(new { op = "finish" }))["receipt"] is not null);
    }

    private static async Task AdmissionTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        using var partials = new ResumableUploadStore(root.Runtime, f.Store);
        await using var host = new RfcommTestHost(f.Pairing, partials);
        var zipped = Gzip(Fixtures.Wave());
        var manifest = Fixtures.Manifest();
        using var first = (await partials.BeginAsync(Fixtures.Parse(manifest), Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!;
        var second = (await partials.BeginAsync(Fixtures.Parse(Fixtures.Manifest()), Fixtures.Hash(zipped), zipped.Length, CancellationToken.None)).Upload!;
        try
        {
            Check.Equal(503, (await f.UploadAsync(Fixtures.Manifest())).Status);
            using var client = await host.AuthorizedAsync();
            Failure(await client.BeginAsync(Fixtures.Manifest(), zipped), 503);
        }
        finally { second.Dispose(); }
        var receipt = (await f.UploadAsync(manifest)).Body["receipt"]!.ToJsonString();
        await first.AppendAsync(0, zipped, CancellationToken.None);
        var finished = await first.FinishAsync(CancellationToken.None);
        Check.Equal(receipt, JsonSerializer.SerializeToNode(finished, Protocol.Json)!.ToJsonString());
        Check.Equal(1, f.Store.Entries().Count());
    }

    private static async Task TimeoutTest()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime);
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        await using (var host = new RfcommTestHost(pairing, partials, TimeSpan.FromMilliseconds(300)))
        {
            using var client = await host.AuthorizedAsync();
            await client.BeginAsync(Fixtures.Manifest(), Gzip(Fixtures.Wave()));
            Failure(await client.ReadAsync(), 408);
            await host.DrainAsync();
            Check.Equal(2, inbox.UploadSlots.CurrentCount);
        }
        var cancelling = new RfcommTestHost(pairing, partials);
        using (var client = await cancelling.AuthorizedAsync())
        {
            await client.BeginAsync(Fixtures.Manifest(), Gzip(Fixtures.Wave()));
            await cancelling.DisposeAsync();
            Check.Equal(2, inbox.UploadSlots.CurrentCount);
        }
        Check.Equal(0, inbox.Entries().Count());
    }

    private static async Task DiscoveryTest()
    {
        Check.Equal(Windows.Networking.Sockets.SocketProtectionLevel.BluetoothEncryptionWithAuthentication,
            RfcommBridgeServer.RequiredProtection, "Bluetooth listener must never downgrade OS authentication/encryption.");
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        var original = File.ReadAllBytes(Pairing.ConfigPath(root.Runtime));
        var cert = File.ReadAllBytes(Path.Combine(root.Runtime, "bridge", "certificate.pfx"));
        var urls = new[] { "https://192.168.100.100:8787", "https://192.168.200.200:8787", "https://10.100.100.100:8787", "https://172.31.100.100:8787" };
        RfcommEndpoint? endpoint = new("12:34:56:AB:CD:EF", Protocol.RfcommServiceUuid);
        var buffer = new DiscoveryReadBuffer(() => BridgeDiscovery.Encode(pairing.Config.BridgeId, urls, endpoint));
        var expected = BridgeDiscovery.Encode(pairing.Config.BridgeId, urls, endpoint);
        Check.True(expected.Length <= 512);
        var first = buffer.Read("paired-test", 0, 30);
        endpoint = null;
        Check.True(first.Concat(buffer.Read("paired-test", 30, 512)).SequenceEqual(expected));
        var offline = JsonNode.Parse(buffer.Read("paired-test", 0, 512))!;
        Check.True(offline["bluetoothAddress"] is null && offline["rfcommServiceUuid"] is null);
        var online = JsonNode.Parse(expected)!;
        Check.Equal(2, online["schemaVersion"]!.GetValue<int>());
        Check.Equal("12:34:56:AB:CD:EF", online["bluetoothAddress"]!.GetValue<string>());
        Check.Equal(Protocol.RfcommServiceUuid, online["rfcommServiceUuid"]!.GetValue<string>());
        Check.Equal("12:34:56:AB:CD:EF", RfcommBridgeServer.FormatAddress(0x123456abcdef));
        await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => RfcommBridgeServer.FormatAddress(0)));
        await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => RfcommBridgeServer.FormatAddress(0x1000000000000)));
        await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeDiscovery.Encode(pairing.Config.BridgeId, [], new("12:34:56:ab:cd:ef", Protocol.RfcommServiceUuid))));
        using var unchanged = Pairing.Setup(root.Runtime, null);
        Check.True(original.SequenceEqual(File.ReadAllBytes(Pairing.ConfigPath(root.Runtime))));
        Check.True(cert.SequenceEqual(File.ReadAllBytes(Path.Combine(root.Runtime, "bridge", "certificate.pfx"))));
    }

    private static async Task OptionsTest()
    {
        using var root = new TestRoot();
        var probe = BridgeOptions.Parse(["--rfcomm-probe", "--repo-root", root.Root]);
        Check.Equal("--rfcomm-probe", probe.Mode);
        Check.True(!Directory.Exists(root.Runtime));
        var defaults = BridgeOptions.Parse(["--serve", "--repo-root", root.Root]);
        Check.True(!defaults.TranscribeOnly && !defaults.NoTranscribe && defaults.Database is null);
        Check.Equal("node", defaults.NodePath);
        var local = BridgeOptions.Parse(["--serve", "--transcribe-only", "--repo-root", root.Root]);
        Check.True(local.TranscribeOnly && !local.NoTranscribe && local.Database is null);
        foreach (var processingFlags in new[] { Array.Empty<string>(), new[] { "--no-transcribe" } })
        {
            var configured = BridgeOptions.Parse(["--serve", "--repo-root", root.Root,
                "--database", "isolated.sqlite", "--node", "fixture-node.exe", .. processingFlags]);
            Check.True(!configured.TranscribeOnly);
            Check.Equal(processingFlags.Length != 0, configured.NoTranscribe);
            Check.Equal(Path.Combine(root.Root, "isolated.sqlite"), configured.Database);
            Check.Equal("fixture-node.exe", configured.NodePath);
        }
        Check.True(!Directory.Exists(root.Runtime));
        foreach (var args in new[] { new[] { "--rfcomm-probe", "--serve" }, new[] { "--rfcomm-probe", "--transcribe-only" }, new[] { "--rfcomm-probe", "--database", "isolated.sqlite" }, new[] { "--rfcomm-probe", "--node", "node" } })
            await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeOptions.Parse(args)));
    }

    private static async Task UntilAsync(Func<bool> predicate)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!predicate()) await Task.Delay(10, deadline.Token);
    }

    private static PartialProgress ReadProgressWithoutBlockingRename(string path)
    {
        // This observer races the writer intentionally. File.ReadAllBytes denies
        // FILE_SHARE_DELETE and would itself prevent the atomic progress commit.
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return JsonSerializer.Deserialize<PartialProgress>(file, Protocol.Json)!;
    }
}
