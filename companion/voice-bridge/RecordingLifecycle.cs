using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace VoiceBridge;

internal sealed record RecordingQuery(string DeviceId, string RecordingId, string Sha256, bool SupportsRetention = false)
{
    public static RecordingQuery Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new ClientFault(400, "Expected an object.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject())
            if (!names.Add(field.Name)) throw new ClientFault(400, "Duplicate query property.");
        var device = Protocol.Uuid(RfcommFrames.Text(root, "deviceId"), "deviceId");
        var recording = Protocol.Uuid(RfcommFrames.Text(root, "recordingId"), "recordingId");
        var sha = RfcommFrames.Text(root, "sha256");
        if (!Pairing.IsHex(sha, 64)) throw new ClientFault(400, "Invalid audio SHA-256.");
        var supportsRetention = false;
        if (root.TryGetProperty("supportsRetention", out var support))
        {
            if (support.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new ClientFault(400, "Invalid retention capability.");
            supportsRetention = support.GetBoolean();
        }
        return new(device, recording, sha.ToLowerInvariant(), supportsRetention);
    }
}

internal sealed record RecordingStatus(bool Ok, string RecordingId, string Sha256, string ProcessingStatus,
    bool AudioDeleted, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? PhoneAudioDeleted = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool RetainAudio = false);

// One bounded record per recording; no snapshots or transcript text in transport responses.
internal sealed record RecordingCompletion(int SchemaVersion, StoredReceipt Stored, string TranscriptSha256,
    string CompletedAt, bool AudioDeleted = false, bool PhoneAudioDeleted = false);

internal sealed partial class InboxStore
{
    internal Func<RecordingManifest, CancellationToken, Task<bool>>? CleanupRegisteredCacheAsync { get; set; }

    private static bool IsRetained(InboxEntry entry)
    {
        var path = Path.Combine(entry.Directory, "retain-audio.json");
        Paths.RejectLinks(path);
        // Even an unreadable/malformed marker blocks deletion. Retention does not
        // expire just because a later receiver was started without the test flag.
        return File.Exists(path) || Directory.Exists(path);
    }

    private RecordingCompletion? ReadCompletion(InboxEntry entry)
    {
        var path = Path.Combine(entry.Directory, "tombstone.json");
        Paths.RejectLinks(path);
        if (!File.Exists(path)) return null;
        var completion = DurableFiles.ReadJson<RecordingCompletion>(path);
        if (completion.SchemaVersion != 1 || completion.Stored != entry.Stored ||
            !DateTimeOffset.TryParse(completion.CompletedAt, out _) ||
            LocalRecordingTranscriber.ReadCached(entry) is not { } transcript ||
            transcript.CompletedAt != completion.CompletedAt || TranscriptHash(entry) != completion.TranscriptSha256)
            throw new IOException("Completion proof or persisted transcript failed verification.");
        return completion;
    }

    private static string TranscriptHash(InboxEntry entry)
    {
        var path = Path.Combine(entry.Directory, "transcript.json");
        Paths.RejectLinks(path);
        if (new FileInfo(path).Length > LocalRecordingTranscriber.MaxTranscriptBytes)
            throw new IOException("Oversized transcript.");
        return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    }

    internal async Task CompleteLocalAsync(InboxEntry entry, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            entry = ReadEntry(entry.Directory);
            if (ReadCompletion(entry) is not null) return;
            var transcript = LocalRecordingTranscriber.ReadCached(entry)
                ?? throw new IOException("Local transcript is not durably verifiable.");
            var completion = new RecordingCompletion(1, entry.Stored, TranscriptHash(entry), transcript.CompletedAt);
            DurableFiles.ReplaceJson(Path.Combine(entry.Directory, "tombstone.json"), completion);
            _ = ReadCompletion(entry) ?? throw new IOException("Completion proof was not persisted.");
        }
        finally { gate.Release(); }
    }

