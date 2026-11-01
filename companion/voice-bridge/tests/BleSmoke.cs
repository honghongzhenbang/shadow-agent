namespace VoiceBridge.Tests;

internal static class BleSmoke
{
    // This explicit opt-in is the only test that uses actual BLE hardware; the regular suite never does.
    public static async Task<int> RunAsync()
    {
        try
        {
            using var root = new TestRoot();
            using var lease = new RuntimeLease(root.Runtime);
            using var pairing = Pairing.Setup(root.Runtime, null);
            using var store = new InboxStore(root.Runtime);
            await using var app = BridgeServer.Build(root.Options, pairing, store, testPort: 0);
            await app.StartAsync();
            using var unavailable = new CancellationTokenSource();
            using (var beacon = await BluetoothBeacon.StartAsync(pairing.Config.BridgeId, Console.WriteLine, unavailable.Cancel))
            {
                await Task.Delay(TimeSpan.FromSeconds(15), unavailable.Token);
                Console.WriteLine("BLE_SMOKE_PASS: full Started advertisement held for 15 seconds; no ASR, microphone or production files.");
            }
            await app.StopAsync();
            Console.WriteLine($"BLE_SMOKE_RECEIVED_ENTRIES={store.Entries().Count()}; temporary HTTPS listener and GATT advertisement stopped.");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"BLE_SMOKE_FAIL: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }
}
