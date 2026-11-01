using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal static class LocalTranscriptionTests
{
    public static (string Name, Func<Task> Run)[] Cases =>
    [
        ("local acoustic clusters: explicit opt-in, labels not identities and restart cache", SpeakerClustersAsync),
        ("local CLI scope, conflicts and legacy defaults", OptionsAsync),
        ("local ASR fixed interpreter, ROOT models and two CPU threads", ProcessContractAsync),
        ("local transcript result, hash binding and restart cache", ResultAndCacheAsync),
        ("local silence is a successful empty transcript", SilenceAsync),
        ("local ASR rejects failure and malformed or mismatched results", InvalidResultsAsync),
        ("local cache mismatch and corrupt result are retried", CacheRecoveryAsync),
        ("local intake boundary and audio integrity before and after ASR", AudioIntegrityAsync),
        ("local durable failure, backoff and restart retry", RetryAsync),
        ("local transcript disk failure cannot acknowledge completion", DiskFailureAsync),
        ("local cancellation remains retryable without an import", CancellationAsync),
        ("local saved transcript survives interrupted queue completion", InterruptedCompletionAsync),
        ("local and Agent queues never claim each other's work", ModeIsolationAsync),
        ("fixed recording parts wait, reassemble once and share semantic transcript", RecordingPackageAsync),
        ("local queue is single consumer even with concurrent scans", SequentialAsync)
    ];

    public static async Task RunAsync()
    {
        foreach (var (_, run) in Cases) await run();
    }

    private static BridgeOptions Options(TestRoot root) =>
        new("--serve", root.Root, root.Runtime, null, false, null, "node", TranscribeOnly: true);

    private static async Task SpeakerClustersAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime, retainAudio: true);
        var options = BridgeOptions.Parse(["--serve", "--transcribe-only", "--speaker-clusters", "--repo-root", root.Root]);
        Check.True(options.SpeakerClusters);
        await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeOptions.Parse(["--serve", "--speaker-clusters"])));
        JsonObject Clustered()
        {
            var json = JsonNode.Parse(ResultJson())!.AsObject();
            json["diarization"]!["mode"] = "vad-cluster";
            json["segments"]![0]!["speakerLabel"] = "speaker_00";
            json["speakers"] = new JsonArray(new JsonObject
            {
                ["label"] = "speaker_00", ["embedding"] = new JsonArray(1.0, 0.0),
                ["embeddingDimension"] = 2, ["embeddingModel"] = "3dspeaker-campplus-zh-cn-16k@sha256:" + new string('a', 64)
            });
            return json;
        }
        var runner = new FakeRunner { Handler = (_, _) => Task.FromResult(new LocalAsrProcessResult(0, Clustered().ToJsonString(), "")) };
        var entry = await StoreAsync(store);
        var transcriber = new LocalRecordingTranscriber(Options(root) with { SpeakerClusters = true }, runner);
        var result = await transcriber.TranscribeAsync(entry, CancellationToken.None);
        Check.Equal("vad-cluster", result.Result.GetProperty("diarization").GetProperty("mode").GetString());
        Check.True(runner.LastStart!.ArgumentList.Contains("vad-cluster"));
        Check.True(LocalRecordingTranscriber.ReadCached(entry) is not null);
        Check.Equal(1, runner.Calls);
        foreach (var mutate in new Action<JsonObject>[]
        {
            json => json["speakers"]![0]!["personId"] = "not-an-acoustic-claim",
            json => json["speakers"]![0]!["embedding"] = new JsonArray(0.0, 0.0),
            json => json["speakers"]![0]!["embeddingDimension"] = 3,
            json => json["segments"]![0]!["speakerLabel"] = "someone_else",
            json => json["diarization"]!["mode"] = "none"
        })
        {
            var invalid = Clustered();
            mutate(invalid);
            var rejected = await StoreAsync(store);
            runner.Handler = (_, _) => Task.FromResult(new LocalAsrProcessResult(0, invalid.ToJsonString(), ""));
            await Check.ThrowsAsync<IOException>(() => transcriber.TranscribeAsync(rejected, CancellationToken.None));
            Check.True(File.Exists(Path.Combine(rejected.Directory, "audio.wav")));
            Check.True(!File.Exists(Path.Combine(rejected.Directory, "transcript.json")));
        }
    }

    private static async Task<InboxEntry> StoreAsync(InboxStore store)
    {
        var manifest = Fixtures.Parse(Fixtures.Manifest());
        await store.StoreAsync(manifest, Fixtures.Wave(), CancellationToken.None);
        return store.ReadEntry(Path.Combine(store.Root, manifest.DeviceId, manifest.RecordingId));
    }

    private static async Task OptionsAsync()
    {
        using var root = new TestRoot();
        var parsed = BridgeOptions.Parse(["--serve", "--transcribe-only", "--repo-root", root.Root,
            "--runtime-root", root.Runtime, "--listen-ip", "127.0.0.1"]);
        Check.True(parsed.TranscribeOnly && !parsed.NoTranscribe && parsed.Database is null);
        Check.Equal("--serve", parsed.Mode);
        Check.Equal(root.Runtime, parsed.RuntimeRoot);
        Check.Equal("127.0.0.1", parsed.ListenIp);
        Check.True(!BridgeOptions.Parse(["--serve", "--repo-root", root.Root]).TranscribeOnly);
        Check.True(!new BridgeOptions("--serve", root.Root, root.Runtime, null, false, null, "node").TranscribeOnly);
        foreach (var args in new[]
        {
            new[] { "--serve", "--transcribe-only", "--no-transcribe" },
            new[] { "--serve", "--transcribe-only", "--database", "isolated.sqlite" },
            new[] { "--serve", "--transcribe-only", "--node", "node" },
            new[] { "--serve", "--transcribe-only", "--transcribe-only" },
            new[] { "--setup", "--transcribe-only" }, new[] { "--check", "--transcribe-only" },
            new[] { "--probe", "--transcribe-only" }, new[] { "--help", "--transcribe-only" },
            new[] { "--transcribe-only" }, new[] { "--serve", "--transcribe-only", "--bridge-id", Guid.NewGuid().ToString("D") },
            new[] { "--setup", "--server-url", "https://127.0.0.1:8787" }
        }) await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeOptions.Parse([.. args, "--repo-root", root.Root])));
        foreach (var invalid in new[] { parsed with { TranscribeOnly = false }, parsed with { NoTranscribe = true }, parsed with { Database = "forbidden.sqlite" } })
            await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => new LocalRecordingTranscriber(invalid, new FakeRunner())));
    }

    private static async Task ProcessContractAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var options = Options(root);
        var runner = new FakeRunner();
        IRecordingTranscriber transcriber = new LocalRecordingTranscriber(options, runner);
        await transcriber.TranscribeAsync(entry, CancellationToken.None);
        var info = runner.LastStart!;
        Check.Equal(@"D:\anaconda\python.exe", info.FileName);
        Check.Equal(entry.Directory, info.WorkingDirectory);
        Check.True(!info.UseShellExecute && info.CreateNoWindow && info.RedirectStandardOutput && info.RedirectStandardError);
        Check.Equal(Encoding.UTF8, info.StandardOutputEncoding);
        Check.Equal(Encoding.UTF8, info.StandardErrorEncoding);
        Check.True(info.ArgumentList.SequenceEqual(new[]
        {
            "-I", "-B", Path.Combine(root.Root, "scripts", "voice-runtime", "asr.py"),
            "--audio", Path.Combine(entry.Directory, "audio.wav"),
            "--model-dir", Path.Combine(root.Root, "runtime", "voice", "models"),
            "--output", "json", "--language", "zh", "--threads", "2", "--diarization", "none", "--max-seconds", "600"
        }));
        foreach (var variable in new[] { "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS" })
            Check.Equal("2", info.Environment[variable]);
        Check.True(info.ArgumentList.All(x => !x.Contains("voice-input.mjs", StringComparison.Ordinal)));
        Check.True(!File.Exists(Path.Combine(root.Root, "isolated.sqlite")));
        await Check.ThrowsAsync<InvalidOperationException>(() => new NodeRecordingImporter(options).ImportAsync(entry, CancellationToken.None));

        var otherRuntime = Path.Combine(root.Root, "runtime", "phone-test-intake");
        using var separate = new InboxStore(otherRuntime);
        var separateEntry = await StoreAsync(separate);
        var separatedInfo = new LocalRecordingTranscriber(options with { RuntimeRoot = otherRuntime }, runner).StartInfo(separateEntry);
        Check.Equal(Path.Combine(root.Root, "runtime", "voice", "models"), separatedInfo.ArgumentList[6]);
        Check.Equal(Path.Combine(separateEntry.Directory, "audio.wav"), separatedInfo.ArgumentList[4]);
    }

    private static async Task ResultAndCacheAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new FakeRunner();
        var result = await new LocalRecordingTranscriber(Options(root), runner).TranscribeAsync(entry, CancellationToken.None);
        Check.Equal("local-transcription", result.ProcessingMode);
        Check.Equal(entry.Manifest.Sha256, result.AudioSha256);
        Check.Equal(entry.Stored.IdentityHash, result.ManifestIdentityHash);
        Check.Equal(entry.Manifest.RecordingId, result.RecordingId);
        Check.Equal(entry.Manifest.DeviceId, result.DeviceId);
        Check.True(result.TestOnly);
        Check.Equal("synthetic local text", result.Result.GetProperty("segments")[0].GetProperty("text").GetString());
        var path = Path.Combine(entry.Directory, "transcript.json");
        var bytes = File.ReadAllBytes(path);
        var saved = JsonNode.Parse(bytes)!.AsObject();
        Check.Equal(result.AudioSha256, saved["audioSha256"]!.GetValue<string>());
        Check.True(!saved.ContainsKey("importedRecordingId"));
        var restartedRunner = new FakeRunner { Handler = (_, _) => throw new IOException("Cache should avoid inference.") };
        await new LocalRecordingTranscriber(Options(root), restartedRunner).TranscribeAsync(store.ReadEntry(entry.Directory), CancellationToken.None);
        Check.Equal(0, restartedRunner.Calls);
        Check.True(bytes.SequenceEqual(File.ReadAllBytes(path)));
        Check.Equal(entry.Stored.Receipt, store.ReadEntry(entry.Directory).Stored.Receipt);
    }

    private static async Task SilenceAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new FakeRunner { Handler = (_, _) => Task.FromResult(new LocalAsrProcessResult(0, ResultJson(speech: false), "")) };
        var queue = new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { });
        await queue.ProcessPendingOnceAsync(CancellationToken.None);
        CheckLocalComplete(store, entry);
        var transcript = JsonNode.Parse(File.ReadAllBytes(Path.Combine(entry.Directory, "transcript.json")))!;
        Check.Equal(0, transcript["result"]!["segments"]!.AsArray().Count);
        Check.True(transcript["result"]!["warnings"]!.AsArray().Any(x => x!.GetValue<string>() == "NO_SPEECH_DETECTED"));
    }

    private static async Task InvalidResultsAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var wrongAudio = JsonNode.Parse(ResultJson())!;
        wrongAudio["audio"]!["sampleCount"] = 3200;
        var wrongTime = JsonNode.Parse(ResultJson())!;
        wrongTime["segments"]![0]!["endMs"] = 101;
        var wrongEngine = JsonNode.Parse(ResultJson())!;
        wrongEngine["engine"] = "remote-asr";
        var missingSegments = JsonNode.Parse(ResultJson())!.AsObject();
        missingSegments.Remove("segments");
        foreach (var output in new[]
        {
            new LocalAsrProcessResult(1, ResultJson(), "{\"schemaVersion\":1,\"error\":{\"code\":\"VOICE_RUNTIME_ERROR\",\"message\":\"Synthetic missing model\"}}"),
            new LocalAsrProcessResult(0, "not json", ""), new LocalAsrProcessResult(0, "[]", ""),
            new LocalAsrProcessResult(0, "{\"error\":{\"message\":\"failure\"}}", ""),
            new LocalAsrProcessResult(0, wrongAudio.ToJsonString(), ""), new LocalAsrProcessResult(0, wrongTime.ToJsonString(), ""),
            new LocalAsrProcessResult(0, wrongEngine.ToJsonString(), ""), new LocalAsrProcessResult(0, missingSegments.ToJsonString(), ""),
            new LocalAsrProcessResult(0, new string('x', LocalRecordingTranscriber.MaxTranscriptBytes + 1), "")
        })
        {
            var runner = new FakeRunner { Handler = (_, _) => Task.FromResult(output) };
            await Check.ThrowsAsync<IOException>(() => new LocalRecordingTranscriber(Options(root), runner).TranscribeAsync(entry, CancellationToken.None));
            Check.True(!File.Exists(Path.Combine(entry.Directory, "transcript.json")));
        }
    }

    private static async Task CacheRecoveryAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new FakeRunner();
        var transcriber = new LocalRecordingTranscriber(Options(root), runner);
        await transcriber.TranscribeAsync(entry, CancellationToken.None);
        var path = Path.Combine(entry.Directory, "transcript.json");
        foreach (var field in new[] { "audioSha256", "manifestIdentityHash", "deviceId", "recordingId", "processingMode" })
        {
            var saved = JsonNode.Parse(File.ReadAllBytes(path))!;
            saved[field] = "wrong-binding";
            DurableFiles.ReplaceJson(path, saved);
            await transcriber.TranscribeAsync(entry, CancellationToken.None);
        }
        File.WriteAllText(path, "unfinished JSON", Encoding.UTF8);
        await transcriber.TranscribeAsync(entry, CancellationToken.None);
        Check.Equal(7, runner.Calls);
        var large = JsonNode.Parse(ResultJson())!;
        large["segments"]![0]!["text"] = new string('x', Protocol.MaxManifestBytes + 1);
        File.Delete(path);
        runner.Handler = (_, _) => Task.FromResult(new LocalAsrProcessResult(0, large.ToJsonString(), ""));
        await transcriber.TranscribeAsync(entry, CancellationToken.None);
        Check.True(new FileInfo(path).Length > Protocol.MaxManifestBytes);
        await transcriber.TranscribeAsync(entry, CancellationToken.None);
        Check.Equal(8, runner.Calls);
    }

    private static async Task AudioIntegrityAsync()
    {
        using var root = new TestRoot();
        using var outside = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        using var outsideStore = new InboxStore(outside.Runtime);
        var entry = await StoreAsync(store);
        var runner = new FakeRunner();
        var transcriber = new LocalRecordingTranscriber(Options(root), runner);
        var outsideEntry = await StoreAsync(outsideStore);
        await Check.ThrowsAsync<IOException>(() => transcriber.TranscribeAsync(outsideEntry, CancellationToken.None));
        Check.Equal(0, runner.Calls);
        var path = Path.Combine(entry.Directory, "audio.wav");
        File.WriteAllBytes(path, Fixtures.Wave(value: 4));
        await Check.ThrowsAsync<ClientFault>(() => transcriber.TranscribeAsync(entry, CancellationToken.None));
        Check.Equal(0, runner.Calls);
        File.WriteAllBytes(path, Fixtures.Wave());
        runner.Handler = (_, _) =>
        {
            File.WriteAllBytes(path, Fixtures.Wave(value: 5));
            return Task.FromResult(new LocalAsrProcessResult(0, ResultJson(), ""));
        };
        await Check.ThrowsAsync<ClientFault>(() => transcriber.TranscribeAsync(entry, CancellationToken.None));
        Check.True(!File.Exists(Path.Combine(entry.Directory, "transcript.json")));
    }

    private static async Task RetryAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var now = DateTimeOffset.UtcNow;
        var runner = new FakeRunner { Handler = (_, _) => Task.FromResult(new LocalAsrProcessResult(1, "", "{\"error\":{\"message\":\"Synthetic missing model\"}}")) };
        var queue = new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => now);
        await queue.ProcessPendingOnceAsync(CancellationToken.None);
        var failed = store.ReadQueue(entry.Directory);
        Check.Equal("failed", failed.Status);
        Check.Equal(1, failed.Attempts);
        Check.True(failed.LastError!.Contains("Synthetic missing model", StringComparison.Ordinal));
        Check.Equal(Protocol.Utc(now.AddMinutes(1)), failed.NextAttemptAt);
        Check.Equal("local-transcription", QueueJson(entry)["processingMode"]!.GetValue<string>());
        Check.True(failed.ImportedRecordingId is null);
        using var restartedStore = new InboxStore(root.Runtime);
        var restarted = new ImportQueue(restartedStore, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => now);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(1, runner.Calls);
        now = now.AddMinutes(1);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(2, runner.Calls);
        Check.Equal(Protocol.Utc(now.AddMinutes(2)), store.ReadQueue(entry.Directory).NextAttemptAt);
        runner.Handler = null;
        now = now.AddMinutes(2);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        CheckLocalComplete(store, entry);
        Check.Equal(3, store.ReadQueue(entry.Directory).Attempts);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(3, runner.Calls);
        Check.Equal(entry.Stored.Receipt, store.ReadEntry(entry.Directory).Stored.Receipt);
    }

    private static async Task DiskFailureAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var now = DateTimeOffset.UtcNow;
        var transcriptPath = Path.Combine(entry.Directory, "transcript.json");
        Directory.CreateDirectory(transcriptPath);
        var runner = new FakeRunner();
        var queue = new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => now);
        await queue.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal("failed", store.ReadQueue(entry.Directory).Status);
        Check.True(store.ReadQueue(entry.Directory).ImportedRecordingId is null);
        Check.True(!File.Exists(transcriptPath));
        Check.Equal(0, Directory.EnumerateFiles(entry.Directory, "transcript.json.*.tmp").Count());
        Directory.Delete(transcriptPath, recursive: false);
        now = now.AddMinutes(1);
        await queue.ProcessPendingOnceAsync(CancellationToken.None);
        CheckLocalComplete(store, entry);
        Check.Equal(2, runner.Calls);
    }

    private static async Task CancellationAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var now = DateTimeOffset.UtcNow;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runner = new FakeRunner { Handler = async (_, ct) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, ct);
            return new(0, ResultJson(), "");
        } };
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var transcriber = new LocalRecordingTranscriber(Options(root), runner);
        await Check.ThrowsAsync<OperationCanceledException>(() => transcriber.TranscribeAsync(entry, cancelled.Token));
        Check.Equal(0, runner.Calls);
        using var cancel = new CancellationTokenSource();
        var queue = new ImportQueue(store, transcriber, _ => { }, () => now);
        var waiting = queue.ProcessPendingOnceAsync(cancel.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancel.Cancel();
        await Check.ThrowsAsync<OperationCanceledException>(() => waiting);
        var state = store.ReadQueue(entry.Directory);
        Check.Equal("failed", state.Status);
        Check.True(state.LastError!.Contains("local-transcription", StringComparison.Ordinal));
        Check.True(state.ImportedRecordingId is null && state.NextAttemptAt is not null);
        Check.True(!File.Exists(Path.Combine(entry.Directory, "transcript.json")));
        runner.Handler = null;
        now = now.AddMinutes(1);
        await new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => now).ProcessPendingOnceAsync(CancellationToken.None);
        CheckLocalComplete(store, entry);

        var lateEntry = await StoreAsync(store);
        using var lateCancel = new CancellationTokenSource();
        runner.Handler = (_, _) => { lateCancel.Cancel(); return Task.FromResult(new LocalAsrProcessResult(0, ResultJson(), "")); };
        await Check.ThrowsAsync<OperationCanceledException>(() => transcriber.TranscribeAsync(lateEntry, lateCancel.Token));
        Check.True(!File.Exists(Path.Combine(lateEntry.Directory, "transcript.json")));
    }

    private static async Task InterruptedCompletionAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        await new LocalRecordingTranscriber(Options(root), new FakeRunner()).TranscribeAsync(entry, CancellationToken.None);
        var state = JsonSerializer.SerializeToNode(new QueueState("processing", 1, Protocol.Utc(DateTimeOffset.UtcNow)), Protocol.Json)!;
        state["processingMode"] = "local-transcription";
        DurableFiles.ReplaceJson(Path.Combine(entry.Directory, "queue.json"), state);
        var runner = new FakeRunner { Handler = (_, _) => throw new IOException("Committed result must be reused after restart.") };
        await new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }).ProcessPendingOnceAsync(CancellationToken.None);
        CheckLocalComplete(store, entry);
        Check.Equal(0, runner.Calls);
        Check.Equal(2, store.ReadQueue(entry.Directory).Attempts);
    }

    private static async Task ModeIsolationAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var localEntry = await StoreAsync(store);
        var runner = new FakeRunner { Handler = (_, _) => throw new IOException("Synthetic failure.") };
        var now = DateTimeOffset.UtcNow;
        await new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => now).ProcessPendingOnceAsync(CancellationToken.None);
        var importer = new FakeImporter();
        now = now.AddMinutes(2);
        var agentQueue = new ImportQueue(store, importer, _ => { }, () => now);
        await agentQueue.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(0, importer.Calls);
        var agentEntry = await StoreAsync(store);
        await agentQueue.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(1, importer.Calls);
        Check.Equal("agent-import", QueueJson(agentEntry)["processingMode"]!.GetValue<string>());
        Check.Equal("fake-agent-id", store.ReadQueue(agentEntry.Directory).ImportedRecordingId);
        foreach (var status in new[] { "processing", "failed", "transcribed" })
        {
            var legacyEntry = await StoreAsync(store);
            store.WriteQueue(legacyEntry.Directory, new QueueState(status, 1, Protocol.Utc(now)));
        }
        runner.Handler = null;
        await new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => now).ProcessPendingOnceAsync(CancellationToken.None);
        CheckLocalComplete(store, localEntry);
        Check.Equal(2, runner.Calls);
        Check.True(!File.Exists(Path.Combine(agentEntry.Directory, "transcript.json")));
    }

    private static async Task SequentialAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        for (var i = 0; i < 3; i++) await StoreAsync(store);
        var runner = new FakeRunner { Handler = async (_, ct) => { await Task.Delay(20, ct); return new(0, ResultJson(), ""); } };
        var queue = new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), _ => { });
        await Task.WhenAll(queue.ProcessPendingOnceAsync(CancellationToken.None), queue.ProcessPendingOnceAsync(CancellationToken.None));
        Check.Equal(3, runner.Calls);
        Check.Equal(1, runner.MaxConcurrent);
        foreach (var directory in store.Entries()) CheckLocalComplete(store, store.ReadEntry(directory));
    }

    private static async Task RecordingPackageAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime, retainAudio: true);
        var device = Guid.NewGuid().ToString("D");
        var conversation = Guid.NewGuid().ToString("D");
        var package = Guid.NewGuid().ToString("D");
        var firstJson = Fixtures.Manifest();
        firstJson["deviceId"] = device; firstJson["conversationId"] = conversation;
        firstJson["kind"] = "voice-recording-package-part"; firstJson["packageId"] = package;
        firstJson["partIndex"] = 0; firstJson["previousRecordingId"] = null; firstJson["finalPart"] = false;
        var firstManifest = Fixtures.Parse(firstJson);
        await store.StoreAsync(firstManifest, Fixtures.Wave(), CancellationToken.None);
        var first = store.ReadEntry(Path.Combine(store.Root, device, firstManifest.RecordingId));
        var runner = new FakeRunner();
        var transcriber = new LocalRecordingTranscriber(Options(root), runner, store);
        await Check.ThrowsAsync<RecordingPackagePendingException>(() => transcriber.TranscribeAsync(first, CancellationToken.None));
        Check.Equal(0, runner.Calls);

        var secondJson = Fixtures.Manifest();
        secondJson["deviceId"] = device; secondJson["conversationId"] = conversation;
        secondJson["kind"] = "voice-recording-package-part"; secondJson["packageId"] = package;
        secondJson["partIndex"] = 1; secondJson["previousRecordingId"] = firstManifest.RecordingId;
        secondJson["finalPart"] = true;
        var secondManifest = Fixtures.Parse(secondJson);
        await store.StoreAsync(secondManifest, Fixtures.Wave(), CancellationToken.None);
        runner.Handler = (_, _) => Task.FromResult(new LocalAsrProcessResult(0, ResultJson(samples: 3200), ""));
        var result = await transcriber.TranscribeAsync(first, CancellationToken.None);
        Check.Equal(package, result.LogicalRecordingId);
        Check.Equal(2, result.SourcePackages!.Count);
        Check.Equal(3200L, result.SourcePackages[^1].EndSample);
        Check.Equal(1, runner.Calls);
        Check.True(runner.LastStart!.ArgumentList.Contains("--continuation-audio"));
        var second = store.ReadEntry(Path.Combine(store.Root, device, secondManifest.RecordingId));
        var cachedSecond = await transcriber.TranscribeAsync(second, CancellationToken.None);
        Check.Equal(package, cachedSecond.LogicalRecordingId);
        Check.Equal(1, runner.Calls);
    }

    private static JsonObject QueueJson(InboxEntry entry) => JsonNode.Parse(File.ReadAllBytes(Path.Combine(entry.Directory, "queue.json")))!.AsObject();

    private static void CheckLocalComplete(InboxStore store, InboxEntry entry)
    {
        var state = store.ReadQueue(entry.Directory);
        Check.Equal("transcribed", state.Status);
        Check.True(state.ImportedRecordingId is null && state.LastError is null && state.NextAttemptAt is null);
        var json = QueueJson(entry);
        Check.Equal("local-transcription", json["processingMode"]!.GetValue<string>());
        Check.Equal("transcript.json", json["transcriptPath"]!.GetValue<string>());
        Check.True(!json.ContainsKey("importedRecordingId"));
        Check.True(File.Exists(Path.Combine(entry.Directory, "transcript.json")));
    }

    internal static string ResultJson(bool speech = true, int samples = 1600) => JsonSerializer.Serialize(new
    {
        schemaVersion = 1, engine = "sherpa-onnx/1.13.8/cpu", model = "sensevoice-small-int8-2024-07-17", language = "zh",
        durationMs = samples / 16.0, audio = new { sampleRateHz = 16000, sampleCount = samples, channels = 1 },
        segments = speech ? new[] { new { id = "segment_0000", startMs = 0, endMs = samples / 16.0, text = "synthetic local text", speakerLabel = "unknown" } } : [],
        speakers = speech ? new[] { new { label = "unknown" } } : [],
        timings = new { decodeMs = 1, asrMs = 1, diarizationMs = 0, totalMs = 2 },
        warnings = speech ? new[] { "DIARIZATION_DISABLED" } : new[] { "DIARIZATION_DISABLED", "NO_SPEECH_DETECTED" },
        diarization = new { mode = "none", speakerChangeDetection = false, overlapDetection = false }
    });

    private sealed class FakeRunner : ILocalAsrRunner
    {
        public Func<ProcessStartInfo, CancellationToken, Task<LocalAsrProcessResult>>? Handler { get; set; }
        public ProcessStartInfo? LastStart { get; private set; }
        public int Calls { get; private set; }
        public int MaxConcurrent { get; private set; }
        private int active;

        public async Task<LocalAsrProcessResult> RunAsync(ProcessStartInfo startInfo, CancellationToken cancellationToken)
        {
            Calls++;
            LastStart = startInfo;
            active++;
            MaxConcurrent = Math.Max(MaxConcurrent, active);
            try { return Handler is null ? new(0, ResultJson(), "") : await Handler(startInfo, cancellationToken); }
            finally { active--; }
        }
    }

    private sealed class FakeImporter : IRecordingImporter
    {
        public int Calls { get; private set; }
        public Task<string> ImportAsync(InboxEntry entry, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult("fake-agent-id");
        }
    }
}
