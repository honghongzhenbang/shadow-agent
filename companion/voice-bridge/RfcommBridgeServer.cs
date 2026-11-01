using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Rfcomm;
using Windows.Devices.Radios;
using Windows.Networking.Sockets;
using Windows.Storage.Streams;

namespace VoiceBridge;

internal sealed record RfcommEndpoint(string BluetoothAddress, string RfcommServiceUuid);
internal sealed record RfcommProbe(string Status, bool AdapterPresent, bool IsClassicSupported, string? RadioState,
    bool ServiceRegistered, bool ListenerBound, bool Advertising, string? BluetoothAddress, string RfcommServiceUuid,
    string Stage, string? Error);

internal sealed class RfcommBridgeServer : IRfcommBridgeListener
{
    internal const SocketProtectionLevel RequiredProtection = SocketProtectionLevel.BluetoothEncryptionWithAuthentication;
    private readonly object gate = new();
    private readonly Dictionary<StreamSocket, Task> connections = new();
    private readonly CancellationTokenSource stop = new();
    private readonly TaskCompletionSource unavailable = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly RfcommTlsSession? session;
    private readonly Action<string> log;
    private BluetoothAdapter? adapter;
    private string? bluetoothAddress;
    private Radio? radio;
    private RfcommServiceProvider? provider;
    private StreamSocketListener? listener;
    private bool bound;
    private bool advertising;
    private bool disposed;
    private Task? disposal;
    private string stage = "adapter";

    private RfcommBridgeServer(RfcommTlsSession? session, Action<string> log)
    { this.session = session; this.log = log; }

    public Task Unavailable => unavailable.Task;

    public RfcommEndpoint? Endpoint
    {
        get
        {
            lock (gate)
                return !disposed && !Unavailable.IsCompleted && advertising && bound && radio?.State == RadioState.On && bluetoothAddress is not null
                    ? new(bluetoothAddress, Protocol.RfcommServiceUuid) : null;
        }
    }

    public static async Task<RfcommBridgeServer> StartAsync(Pairing pairing, ResumableUploadStore partials, Action<string> log,
        CancellationToken cancellationToken = default)
    {
        var service = new RfcommBridgeServer(new RfcommTlsSession(pairing, partials, log), log);
        try { await service.RegisterAsync(cancellationToken); return service; }
        catch { await service.DisposeAsync(); throw; }
    }

    public static async Task<RfcommProbe> ProbeAsync()
    {
        // No pairing files, runtime lease, microphone, outbound connection or TLS data.
        await using var service = new RfcommBridgeServer(null, _ => { });
        try
        {
            await service.RegisterAsync();
            return service.Report("passed", null);
        }
        catch (Exception ex) { return service.Report("unavailable", $"{ex.GetType().Name} (0x{ex.HResult:X8})"); }
    }

    private RfcommProbe Report(string status, string? error) => new(status, adapter is not null, adapter?.IsClassicSupported ?? false,
        radio?.State.ToString(), provider is not null, bound, advertising, bluetoothAddress,
        Protocol.RfcommServiceUuid, stage, error);

