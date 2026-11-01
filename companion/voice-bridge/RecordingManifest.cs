using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace VoiceBridge;

internal sealed record RecordingManifest(
    string DeviceId, string RecordingId, string ConversationId, string RecordedAt, string Sha256,
    int SampleRateHz, long SampleCount, int Channels, double DurationMs,
    string TimeBasis, double? TimeUncertaintyMs, string? Title, bool TestOnly,
    string AudioPath = "audio.wav", string Source = "android_ble_bridge",
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool CleanupAfterTranscription = false,
    string? Kind = null, string? PackageId = null, int PartIndex = 0,
    string? PreviousRecordingId = null, bool FinalPart = true)
{
    public bool IsStandardPackagePart => Kind == "voice-recording-package-part";

    public static RecordingManifest Parse(ReadOnlyMemory<byte> json)
    {
        if (json.Length > Protocol.MaxManifestBytes) throw new ClientFault(413, "Manifest exceeds 32 KiB.");
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new ClientFault(400, "Manifest must be a JSON object.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject())
            if (!names.Add(field.Name)) throw new ClientFault(400, "Duplicate manifest property.");
        var device = Protocol.Uuid(Text(root, "deviceId"), "deviceId");
        var recording = Protocol.Uuid(Text(root, "recordingId"), "recordingId");
        var conversation = Protocol.Uuid(Text(root, "conversationId", optional: true) ?? recording, "conversationId");
        var recordedAt = Text(root, "recordedAt")!;
        if (!Regex.IsMatch(recordedAt, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$", RegexOptions.CultureInvariant) ||
            !DateTimeOffset.TryParse(recordedAt, CultureInfo.InvariantCulture, DateTimeStyles.None, out var at))
            throw new ClientFault(400, "recordedAt requires an ISO timestamp with timezone.");
        var sha = Text(root, "sha256");
        if (!Pairing.IsHex(sha, 64)) throw new ClientFault(400, "sha256 must be a 64-character hexadecimal digest of the WAV file.");
        var sampleRate = Integer(root, "sampleRateHz");
        var channels = Integer(root, "channels");
        var sampleCount = Integer(root, "sampleCount");
        var duration = Number(root, "durationMs");
        if (sampleRate != 16000 || channels != 1 || sampleCount <= 0 || sampleCount > Protocol.MaxAudioBytes / 2 || duration <= 0)
            throw new ClientFault(400, "Only nonempty PCM16 mono 16000 Hz recordings are accepted.");
        var basis = Text(root, "timeBasis", optional: true) ?? "device_unverified";
        double? uncertainty = root.TryGetProperty("timeUncertaintyMs", out var u) && u.ValueKind != JsonValueKind.Null
            ? Number(root, "timeUncertaintyMs") : null;
        if (uncertainty < 0) throw new ClientFault(400, "timeUncertaintyMs must be nonnegative.");
        var title = Text(root, "title", optional: true, max: 120);
        var testOnly = false;
        if (root.TryGetProperty("testOnly", out var test))
        {
            if (test.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new ClientFault(400, "testOnly must be boolean.");
            testOnly = test.GetBoolean();
        }
        var cleanup = false;
        if (root.TryGetProperty("cleanupAfterTranscription", out var cleanupValue))
        {
            if (cleanupValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new ClientFault(400, "cleanupAfterTranscription must be boolean.");
            cleanup = cleanupValue.GetBoolean();
        }
        var kind = Text(root, "kind", optional: true, max: 64);
        string? packageId = null;
        string? previous = null;
        var partIndex = 0;
        var finalPart = true;
        if (kind is not null)
        {
            if (kind != "voice-recording-package-part")
                throw new ClientFault(400, "Unsupported recording package kind.");
            packageId = Protocol.Uuid(Text(root, "packageId"), "packageId");
            var parsedPart = Integer(root, "partIndex");
            if (parsedPart < 0 || parsedPart > 100_000) throw new ClientFault(400, "partIndex is outside the supported range.");
            partIndex = (int)parsedPart;
            previous = Text(root, "previousRecordingId", optional: true);
            if (previous is not null)
            {
                previous = Protocol.Uuid(previous, "previousRecordingId");
                if (previous == recording) throw new ClientFault(400, "A package part cannot reference itself.");
            }
            if ((partIndex == 0) != (previous is null))
                throw new ClientFault(400, "The first package part cannot have a predecessor; later parts require one.");
            if (!root.TryGetProperty("finalPart", out var finalValue) ||
                finalValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new ClientFault(400, "finalPart must be boolean for a recording package part.");
            finalPart = finalValue.GetBoolean();
        }
        // Omit false during serialization to preserve legacy receipt/transcript identity hashes.
        // Never retain caller-controlled audioPath, filenames, or import/runtime/database options.
        return new(device, recording, conversation, Protocol.Utc(at), sha!.ToLowerInvariant(), (int)sampleRate,
            sampleCount, (int)channels, duration, basis, uncertainty, title, testOnly,
            CleanupAfterTranscription: cleanup, Kind: kind, PackageId: packageId, PartIndex: partIndex,
            PreviousRecordingId: previous, FinalPart: finalPart);
    }

    public string IdentityHash() => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(this, Protocol.Json))).ToLowerInvariant();

    private static string? Text(JsonElement root, string key, bool optional = false, int max = 128)
    {
        if ((!root.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null) && optional) return null;
        if (value.ValueKind != JsonValueKind.String) throw new ClientFault(400, $"{key} must be a string.");
        var text = value.GetString()!;
        if (text.Length == 0 || text.Length > max || text.Any(char.IsControl)) throw new ClientFault(400, $"Invalid {key}.");
        return text;
    }

    private static long Integer(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var number))
            throw new ClientFault(400, $"{key} must be an integer.");
        return number;
    }

    private static double Number(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Number ||
            !value.TryGetDouble(out var number) || !double.IsFinite(number)) throw new ClientFault(400, $"Invalid {key}.");
        return number;
    }
}
