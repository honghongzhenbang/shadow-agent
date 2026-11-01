using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal static class JavaInteropTest
{
    public static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 5)
        {
            Console.Error.WriteLine("--java-interop REPO_ROOT JDK_HOME ANDROID_JAR JSON_JAR");
            return 2;
        }
        try
        {
            using var root = new TestRoot();
            Paths.PrivateDirectory(root.Root);
            var repo = Path.GetFullPath(args[1]);
            var jdk = Path.GetFullPath(args[2]);
            var androidJar = Path.GetFullPath(args[3]);
            var jsonJar = Path.GetFullPath(args[4]);
            var core = Path.Combine(repo, "mobile", "android", "app", "src", "main", "java", "com", "shadowagent", "voice", "core");
            string[] names = ["RfcommSession", "TlsEngineStream", "PinnedBridgeTls", "BridgeFrames", "LosslessUpload",
                "TransportGuard", "ReceiptValidator", "BridgeHealth", "RecordingStore", "WavFile", "AppSettings", "ProximityPolicy"];
            var sources = names.Select(name => Path.Combine(core, name + ".java")).ToArray();
            var hashes = sources.Select(path => Fixtures.Hash(File.ReadAllBytes(path))).ToArray();
            var classes = Directory.CreateDirectory(Path.Combine(root.Root, "classes")).FullName;
            var classPath = string.Join(Path.PathSeparator, classes, jsonJar, androidJar);
            await RunProcessAsync(Path.Combine(jdk, "bin", "javac.exe"),
                ["-encoding", "UTF-8", "--release", "17", "-classpath", classPath, "-d", classes,
                    .. sources, Path.Combine(repo, "companion", "voice-bridge", "tests", "fixtures", "java", "RfcommInteropClient.java")], root.Root);
            for (var i = 0; i < sources.Length; i++)
            {
                Check.Equal(hashes[i], Fixtures.Hash(File.ReadAllBytes(sources[i])), "Java source changed during compilation; rerun against a stable snapshot.");
                Console.WriteLine($"SOURCE {names[i]}.java sha256={hashes[i]}");
            }

            using var lease = new RuntimeLease(root.Runtime);
            using var pairing = Pairing.Setup(root.Runtime, null);
            using var store = new InboxStore(root.Runtime);
            using var partials = new ResumableUploadStore(root.Runtime, store);
            await using var host = new RfcommTestHost(pairing, partials);
            Check.True(host.Port is not (8787 or 25576));
            var cases = new JsonArray();
            foreach (var protocol in new[] { "TLSv1.2", "TLSv1.3" })
            {
                var directory = Directory.CreateDirectory(Path.Combine(root.Root, protocol)).FullName;
                var wave = Fixtures.Wave(80000);
                new Random(127).NextBytes(wave.AsSpan(44, 80000));
                DurableFiles.WriteNew(Path.Combine(directory, "audio.wav"), wave);
                DurableFiles.WriteJsonNew(Path.Combine(directory, "manifest.json"), Fixtures.Manifest(wave));
                cases.Add(new JsonObject { ["protocol"] = protocol, ["directory"] = directory });
            }
            var configPath = Path.Combine(root.Root, "interop.json");
            DurableFiles.WriteJsonNew(configPath, new { port = host.Port, pairing = pairing.Config, cases });
            Console.WriteLine($"HOST loopback=127.0.0.1:{host.Port}; synthetic private fixtures; no BLE, RFCOMM radio, ASR or Agent.");
            var output = await RunProcessAsync(Path.Combine(jdk, "bin", "java.exe"),
                ["-cp", classPath, "com.shadowagent.voice.core.RfcommInteropClient", configPath], root.Root);
            await host.DrainAsync();
            var result = JsonNode.Parse(output)!.AsObject();
            Check.Equal(true, result["wrongPinRejected"]!.GetValue<bool>());
            Check.Equal(true, result["wrongSanRejected"]!.GetValue<bool>());
            Check.Equal(true, result["wrongTokenRejected"]!.GetValue<bool>());
            var results = result["uploads"]!.AsArray();
            Check.Equal(cases.Count, results.Count);
            Check.Equal(cases.Count, store.Entries().Count());
            for (var i = 0; i < cases.Count; i++)
            {
                var directory = cases[i]!["directory"]!.GetValue<string>();
                var manifest = Fixtures.Parse(JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "manifest.json")))!.AsObject());
                var entry = store.ReadEntry(store.Entries().Single(path => Path.GetFileName(path) == manifest.RecordingId));
                var receipt = JsonSerializer.Deserialize<RecordingReceipt>(results[i]!["receipt"]!.ToJsonString(), Protocol.Json)!;
                Check.Equal(entry.Stored.Receipt, receipt);
                Check.Equal(cases[i]!["protocol"]!.GetValue<string>(), results[i]!["protocol"]!.GetValue<string>());
                Check.Equal(true, results[i]!["duplicateReceipt"]!.GetValue<bool>());
                Check.True(File.ReadAllBytes(Path.Combine(directory, "audio.wav")).SequenceEqual(File.ReadAllBytes(Path.Combine(entry.Directory, "audio.wav"))));
                Check.True(new FileInfo(Path.Combine(directory, "audio.wav.gz")).Length > Protocol.MaxChunkBytes);
                Check.Equal("pending", store.ReadQueue(entry.Directory).Status);
                Check.Equal(0, store.ReadQueue(entry.Directory).Attempts);
            }
            Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
            Check.True(!File.Exists(root.Options.Database));
            Console.WriteLine(result.ToJsonString(Protocol.Json));
            Console.WriteLine("PASS Java -> .NET TLS 1.2/1.3, auth/health, multi-chunk gzip, durable receipt, duplicate receipt and exact WAV bytes; wrong pin/SAN/token rejected. TCP simulation only, not phone or RFCOMM hardware acceptance.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine($"FAIL Java/.NET interop: {ex}"); return 1; }
    }

    private static async Task<string> RunProcessAsync(string executable, string[] arguments, string directory)
    {
        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("Could not start isolated Java test process.");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        try { await process.WaitForExitAsync(deadline.Token); }
        finally
        {
            if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
        }
        var stdout = await output;
        var stderr = await error;
        Check.Equal(0, process.ExitCode, $"{Path.GetFileName(executable)} failed: {stderr}");
        if (!string.IsNullOrWhiteSpace(stderr)) Console.Error.WriteLine(stderr);
        return stdout;
    }
}
