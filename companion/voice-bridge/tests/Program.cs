using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.AccessControl;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--java-interop") return await JavaInteropTest.RunAsync(args);
        if (args.Length == 1 && args[0] == "--ble-smoke") return await BleSmoke.RunAsync();
        if (args.Length == 3 && args[0] == "--local-asr-smoke" && args[1] == "--repo-root")
            return await LocalAsrSmoke.RunAsync(args[2]);
        var checkOnly = args.Length == 1 && args[0] == "--check-tests";
        var dualOnly = args.Length == 1 && args[0] == "--dual-transport-tests";
        var bluetoothOnly = args.Length == 1 && args[0] == "--bluetooth-recovery-tests";
        if (args.Length > 0 && !checkOnly && !dualOnly && !bluetoothOnly) return await EmulatorTestHost.RunAsync(args);
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("BLE startup transitions, bounded wait and loss after readiness", BluetoothAdvertisementStateTest.RunAsync),
            ("BLE loss recovery, bounded backoff and shutdown disposal", BluetoothBeaconSupervisorTest.RunAsync),
            ("private ACLs without ownership changes or shared-root mutation", PrivateAclTest),
            ("pairing persistence, stable DNS identity, ACL and exclusive lease", PairingTest),
            ("dynamic BLE endpoints and stable long-read snapshots", DiscoveryTest),
            ("TLS pin, HTTPS only and authentication on every route", SecurityTest),
            ("durable upload, manifest file field, duplicate and restart", UploadTest),
            ("conflicting identity and immutable metadata", ConflictTest),
            ("UUID traversal, upload filenames and untrusted audioPath", TraversalTest),
            ("hash, frame, duration and PCM validation", ValidationTest),
            ("multipart structure, streamed size and exact 16 MiB limit", MultipartTest),
            ("disk failure never acknowledges, staged crash recovery", DiskFailureTest),
            ("durable retry, restart recovery and sequential queue", QueueTest),
            ("Node process contract, busy/failure and cancellation", NodeProcessTest),
            ("CLI scope and safety defaults", OptionsTest)
        };
        tests = checkOnly ? BridgeDiagnosticsTests.Cases : dualOnly ? DualTransportTests.Cases
            : bluetoothOnly ? BluetoothRecoveryTests.Cases
            : tests.Concat(BridgeDiagnosticsTests.Cases).Concat(LocalTranscriptionTests.Cases).Concat(DualTransportTests.Cases)
                .Concat(RecordingLifecycleTests.Cases).Concat(BluetoothRecoveryTests.Cases).ToArray();
        var failures = 0;
        foreach (var (name, run) in tests)
        {
            try { await run(); Console.WriteLine($"PASS {name}"); }
            catch (Exception ex) { failures++; Console.Error.WriteLine($"FAIL {name}\n{ex}"); }
        }
        Console.WriteLine($"{tests.Length - failures}/{tests.Length} test groups passed. Synthetic audio only; no BLE advertising, microphone, production DB or real ASR.");
        return failures == 0 ? 0 : 1;
    }

    private static Task PrivateAclTest()
    {
        using var root = new TestRoot();
        Directory.CreateDirectory(root.Runtime);
        var parent = new DirectoryInfo(root.Runtime);
        var before = parent.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All);
        using (var lease = new RuntimeLease(root.Runtime))
            Check.Equal(before, parent.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All));
        var directory = Directory.CreateDirectory(Path.Combine(root.Runtime, "private-acl-test"));
        var originalOwner = directory.GetAccessControl().GetOwner(typeof(SecurityIdentifier));
        var identity = WindowsIdentity.GetCurrent().User!;
        var limited = new DirectorySecurity();
        limited.SetAccessRuleProtection(true, false);
        limited.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.Modify | FileSystemRights.Synchronize,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        limited.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(limited);
        Paths.PrivateDirectory(directory.FullName);
        var updated = directory.GetAccessControl();
        Check.Equal(originalOwner, updated.GetOwner(typeof(SecurityIdentifier)));
        Check.True(updated.AreAccessRulesProtected);
        foreach (FileSystemAccessRule rule in updated.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            Check.True(rule.IdentityReference.Value == identity.Value || rule.IdentityReference.Value == "S-1-5-18");
            Check.Equal(FileSystemRights.FullControl, rule.FileSystemRights);
        }
        return Task.CompletedTask;
    }

    private static async Task PairingTest()
    {
        using var root = new TestRoot();
        using var lease = new RuntimeLease(root.Runtime);
        using var first = Pairing.Setup(root.Runtime, null);
        var original = File.ReadAllBytes(Pairing.ConfigPath(root.Runtime));
        using var second = Pairing.Setup(root.Runtime, null);
        Check.True(original.SequenceEqual(File.ReadAllBytes(Pairing.ConfigPath(root.Runtime))));
        Check.Equal(first.Config, second.Config);
        Check.Equal(64, first.Config.Token.Length);
        Check.Equal(Protocol.ServiceUuid, first.Config.ServiceUuid);
        Check.Equal(Protocol.IdentityCharacteristicUuid, first.Config.IdentityCharacteristicUuid);
        Check.Equal(Pairing.Fingerprint(first.Certificate), first.Config.CertificateSha256);
        var san = new X509SubjectAlternativeNameExtension(first.Certificate.Extensions["2.5.29.17"]!.RawData);
        Check.True(san.EnumerateDnsNames().SequenceEqual(new[] { first.Config.ServerName }));
        Check.Equal(0, san.EnumerateIPAddresses().Count());
        Check.True(!Encoding.UTF8.GetString(original).Contains("serverUrl"), "Pairing must not bind a changing LAN address.");
        var permissions = new DirectoryInfo(Path.Combine(root.Runtime, "bridge")).GetAccessControl();
        Check.True(permissions.AreAccessRulesProtected);
        var permitted = new[] { WindowsIdentity.GetCurrent().User!.Value, "S-1-5-18" };
        foreach (FileSystemAccessRule rule in permissions.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            Check.True(permitted.Contains(rule.IdentityReference.Value));
        await Check.ThrowsAsync<IOException>(() => Task.Run(() => { using var locked = new RuntimeLease(root.Runtime); }));
        await Check.ThrowsAsync<InvalidOperationException>(() => Task.Run(() => Pairing.Setup(root.Runtime, Guid.NewGuid().ToString("D"))));
    }

    private static async Task DiscoveryTest()
    {
        var id = Guid.NewGuid().ToString("D");
        var urls = new[] { "https://192.168.10.2:8787" };
        var now = DateTimeOffset.UtcNow;
        var buffer = new DiscoveryReadBuffer(() => BridgeDiscovery.Encode(id, urls), () => now);
        var expected = BridgeDiscovery.Encode(id, urls);
        var first = buffer.Read("phone-a", 0, 30);
        urls = ["https://10.1.2.3:8787"];
        var second = buffer.Read("phone-a", 30, 512);
        Check.True(first.Concat(second).SequenceEqual(expected), "One long read must not mix two network snapshots.");
        var changed = buffer.Read("phone-b", 0, 512);
        using var parsed = JsonDocument.Parse(changed);
        Check.Equal(2, parsed.RootElement.GetProperty("schemaVersion").GetInt32());
        Check.Equal(urls[0], parsed.RootElement.GetProperty("endpoints")[0].GetString());
        Check.True(changed.Length < 512 && !Encoding.UTF8.GetString(changed).Contains("token"));
        Check.True(buffer.Read("phone-a", 0, 512).SequenceEqual(changed));
        now = now.AddSeconds(11);
        await Check.ThrowsAsync<ArgumentOutOfRangeException>(() => Task.Run(() => buffer.Read("phone-a", 30, 512)));
        foreach (var url in new[] { "https://8.8.8.8:8787", "http://192.168.1.2:8787", "https://127.0.0.1:8787", "https://169.254.1.2:8787" })
            await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeDiscovery.Encode(id, [url])));
        using var empty = JsonDocument.Parse(BridgeDiscovery.Encode(id, []));
        Check.Equal(0, empty.RootElement.GetProperty("endpoints").GetArrayLength());
    }

    private static async Task SecurityTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        using var anonymous = f.NewClient(authenticated: false);
        foreach (var endpoint in new[] { "/v1/health", "/v1/recordings", "/missing", "/pairing.json" })
        {
            using var get = await anonymous.GetAsync(endpoint);
            Check.Equal(401, (int)get.StatusCode);
        }
        using (var post = await anonymous.PostAsync("/v1/recordings", new StringContent("not multipart")))
            Check.Equal(401, (int)post.StatusCode);
        anonymous.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", new string('a', 64));
        using (var wrong = await anonymous.GetAsync("/v1/health")) Check.Equal(401, (int)wrong.StatusCode);
        anonymous.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", f.Pairing.Config.Token);
        using (var wrong = await anonymous.GetAsync("/v1/health")) Check.Equal(401, (int)wrong.StatusCode);
        using var health = await f.Client.GetAsync("/v1/health");
        Check.Equal(200, (int)health.StatusCode);
        var body = JsonNode.Parse(await health.Content.ReadAsStringAsync())!;
        Check.Equal(true, body["ok"]!.GetValue<bool>());
        Check.Equal(f.Pairing.Config.BridgeId, body["bridgeId"]!.GetValue<string>());
        Check.True(DateTimeOffset.TryParse(body["utc"]!.GetValue<string>(), out _));
        Check.True(!body.ToJsonString().Contains(f.Pairing.Config.Token));
        using var badPin = f.NewClient(new string('0', 64));
        await Check.ThrowsAsync<HttpRequestException>(() => badPin.GetAsync("/v1/health"));
        using var wrongName = f.NewClient(serverName: "voice-wrong-identity.local");
        await Check.ThrowsAsync<HttpRequestException>(() => wrongName.GetAsync("/v1/health"));
        using var normalTrust = new HttpClient(new HttpClientHandler { UseProxy = false });
        await Check.ThrowsAsync<HttpRequestException>(() => normalTrust.GetAsync(new Uri(f.Client.BaseAddress!, "/v1/health")));
        var cleartext = new UriBuilder(f.Client.BaseAddress!) { Scheme = "http" }.Uri;
        try
        {
            using var response = await anonymous.GetAsync(new Uri(cleartext, "/v1/health"));
            Check.True(!response.IsSuccessStatusCode, "The listener must never serve plaintext HTTP.");
        }
        catch (HttpRequestException) { }
        using var missing = await f.Client.GetAsync("/pairing.json");
        Check.Equal(404, (int)missing.StatusCode);
    }

    private static async Task UploadTest()
    {
        using var root = new TestRoot();
        var manifest = Fixtures.Manifest();
        string receipt;
        string pin;
        await using (var f = await EndpointFixture.StartAsync(root))
        {
            var first = await f.UploadAsync(manifest, manifestFile: true);
            Check.Equal(200, first.Status);
            Check.Equal(true, first.Body["ok"]!.GetValue<bool>());
            receipt = first.Body["receipt"]!.ToJsonString();
            Check.Equal(3, first.Body["receipt"]!.AsObject().Count);
            var path = f.Store.Entries().Single();
            var entry = f.Store.ReadEntry(path);
            Check.Equal(manifest["recordingId"]!.GetValue<string>(), entry.Stored.Receipt.RecordingId);
            Check.True(File.ReadAllBytes(Path.Combine(path, "audio.wav")).SequenceEqual(Fixtures.Wave()));
            Check.Equal("pending", f.Store.ReadQueue(path).Status);
            Check.Equal(0, f.Store.ReadQueue(path).Attempts);
            Check.Equal(4, Directory.EnumerateFiles(path).Count());
            foreach (var result in await Task.WhenAll(f.UploadAsync(manifest), f.UploadAsync(manifest)))
            {
                Check.Equal(200, result.Status);
                Check.Equal(receipt, result.Body["receipt"]!.ToJsonString());
            }
            Check.Equal(1, f.Store.Entries().Count());
            pin = f.Pairing.Config.CertificateSha256;
        }
        await using (var f = await EndpointFixture.StartAsync(root))
        {
            var duplicate = await f.UploadAsync(manifest, chunked: true);
            Check.Equal(200, duplicate.Status);
            Check.Equal(receipt, duplicate.Body["receipt"]!.ToJsonString());
            Check.Equal(pin, f.Pairing.Config.CertificateSha256);
        }
    }

    private static async Task ConflictTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        var manifest = Fixtures.Manifest();
        Check.Equal(200, (await f.UploadAsync(manifest)).Status);
        foreach (var field in new[] { "conversationId", "recordedAt", "timeBasis", "title" })
        {
            var changed = manifest.DeepClone().AsObject();
            changed[field] = field switch
            {
                "conversationId" => Guid.NewGuid().ToString("D"), "recordedAt" => "2026-10-15T01:01:00Z",
                "timeBasis" => "different_clock", _ => "different title"
            };
            Check.Equal(409, (await f.UploadAsync(changed)).Status, field);
        }
        var other = Fixtures.Wave(value: 1);
        var changedAudio = manifest.DeepClone().AsObject();
        changedAudio["sha256"] = Fixtures.Hash(other);
        Check.Equal(409, (await f.UploadAsync(changedAudio, other)).Status);
        var anotherDevice = manifest.DeepClone().AsObject();
        anotherDevice["deviceId"] = Guid.NewGuid().ToString("D");
        Check.Equal(200, (await f.UploadAsync(anotherDevice)).Status);
        Check.Equal(2, f.Store.Entries().Count());
    }

    private static async Task TraversalTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        foreach (var field in new[] { "deviceId", "recordingId", "conversationId" })
            foreach (var value in new[] { "../../outside", @"C:\Windows\system.ini", "CON", Guid.Empty.ToString("D"), "not-a-uuid" })
            {
                var invalid = Fixtures.Manifest();
                invalid[field] = value;
                Check.Equal(400, (await f.UploadAsync(invalid)).Status, field + ":" + value);
            }
        Check.Equal(0, f.Store.Entries().Count());
        var manifest = Fixtures.Manifest();
        var outside = Path.Combine(root.Root, "must-not-exist.wav");
        manifest["audioPath"] = outside;
        manifest["database"] = outside;
        manifest["runtimeRoot"] = outside;
        Check.Equal(200, (await f.UploadAsync(manifest, fileName: "../../outside.wav")).Status);
        Check.True(!File.Exists(outside));
        var stored = JsonNode.Parse(File.ReadAllBytes(Path.Combine(f.Store.Entries().Single(), "manifest.json")))!;
        Check.Equal("audio.wav", stored["audioPath"]!.GetValue<string>());
        Check.True(stored["database"] is null && stored["runtimeRoot"] is null);
        var changed = manifest.DeepClone().AsObject();
        changed["audioPath"] = @"\\attacker.invalid\share\audio.wav";
        Check.Equal(200, (await f.UploadAsync(changed)).Status);
    }

    private static async Task ValidationTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        var edits = new (string Key, JsonNode? Value)[]
        {
            ("sha256", new string('0', 64)), ("sha256", "bad"), ("sampleRateHz", 44100), ("sampleCount", 1599),
            ("channels", 2), ("durationMs", 500), ("sampleCount", 1.5), ("recordedAt", "2026-10-15T09:00:00"),
            ("timeUncertaintyMs", -1), ("testOnly", "true")
        };
        foreach (var (key, value) in edits)
        {
            var manifest = Fixtures.Manifest();
            manifest[key] = value?.DeepClone();
            Check.Equal(400, (await f.UploadAsync(manifest)).Status, key);
        }
        foreach (var mutate in new Action<byte[]>[]
        {
            b => b[0] = 0, b => Fixtures.U32(b, 4, 0), b => Fixtures.U16(b, 20, 3),
            b => Fixtures.U16(b, 22, 2), b => Fixtures.U32(b, 24, 44100), b => Fixtures.U32(b, 28, 123),
            b => Fixtures.U16(b, 32, 1), b => Fixtures.U16(b, 34, 8), b => Fixtures.U32(b, 40, 3199),
            b => Fixtures.U32(b, 16, uint.MaxValue), b => Fixtures.U32(b, 40, uint.MaxValue)
        })
        {
            var audio = Fixtures.Wave();
            mutate(audio);
            Check.Equal(400, (await f.UploadAsync(Fixtures.Manifest(audio), audio)).Status);
        }
        var truncated = Fixtures.Wave()[..^2];
        Check.Equal(400, (await f.UploadAsync(Fixtures.Manifest(truncated), truncated)).Status);
        var oneSample = Fixtures.Wave(1);
        Check.Equal(200, (await f.UploadAsync(Fixtures.Manifest(oneSample), oneSample)).Status);
        Check.Equal(1, f.Store.Entries().Count());
    }

    private static async Task MultipartTest()
    {
        using var root = new TestRoot();
        await using var f = await EndpointFixture.StartAsync(root);
        using (var response = await f.Client.PostAsync("/v1/recordings", new StringContent("{}"))) Check.Equal(415, (int)response.StatusCode);
        foreach (var type in new[] { "missing", "duplicate", "unknown", "invalid-json" })
        {
            using var content = new MultipartFormDataContent();
            content.Add(new StringContent(type == "invalid-json" ? "{" : Fixtures.Manifest().ToJsonString()), "manifest");
            if (type != "missing") content.Add(new ByteArrayContent(Fixtures.Wave()), "audio", "audio.wav");
            if (type == "duplicate") content.Add(new StringContent("{}"), "manifest");
            if (type == "unknown") content.Add(new StringContent("{}"), "extra");
            using var response = await f.Client.PostAsync("/v1/recordings", content);
            Check.Equal(400, (int)response.StatusCode, type);
        }
        var oversizedManifest = Fixtures.Manifest();
        oversizedManifest["extra"] = new string('x', Protocol.MaxManifestBytes);
        Check.Equal(413, (await f.UploadAsync(oversizedManifest, chunked: true)).Status);
        var oversized = new byte[Protocol.MaxAudioBytes + 1];
        Check.Equal(413, (await f.UploadAsync(Fixtures.Manifest(), oversized, chunked: true)).Status);
        var maxWave = Fixtures.Wave((Protocol.MaxAudioBytes - 44) / 2);
        Check.Equal(Protocol.MaxAudioBytes, maxWave.Length);
        Check.Equal(200, (await f.UploadAsync(Fixtures.Manifest(maxWave), maxWave, manifestFile: true)).Status);
        Check.Equal(1, f.Store.Entries().Count());
    }

    private static async Task DiskFailureTest()
    {
        using var root = new TestRoot();
        var fail = true;
        await using var f = await EndpointFixture.StartAsync(root, path =>
        {
            Check.True(File.Exists(Path.Combine(path, "audio.wav")) && File.Exists(Path.Combine(path, "receipt.json")));
            if (fail) throw new IOException("Synthetic commit failure.");
        });
        var manifest = Fixtures.Manifest();
        var rejected = await f.UploadAsync(manifest);
        Check.Equal(503, rejected.Status);
        Check.True(rejected.Body["receipt"] is null);
        Check.Equal(0, f.Store.Entries().Count());
        Check.Equal(0, Directory.EnumerateFiles(f.Store.Root, "*", SearchOption.AllDirectories).Count());
        var staging = Path.Combine(f.Store.Root, manifest["deviceId"]!.GetValue<string>(), ".interrupted.staging");
        Directory.CreateDirectory(staging);
        File.WriteAllText(Path.Combine(staging, "audio.wav"), "unfinished");
        Check.Equal(0, f.Store.Entries().Count());
        fail = false;
        Check.Equal(200, (await f.UploadAsync(manifest)).Status);
        var entryPath = f.Store.Entries().Single();
        File.WriteAllBytes(Path.Combine(entryPath, "audio.wav"), Fixtures.Wave(value: 4));
        Check.True((await f.UploadAsync(manifest)).Status != 200, "Never acknowledge corrupted persisted audio.");
    }

    private static async Task QueueTest()
    {
        using var root = new TestRoot();
        using var lease = new RuntimeLease(root.Runtime);
        using var store = new InboxStore(root.Runtime);
        var manifest = Fixtures.Parse(Fixtures.Manifest());
        var receipt = await store.StoreAsync(manifest, Fixtures.Wave(), CancellationToken.None);
        var directory = store.Entries().Single();
        var importer = new FakeImporter { Fail = true };
        var now = DateTimeOffset.UtcNow;
        var queue = new ImportQueue(store, importer, _ => { }, () => now);
        await queue.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal("failed", store.ReadQueue(directory).Status);
        Check.Equal(1, store.ReadQueue(directory).Attempts);
        Check.True(store.ReadQueue(directory).LastError!.Contains("Synthetic"));
        Check.Equal(receipt, store.ReadEntry(directory).Stored.Receipt);
        importer.Fail = false;
        var restarted = new ImportQueue(store, importer, _ => { }, () => now);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(1, importer.Calls);
        now = now.AddMinutes(2);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal("transcribed", store.ReadQueue(directory).Status);
        Check.Equal(2, store.ReadQueue(directory).Attempts);
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(2, importer.Calls);
        for (var i = 0; i < 3; i++) await store.StoreAsync(Fixtures.Parse(Fixtures.Manifest()), Fixtures.Wave(), CancellationToken.None);
        var pending = store.Entries().First(x => x != directory);
        store.WriteQueue(pending, new QueueState("processing", 1, Protocol.Utc(now)));
        await restarted.ProcessPendingOnceAsync(CancellationToken.None);
        Check.Equal(1, importer.MaxConcurrent);
        Check.True(store.Entries().All(x => store.ReadQueue(x).Status == "transcribed"));
        Check.Equal(5, importer.Calls);
    }

    private static async Task NodeProcessTest()
    {
        using var root = new TestRoot();
        using var lease = new RuntimeLease(root.Runtime);
        using var store = new InboxStore(root.Runtime);
        await store.StoreAsync(Fixtures.Parse(Fixtures.Manifest()), Fixtures.Wave(), CancellationToken.None);
        var entry = store.ReadEntry(store.Entries().Single());
        Directory.CreateDirectory(Path.Combine(root.Root, "scripts"));
        File.Copy(Path.Combine(AppContext.BaseDirectory, "fixtures", "fake-import.mjs"), Path.Combine(root.Root, "scripts", "voice-input.mjs"));
        var importer = new NodeRecordingImporter(root.Options);
        var start = importer.StartInfo(entry);
        Check.Equal(entry.Directory, start.WorkingDirectory);
        Check.Equal(false, start.UseShellExecute);
        Check.Equal(true, start.CreateNoWindow);
        Check.Equal("manifest.json", start.ArgumentList[3]);
        Check.Equal(root.Options.Database, start.ArgumentList[5]);
        foreach (var mode in new[] { "failed", "busy", "invalid" })
        {
            File.WriteAllText(Path.Combine(root.Root, "control.json"), JsonSerializer.Serialize(new { mode }));
            await Check.ThrowsAsync<IOException>(() => importer.ImportAsync(entry, CancellationToken.None));
        }
        File.WriteAllText(Path.Combine(root.Root, "control.json"), "{\"mode\":\"success\"}");
        Check.Equal("fixture-id", await importer.ImportAsync(entry, CancellationToken.None));
        var unsafeImporter = new NodeRecordingImporter(root.Options with { Database = null });
        await Check.ThrowsAsync<InvalidOperationException>(() => unsafeImporter.ImportAsync(entry, CancellationToken.None));
        File.WriteAllText(Path.Combine(root.Root, "control.json"), "{\"mode\":\"wait\"}");
        File.Delete(Path.Combine(root.Root, "child-pid.json"));
        using var cancel = new CancellationTokenSource();
        var waiting = importer.ImportAsync(entry, cancel.Token);
        for (var i = 0; i < 100 && !File.Exists(Path.Combine(root.Root, "child-pid.json")); i++) await Task.Delay(20);
        Check.True(File.Exists(Path.Combine(root.Root, "child-pid.json")));
        var pid = JsonSerializer.Deserialize<int>(File.ReadAllText(Path.Combine(root.Root, "child-pid.json")));
        cancel.Cancel();
        await Check.ThrowsAsync<OperationCanceledException>(() => waiting);
        try { using var process = Process.GetProcessById(pid); Check.True(process.HasExited); }
        catch (ArgumentException) { }
        Check.True(!File.Exists(root.Options.Database), "Fixture must not create any actual database.");
    }

    private static async Task OptionsTest()
    {
        using var root = new TestRoot();
        var options = BridgeOptions.Parse(["--serve", "--no-transcribe", "--repo-root", root.Root, "--listen-ip", "127.0.0.1"]);
        Check.True(options.NoTranscribe);
        Check.Equal("127.0.0.1", options.ListenIp);
        Check.Equal("--help", BridgeOptions.Parse(["--repo-root", root.Root]).Mode);
        foreach (var arguments in new[]
        {
            new[] { "--serve", "--probe" }, new[] { "--unknown" }, new[] { "--serve", "--server-url", "https://127.0.0.1:8787" },
            new[] { "--serve", "--listen-ip", "hostname.invalid" }, new[] { "--serve", "--repo-root", root.Root, "--runtime-root", root.Root }
        }) await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => BridgeOptions.Parse(arguments)));
        foreach (var url in new[] { "http://127.0.0.1:8787", "https://host:8787", "https://127.0.0.1:8787/pair", "https://0.0.0.0:8787", "https://127.0.0.1:8788", "https://8.8.8.8:8787" })
            await Check.ThrowsAsync<ArgumentException>(() => Task.Run(() => Protocol.ServerUri(url)));
    }

    private sealed class FakeImporter : IRecordingImporter
    {
        public bool Fail { get; set; }
        public int Calls { get; private set; }
        public int MaxConcurrent { get; private set; }
        private int active;
        public async Task<string> ImportAsync(InboxEntry entry, CancellationToken ct)
        {
            Calls++;
            active++;
            MaxConcurrent = Math.Max(MaxConcurrent, active);
            try
            {
                await Task.Delay(5, ct);
                if (Fail) throw new IOException("Synthetic transcriber failure.");
                return "isolated-fake-import";
            }
            finally { active--; }
        }
    }
}
