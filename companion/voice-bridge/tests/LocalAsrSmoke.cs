using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VoiceBridge.Tests;

internal static class LocalAsrSmoke
{
    public static async Task<int> RunAsync(string repoRoot)
    {
        try
        {
            repoRoot = Path.GetFullPath(repoRoot);
            var fixture = Path.Combine(repoRoot, "runtime", "voice", "fixtures", "TEST_ONLY_two-speaker-A-B-A.wav");
            var metadata = JsonNode.Parse(File.ReadAllText(fixture + ".manifest.json"))!;
            Check.True(metadata["testOnly"]!.GetValue<bool>(), "Only the explicit public test fixture is allowed.");
            var audio = File.ReadAllBytes(fixture);
            Check.Equal(metadata["sha256"]!.GetValue<string>(), Fixtures.Hash(audio));
            using var root = new TestRoot();
            await using var endpoint = await EndpointFixture.StartAsync(root);
            var manifest = Fixtures.Manifest(audio);
            manifest["sampleCount"] = metadata["sampleCount"]!.GetValue<long>();
            manifest["durationMs"] = metadata["sampleCount"]!.GetValue<long>() * 1000.0 / 16000;
            manifest["title"] = "TEST_ONLY public speech local ASR smoke";
            manifest["cleanupAfterTranscription"] = true;
            var uploadClock = Stopwatch.StartNew();
            var upload = await endpoint.UploadAsync(manifest, audio, manifestFile: true);
            Check.Equal(200, upload.Status);
            uploadClock.Stop();
            var options = root.Options with { RepoRoot = repoRoot, NoTranscribe = false, Database = null, TranscribeOnly = true, SpeakerClusters = true };
            var queue = new ImportQueue(endpoint.Store, new LocalRecordingTranscriber(options), Console.WriteLine);
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
            var asrClock = Stopwatch.StartNew();
            await queue.ProcessPendingOnceAsync(timeout.Token);
            asrClock.Stop();
            var directory = endpoint.Store.Entries().Single();
            var state = JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "queue.json")))!;
            Check.Equal("transcribed", state["status"]!.GetValue<string>(), state.ToJsonString());
            Check.Equal("local-transcription", state["processingMode"]!.GetValue<string>());
            Check.True(state["importedRecordingId"] is null);
            var transcript = JsonSerializer.Deserialize<LocalTranscript>(File.ReadAllBytes(Path.Combine(directory, "transcript.json")), Protocol.Json)!;
            Check.Equal(Fixtures.Hash(audio), transcript.AudioSha256);
            Check.True(transcript.TestOnly);
            Check.True(transcript.Result.GetProperty("segments").GetArrayLength() > 0);
            Check.Equal("vad-cluster", transcript.Result.GetProperty("diarization").GetProperty("mode").GetString());
            Check.True(transcript.Result.GetProperty("speakers").EnumerateArray().Any(s => s.TryGetProperty("embedding", out _)),
                "Public multi-speaker fixture must produce acoustic samples, not fabricated person identities.");
            var cacheClock = Stopwatch.StartNew();
            var again = LocalRecordingTranscriber.ReadCached(endpoint.Store.ReadEntry(directory))
                ?? throw new IOException("Persisted transcript is missing after audio cleanup.");
            cacheClock.Stop();
            Check.Equal(transcript.CompletedAt, again.CompletedAt);
            var query = new RecordingQuery(manifest["deviceId"]!.GetValue<string>(), manifest["recordingId"]!.GetValue<string>(), Fixtures.Hash(audio));
            var completed = await endpoint.Store.StatusAsync(query, false, timeout.Token);
            Check.Equal("completed", completed.ProcessingStatus);
            Check.True(completed.AudioDeleted && !File.Exists(Path.Combine(directory, "audio.wav")));
            var duplicate = await endpoint.UploadAsync(manifest, audio, manifestFile: true);
            Check.Equal(200, duplicate.Status);
            Check.True(!File.Exists(Path.Combine(directory, "audio.wav")), "Duplicate must not restore cleaned audio.");
            var acknowledged = await endpoint.Store.StatusAsync(query, true, timeout.Token);
            Check.True(acknowledged.PhoneAudioDeleted == true && acknowledged.AudioDeleted);
            Check.Equal(0, Directory.EnumerateFiles(root.Root, "*.sqlite*", SearchOption.AllDirectories).Count());
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                status = "passed", scope = "local_https_to_real_cpu_asr",
                testOnly = true, microphone = false, agent = false, database = false,
                audioSeconds = manifest["durationMs"]!.GetValue<double>() / 1000,
                uploadMs = uploadClock.Elapsed.TotalMilliseconds, asrSeconds = asrClock.Elapsed.TotalSeconds,
                cachedReadMs = cacheClock.Elapsed.TotalMilliseconds,
                audioDeleted = completed.AudioDeleted, duplicateDidNotRestoreAudio = true,
                cleanupAckProtocol = acknowledged.PhoneAudioDeleted == true,
                segments = transcript.Result.GetProperty("segments").GetArrayLength(),
                diarization = transcript.Result.GetProperty("diarization").GetProperty("mode").GetString(),
                acousticClusters = transcript.Result.GetProperty("speakers").GetArrayLength(),
                engine = transcript.Result.GetProperty("engine").GetString(),
                model = transcript.Result.GetProperty("model").GetString()
            }, Protocol.Json));
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Local ASR smoke failed: {ex}");
            return 1;
        }
    }
}
