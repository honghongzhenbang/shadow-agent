using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VoiceBridge;

internal interface IRecordingTranscriber
{
    Task<LocalTranscript> TranscribeAsync(InboxEntry entry, CancellationToken cancellationToken);
}

internal sealed record LocalTranscript(int SchemaVersion, string ProcessingMode, string DeviceId, string RecordingId,
    string AudioSha256, string ManifestIdentityHash, bool TestOnly, string CompletedAt, JsonElement Result,
    string? LogicalRecordingId = null, IReadOnlyList<SourcePackagePart>? SourcePackages = null);
internal sealed record SourcePackagePart(string RecordingId, string AudioSha256, int PartIndex,
    long StartSample, long EndSample);

internal sealed record LocalAsrProcessResult(int ExitCode, string StandardOutput, string StandardError);

internal interface ILocalAsrRunner
{
    Task<LocalAsrProcessResult> RunAsync(ProcessStartInfo startInfo, CancellationToken cancellationToken);
}

internal sealed class LocalRecordingTranscriber : IRecordingTranscriber
{
    internal const string ProcessingMode = "local-transcription";
    internal const int MaxTranscriptBytes = 4 * 1024 * 1024;
    private readonly BridgeOptions options;
    private readonly ILocalAsrRunner runner;
    private readonly InboxStore? store;

    public LocalRecordingTranscriber(BridgeOptions options, ILocalAsrRunner? runner = null, InboxStore? store = null)
    {
        if (!options.TranscribeOnly || options.NoTranscribe || options.Database is not null)
            throw new ArgumentException("Local transcription requires --transcribe-only without --no-transcribe or --database.");
        this.options = options;
        this.runner = runner ?? new LocalAsrProcessRunner();
        this.store = store;
    }

    internal ProcessStartInfo StartInfo(InboxEntry entry)
        => StartInfo([entry]);

    private ProcessStartInfo StartInfo(IReadOnlyList<InboxEntry> entries)
    {
        foreach (var member in entries) ValidateDirectory(member);
        var entry = entries[0];
        var script = Path.Combine(options.RepoRoot, "scripts", "voice-runtime", "asr.py");
        // runtime_common.py fixes packages to script ROOT/runtime/voice, not the phone intake runtime.
        var models = Path.Combine(options.RepoRoot, "runtime", "voice", "models");
        Paths.RejectLinks(script);
        Paths.RejectLinks(models);
        var info = new ProcessStartInfo(@"D:\anaconda\python.exe")
        {
            WorkingDirectory = entry.Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var argument in new[]
        {
            "-I", "-B", script, "--audio", Path.Combine(entry.Directory, "audio.wav"),
            "--model-dir", models, "--output", "json", "--language", "zh", "--threads", "2",
            "--diarization", options.SpeakerClusters ? "vad-cluster" : "none", "--max-seconds", "600"
        }) info.ArgumentList.Add(argument);
        foreach (var continuation in entries.Skip(1))
        {
            info.ArgumentList.Add("--continuation-audio");
            info.ArgumentList.Add(Path.Combine(continuation.Directory, "audio.wav"));
        }
        foreach (var name in new[] { "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS" })
            info.Environment[name] = "2";
        info.Environment["HF_HUB_OFFLINE"] = "1";
        info.Environment["TRANSFORMERS_OFFLINE"] = "1";
        return info;
    }