    private async Task RegisterAsync(CancellationToken cancellationToken = default)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        adapter = await BluetoothAdapter.GetDefaultAsync().AsTask(deadline.Token);
        if (adapter is null || !adapter.IsClassicSupported) throw new NotSupportedException("Classic Bluetooth is unavailable.");
        bluetoothAddress = FormatAddress(adapter.BluetoothAddress);
        stage = "radio";
        radio = await adapter.GetRadioAsync().AsTask(deadline.Token);
        if (radio is not null) radio.StateChanged += RadioStateChanged;
        if (radio?.State != RadioState.On) throw new InvalidOperationException("Bluetooth radio must already be on.");
        stage = "registration";
        provider = await RfcommServiceProvider.CreateAsync(RfcommServiceId.FromUuid(Guid.Parse(Protocol.RfcommServiceUuid))).AsTask(deadline.Token);
        if (provider is null) throw new NotSupportedException("RFCOMM registration unavailable.");
        listener = new StreamSocketListener();
        listener.ConnectionReceived += ConnectionReceived;
        stage = "bind";
        await listener.BindServiceNameAsync(provider.ServiceId.AsString(), RequiredProtection).AsTask(deadline.Token);
        lock (gate) bound = true;
        using (var name = new DataWriter())
        {
            name.WriteByte(0x25); // SDP text string, one-byte length.
            name.WriteByte((byte)System.Text.Encoding.UTF8.GetByteCount("Voice Bridge"));
            name.WriteString("Voice Bridge");
            provider.SdpRawAttributes.Add(0x100, name.DetachBuffer());
        }
        stage = "advertise";
        deadline.Token.ThrowIfCancellationRequested();
        if (Unavailable.IsCompleted || radio.State != RadioState.On)
            throw new IOException("RFCOMM radio lost during registration.");
        provider.StartAdvertising(listener, radioDiscoverable: false);
        lock (gate) advertising = true;
        if (Endpoint is null) throw new InvalidOperationException("RFCOMM became unavailable during registration.");
        stage = "listening";
    }

    private void RadioStateChanged(Radio sender, object args)
    {
        if (sender.State == RadioState.On) return;
        lock (gate)
        {
            if (disposed) return;
            advertising = false;
            bound = false;
            unavailable.TrySetResult();
        }
        // Never keep publishing a stale endpoint after losing the radio. LAN remains usable.
        // The supervisor owns cancellation/draining, outside the WinRT callback and gate.
    }

    private void ConnectionReceived(StreamSocketListener sender, StreamSocketListenerConnectionReceivedEventArgs args)
    {
        var socket = args.Socket;
        lock (gate)
        {
            if (disposed || Unavailable.IsCompleted || !advertising || sender != listener ||
                stop.IsCancellationRequested || session is null || connections.Count >= 4)
            {
                socket.Dispose();
                return;
            }
            connections.Add(socket, Task.Run(() => HandleSocketAsync(socket)));
        }
    }

    private async Task HandleSocketAsync(StreamSocket socket)
    {
        using var cancelled = stop.Token.Register(socket.Dispose);
        try
        {
            var protection = socket.Information.ProtectionLevel;
            // The accepted WinRT socket reports PlainSocket on the validated Windows host.
            // Enforce Bluetooth protection at bind time; this value is diagnostic, not a TLS verdict.
            log($"RFCOMM socket received; required={RequiredProtection}; reported={protection}.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
            deadline.CancelAfter(TimeSpan.FromSeconds(15));
            using var peer = await BluetoothDevice.FromHostNameAsync(socket.Information.RemoteHostName).AsTask(deadline.Token);
            if (peer?.DeviceInformation.Pairing.IsPaired != true)
            {
                log("RFCOMM rejected: peer is not system-paired.");
                return;
            }
            log("RFCOMM paired peer verified; starting TLS.");
            using var transport = new DuplexStream(socket.InputStream.AsStreamForRead(), socket.OutputStream.AsStreamForWrite());
            await session!.RunAsync(transport, stop.Token);
        }
        catch (Exception ex) { log($"RFCOMM connection ended: {ex.GetType().Name}."); }
        finally
        {
            socket.Dispose();
            lock (gate) connections.Remove(socket);
        }
    }

    internal static string FormatAddress(ulong address)
    {
        if (address == 0 || address > 0xffffffffffff) throw new ArgumentException("Invalid Bluetooth address.");
        var hex = address.ToString("X12", System.Globalization.CultureInfo.InvariantCulture);
        return string.Join(":", Enumerable.Range(0, 6).Select(i => hex.Substring(i * 2, 2)));
    }

    public ValueTask DisposeAsync()
    {
        lock (gate)
        {
            if (disposal is not null) return new(disposal);
            disposed = true;
            advertising = false;
            bound = false;
            unavailable.TrySetResult();
            var pending = connections.Values.ToArray();
            // Cancellation disposes sockets; never invoke those callbacks under gate.
            disposal = Task.Run(() => DisposeCoreAsync(pending));
            return new(disposal);
        }
    }

    private async Task DisposeCoreAsync(Task[] pending)
    {
        var cleanup = new BluetoothCleanup("RFCOMM");
        cleanup.Attempt(() => { if (radio is not null) radio.StateChanged -= RadioStateChanged; });
        cleanup.Attempt(() => { if (listener is not null) listener.ConnectionReceived -= ConnectionReceived; });
        cleanup.Attempt(() => provider?.StopAdvertising());
        cleanup.Attempt(() => listener?.Dispose());
        cleanup.Attempt(stop.Cancel);
        await cleanup.AttemptAsync(() => Task.WhenAll(pending));
        cleanup.Attempt(stop.Dispose);
        listener = null; provider = null; radio = null; adapter = null;
        cleanup.ThrowIfFailed();
    }
}

internal sealed class DuplexStream(Stream input, Stream output) : Stream
{
    public override bool CanRead => input.CanRead;
    public override bool CanWrite => output.CanWrite;
    public override bool CanSeek => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() => output.Flush();
    public override Task FlushAsync(CancellationToken cancellationToken) => output.FlushAsync(cancellationToken);
    public override int Read(byte[] buffer, int offset, int count) => input.Read(buffer, offset, count);
    public override int Read(Span<byte> buffer) => input.Read(buffer);
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => input.ReadAsync(buffer, cancellationToken);
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => input.ReadAsync(buffer, offset, count, cancellationToken);
    public override void Write(byte[] buffer, int offset, int count) => output.Write(buffer, offset, count);
    public override void Write(ReadOnlySpan<byte> buffer) => output.Write(buffer);
    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => output.WriteAsync(buffer, cancellationToken);
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => output.WriteAsync(buffer, offset, count, cancellationToken);
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing) { input.Dispose(); output.Dispose(); }
        base.Dispose(disposing);
    }
}
