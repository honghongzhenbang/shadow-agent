using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal static class RecordingLifecycleTests
{
    public static (string Name, Func<Task> Run)[] Cases =>
    [
        ("retention: new uploads persist hold across restart and block old-client deletion", RetainAsync),
        ("cleanup: strict opt-in, legacy identity and no historical sweep", OptInAsync),
        ("cleanup: persisted completion, deletion, restart and missing receipt", CompleteAsync),
        ("cleanup: terminal scans never read transcript or rerun ASR; status stays strict", TerminalScanAsync),
        ("cleanup: nonterminal markers and remaining cache retain verification and recovery", TerminalScanRecoveryAsync),
        ("cleanup: terminal scheduling hint cannot authorize deletion of reappearing audio", TerminalScanDeletionGuardAsync),
        ("cleanup: explicit silence only; ASR and transcript write failures retain audio", FailuresAsync),
        ("cleanup: tombstone write failure retains audio and retries cached transcript", CompletionWriteFailureAsync),
        ("cleanup: deletion failure retries without inference; phone ack independent", DeleteFailureAsync),
        ("cleanup: phone acknowledgement write failure never claims deletion", AckWriteFailureAsync),
        ("cleanup: interrupted deletion and queue commit recover without WAV", InterruptedAsync),
        ("cleanup: transcript tampering/missing proof cannot claim completion", CorruptionAsync),
        ("cleanup: pending/processing/failed, identity mismatch and premature ack", StatusAsync),
        ("cleanup: Agent import does not authorize deletion", AgentAsync),
        ("cleanup: registered cache lease, retry and manual exports preserved", CacheAsync),
        ("cleanup: HTTPS and authenticated RFCOMM status/ack contract", TransportsAsync),
        ("cleanup: links, path escape and concurrent duplicate requests", PathsAndConcurrencyAsync)
    ];

    private static readonly CancellationToken Ct = CancellationToken.None;

    private static async Task RetainAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime, retainAudio: true);
        var entry = await StoreAsync(store);
        var runner = new Runner();
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        Audio(entry, true);
        Check.True(File.Exists(Path.Combine(entry.Directory, "retain-audio.json")));
        var legacy = await store.StatusAsync(Query(entry), false, Ct);
        Check.Equal("processing", legacy.ProcessingStatus);
        Check.True(legacy.RetainAudio && !legacy.AudioDeleted);
        var current = await store.StatusAsync(Query(entry) with { SupportsRetention = true }, false, Ct);
        Check.Equal("completed", current.ProcessingStatus);
        Check.True(current.RetainAudio && !current.AudioDeleted);
        await Fault(409, () => store.StatusAsync(Query(entry), true, Ct));
        using var restarted = new InboxStore(root.Runtime);
        await Queue(root, restarted, runner).ProcessPendingOnceAsync(Ct);
        Check.Equal(1, runner.Calls);
        Audio(entry, true);
        Check.Equal(current, await restarted.StatusAsync(Query(entry) with { SupportsRetention = true }, false, Ct));
        Check.True(BridgeOptions.Parse(["--serve", "--retain-audio", "--repo-root", root.Root, "--runtime-root", root.Runtime]).RetainAudio);
    }
    private static RecordingQuery Query(InboxEntry entry) => new(entry.Manifest.DeviceId, entry.Manifest.RecordingId, entry.Manifest.Sha256);
    private static BridgeOptions Options(TestRoot root) => root.Options with { NoTranscribe = false, TranscribeOnly = true, Database = null };
    private static ImportQueue Queue(TestRoot root, InboxStore store, Runner runner) =>
        new(store, new LocalRecordingTranscriber(Options(root), runner), _ => { }, () => DateTimeOffset.UtcNow.AddDays(1));

    private static async Task<InboxEntry> StoreAsync(InboxStore store, bool optIn = true)
    {
        var json = Fixtures.Manifest();
        if (optIn) json["cleanupAfterTranscription"] = true;
        var manifest = Fixtures.Parse(json);
        await store.StoreAsync(manifest, Fixtures.Wave(), Ct);
        return store.ReadEntry(Path.Combine(store.Root, manifest.DeviceId, manifest.RecordingId));
    }

    private static async Task Fault(int expected, Func<Task> action)
    {
        try { await action(); }
        catch (ClientFault ex) { Check.Equal(expected, ex.Status); return; }
        throw new InvalidOperationException($"Expected ClientFault {expected}.");
    }

    private static void Audio(InboxEntry entry, bool exists) => Check.Equal(exists, File.Exists(Path.Combine(entry.Directory, "audio.wav")));

    private static async Task OptInAsync()
    {
        var json = Fixtures.Manifest();
        var legacy = Fixtures.Parse(json);
        Check.True(!legacy.CleanupAfterTranscription);
        var serialized = JsonSerializer.SerializeToNode(legacy, Protocol.Json)!.AsObject();
        Check.True(!serialized.ContainsKey("cleanupAfterTranscription"));
        Check.Equal(Fixtures.Hash(JsonSerializer.SerializeToUtf8Bytes(serialized, Protocol.Json)), legacy.IdentityHash());
        json["cleanupAfterTranscription"] = false;
        Check.Equal(legacy.IdentityHash(), Fixtures.Parse(json).IdentityHash());
        foreach (var invalid in new JsonNode?[] { null, JsonValue.Create("true"), JsonValue.Create(1), new JsonObject() })
        {
            json["cleanupAfterTranscription"] = invalid;
            await Fault(400, () => Task.Run(() => Fixtures.Parse(json)));
        }
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store, false);
        var runner = new Runner();
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        Audio(entry, true);
        Check.Equal("completed", (await store.StatusAsync(Query(entry), false, Ct)).ProcessingStatus);
        await Fault(409, () => store.StatusAsync(Query(entry), true, Ct));
        await Fault(409, () => store.FindReceiptAsync(entry.Manifest with { CleanupAfterTranscription = true }, Ct));
        var historical = await StoreAsync(store);
        await new LocalRecordingTranscriber(Options(root), runner).TranscribeAsync(historical, Ct);
        WriteState(store, historical, "transcribed");
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        Audio(historical, true);
        Check.True(!File.Exists(Path.Combine(historical.Directory, "tombstone.json")));
    }

    private static async Task CompleteAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        Audio(entry, true);
        Check.Equal("pending", (await store.StatusAsync(Query(entry), false, Ct)).ProcessingStatus);
        var runner = new Runner();
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        Audio(entry, false);
        foreach (var name in new[] { "manifest.json", "receipt.json", "transcript.json", "tombstone.json" })
            Check.True(File.Exists(Path.Combine(entry.Directory, name)));
        var status = await store.StatusAsync(Query(entry), false, Ct);
        Check.Equal("completed", status.ProcessingStatus);
        Check.True(status.AudioDeleted && status.PhoneAudioDeleted is null);
        var ack = await store.StatusAsync(Query(entry), true, Ct);
        Check.Equal(true, ack.PhoneAudioDeleted);
        var tombstone = File.ReadAllBytes(Path.Combine(entry.Directory, "tombstone.json"));
        Check.Equal(ack, await store.StatusAsync(Query(entry), true, Ct));
        Check.True(tombstone.SequenceEqual(File.ReadAllBytes(Path.Combine(entry.Directory, "tombstone.json"))));
        File.Delete(Path.Combine(entry.Directory, "receipt.json"));
        using var restarted = new InboxStore(root.Runtime);
        Check.Equal(status, await restarted.StatusAsync(Query(entry), false, Ct));
        Check.Equal(ack, await restarted.StatusAsync(Query(entry), true, Ct));
        Check.Equal(entry.Stored.Receipt, await restarted.FindReceiptAsync(entry.Manifest, Ct));
        Check.Equal(entry.Stored.Receipt, await restarted.StoreAsync(entry.Manifest, Fixtures.Wave(), Ct));
        var noInference = new Runner { Output = new(1, "", "") };
        await Queue(root, restarted, noInference).ProcessPendingOnceAsync(Ct);
        Check.Equal(0, noInference.Calls);
        Audio(entry, false);
        await Fault(409, () => restarted.FindReceiptAsync(entry.Manifest with { Title = "changed" }, Ct));
    }

    private static async Task TerminalScanAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new Runner();
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        var transcriptPath = Path.Combine(entry.Directory, "transcript.json");
        var queueBytes = File.ReadAllBytes(Path.Combine(entry.Directory, "queue.json"));
        var tombstoneBytes = File.ReadAllBytes(Path.Combine(entry.Directory, "tombstone.json"));
        File.Delete(Path.Combine(entry.Directory, "receipt.json"));
        using var restarted = new InboxStore(root.Runtime);
        var logs = new List<string>();
        var queue = new ImportQueue(restarted, new LocalRecordingTranscriber(Options(root), runner), logs.Add);
        using (var locked = new FileStream(transcriptPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            for (var i = 0; i < 3; i++) await queue.ProcessPendingOnceAsync(Ct);
            Check.Equal(0, logs.Count, "A terminal scan must not even attempt to open the exclusively held transcript.");
            Check.Equal(1, runner.Calls);
            await Check.ThrowsAsync<IOException>(() => restarted.StatusAsync(Query(entry), false, Ct));
        }
        Check.True(queueBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(entry.Directory, "queue.json"))));
        Check.True(tombstoneBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(entry.Directory, "tombstone.json"))));
        Check.Equal("completed", (await restarted.StatusAsync(Query(entry), false, Ct)).ProcessingStatus);
        var transcript = JsonNode.Parse(File.ReadAllBytes(transcriptPath))!;
        transcript["result"]!["segments"]![0]!["text"] = "tampered";
        DurableFiles.ReplaceJson(transcriptPath, transcript);
        await queue.ProcessPendingOnceAsync(Ct);
        Check.Equal(0, logs.Count);
        Check.Equal(1, runner.Calls);
        await Check.ThrowsAsync<IOException>(() => restarted.StatusAsync(Query(entry), false, Ct));
        await Check.ThrowsAsync<IOException>(() => restarted.StatusAsync(Query(entry), true, Ct));
        Audio(entry, false);
    }

    private static async Task TerminalScanRecoveryAsync()
    {
        foreach (var condition in new[] { "processing", "failed", "deletion-uncommitted", "cache-remains", "missing-transcript", "invalid-identity" })
        {
            using var root = new TestRoot();
            using var store = new InboxStore(root.Runtime);
            var entry = await StoreAsync(store);
            var runner = new Runner();
            await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
            var tombstonePath = Path.Combine(entry.Directory, "tombstone.json");
            var completion = DurableFiles.ReadJson<RecordingCompletion>(tombstonePath);
            var transcriptPath = Path.Combine(entry.Directory, "transcript.json");
            var transcript = File.ReadAllBytes(transcriptPath);
            var partial = Path.Combine(root.Runtime, "mobile-partials", entry.Manifest.DeviceId + "_" + entry.Manifest.RecordingId);
            if (condition is "processing" or "failed") WriteState(store, entry, condition);
            if (condition == "deletion-uncommitted") DurableFiles.ReplaceJson(tombstonePath, completion with { AudioDeleted = false });
            if (condition == "cache-remains") Directory.CreateDirectory(partial);
            if (condition == "missing-transcript") File.Delete(transcriptPath);
            if (condition == "invalid-identity") DurableFiles.ReplaceJson(tombstonePath,
                completion with { Stored = completion.Stored with { DeviceId = Guid.NewGuid().ToString("D") } });
            using var restarted = new InboxStore(root.Runtime);
            var logs = new List<string>();
            var queue = new ImportQueue(restarted, new LocalRecordingTranscriber(Options(root), runner), logs.Add);
            using (var locked = condition == "missing-transcript" ? null : new FileStream(transcriptPath, FileMode.Open, FileAccess.Read, FileShare.None))
                await queue.ProcessPendingOnceAsync(Ct);
            Check.True(logs.Count != 0, $"{condition} must retain strict verification, not use the terminal skip.");
            Check.Equal(1, runner.Calls);
            if (condition == "cache-remains") Directory.Delete(partial);
            if (condition == "missing-transcript") DurableFiles.WriteNew(transcriptPath, transcript);
            if (condition == "invalid-identity") DurableFiles.ReplaceJson(tombstonePath, completion);
            await queue.ProcessPendingOnceAsync(Ct);
            Check.Equal("transcribed", restarted.ReadQueue(entry.Directory).Status);
            Check.True((await restarted.StatusAsync(Query(entry), false, Ct)).AudioDeleted);
            Check.Equal(1, runner.Calls);
        }
    }

    private static async Task TerminalScanDeletionGuardAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new Runner();
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        var transcriptPath = Path.Combine(entry.Directory, "transcript.json");
        var original = File.ReadAllBytes(transcriptPath);
        var transcript = JsonNode.Parse(original)!;
        transcript["result"]!["segments"]![0]!["text"] = "tampered";
        DurableFiles.ReplaceJson(transcriptPath, transcript);
        DurableFiles.WriteNew(Path.Combine(entry.Directory, "audio.wav"), Fixtures.Wave());
        var logs = new List<string>();
        var queue = new ImportQueue(store, new LocalRecordingTranscriber(Options(root), runner), logs.Add);
        await queue.ProcessPendingOnceAsync(Ct);
        Check.True(logs.Count != 0);
        Audio(entry, true);
        Check.Equal(1, runner.Calls);
        File.Delete(transcriptPath);
        DurableFiles.WriteNew(transcriptPath, original);
        await queue.ProcessPendingOnceAsync(Ct);
        Audio(entry, false);
        Check.Equal(1, runner.Calls);
        Check.True((await store.StatusAsync(Query(entry), false, Ct)).AudioDeleted);
    }

    private static async Task FailuresAsync()
    {
        foreach (var failure in new[] { "valid-silence", "empty", "unmarked-empty", "asr", "disk", "return-without-save" })
        {
            using var root = new TestRoot();
            using var store = new InboxStore(root.Runtime);
            var entry = await StoreAsync(store);
            var runner = new Runner();
            var silence = JsonNode.Parse(LocalTranscriptionTests.ResultJson(false))!;
            if (failure == "unmarked-empty") silence["warnings"] = new JsonArray();
            runner.Output = failure switch
            {
                "valid-silence" or "unmarked-empty" => new(0, silence.ToJsonString(), ""),
                "empty" => new(0, "", ""), "asr" => new(1, LocalTranscriptionTests.ResultJson(), ""), _ => runner.Output
            };
            if (failure == "disk") Directory.CreateDirectory(Path.Combine(entry.Directory, "transcript.json"));
            var queue = failure == "return-without-save" ? new ImportQueue(store, new UnsavedTranscriber(), _ => { }) : Queue(root, store, runner);
            await queue.ProcessPendingOnceAsync(Ct);
            var status = await store.StatusAsync(Query(entry), false, Ct);
            Check.Equal(failure == "valid-silence" ? "completed" : "failed", status.ProcessingStatus);
            Check.Equal(failure == "valid-silence", status.AudioDeleted);
            Audio(entry, failure != "valid-silence");
        }
    }

    private static async Task CompletionWriteFailureAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var path = Path.Combine(entry.Directory, "tombstone.json");
        Directory.CreateDirectory(path);
        var runner = new Runner();
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        Audio(entry, true);
        Check.Equal("failed", (await store.StatusAsync(Query(entry), false, Ct)).ProcessingStatus);
        Directory.Delete(path);
        WriteState(store, entry, "failed");
        await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
        Check.Equal(1, runner.Calls);
        Audio(entry, false);
    }

    private static async Task DeleteFailureAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var audio = Path.Combine(entry.Directory, "audio.wav");
        var runner = new Runner();
        using (var locked = new FileStream(audio, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
            var status = await store.StatusAsync(Query(entry), true, Ct);
            Check.Equal("completed", status.ProcessingStatus);
            Check.True(!status.AudioDeleted && status.PhoneAudioDeleted == true);
            Audio(entry, true);
        }
        using var restarted = new InboxStore(root.Runtime);
        await Queue(root, restarted, runner).ProcessPendingOnceAsync(Ct);
        Audio(entry, false);
        Check.Equal(1, runner.Calls);
        Check.True((await restarted.StatusAsync(Query(entry), true, Ct)).AudioDeleted);
    }

    private static async Task InterruptedAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new Runner();
        await new LocalRecordingTranscriber(Options(root), runner).TranscribeAsync(entry, Ct);
        await store.CompleteLocalAsync(entry, Ct);
        File.Delete(Path.Combine(entry.Directory, "audio.wav"));
        WriteState(store, entry, "processing");
        using var restarted = new InboxStore(root.Runtime);
        Check.True(!(await restarted.StatusAsync(Query(entry), false, Ct)).AudioDeleted);
        await Queue(root, restarted, runner).ProcessPendingOnceAsync(Ct);
        Check.True((await restarted.StatusAsync(Query(entry), false, Ct)).AudioDeleted);
        Check.Equal("transcribed", restarted.ReadQueue(entry.Directory).Status);
        Check.Equal(1, runner.Calls);
    }

    private static async Task AckWriteFailureAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        await Queue(root, store, new Runner()).ProcessPendingOnceAsync(Ct);
        var path = Path.Combine(entry.Directory, "tombstone.json");
        using (var locked = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await Check.ThrowsAsync<IOException>(() => store.StatusAsync(Query(entry), true, Ct));
            Check.True(!DurableFiles.ReadJson<RecordingCompletion>(path).PhoneAudioDeleted);
        }
        using var restarted = new InboxStore(root.Runtime);
        using var briefReader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var release = Task.Run(async () => { await Task.Delay(30); briefReader.Dispose(); });
        try { Check.Equal(true, (await restarted.StatusAsync(Query(entry), true, Ct)).PhoneAudioDeleted); }
        finally { await release; }
    }

    private static async Task CorruptionAsync()
    {
        foreach (var failure in new[] { "transcript-missing", "transcript-changed", "receipt-changed", "proof-missing" })
        {
            using var root = new TestRoot();
            using var store = new InboxStore(root.Runtime);
            var entry = await StoreAsync(store);
            var runner = new Runner();
            await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
            var transcriptPath = Path.Combine(entry.Directory, "transcript.json");
            if (failure == "transcript-missing") File.Delete(transcriptPath);
            if (failure == "transcript-changed")
            {
                var json = JsonNode.Parse(File.ReadAllBytes(transcriptPath))!;
                json["result"]!["segments"]![0]!["text"] = "changed";
                DurableFiles.ReplaceJson(transcriptPath, json);
            }
            if (failure == "receipt-changed") DurableFiles.ReplaceJson(Path.Combine(entry.Directory, "receipt.json"),
                entry.Stored with { IdentityHash = new string('0', 64) });
            if (failure == "proof-missing") File.Delete(Path.Combine(entry.Directory, "tombstone.json"));
            await Check.ThrowsAsync<IOException>(() => store.StatusAsync(Query(entry), false, Ct));
            await Check.ThrowsAsync<IOException>(() => store.StoreAsync(entry.Manifest, Fixtures.Wave(), Ct));
            Audio(entry, false);
        }
    }

    private static async Task StatusAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        foreach (var state in new[] { "pending", "processing", "failed" })
        {
            WriteState(store, entry, state);
            Check.Equal(state, (await store.StatusAsync(Query(entry), false, Ct)).ProcessingStatus);
            await Fault(409, () => store.StatusAsync(Query(entry), true, Ct));
        }
        await Fault(404, () => store.StatusAsync(Query(entry) with { RecordingId = Guid.NewGuid().ToString("D") }, false, Ct));
        await Fault(404, () => store.StatusAsync(Query(entry) with { DeviceId = Guid.NewGuid().ToString("D") }, true, Ct));
        await Fault(409, () => store.StatusAsync(Query(entry) with { Sha256 = new string('a', 64) }, true, Ct));
        await Fault(400, () => store.StatusAsync(Query(entry) with { DeviceId = "../escape" }, false, Ct));
        Audio(entry, true);
    }

    private static async Task AgentAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        await new ImportQueue(store, new Importer(), _ => { }).ProcessPendingOnceAsync(Ct);
        Audio(entry, true);
        Check.Equal("transcribed", store.ReadQueue(entry.Directory).Status);
        Check.Equal("processing", (await store.StatusAsync(Query(entry), false, Ct)).ProcessingStatus);
        await Fault(409, () => store.StatusAsync(Query(entry), true, Ct));
    }

    private static byte[] Gzip()
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, true)) gzip.Write(Fixtures.Wave());
        return output.ToArray();
    }

    private static async Task CacheAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        using var partials = new ResumableUploadStore(root.Runtime, store);
        var manifest = Fixtures.Parse(Fixtures.Manifest()) with { CleanupAfterTranscription = true };
        var zipped = Gzip();
        var upload = (await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, Ct)).Upload!;
        try
        {
            await upload.AppendAsync(0, zipped, Ct);
            await store.StoreAsync(manifest, Fixtures.Wave(), Ct); // HTTPS wins while RFCOMM still holds a lease.
            var entry = store.ReadEntry(Path.Combine(store.Root, manifest.DeviceId, manifest.RecordingId));
            var export = Path.Combine(entry.Directory, "manual-export.wav");
            DurableFiles.WriteNew(export, Fixtures.Wave());
            var runner = new Runner();
            await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
            Audio(entry, true);
            Check.True(!(await store.StatusAsync(Query(entry), false, Ct)).AudioDeleted);
            Check.True(File.Exists(Path.Combine(upload.Directory, "compressed.part")));
            upload.Dispose();
            using (var locked = new FileStream(Path.Combine(upload.Directory, "compressed.part"), FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
                Audio(entry, true);
                Check.True(!(await store.StatusAsync(Query(entry), false, Ct)).AudioDeleted);
            }
            await Queue(root, store, runner).ProcessPendingOnceAsync(Ct);
            Audio(entry, false);
            Check.True(!Directory.Exists(upload.Directory));
            Check.True(File.Exists(export));
            var begin = await partials.BeginAsync(manifest, Fixtures.Hash(zipped), zipped.Length, Ct);
            Check.True(begin.Upload is null && begin.Receipt == entry.Stored.Receipt);
            Check.Equal(1, runner.Calls);
        }
        finally { upload.Dispose(); }
    }

    private static async Task TransportsAsync()
    {
        using var root = new TestRoot();
        await using var https = await EndpointFixture.StartAsync(root);
        using var partials = new ResumableUploadStore(root.Runtime, https.Store);
        await using var rfcomm = new RfcommTestHost(https.Pairing, partials);
        var entry = await StoreAsync(https.Store);
        var query = Query(entry);
        var json = JsonSerializer.SerializeToNode(query, Protocol.Json)!.AsObject();
        async Task<(int Code, JsonObject Body)> Post(string route, string body, HttpClient? client = null)
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await (client ?? https.Client).PostAsync("/v1/recordings/" + route, content);
            return ((int)response.StatusCode, JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsObject());
        }
        foreach (var route in new[] { "status", "cleanup-ack" })
        {
            using var anonymous = https.NewClient(authenticated: false);
            Check.Equal(401, (await Post(route, json.ToJsonString(), anonymous)).Code);
            Check.Equal(400, (await Post(route, "[]")).Code);
            Check.Equal(400, (await Post(route, "{\"deviceId\":\"a\",\"deviceId\":\"b\"}")).Code);
            Check.Equal(413, (await Post(route, new string(' ', Protocol.MaxManifestBytes + 1))).Code);
        }
        foreach (var op in new[] { "status", "cleanup_ack" })
        {
            using var anonymous = await rfcomm.ConnectAsync();
            Check.Equal(401, (await anonymous.RequestAsync(new { op, query.DeviceId, query.RecordingId, query.Sha256 }))["status"]!.GetValue<int>());
        }
        Check.Equal(409, (await Post("cleanup-ack", json.ToJsonString())).Code);
        var queue = Queue(root, https.Store, new Runner());
        using (var locked = new FileStream(Path.Combine(entry.Directory, "audio.wav"), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await queue.ProcessPendingOnceAsync(Ct);
            using var connection = await rfcomm.AuthorizedAsync();
            foreach (var op in new[] { "status", "cleanup_ack" })
            {
                var http = await Post(op == "status" ? "status" : "cleanup-ack", json.ToJsonString());
                var bluetooth = await connection.RequestAsync(new { op, query.DeviceId, query.RecordingId, query.Sha256 });
                Check.Equal(200, http.Code);
                Check.True(JsonNode.DeepEquals(http.Body, bluetooth));
                Check.Equal("completed", http.Body["processingStatus"]!.GetValue<string>());
                Check.Equal(false, http.Body["audioDeleted"]!.GetValue<bool>());
                if (op == "cleanup_ack") Check.Equal(true, http.Body["phoneAudioDeleted"]!.GetValue<bool>());
            }
        }
        await queue.ProcessPendingOnceAsync(Ct);
        using var client = await rfcomm.AuthorizedAsync();
        foreach (var op in new[] { "status", "cleanup_ack" })
        {
            var http = await Post(op == "status" ? "status" : "cleanup-ack", json.ToJsonString());
            var bluetooth = await client.RequestAsync(new { op, query.DeviceId, query.RecordingId, query.Sha256 });
            Check.Equal(200, http.Code);
            Check.True(JsonNode.DeepEquals(http.Body, bluetooth));
            Check.Equal(op == "status" ? 5 : 6, http.Body.Count);
            Check.Equal("completed", http.Body["processingStatus"]!.GetValue<string>());
            Check.Equal(true, http.Body["audioDeleted"]!.GetValue<bool>());
        }
        var duplicate = await https.UploadAsync(JsonSerializer.SerializeToNode(entry.Manifest, Protocol.Json)!.AsObject());
        Check.Equal(200, duplicate.Status);
        Check.True(JsonNode.DeepEquals(JsonSerializer.SerializeToNode(entry.Stored.Receipt, Protocol.Json), duplicate.Body["receipt"]));
        var begin = await client.BeginAsync(JsonSerializer.SerializeToNode(entry.Manifest, Protocol.Json)!.AsObject(), Gzip());
        Check.True(JsonNode.DeepEquals(JsonSerializer.SerializeToNode(entry.Stored.Receipt, Protocol.Json), begin["receipt"]));
        Audio(entry, false);
        foreach (var (field, value, code) in new[] { ("recordingId", Guid.NewGuid().ToString("D"), 404), ("sha256", new string('a', 64), 409) })
        {
            var bad = json.DeepClone().AsObject();
            bad[field] = value;
            foreach (var op in new[] { "status", "cleanup_ack" })
            {
                Check.Equal(code, (await Post(op == "status" ? "status" : "cleanup-ack", bad.ToJsonString())).Code);
                using var connection = await rfcomm.AuthorizedAsync();
                var frame = bad.DeepClone().AsObject();
                frame["op"] = op;
                Check.Equal(code, (await connection.RequestAsync(frame))["status"]!.GetValue<int>());
            }
        }
    }

    private static async Task PathsAndConcurrencyAsync()
    {
        using var root = new TestRoot();
        using var store = new InboxStore(root.Runtime);
        var entry = await StoreAsync(store);
        var runner = new Runner();
        await new LocalRecordingTranscriber(Options(root), runner).TranscribeAsync(entry, Ct);
        await store.CompleteLocalAsync(entry, Ct);
        var audio = Path.Combine(entry.Directory, "audio.wav");
        var target = Path.Combine(root.Root, "recording-target");
        Directory.Move(entry.Directory, target);
        try
        {
            var info = new ProcessStartInfo("powershell") { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command",
                "New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET -ErrorAction Stop | Out-Null" })
                info.ArgumentList.Add(arg);
            info.Environment["TEST_LINK"] = entry.Directory;
            info.Environment["TEST_TARGET"] = target;
            using var process = Process.Start(info)!;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            await stdout;
            Check.Equal(0, process.ExitCode, await stderr);
            await Check.ThrowsAsync<IOException>(() => store.CleanupCompletedAsync(entry.Directory, Ct));
            await Check.ThrowsAsync<IOException>(() => store.StatusAsync(Query(entry), false, Ct));
            Directory.Move(target, target + "-moved");
            try { await Check.ThrowsAsync<IOException>(() => Task.Run(() => Paths.RejectLinks(entry.Directory))); }
            finally { Directory.Move(target + "-moved", target); }
        }
        finally
        {
            if (Directory.Exists(entry.Directory))
            {
                Check.True((File.GetAttributes(entry.Directory) & FileAttributes.ReparsePoint) != 0);
                Directory.Delete(entry.Directory);
            }
            Directory.Move(target, entry.Directory);
        }
        Check.True(File.Exists(audio));
        await Check.ThrowsAsync<IOException>(() => store.CleanupCompletedAsync(root.Root, Ct));
        var queue = Queue(root, store, runner);
        await Task.WhenAll(queue.ProcessPendingOnceAsync(Ct), queue.ProcessPendingOnceAsync(Ct),
            store.StoreAsync(entry.Manifest, Fixtures.Wave(), Ct), store.StatusAsync(Query(entry), true, Ct));
        Audio(entry, false);
        Check.Equal(1, runner.Calls);
    }

    private static void WriteState(InboxStore store, InboxEntry entry, string status)
    {
        var state = JsonSerializer.SerializeToNode(new QueueState(status, 1, Protocol.Utc(DateTimeOffset.UtcNow)), Protocol.Json)!;
        state["processingMode"] = "local-transcription";
        DurableFiles.ReplaceJson(Path.Combine(entry.Directory, "queue.json"), state);
    }

    private sealed class Runner : ILocalAsrRunner
    {
        public int Calls { get; private set; }
        public LocalAsrProcessResult Output { get; set; } = new(0, LocalTranscriptionTests.ResultJson(), "");
        public Task<LocalAsrProcessResult> RunAsync(ProcessStartInfo info, CancellationToken ct)
        { Calls++; return Task.FromResult(Output); }
    }

    private sealed class Importer : IRecordingImporter
    {
        public Task<string> ImportAsync(InboxEntry entry, CancellationToken ct) => Task.FromResult("agent-id");
    }

    private sealed class UnsavedTranscriber : IRecordingTranscriber
    {
        public Task<LocalTranscript> TranscribeAsync(InboxEntry entry, CancellationToken ct) => Task.FromResult(
            new LocalTranscript(1, "local-transcription", entry.Manifest.DeviceId, entry.Manifest.RecordingId,
                entry.Manifest.Sha256, entry.Stored.IdentityHash, true, Protocol.Utc(DateTimeOffset.UtcNow),
                JsonSerializer.Deserialize<JsonElement>(LocalTranscriptionTests.ResultJson())));
    }
}
