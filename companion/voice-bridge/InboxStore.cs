using System.Text.Json;

namespace VoiceBridge;

internal sealed record RecordingReceipt(string RecordingId, string Sha256, string StoredAt);
internal sealed record StoredReceipt(string DeviceId, string IdentityHash, RecordingReceipt Receipt);
internal sealed record QueueState(string Status, int Attempts, string UpdatedAt, string? NextAttemptAt = null,
    string? LastError = null, string? ImportedRecordingId = null);
internal sealed record InboxEntry(string Directory, RecordingManifest Manifest, StoredReceipt Stored);
internal sealed class RecordingPackagePendingException(string message) : IOException(message);

internal sealed partial class InboxStore : IDisposable
{
    private readonly string root;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Action<string>? beforeCommit;
    private readonly Func<long> freeBytes;
    private readonly bool retainAudio;
    public string Root => root;
    public SemaphoreSlim UploadSlots { get; } = new(2, 2);

    public InboxStore(string runtimeRoot, Action<string>? beforeCommit = null, Func<long>? freeBytes = null,
        bool retainAudio = false)
    {
        root = Path.Combine(runtimeRoot, "mobile-inbox");
        Paths.PrivateDirectory(root);
        this.beforeCommit = beforeCommit;
        this.retainAudio = retainAudio;
        this.freeBytes = freeBytes ?? (() => new DriveInfo(Path.GetPathRoot(root)!).AvailableFreeSpace);
    }

    public async Task<RecordingReceipt> StoreAsync(RecordingManifest manifest, byte[] audio, CancellationToken cancellationToken)
    {
        WaveValidator.Validate(audio, manifest);
        await gate.WaitAsync(cancellationToken);
        try
        {
            var deviceRoot = Path.Combine(root, Protocol.Uuid(manifest.DeviceId, "deviceId"));
            var destination = Path.Combine(deviceRoot, Protocol.Uuid(manifest.RecordingId, "recordingId"));
            Paths.RejectLinks(destination);
            var identity = manifest.IdentityHash();
            if (Directory.Exists(destination))
            {
                var stored = ReadEntry(destination);
                if (stored.Stored.IdentityHash != identity) throw new ClientFault(409, "Recording identity already exists with different content or metadata.");
                return stored.Stored.Receipt;
            }
            if (freeBytes() - Protocol.MinFreeStorageBytes < audio.Length + 64 * 1024L)
                throw new ClientFault(507, "Insufficient free storage.");
            Directory.CreateDirectory(deviceRoot);
            var temporary = Path.Combine(deviceRoot, "." + Guid.NewGuid().ToString("N") + ".staging");
            Directory.CreateDirectory(temporary);
            try
            {
                var receipt = new RecordingReceipt(manifest.RecordingId, manifest.Sha256, Protocol.Utc(DateTimeOffset.UtcNow));
                DurableFiles.WriteNew(Path.Combine(temporary, "audio.wav"), audio);
                DurableFiles.WriteJsonNew(Path.Combine(temporary, "manifest.json"), manifest);
                DurableFiles.WriteJsonNew(Path.Combine(temporary, "receipt.json"), new StoredReceipt(manifest.DeviceId, identity, receipt));
                DurableFiles.WriteJsonNew(Path.Combine(temporary, "queue.json"), new QueueState("pending", 0, receipt.StoredAt));
                if (retainAudio)
                    DurableFiles.WriteJsonNew(Path.Combine(temporary, "retain-audio.json"), new { reason = "explicit-test-retention", retainedAt = receipt.StoredAt });
                cancellationToken.ThrowIfCancellationRequested();
                beforeCommit?.Invoke(temporary);
                // Publish audio, receipts and the optional retention decision together.
                DurableFiles.Move(temporary, destination);
                return receipt;
            }
            finally { DurableFiles.RemoveStage(temporary, "audio.wav", "manifest.json", "receipt.json", "queue.json", "retain-audio.json"); }
        }
        finally { gate.Release(); }
    }

