using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Radios;
using Windows.Foundation;
using Windows.Security.Cryptography;

namespace VoiceBridge;

internal sealed record BluetoothProbe(bool AdapterPresent, bool IsLowEnergySupported,
    bool IsPeripheralRoleSupported, string? RadioState, string? Error);

internal sealed class BluetoothBeacon : IDisposable
{
    private GattServiceProvider? provider;
    private Radio? radio;
    private GattLocalCharacteristic? identity;
    private TypedEventHandler<GattLocalCharacteristic, GattReadRequestedEventArgs>? readRequested;
    private TypedEventHandler<GattServiceProvider, GattServiceProviderAdvertisementStatusChangedEventArgs>? statusChanged;
    private int disposed;
    private readonly Action<string> log;
    private readonly BluetoothAdvertisementState state;

    private BluetoothBeacon(Action<string> log, Action unavailable)
    {
        this.log = log;
        state = new BluetoothAdvertisementState(unavailable);
    }

    public static async Task<BluetoothProbe> ProbeAsync()
    {
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var adapter = await BluetoothAdapter.GetDefaultAsync().AsTask(deadline.Token);
            if (adapter is null) return new(false, false, false, null, "No Bluetooth adapter.");
            var radio = await adapter.GetRadioAsync().AsTask(deadline.Token);
            return new(true, adapter.IsLowEnergySupported, adapter.IsPeripheralRoleSupported, radio?.State.ToString(), null);
        }
        catch (Exception ex) { return new(false, false, false, null, $"{ex.GetType().Name}: {ex.Message}"); }
    }

    public static async Task<BluetoothBeacon> StartAsync(string bridgeId, Action<string> log, Action unavailable,
        Func<string[]>? endpoints = null, Func<RfcommEndpoint?>? rfcomm = null, CancellationToken cancellationToken = default)
    {
        var beacon = new BluetoothBeacon(log, unavailable);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(30));
            var adapter = await BluetoothAdapter.GetDefaultAsync().AsTask(deadline.Token);
            if (adapter?.IsPeripheralRoleSupported != true)
                throw new InvalidOperationException("BLE peripheral unavailable.");
            beacon.radio = await adapter.GetRadioAsync().AsTask(deadline.Token);
            if (beacon.radio is not null) beacon.radio.StateChanged += beacon.RadioStateChanged;
            if (beacon.radio?.State != RadioState.On)
                throw new InvalidOperationException("BLE radio unavailable.");
            var result = await GattServiceProvider.CreateAsync(Guid.Parse(Protocol.ServiceUuid)).AsTask(deadline.Token);
            if (result.Error != BluetoothError.Success || result.ServiceProvider is null)
                throw new InvalidOperationException($"GATT service creation failed: {result.Error}");
            beacon.provider = result.ServiceProvider;
            var characteristic = await beacon.provider.Service.CreateCharacteristicAsync(Guid.Parse(Protocol.IdentityCharacteristicUuid),
                new GattLocalCharacteristicParameters
                {
                    CharacteristicProperties = GattCharacteristicProperties.Read,
                    ReadProtectionLevel = GattProtectionLevel.Plain
                }).AsTask(deadline.Token);
            if (characteristic.Error != BluetoothError.Success)
                throw new InvalidOperationException($"GATT identity creation failed: {characteristic.Error}");
            var snapshots = new DiscoveryReadBuffer(() => BridgeDiscovery.Encode(bridgeId, (endpoints ?? BridgeDiscovery.CurrentEndpoints)(), rfcomm?.Invoke()));
            beacon.identity = characteristic.Characteristic;
            beacon.readRequested = async (_, args) =>
            {
                using var deferral = args.GetDeferral();
                log("BLE identity read requested.");
                try
                {
                    var request = await args.GetRequestAsync();
                    if (request is null)
                    {
                        log("BLE identity read cancelled before request retrieval.");
                        return;
                    }
                    try
                    {
                        var bytes = snapshots.Read(args.Session.DeviceId.Id, request.Offset, request.Length);
                        request.RespondWithValue(CryptographicBuffer.CreateFromByteArray(bytes));
                        log($"BLE identity response: offset={request.Offset}, maxLength={request.Length}, bytes={bytes.Length}");
                    }
                    catch (ArgumentOutOfRangeException)
                    {
                        log($"BLE identity offset rejected: offset={request.Offset}, maxLength={request.Length}");
                        request.RespondWithProtocolError(0x07);
                    }
                    catch (Exception ex)
                    {
                        log($"BLE endpoint discovery failed: {ex.GetType().Name}");
                        request.RespondWithProtocolError(0x0E);
                    }
                }
                catch (Exception ex) { log($"BLE read cancelled or unavailable: {ex.GetType().Name}"); }
            };
            beacon.identity.ReadRequested += beacon.readRequested;
            beacon.statusChanged = (_, args) =>
            {
                log($"BLE advertisement status={args.Status}, error={args.Error}");
                beacon.state.Observe(args.Status, args.Error);
            };
            beacon.provider.AdvertisementStatusChanged += beacon.statusChanged;
            deadline.Token.ThrowIfCancellationRequested();
            if (beacon.radio.State != RadioState.On) beacon.state.LoseRadio();
            if (beacon.state.Started.IsCompleted) await beacon.state.Started;
            beacon.provider.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = true });
            await beacon.state.Started.WaitAsync(TimeSpan.FromSeconds(15), deadline.Token);
            if (!beacon.state.IsRunning || beacon.provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started)
                throw new InvalidOperationException("BLE advertising stopped before startup completed.");
            return beacon;
        }
        catch { beacon.Dispose(); throw; }
    }

    private void RadioStateChanged(Radio sender, object args)
    {
        if (sender.State != RadioState.On) state.LoseRadio();
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        state.Dispose();
        var cleanup = new BluetoothCleanup("BLE");
        cleanup.Attempt(() => { if (radio is not null) radio.StateChanged -= RadioStateChanged; });
        cleanup.Attempt(() => { if (identity is not null && readRequested is not null) identity.ReadRequested -= readRequested; });
        cleanup.Attempt(() => { if (provider is not null && statusChanged is not null) provider.AdvertisementStatusChanged -= statusChanged; });
        cleanup.Attempt(() => provider?.StopAdvertising());
        radio = null; identity = null; readRequested = null; provider = null; statusChanged = null;
        cleanup.ThrowIfFailed();
    }
}

