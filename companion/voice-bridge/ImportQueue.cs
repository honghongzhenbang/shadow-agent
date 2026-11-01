using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace VoiceBridge;

internal interface IRecordingImporter
{
    Task<string> ImportAsync(InboxEntry entry, CancellationToken cancellationToken);
}

internal sealed class NodeRecordingImporter(BridgeOptions options) : IRecordingImporter
{
    internal ProcessStartInfo StartInfo(InboxEntry entry)
    {
        if (options.TranscribeOnly)
            throw new InvalidOperationException("--transcribe-only cannot start the Node/Agent importer. Select LocalRecordingTranscriber.");
        if (entry.Manifest.TestOnly && options.Database is null)
            throw new InvalidOperationException("Test-only audio requires an explicit isolated --database; no importer was started.");
        var manifest = Path.Combine(entry.Directory, "manifest.json");
        var info = new ProcessStartInfo(options.NodePath)
        {
            WorkingDirectory = entry.Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        // A relative manifest is resolved beside the fixed audio.wav, even when runtime is on another drive.
        info.ArgumentList.Add(Path.Combine(options.RepoRoot, "scripts", "voice-input.mjs"));
        info.ArgumentList.Add("import");
        info.ArgumentList.Add("--manifest");
        info.ArgumentList.Add(Path.GetFileName(manifest));
        if (options.Database is not null)
        {
            info.ArgumentList.Add("--database");
            info.ArgumentList.Add(options.Database);
        }
        return info;
    }

    public async Task<string> ImportAsync(InboxEntry entry, CancellationToken cancellationToken)
    {
        using var process = new Process { StartInfo = StartInfo(entry) };
        if (!process.Start()) throw new IOException("Node importer did not start.");
        var output = ReadOutputAsync(process.StandardOutput);
        var error = ReadOutputAsync(process.StandardError);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromHours(7));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(output, error);
            if (cancellationToken.IsCancellationRequested) throw;
            throw new IOException("Node importer timed out; pending work will retry.");
        }
        var stdout = await output;
        var stderr = await error;
        if (process.ExitCode != 0) throw new IOException($"Node importer exited {process.ExitCode}: {stderr[..Math.Min(stderr.Length, 1500)]}");
        using var document = JsonDocument.Parse(stdout);
        if (!document.RootElement.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object ||
            (result.TryGetProperty("busy", out var busy) && busy.ValueKind == JsonValueKind.True) ||
            !result.TryGetProperty("evidenceIds", out var evidence) || evidence.ValueKind != JsonValueKind.Array ||
            !result.TryGetProperty("recordingId", out var id) || id.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(id.GetString()))
            throw new IOException("Node did not confirm completed transcription (it may be leased/busy); will retry.");
        return id.GetString()!;
    }

    private static async Task<string> ReadOutputAsync(StreamReader reader)
    {
        var result = new StringBuilder();
        var buffer = new char[4096];
        int read;
        while ((read = await reader.ReadAsync(buffer)) != 0)
        {
            var keep = Math.Min(read, 128 * 1024 - result.Length);
            if (keep > 0) result.Append(buffer, 0, keep);
        }
        return result.ToString();
    }
}

internal sealed class ImportQueue
{
    private readonly InboxStore store;
    private readonly Func<InboxEntry, CancellationToken, Task<string?>> process;
    private readonly string processingMode;
    private readonly Action<string> log;
    private readonly Func<DateTimeOffset>? clock;
    private readonly SemaphoreSlim gate = new(1, 1);

    public ImportQueue(InboxStore store, IRecordingImporter importer, Action<string> log, Func<DateTimeOffset>? clock = null)
        : this(store, async (entry, ct) => await importer.ImportAsync(entry, ct), "agent-import", log, clock) { }

    public ImportQueue(InboxStore store, IRecordingTranscriber transcriber, Action<string> log, Func<DateTimeOffset>? clock = null)
        : this(store, async (entry, ct) => { await transcriber.TranscribeAsync(entry, ct); return null; },
            "local-transcription", log, clock) { }

    private ImportQueue(InboxStore store, Func<InboxEntry, CancellationToken, Task<string?>> process,
        string processingMode, Action<string> log, Func<DateTimeOffset>? clock)
    {
        this.store = store;
        this.process = process;
        this.processingMode = processingMode;
        this.log = log;
        this.clock = clock;
    }

    private DateTimeOffset Now => clock?.Invoke() ?? DateTimeOffset.UtcNow;

