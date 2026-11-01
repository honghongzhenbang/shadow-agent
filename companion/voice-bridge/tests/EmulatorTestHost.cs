using Microsoft.Extensions.Hosting;

namespace VoiceBridge.Tests;

internal static class EmulatorTestHost
{
    public static async Task<int> RunAsync(string[] args)
    {
        var seconds = 300;
        if (args[0] != "--emulator-test-host" ||
            (args.Length != 1 && (args.Length != 3 || args[1] != "--seconds" || !int.TryParse(args[2], out seconds))) ||
            seconds < 1 || seconds > 900)
        {
            Console.Error.WriteLine("Tests accept only: --emulator-test-host [--seconds 1..900]. Default lifetime: 300 seconds.");
            return 1;
        }
        try
        {
            using var root = new TestRoot();
            using var lease = new RuntimeLease(root.Runtime);
            using var pairing = Pairing.Setup(root.Runtime, null);
            using var store = new InboxStore(root.Runtime);
            await using var app = BridgeServer.Build(root.Options with { ListenIp = "127.0.0.1" }, pairing, store, testPort: 8787);
            await app.StartAsync();
            Console.WriteLine($"EMULATOR_TEST_PAIRING_FILE={Pairing.ConfigPath(root.Runtime)}");
            Console.WriteLine($"EMULATOR_TEST_INBOX={store.Root}");
            Console.WriteLine($"EMULATOR_TEST_EXPIRES_UTC={Protocol.Utc(DateTimeOffset.UtcNow.AddSeconds(seconds))}");
            Console.WriteLine($"EMULATOR_TEST_STOP_FILE={Path.Combine(root.Root, "stop.request")}");
            Console.WriteLine("Test-only host: https://10.0.2.2:8787 -> 127.0.0.1:8787; no BLE, Node, ASR, microphone or production files. Ctrl+C stops early.");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
            using var stopFile = new FileSystemWatcher(root.Root, "stop.request");
            stopFile.Created += (_, _) => app.Lifetime.StopApplication();
            stopFile.EnableRaisingEvents = true;
            await app.WaitForShutdownAsync(deadline.Token);
            Console.WriteLine($"EMULATOR_TEST_RECEIVED_ENTRIES={store.Entries().Count()}");
            Console.WriteLine("Test host stopped; its private pairing, certificate and recordings are being removed.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Emulator test host failed: {ex.Message}");
            return 1;
        }
    }
}