    internal bool HasCompletion(string directory) => ReadCompletion(ReadEntry(directory)) is not null;

    internal async Task CleanupCompletedAsync(string directory, CancellationToken ct)
    {
        var entry = ReadEntry(directory);
        if (IsRetained(entry) || !entry.Manifest.CleanupAfterTranscription || ReadCompletion(entry) is null) return;
        // Never hold the inbox gate while acquiring the partial-store gate (uploads acquire in that order).
        if (CleanupRegisteredCacheAsync is { } cleanup)
        {
            if (!await cleanup(entry.Manifest, ct)) return;
        }
        else
        {
            var cache = Path.Combine(Path.GetDirectoryName(root)!, "mobile-partials",
                entry.Manifest.DeviceId + "_" + entry.Manifest.RecordingId);
            Paths.RejectLinks(cache);
            if (Directory.Exists(cache)) return; // No owner available to prove that the cache has no active reader.
        }
        await gate.WaitAsync(ct);
        try
        {
            entry = ReadEntry(directory);
            if (IsRetained(entry)) return;
            var completion = ReadCompletion(entry) ?? throw new IOException("Missing completion proof.");
            var audio = Path.Combine(directory, "audio.wav");
            Paths.RejectLinks(audio);
            if (File.Exists(audio))
            {
                if (new FileInfo(audio).Length > Protocol.MaxAudioBytes) throw new IOException("Oversized WAV.");
                WaveValidator.Validate(File.ReadAllBytes(audio), entry.Manifest);
                File.Delete(audio);
            }
            if (File.Exists(audio) || Directory.Exists(audio)) throw new IOException("Audio deletion not confirmed.");
            if (!completion.AudioDeleted)
                DurableFiles.ReplaceJson(Path.Combine(directory, "tombstone.json"), completion with { AudioDeleted = true });
        }
        finally { gate.Release(); }
    }

    public async Task<RecordingStatus> StatusAsync(RecordingQuery query, bool cleanupAck, CancellationToken ct)
    {
        query = RecordingQuery.Parse(JsonSerializer.SerializeToElement(query, Protocol.Json));
        await gate.WaitAsync(ct);
        try
        {
            var directory = Path.Combine(root, query.DeviceId, query.RecordingId);
            Paths.RejectLinks(directory);
            if (!Directory.Exists(directory)) throw new ClientFault(404, "Unknown recording.");
            var entry = ReadEntry(directory);
            if (entry.Manifest.Sha256 != query.Sha256) throw new ClientFault(409, "Recording hash mismatch.");
            var completion = ReadCompletion(entry);
            if (cleanupAck)
            {
                if (completion is null || IsRetained(entry) || !entry.Manifest.CleanupAfterTranscription)
                    throw new ClientFault(409, "Recording is not eligible for cleanup acknowledgement.");
                if (!completion.PhoneAudioDeleted)
                {
                    completion = completion with { PhoneAudioDeleted = true };
                    DurableFiles.ReplaceJson(Path.Combine(directory, "tombstone.json"), completion);
                    completion = ReadCompletion(entry) ?? throw new IOException("Cleanup acknowledgement not persisted.");
                }
            }
            var status = completion is not null ? "completed" : ReadQueue(directory).Status switch
            {
                "pending" => "pending", "failed" => "failed", _ => "processing"
            };
            var audioPath = Path.Combine(directory, "audio.wav");
            var deleted = completion?.AudioDeleted == true && !File.Exists(audioPath) && !Directory.Exists(audioPath);
            var retained = IsRetained(entry);
            // Old apps delete on 'completed' alone. Never authorize that path for
            // retained recordings; newer clients can display the true ASR state.
            if (retained && !query.SupportsRetention && status == "completed") status = "processing";
            return new(true, query.RecordingId, query.Sha256, status, deleted,
                cleanupAck ? completion!.PhoneAudioDeleted : null, retained);
        }
        finally { gate.Release(); }
    }
}