    public async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await ProcessPendingOnceAsync(ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex) { log($"Queue scan failed; will retry: {ex.GetType().Name}"); }
            try { await Task.Delay(TimeSpan.FromSeconds(2), ct); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
        }
    }

    internal async Task ProcessPendingOnceAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { await ProcessEntriesAsync(ct); }
        finally { gate.Release(); }
    }

    private async Task ProcessEntriesAsync(CancellationToken ct)
    {
        foreach (var directory in store.Entries())
        {
            ct.ThrowIfCancellationRequested();
            QueueState state;
            string? savedMode;
            try
            {
                state = store.ReadQueue(directory);
                savedMode = DurableFiles.ReadJson<QueueProcessingMetadata>(Path.Combine(directory, "queue.json")).ProcessingMode;
                // Unclaimed uploads may enter either mode. Previously attempted legacy work belongs to the Agent importer.
                savedMode ??= state.Status == "pending" && state.Attempts == 0 && state.ImportedRecordingId is null
                    ? null : "agent-import";
            }
            catch (Exception ex)
            {
                log($"Queue state unreadable for {Path.GetFileName(directory)}: {ex.GetType().Name}; receipt is not ASR completion.");
                continue;
            }
            if (savedMode is not null && savedMode != processingMode) continue;
            if (processingMode == LocalRecordingTranscriber.ProcessingMode && File.Exists(Path.Combine(directory, "tombstone.json")))
            {
                try
                {
                    if (state.Status == "transcribed" && CanSkipCleanedEntry(directory)) continue;
                    if (store.HasCompletion(directory))
                    {
                        if (state.Status != "transcribed")
                            WriteState(directory, state with { Status = "transcribed", UpdatedAt = Protocol.Utc(Now), NextAttemptAt = null, LastError = null });
                        await store.CleanupCompletedAsync(directory, ct);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { log($"Completion verification/cleanup pending: {Path.GetFileName(directory)} ({ex.GetType().Name})"); }
                continue;
            }
            if (state.Status == "transcribed" || (state.NextAttemptAt is not null &&
                DateTimeOffset.Parse(state.NextAttemptAt, CultureInfo.InvariantCulture) > Now)) continue;
            state = new("processing", checked(state.Attempts + 1), Protocol.Utc(Now));
            WriteState(directory, state);
            try
            {
                var entry = store.ReadEntry(directory);
                var importedId = await process(entry, ct);
                ct.ThrowIfCancellationRequested();
                if (processingMode == LocalRecordingTranscriber.ProcessingMode)
                    await store.CompleteLocalAsync(entry, ct);
                WriteState(directory, state with { Status = "transcribed", UpdatedAt = Protocol.Utc(Now), ImportedRecordingId = importedId });
                log($"{processingMode} completed: {entry.Manifest.RecordingId}");
            }
            catch (RecordingPackagePendingException ex)
            {
                WriteState(directory, state with { Status = "pending", Attempts = state.Attempts - 1,
                    UpdatedAt = Protocol.Utc(Now), NextAttemptAt = Protocol.Utc(Now.AddSeconds(2)), LastError = ex.Message });
                log($"Recording package is incomplete; waiting for remaining parts: {Path.GetFileName(directory)}");
            }
            catch (Exception ex)
            {
                var delay = Math.Min(3600, 60 * Math.Pow(2, Math.Min(state.Attempts - 1, 6)));
                var detail = ct.IsCancellationRequested ? $"Bridge stopped during {processingMode}; retry is pending." : ex.Message;
                WriteState(directory, state with
                {
                    Status = "failed", UpdatedAt = Protocol.Utc(Now), NextAttemptAt = Protocol.Utc(Now.AddSeconds(delay)),
                    LastError = detail[..Math.Min(detail.Length, 1800)]
                });
                log($"{processingMode} failed, durable retry scheduled: {Path.GetFileName(directory)} ({ex.GetType().Name})");
                if (ct.IsCancellationRequested) ct.ThrowIfCancellationRequested();
            }
            if (processingMode == LocalRecordingTranscriber.ProcessingMode && File.Exists(Path.Combine(directory, "tombstone.json")))
            {
                try { await store.CleanupCompletedAsync(directory, ct); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { log($"Audio cleanup pending: {Path.GetFileName(directory)} ({ex.GetType().Name})"); }
            }
        }
    }

    private bool CanSkipCleanedEntry(string directory)
    {
        // Scheduling hint only: never use this lightweight check to authorize deletion or answer status queries.
        var completion = DurableFiles.ReadJson<RecordingCompletion>(Path.Combine(directory, "tombstone.json"));
        var stored = completion.Stored;
        if (completion.SchemaVersion != 1 || !completion.AudioDeleted || stored?.Receipt is not { } receipt ||
            stored.DeviceId != Path.GetFileName(Path.GetDirectoryName(directory)) || receipt.RecordingId != Path.GetFileName(directory) ||
            !Pairing.IsHex(stored.IdentityHash, 64) || !Pairing.IsHex(receipt.Sha256, 64) ||
            !Pairing.IsHex(completion.TranscriptSha256, 64) || !DateTimeOffset.TryParse(completion.CompletedAt, out _))
            return false;
        foreach (var name in new[] { "manifest.json", "transcript.json" })
        {
            var path = Path.Combine(directory, name);
            Paths.RejectLinks(path);
            if (!File.Exists(path)) return false;
        }
        var audio = Path.Combine(directory, "audio.wav");
        var partial = Path.Combine(Path.GetDirectoryName(store.Root)!, "mobile-partials", stored.DeviceId + "_" + receipt.RecordingId);
        Paths.RejectLinks(audio);
        Paths.RejectLinks(partial);
        return !File.Exists(audio) && !Directory.Exists(audio) && !File.Exists(partial) && !Directory.Exists(partial);
    }

    private void WriteState(string directory, QueueState state)
    {
        var json = JsonSerializer.SerializeToNode(state, Protocol.Json)!.AsObject();
        json["processingMode"] = processingMode;
        if (processingMode == "local-transcription")
        {
            json.Remove("importedRecordingId");
            json["transcriptPath"] = state.Status == "transcribed" ? "transcript.json" : null;
        }
        DurableFiles.ReplaceJson(Path.Combine(directory, "queue.json"), json);
    }

    private sealed record QueueProcessingMetadata(string? ProcessingMode);
}
