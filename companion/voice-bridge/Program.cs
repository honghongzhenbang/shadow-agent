using System.Text.Json;
using Microsoft.Extensions.Hosting;

namespace VoiceBridge;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            var options = BridgeOptions.Parse(args);
            if (options.Mode == "--help")
            {
                Console.WriteLine("""
                    Voice Bridge (Windows, HTTPS + paired RFCOMM/TLS, no PC microphone).
                      --probe
                      --rfcomm-probe
                      --setup [--bridge-id UUID]
                      --serve [--no-transcribe | --transcribe-only] [--retain-audio] [--speaker-clusters] [--database PATH] [--node PATH] [--listen-ip IPv4]
                      --check
                    Optional: --repo-root PATH --runtime-root PATH (default runtime/voice).
                    --setup creates private bridge/pairing.json for one-time phone import.
                    --transcribe-only saves local ASR results without Node, Agent or database access.
                    Without either processing flag, --serve invokes the existing Node importer.
                    Pairing binds stable identity; current LAN endpoints are discovered over BLE.
                    --check reads existing pairing and checks local direct HTTPS; no lease, BLE or private-key import.
                    --rfcomm-probe temporarily registers/listens for RFCOMM, then unregisters; no runtime access or phone connection.
                    """);
                return 0;
            }
            if (options.Mode == "--probe")
            {
                var probe = await BluetoothBeacon.ProbeAsync();
                Console.WriteLine(JsonSerializer.Serialize(probe, Protocol.Json));
                return probe.IsPeripheralRoleSupported && probe.RadioState == "On" ? 0 : 2;
            }
            if (options.Mode == "--rfcomm-probe")
            {
                var probe = await RfcommBridgeServer.ProbeAsync();
                Console.WriteLine(JsonSerializer.Serialize(probe, Protocol.Json));
                return probe.Status == "passed" ? 0 : 2;
            }
            if (options.Mode == "--check")
            {
                var report = await BridgeDiagnostics.RunAsync(options.RuntimeRoot);
                Console.WriteLine(JsonSerializer.Serialize(report, Protocol.Json));
                return report.Status == "passed" ? 0 : 1;
            }
            using var lease = new RuntimeLease(options.RuntimeRoot);
            if (options.Mode == "--setup")
            {
                using var setup = Pairing.Setup(options.RuntimeRoot, options.BridgeId);
                Console.WriteLine($"Pairing file (private; import on phone): {Pairing.ConfigPath(options.RuntimeRoot)}");
                Console.WriteLine($"Bridge ID: {setup.Config.BridgeId}; TLS identity: {setup.Config.ServerName}");
                return 0;
            }
            using var pairing = Pairing.Load(options.RuntimeRoot);
            await ServeAsync(options, pairing);
            return 0;
        }
        catch (Exception ex)
        {
            if (args.Contains("--check", StringComparer.Ordinal))
            {
                Console.WriteLine(JsonSerializer.Serialize(BridgeDiagnostics.EntryFailure(ex is ArgumentException), Protocol.Json));
                return 1;
            }
            Console.Error.WriteLine($"Voice Bridge failed: {ex.Message}");
            return 1;
        }
    }

    private static async Task ServeAsync(BridgeOptions options, Pairing pairing)
    {
        using var store = new InboxStore(options.RuntimeRoot, retainAudio: options.RetainAudio);
        using var partials = new ResumableUploadStore(options.RuntimeRoot, store);
        await using var app = BridgeServer.Build(options, pairing, store);
        using var queueStop = CancellationTokenSource.CreateLinkedTokenSource(app.Lifetime.ApplicationStopping);
        Task queue = Task.CompletedTask;
        Task maintenance = Task.CompletedTask;
        Task advertising = Task.CompletedTask;
        var rfcomm = new RfcommBridgeSupervisor();
        Task bluetoothIntake = Task.CompletedTask;
        await app.StartAsync();
        try
        {
            maintenance = partials.MaintainAsync(Console.WriteLine, queueStop.Token);
            bluetoothIntake = rfcomm.RunAsync(async token =>
                await RfcommBridgeServer.StartAsync(pairing, partials, Console.WriteLine, token), Console.WriteLine, queueStop.Token);
            string[] Endpoints() => options.ListenIp is null or "0.0.0.0" ? BridgeDiscovery.CurrentEndpoints() :
                BridgeDiscovery.IsPrivateAddress(System.Net.IPAddress.Parse(options.ListenIp)) ? [$"https://{options.ListenIp}:8787"] : [];
            advertising = BluetoothBeaconSupervisor.RunAsync(async unavailable =>
                await BluetoothBeacon.StartAsync(pairing.Config.BridgeId, Console.WriteLine, unavailable, Endpoints, () => rfcomm.Endpoint,
                    queueStop.Token),
                Console.WriteLine, queueStop.Token);
            Console.WriteLine($"HTTPS intake: TCP 8787; current discovery: {string.Join(", ", Endpoints())}; no PC microphone is opened.");
            Console.WriteLine(options.NoTranscribe ? "Transcription disabled; receipts mean durable storage only." :
                options.TranscribeOnly ? "Local transcription only; no Node importer, database or Agent." :
                "Agent import enabled: invoking the existing Node importer sequentially.");
            if (options.RetainAudio) Console.WriteLine("Test retention enabled: newly received source audio is retained on both devices; no automatic expiry.");
            if (options.SpeakerClusters) Console.WriteLine("Local acoustic speaker clusters enabled for new recordings; labels are not confirmed identities.");
            if (!options.NoTranscribe)
                queue = (options.TranscribeOnly ? new ImportQueue(store, new LocalRecordingTranscriber(options, store: store), Console.WriteLine) :
                    new ImportQueue(store, new NodeRecordingImporter(options), Console.WriteLine)).RunAsync(queueStop.Token);
            await app.WaitForShutdownAsync();
        }
        finally
        {
            queueStop.Cancel();
            try { await Task.WhenAll(queue, maintenance, advertising, bluetoothIntake); }
            finally { await app.StopAsync(); }
        }
    }
}