    public async Task<RecordingReceipt?> FindReceiptAsync(RecordingManifest manifest, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var destination = Path.Combine(root, Protocol.Uuid(manifest.DeviceId, "deviceId"), Protocol.Uuid(manifest.RecordingId, "recordingId"));
            Paths.RejectLinks(destination);
            if (!Directory.Exists(destination)) return null;
            var entry = ReadEntry(destination);
            if (entry.Stored.IdentityHash != manifest.IdentityHash()) throw new ClientFault(409, "Recording identity conflict.");
            return entry.Stored.Receipt;
        }
        finally { gate.Release(); }
    }

    public InboxEntry ReadEntry(string directory)
    {
        var manifest = ReadManifest(directory);
        var receiptPath = Path.Combine(directory, "receipt.json");
        Paths.RejectLinks(receiptPath);
        var stored = File.Exists(receiptPath)
            ? DurableFiles.ReadJson<StoredReceipt>(receiptPath)
            : DurableFiles.ReadJson<RecordingCompletion>(Path.Combine(directory, "tombstone.json")).Stored;
        if (Path.GetFileName(directory) != manifest.RecordingId || Path.GetFileName(Path.GetDirectoryName(directory)) != manifest.DeviceId ||
            stored.DeviceId != manifest.DeviceId || stored.Receipt.RecordingId != manifest.RecordingId ||
            stored.Receipt.Sha256 != manifest.Sha256 || stored.IdentityHash != manifest.IdentityHash())
            throw new IOException("Persisted inbox identity failed verification.");
        var audioPath = Path.Combine(directory, "audio.wav");
        Paths.RejectLinks(audioPath);
        var entry = new InboxEntry(directory, manifest, stored);
        var completion = ReadCompletion(entry);
        if (completion is not null) return entry;
        if (new FileInfo(audioPath).Length > Protocol.MaxAudioBytes) throw new IOException("Oversized persisted WAV.");
        WaveValidator.Validate(File.ReadAllBytes(audioPath), manifest);
        return entry;
    }

    private RecordingManifest ReadManifest(string directory)
    {
        if (!Paths.IsWithin(root, directory)) throw new IOException("Inbox path is outside the configured root.");
        Paths.RejectLinks(directory);
        var manifestPath = Path.Combine(directory, "manifest.json");
        if (new FileInfo(manifestPath).Length > Protocol.MaxManifestBytes) throw new IOException("Oversized persisted manifest.");
        Paths.RejectLinks(manifestPath);
        var manifestBytes = File.ReadAllBytes(manifestPath);
        using (var json = JsonDocument.Parse(manifestBytes))
            if (!json.RootElement.TryGetProperty("audioPath", out var audio) || audio.ValueKind != JsonValueKind.String || audio.GetString() != "audio.wav")
                throw new IOException("Persisted audioPath is not the fixed inbox WAV path.");
        return RecordingManifest.Parse(manifestBytes);
    }

    public IEnumerable<string> Entries()
    {
        Paths.RejectLinks(root);
        foreach (var device in Directory.EnumerateDirectories(root).Order(StringComparer.Ordinal))
        {
            if (!IsCanonicalUuid(Path.GetFileName(device))) continue;
            Paths.RejectLinks(device);
            foreach (var recording in Directory.EnumerateDirectories(device).Order(StringComparer.Ordinal))
                if (IsCanonicalUuid(Path.GetFileName(recording)))
                {
                    Paths.RejectLinks(recording);
                    yield return recording;
                }
        }
    }

    public IReadOnlyList<InboxEntry> RecordingPackage(InboxEntry current)
    {
        if (!current.Manifest.IsStandardPackagePart) return [current];
        var deviceRoot = Path.GetDirectoryName(current.Directory)
            ?? throw new IOException("Recording package has no device directory.");
        Paths.RejectLinks(deviceRoot);
        var members = Directory.EnumerateDirectories(deviceRoot)
            .Where(directory => IsCanonicalUuid(Path.GetFileName(directory)))
            .Select(directory => (Directory: directory, Manifest: ReadManifest(directory)))
            .Where(item => item.Manifest.IsStandardPackagePart &&
                item.Manifest.DeviceId == current.Manifest.DeviceId &&
                item.Manifest.PackageId == current.Manifest.PackageId)
            .Select(item => ReadEntry(item.Directory))
            .OrderBy(entry => entry.Manifest.PartIndex).ToArray();
        if (!members.Any(entry => entry.Manifest.RecordingId == current.Manifest.RecordingId))
            throw new IOException("Current recording package part disappeared from the inbox.");
        if (members.Length == 0 || !members[^1].Manifest.FinalPart)
            throw new RecordingPackagePendingException("Waiting for the final recording package part.");
        if (members.Length != members[^1].Manifest.PartIndex + 1)
            throw new RecordingPackagePendingException("Waiting for a missing recording package part.");
        string? previous = null;
        for (var index = 0; index < members.Length; index++)
        {
            var manifest = members[index].Manifest;
            if (manifest.PartIndex != index || manifest.PreviousRecordingId != previous ||
                (index + 1 < members.Length && manifest.FinalPart))
                throw new IOException("Recording package sequence or predecessor chain is invalid.");
            previous = manifest.RecordingId;
        }
        return members;
    }

    public QueueState ReadQueue(string directory)
    {
        if (!Paths.IsWithin(root, directory)) throw new IOException("Queue path is outside the inbox.");
        var state = DurableFiles.ReadJson<QueueState>(Path.Combine(directory, "queue.json"));
        if (state.Status is not ("pending" or "processing" or "failed" or "transcribed") || state.Attempts < 0)
            throw new IOException("Invalid persisted queue state.");
        return state;
    }

    public void WriteQueue(string directory, QueueState state)
    {
        if (!Paths.IsWithin(root, directory)) throw new IOException("Queue path is outside the inbox.");
        DurableFiles.ReplaceJson(Path.Combine(directory, "queue.json"), state);
    }

    private static bool IsCanonicalUuid(string name) => Guid.TryParseExact(name, "D", out var id) && id != Guid.Empty && name == id.ToString("D");
    public void Dispose() { gate.Dispose(); UploadSlots.Dispose(); }
}
