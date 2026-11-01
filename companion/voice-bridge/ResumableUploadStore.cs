using System.Security.Cryptography;
using System.Text.Json;

namespace VoiceBridge;

internal sealed record PartialUploadLimits(long MaxReservedBytes = 128L * 1024 * 1024, int MaxFiles = 16,
    long MinFreeBytes = Protocol.MinFreeStorageBytes, TimeSpan? Retention = null)
{
    public TimeSpan Ttl => Retention ?? TimeSpan.FromHours(24);
}

internal sealed record PartialMetadata(RecordingManifest Manifest, string CompressedSha256, long CompressedSize);
internal sealed record PartialProgress(long Offset, DateTimeOffset UpdatedAt);
internal sealed record UploadBegin(ResumableUpload? Upload, RecordingReceipt? Receipt);

internal sealed class ResumableUploadStore : IDisposable
{
    private readonly InboxStore inbox;
    private readonly PartialUploadLimits limits;
    private readonly Func<DateTimeOffset> clock;
    private readonly Func<long> freeBytes;
    private readonly Action<string>? beforeProgressCommit;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly HashSet<string> active = new(StringComparer.Ordinal);
    public string Root { get; }

    public ResumableUploadStore(string runtimeRoot, InboxStore inbox, PartialUploadLimits? limits = null,
        Func<DateTimeOffset>? clock = null, Func<long>? freeBytes = null, Action<string>? beforeProgressCommit = null)
    {
        this.inbox = inbox;
        this.limits = limits ?? new();
        if (this.limits.MaxFiles < 1 || this.limits.MaxReservedBytes < 18 || this.limits.MinFreeBytes < 0 || this.limits.Ttl <= TimeSpan.Zero)
            throw new ArgumentException("Invalid partial upload limits.");
        this.clock = clock ?? (() => DateTimeOffset.UtcNow);
        Root = Path.Combine(runtimeRoot, "mobile-partials");
        Paths.PrivateDirectory(Root);
        this.freeBytes = freeBytes ?? (() => new DriveInfo(Path.GetPathRoot(Root)!).AvailableFreeSpace);
        this.beforeProgressCommit = beforeProgressCommit;
        SweepLocked();
        inbox.CleanupRegisteredCacheAsync = CleanupCompletedAsync;
    }

    internal Task<RecordingStatus> StatusAsync(RecordingQuery query, bool cleanupAck, CancellationToken ct) =>
        inbox.StatusAsync(query, cleanupAck, ct);