internal sealed class BluetoothAdvertisementState(Action unavailable) : IDisposable
{
    private readonly object gate = new();
    private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool running;
    private bool finished;

    public Task Started => started.Task;
    public bool IsRunning { get { lock (gate) return running && !finished; } }

    public void LoseRadio()
    {
        var notify = false;
        lock (gate)
        {
            if (finished) return;
            finished = true;
            if (running) notify = true;
            else started.TrySetException(new IOException("BLE radio lost during startup."));
        }
        if (notify) unavailable();
    }

    public void Observe(GattServiceProviderAdvertisementStatus status, BluetoothError error)
    {
        var notify = false;
        lock (gate)
        {
            if (finished) return;
            if (!running)
            {
                if (error != BluetoothError.Success)
                {
                    finished = true;
                    started.TrySetException(new InvalidOperationException($"BLE advertising failed: {status}, {error}"));
                }
                else if (status == GattServiceProviderAdvertisementStatus.Started)
                {
                    running = true;
                    started.TrySetResult();
                }
                // Windows can report Aborted/Success just before Started. Only Started
                // proves readiness; all other no-error startup states remain deadline-bound.
                return;
            }
            if (error != BluetoothError.Success || status is GattServiceProviderAdvertisementStatus.Aborted
                or GattServiceProviderAdvertisementStatus.Stopped or GattServiceProviderAdvertisementStatus.StartedWithoutAllAdvertisementData)
            {
                finished = true;
                notify = true;
            }
        }
        if (notify) unavailable();
    }

    public void Dispose() { lock (gate) finished = true; }
}