    public async Task<LocalTranscript> TranscribeAsync(InboxEntry entry, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var cached = ReadCached(entry);
        if (cached is not null) return cached;
        var entries = entry.Manifest.IsStandardPackagePart
            ? store?.RecordingPackage(entry) ?? throw new IOException("Standard recording packages require the inbox package resolver.")
            : [entry];
        foreach (var member in entries) ValidateAudio(member);

        var output = await runner.RunAsync(StartInfo(entries), cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (output.ExitCode != 0)
            throw new IOException($"Local ASR exited {output.ExitCode}: {ErrorDetail(output.StandardError)}");
        if (Encoding.UTF8.GetByteCount(output.StandardOutput) > MaxTranscriptBytes)
            throw new IOException("Local ASR result exceeds the transcript size limit.");
        JsonElement result;
        try
        {
            using var document = JsonDocument.Parse(output.StandardOutput, new JsonDocumentOptions { MaxDepth = 16 });
            ValidateResult(document.RootElement, entries.Sum(member => member.Manifest.SampleCount),
                entry.Manifest.SampleRateHz, entry.Manifest.Channels);
            if (Text(document.RootElement.GetProperty("diarization"), "mode") != (options.SpeakerClusters ? "vad-cluster" : "none"))
                throw new IOException("ASR did not use the requested diarization mode.");
            result = document.RootElement.Clone();
        }
        catch (JsonException ex) { throw new IOException("Local ASR returned invalid JSON; retry is pending.", ex); }

        // The ASR response has no digest. Bind it only after rechecking the exact WAV and persisted receipt.
        foreach (var member in entries) ValidateAudio(member);
        cancellationToken.ThrowIfCancellationRequested();
        var completedAt = Protocol.Utc(DateTimeOffset.UtcNow);
        long cursor = 0;
        var sources = entries.Select(member => {
            var start = cursor;
            cursor += member.Manifest.SampleCount;
            return new SourcePackagePart(member.Manifest.RecordingId, member.Manifest.Sha256,
                member.Manifest.PartIndex, start, cursor);
        }).ToArray();
        foreach (var member in entries)
        {
            var transcript = new LocalTranscript(1, ProcessingMode, member.Manifest.DeviceId,
                member.Manifest.RecordingId, member.Manifest.Sha256, member.Stored.IdentityHash,
                member.Manifest.TestOnly, completedAt, result,
                member.Manifest.PackageId ?? member.Manifest.RecordingId, sources);
            if (JsonSerializer.SerializeToUtf8Bytes(transcript, Protocol.Json).Length > MaxTranscriptBytes)
                throw new IOException("Local transcript exceeds the persisted size limit.");
            DurableFiles.ReplaceJson(Path.Combine(member.Directory, "transcript.json"), transcript);
        }
        return ReadCached(entry) ?? throw new IOException("Persisted transcript failed readback verification.");
    }

    private void ValidateDirectory(InboxEntry entry)
    {
        var expected = Path.Combine(options.RuntimeRoot, "mobile-inbox",
            Protocol.Uuid(entry.Manifest.DeviceId, "deviceId"), Protocol.Uuid(entry.Manifest.RecordingId, "recordingId"));
        if (!string.Equals(Path.GetFullPath(entry.Directory), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
            throw new IOException("Local transcription is restricted to the configured phone intake directory.");
        Paths.RejectLinks(entry.Directory);
        if (entry.Manifest.AudioPath != "audio.wav" || entry.Stored.DeviceId != entry.Manifest.DeviceId ||
            entry.Stored.Receipt.RecordingId != entry.Manifest.RecordingId || entry.Stored.Receipt.Sha256 != entry.Manifest.Sha256 ||
            entry.Stored.IdentityHash != entry.Manifest.IdentityHash())
            throw new IOException("Local transcription receipt/manifest identity mismatch.");
    }

    private void ValidateAudio(InboxEntry entry)
    {
        ValidateDirectory(entry);
        var audio = Path.Combine(entry.Directory, "audio.wav");
        Paths.RejectLinks(audio);
        if (new FileInfo(audio).Length > Protocol.MaxAudioBytes) throw new IOException("Oversized local WAV.");
        WaveValidator.Validate(File.ReadAllBytes(audio), entry.Manifest);
    }

    internal static LocalTranscript? ReadCached(InboxEntry entry)
    {
        var path = Path.Combine(entry.Directory, "transcript.json");
        Paths.RejectLinks(path);
        if (!File.Exists(path)) return null;
        try
        {
            if (new FileInfo(path).Length > MaxTranscriptBytes) return null;
            var transcript = JsonSerializer.Deserialize<LocalTranscript>(File.ReadAllBytes(path), Protocol.Json);
            if (transcript is null || transcript.SchemaVersion != 1 || transcript.ProcessingMode != ProcessingMode ||
                transcript.DeviceId != entry.Manifest.DeviceId || transcript.RecordingId != entry.Manifest.RecordingId ||
                transcript.AudioSha256 != entry.Manifest.Sha256 || transcript.ManifestIdentityHash != entry.Stored.IdentityHash ||
                transcript.TestOnly != entry.Manifest.TestOnly || !DateTimeOffset.TryParse(transcript.CompletedAt, out _)) return null;
            var sources = transcript.SourcePackages;
            var expectedSamples = entry.Manifest.SampleCount;
            if (entry.Manifest.IsStandardPackagePart)
            {
                if (transcript.LogicalRecordingId != entry.Manifest.PackageId || sources is null ||
                    !sources.Any(source => source.RecordingId == entry.Manifest.RecordingId &&
                        source.AudioSha256 == entry.Manifest.Sha256)) return null;
                expectedSamples = sources.Sum(source => source.EndSample - source.StartSample);
                long cursor = 0;
                foreach (var source in sources.OrderBy(source => source.PartIndex))
                {
                    if (source.StartSample != cursor || source.EndSample <= source.StartSample) return null;
                    cursor = source.EndSample;
                }
            }
            ValidateResult(transcript.Result, expectedSamples, entry.Manifest.SampleRateHz, entry.Manifest.Channels);
            return transcript;
        }
        catch (JsonException) { return null; }
        catch (IOException) { return null; }
    }

    private static void ValidateResult(JsonElement result, long sampleCount, int sampleRateHz, int channels)
    {
        if (result.ValueKind != JsonValueKind.Object || result.TryGetProperty("error", out _) ||
            Number(result, "schemaVersion") != 1 || Text(result, "engine") != "sherpa-onnx/1.13.8/cpu" ||
            Text(result, "model") != "sensevoice-small-int8-2024-07-17" || string.IsNullOrWhiteSpace(Text(result, "language")))
            throw new IOException("Local ASR did not confirm a supported CPU transcription result.");
        var duration = Number(result, "durationMs");
        if (Math.Abs(duration - sampleCount * 1000.0 / sampleRateHz) > 1 ||
            !result.TryGetProperty("audio", out var audio) || audio.ValueKind != JsonValueKind.Object ||
            Number(audio, "sampleRateHz") != sampleRateHz || Number(audio, "sampleCount") != sampleCount ||
            Number(audio, "channels") != channels)
            throw new IOException("Local ASR audio metadata does not match the received WAV.");
        if (!result.TryGetProperty("segments", out var segments) || segments.ValueKind != JsonValueKind.Array ||
            !result.TryGetProperty("speakers", out var speakers) || speakers.ValueKind != JsonValueKind.Array ||
            !result.TryGetProperty("warnings", out var warnings) || warnings.ValueKind != JsonValueKind.Array ||
            !result.TryGetProperty("diarization", out var diarization) || diarization.ValueKind != JsonValueKind.Object ||
            Text(diarization, "mode") is not ("none" or "vad-cluster"))
            throw new IOException("Local ASR result is missing transcript arrays or has unexpected diarization.");
        var clustered = Text(diarization, "mode") == "vad-cluster";
        var labels = new HashSet<string>(StringComparer.Ordinal);
        foreach (var speaker in speakers.EnumerateArray())
        {
            var label = speaker.ValueKind == JsonValueKind.Object ? Text(speaker, "label") : null;
            if (label is null || !labels.Add(label)) throw new IOException("Invalid/duplicate acoustic speaker label.");
            if (speaker.TryGetProperty("personId", out _) || speaker.TryGetProperty("name", out _))
                throw new IOException("Acoustic output cannot assert a person's identity.");
            if (label == "unknown")
            {
                if (speaker.TryGetProperty("embedding", out _)) throw new IOException("Unknown speaker cannot provide an identity template.");
                continue;
            }
            if (!clustered || !Regex.IsMatch(label, @"^speaker_[0-9]{2,6}$", RegexOptions.CultureInvariant))
                throw new IOException("Unexpected acoustic speaker label.");
            if (!speaker.TryGetProperty("embedding", out var embedding) || embedding.ValueKind != JsonValueKind.Array ||
                embedding.GetArrayLength() is < 1 or > 4096 || Number(speaker, "embeddingDimension") != embedding.GetArrayLength() ||
                !Regex.IsMatch(Text(speaker, "embeddingModel") ?? "", @"^3dspeaker-campplus-zh-cn-16k@sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant))
                throw new IOException("Invalid local acoustic embedding metadata.");
            double norm = 0;
            foreach (var coordinate in embedding.EnumerateArray())
            {
                if (coordinate.ValueKind != JsonValueKind.Number || !coordinate.TryGetDouble(out var value) || !double.IsFinite(value))
                    throw new IOException("Invalid acoustic embedding value.");
                norm += value * value;
            }
            if (!double.IsFinite(norm) || Math.Abs(norm - 1) > 0.05) throw new IOException("Acoustic embedding must be normalized.");
        }
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var segment in segments.EnumerateArray())
        {
            if (segment.ValueKind != JsonValueKind.Object || string.IsNullOrWhiteSpace(Text(segment, "text")) ||
                string.IsNullOrWhiteSpace(Text(segment, "id")) || !ids.Add(Text(segment, "id")!) ||
                !labels.Contains(Text(segment, "speakerLabel") ?? ""))
                throw new IOException("Invalid local ASR segment.");
            var start = Number(segment, "startMs");
            var end = Number(segment, "endMs");
            if (start < 0 || end <= start || end > duration)
                throw new IOException("Local ASR segment lies outside the received audio.");
        }
        foreach (var warning in warnings.EnumerateArray())
            if (warning.ValueKind != JsonValueKind.String) throw new IOException("Invalid local ASR warning.");
        if (segments.GetArrayLength() == 0 && !warnings.EnumerateArray().Any(x => x.GetString() == "NO_SPEECH_DETECTED"))
            throw new IOException("Empty ASR output lacks explicit no-speech confirmation.");
    }

    private static double Number(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var field) || field.ValueKind != JsonValueKind.Number ||
            !field.TryGetDouble(out var number) || !double.IsFinite(number))
            throw new IOException($"Invalid local ASR field: {name}.");
        return number;
    }

    private static string? Text(JsonElement value, string name) =>
        value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;

    private static string ErrorDetail(string stderr)
    {
        try
        {
            using var document = JsonDocument.Parse(stderr);
            if (document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("error", out var error) &&
                error.ValueKind == JsonValueKind.Object && Text(error, "message") is { } message)
                return message[..Math.Min(message.Length, 1500)];
        }
        catch (JsonException) { }
        return "No structured runtime error was returned; retry is pending.";
    }
}

internal sealed class LocalAsrProcessRunner : ILocalAsrRunner
{
    public async Task<LocalAsrProcessResult> RunAsync(ProcessStartInfo startInfo, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new IOException("Local ASR did not start.");
        var stdout = ReadOutputAsync(process.StandardOutput, LocalRecordingTranscriber.MaxTranscriptBytes);
        var stderr = ReadOutputAsync(process.StandardError, 32 * 1024);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromHours(1));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            // Only this invocation's owned child is stopped, never another bridge or microphone process.
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(stdout, stderr);
            cancellationToken.ThrowIfCancellationRequested();
            throw new IOException("Local ASR timed out; retry is pending.");
        }
        var output = await stdout;
        var error = await stderr;
        if (output.Overflow) throw new IOException("Local ASR output exceeded the bounded capture limit.");
        return new(process.ExitCode, output.Text, error.Text);
    }

    private static async Task<(string Text, bool Overflow)> ReadOutputAsync(StreamReader reader, int limit)
    {
        var result = new StringBuilder();
        var buffer = new char[4096];
        var overflow = false;
        int read;
        while ((read = await reader.ReadAsync(buffer)) != 0)
        {
            var keep = Math.Min(read, limit - result.Length);
            if (keep > 0) result.Append(buffer, 0, keep);
            overflow |= keep != read;
        }
        return (result.ToString(), overflow);
    }
}