    private async Task<bool> CleanupCompletedAsync(RecordingManifest manifest, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var key = Key(manifest);
            if (active.Contains(key)) return false;
            var directory = Path.Combine(Root, key);
            Paths.RejectLinks(directory);
            if (!Directory.Exists(directory)) return true;
            var metadata = DurableFiles.ReadJson<PartialMetadata>(Path.Combine(directory, "upload.json"));
            if (metadata.Manifest != manifest) throw new IOException("Registered cache identity mismatch.");
            Remove(directory);
            return !Directory.Exists(directory);
        }
        finally { gate.Release(); }
    }

    public async Task<UploadBegin> BeginAsync(RecordingManifest manifest, string compressedSha256, long compressedSize, CancellationToken ct)
    {
        ValidateCompressed(compressedSha256, compressedSize);
        // Canonicalize even callers inside this assembly before reserving paths or bytes.
        manifest = RecordingManifest.Parse(JsonSerializer.SerializeToUtf8Bytes(manifest, Protocol.Json));
        if (!await inbox.UploadSlots.WaitAsync(0, ct)) throw new ClientFault(503, "Receiver busy.");
        var leased = false;
        try
        {
            await gate.WaitAsync(ct);
            try
            {
                var partials = SweepLocked();
                var key = Key(manifest);
                var directory = Path.Combine(Root, key);
                if (active.Contains(key)) throw new ClientFault(409, "Recording already has an active upload.");
                var receipt = await inbox.FindReceiptAsync(manifest, ct);
                if (receipt is not null)
                {
                    Remove(directory);
                    return new(null, receipt);
                }
                var metadata = new PartialMetadata(manifest, compressedSha256, compressedSize);
                var progress = new PartialProgress(0, clock());
                var existing = partials.Find(p => p.Directory == directory);
                if (existing is not null)
                {
                    if (existing.Metadata != metadata) throw new ClientFault(409, "Partial upload identity conflict.");
                    progress = existing.Progress;
                }
                else
                {
                    if (partials.Count >= limits.MaxFiles || partials.Sum(p => p.Metadata.CompressedSize) + compressedSize > limits.MaxReservedBytes)
                        throw new ClientFault(507, "Partial upload quota exceeded.");
                }
                var remaining = partials.Sum(p => p.Metadata.CompressedSize - p.Progress.Offset) + (existing is null ? compressedSize : 0);
                RequireSpace(remaining + 2L * Protocol.MaxAudioBytes);
                if (existing is null)
                {
                    var staging = Path.Combine(Root, "." + Guid.NewGuid().ToString("N") + ".staging");
                    Directory.CreateDirectory(staging);
                    try
                    {
                        DurableFiles.WriteJsonNew(Path.Combine(staging, "upload.json"), metadata);
                        DurableFiles.WriteNew(Path.Combine(staging, "compressed.part"), []);
                        DurableFiles.WriteJsonNew(Path.Combine(staging, "progress.json"), progress);
                        ct.ThrowIfCancellationRequested();
                        DurableFiles.Move(staging, directory);
                    }
                    finally { Remove(staging); }
                }
                else
                {
                    // Bytes written before a crash without a committed progress marker
                    // are not resumable. Truncate them before exposing the durable offset.
                    using var file = OpenPartial(directory);
                    file.SetLength(progress.Offset);
                    file.Flush(flushToDisk: true);
                    progress = progress with { UpdatedAt = clock() };
                    DurableFiles.ReplaceJson(Path.Combine(directory, "progress.json"), progress);
                }
                active.Add(key);
                leased = true;
                return new(new ResumableUpload(this, metadata, directory, progress.Offset), null);
            }
            finally { gate.Release(); }
        }
        finally { if (!leased) inbox.UploadSlots.Release(); }
    }

    internal async Task AppendAsync(ResumableUpload upload, long offset, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (data.Length is <= 0 or > Protocol.MaxChunkBytes) throw new ClientFault(400, "Invalid chunk length.");
            if (offset != upload.Offset || data.Length > upload.Metadata.CompressedSize - offset)
                throw new ClientFault(409, "Chunk offset or size conflict.");
            RequireSpace(data.Length + Protocol.MaxAudioBytes);
            using (var file = OpenPartial(upload.Directory))
            {
                if (file.Length != upload.Offset) throw new IOException("Partial length differs from durable progress.");
                file.Position = offset;
                await file.WriteAsync(data, ct);
                file.Flush(flushToDisk: true);
            }
            ct.ThrowIfCancellationRequested();
            beforeProgressCommit?.Invoke(upload.Directory);
            var next = offset + data.Length;
            DurableFiles.ReplaceJson(Path.Combine(upload.Directory, "progress.json"), new PartialProgress(next, clock()));
            upload.Offset = next;
        }
        finally { gate.Release(); }
    }

    internal async Task<RecordingReceipt> FinishAsync(ResumableUpload upload, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (upload.Offset != upload.Metadata.CompressedSize) throw new ClientFault(409, "Upload is incomplete.");
            byte[] compressed;
            using (var file = OpenPartial(upload.Directory))
                compressed = await CompressedAudio.ReadBoundedAsync(file, Protocol.MaxCompressedBytes, ct);
            if (compressed.Length != upload.Metadata.CompressedSize ||
                !CryptographicOperations.FixedTimeEquals(SHA256.HashData(compressed), Convert.FromHexString(upload.Metadata.CompressedSha256)))
                throw new ClientFault(400, "Compressed hash mismatch.");
            var audio = await CompressedAudio.DecodeAsync(compressed, ct);
            RequireSpace(audio.Length);
            var receipt = await inbox.StoreAsync(upload.Metadata.Manifest, audio, ct);
            Remove(upload.Directory);
            return receipt;
        }
        catch (ClientFault ex) when (ex.Status is 400 or 413)
        {
            Remove(upload.Directory);
            throw;
        }
        finally { gate.Release(); }
    }

    internal void Release(ResumableUpload upload)
    {
        gate.Wait();
        try { active.Remove(Key(upload.Metadata.Manifest)); }
        finally { gate.Release(); inbox.UploadSlots.Release(); }
    }

    public async Task SweepAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { SweepLocked(); }
        finally { gate.Release(); }
    }

    public async Task MaintainAsync(Action<string> log, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                try { await SweepAsync(ct); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                { log($"Partial cleanup unavailable: {ex.GetType().Name}."); }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    private sealed record Partial(string Directory, PartialMetadata Metadata, PartialProgress Progress);

    private List<Partial> SweepLocked()
    {
        Paths.RejectLinks(Root);
        var result = new List<Partial>();
        foreach (var directory in Directory.EnumerateDirectories(Root))
        {
            var key = Path.GetFileName(directory);
            Paths.RejectLinks(directory);
            if (key.Length == 41 && key[0] == '.' && key.EndsWith(".staging", StringComparison.Ordinal) &&
                Guid.TryParseExact(key.Substring(1, 32), "N", out _)) { Remove(directory); continue; }
            if (key.Length != 73 || key[36] != '_' || !Guid.TryParseExact(key[..36], "D", out _) || !Guid.TryParseExact(key[37..], "D", out _))
                throw new IOException("Unexpected directory in partial upload store.");
            PartialMetadata metadata;
            PartialProgress progress;
            try
            {
                metadata = DurableFiles.ReadJson<PartialMetadata>(Path.Combine(directory, "upload.json"));
                progress = DurableFiles.ReadJson<PartialProgress>(Path.Combine(directory, "progress.json"));
                var manifest = RecordingManifest.Parse(JsonSerializer.SerializeToUtf8Bytes(metadata.Manifest, Protocol.Json));
                ValidateCompressed(metadata.CompressedSha256, metadata.CompressedSize);
                Paths.RejectLinks(Path.Combine(directory, "compressed.part"));
                if (manifest != metadata.Manifest || key != Key(manifest) || progress.Offset < 0 || progress.Offset > metadata.CompressedSize ||
                    new FileInfo(Path.Combine(directory, "compressed.part")).Length < progress.Offset)
                    throw new IOException("Invalid partial upload state.");
            }
            catch (Exception ex) when (ex is IOException or JsonException or ClientFault)
            {
                if (active.Contains(key)) throw new IOException("Active partial state failed validation.");
                Remove(directory);
                continue;
            }
            if (!active.Contains(key) && clock() - progress.UpdatedAt >= limits.Ttl) { Remove(directory); continue; }
            result.Add(new(directory, metadata, progress));
        }
        return result;
    }

    private static void ValidateCompressed(string hash, long size)
    {
        if (!Pairing.IsHex(hash, 64) || hash != hash.ToLowerInvariant()) throw new ClientFault(400, "Invalid compressed SHA-256.");
        if (size < 18) throw new ClientFault(400, "Invalid compressed size.");
        if (size > Protocol.MaxCompressedBytes) throw new ClientFault(413, "Compressed payload too large.");
    }

    private void RequireSpace(long bytes)
    {
        if (freeBytes() - limits.MinFreeBytes < bytes) throw new ClientFault(507, "Insufficient free storage.");
    }

    private static string Key(RecordingManifest manifest) => manifest.DeviceId + "_" + manifest.RecordingId;

    private static FileStream OpenPartial(string directory)
    {
        var path = Path.Combine(directory, "compressed.part");
        Paths.RejectLinks(path);
        return new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 65536, FileOptions.Asynchronous | FileOptions.WriteThrough);
    }

    private void Remove(string directory)
    {
        if (!Paths.IsWithin(Root, directory)) throw new IOException("Partial path escaped its root.");
        if (!Directory.Exists(directory)) return;
        Paths.RejectLinks(directory);
        foreach (var path in Directory.EnumerateFiles(directory, "progress.json.*.tmp"))
        {
            Paths.RejectLinks(path);
            File.Delete(path);
        }
        DurableFiles.RemoveStage(directory, "compressed.part", "upload.json", "progress.json");
    }

    public void Dispose()
    {
        inbox.CleanupRegisteredCacheAsync = null;
        gate.Dispose();
    }
}

internal sealed class ResumableUpload(ResumableUploadStore owner, PartialMetadata metadata, string directory, long offset) : IDisposable
{
    private int disposed;
    public PartialMetadata Metadata { get; } = metadata;
    public string Directory { get; } = directory;
    public long Offset { get; internal set; } = offset;

    public Task AppendAsync(long position, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        return owner.AppendAsync(this, position, data, ct);
    }

    public Task<RecordingReceipt> FinishAsync(CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(disposed != 0, this);
        return owner.FinishAsync(this, ct);
    }

    public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) owner.Release(this); }
}
