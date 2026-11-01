using System.IO.Compression;
using System.Threading.Channels;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

namespace VoiceBridge.Tests;

internal static class BluetoothRecoveryTests
{
    public static readonly (string Name, Func<Task> Run)[] Cases =
    [
        ("Bluetooth: RFCOMM repeated loss, stale events and serial asynchronous drain", RepeatedLossAsync),
        ("Bluetooth: RFCOMM initially off, capped backoff, recovery and shutdown in backoff", StartupRecoveryAsync),
        ("Bluetooth: RFCOMM shutdown during startup and late resource ownership", StartupShutdownAsync),
        ("Bluetooth: RFCOMM lost startup and failed cleanup never overlap listeners", FailedCleanupAsync),
        ("Bluetooth: release failures attempt every cleanup and stop unsafe retries", CleanupFailuresAsync),
        ("Bluetooth: BLE radio loss during startup, after readiness and after disposal", BleRadioStateAsync),
        ("Bluetooth: BLE advertising transitions and readiness deadlines", BluetoothAdvertisementStateTest.RunAsync),
        ("Bluetooth: BLE backoff and late startup cleanup", BluetoothBeaconSupervisorTest.RunAsync),
        ("Bluetooth: both transports recover while durable processing continues", ProcessingIsolationAsync),
        ("Bluetooth: interrupted TLS upload resumes across supervised listener generations", UploadRecoveryAsync)
    ];

    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static Task Bounded(Task task) => task.WaitAsync(TimeSpan.FromSeconds(10));

    private sealed class RetryStep(TimeSpan duration)
    {
        public TimeSpan Duration { get; } = duration;
        public TaskCompletionSource Continue { get; } = Signal();
    }

    private sealed class RetryClock
    {
        private readonly Channel<RetryStep> steps = Channel.CreateUnbounded<RetryStep>();
        public Task Delay(TimeSpan duration, CancellationToken token)
        {
            var step = new RetryStep(duration);
            steps.Writer.TryWrite(step);
            return step.Continue.Task.WaitAsync(token);
        }
        public async Task<RetryStep> NextAsync() => await steps.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
    }

    private sealed class Listener(Func<Task>? drain = null) : IRfcommBridgeListener
    {
        private readonly TaskCompletionSource lost = Signal();
        public TaskCompletionSource Disposing { get; } = Signal();
        public TaskCompletionSource Disposed { get; } = Signal();
        public int DisposeCalls { get; private set; }
        public RfcommEndpoint? Endpoint => lost.Task.IsCompleted || DisposeCalls != 0 ? null : new("01:02:03:04:05:06", Protocol.RfcommServiceUuid);
        public Task Unavailable => lost.Task;
        public void Lose() => lost.TrySetResult();
        public async ValueTask DisposeAsync()
        {
            DisposeCalls++;
            Disposing.TrySetResult();
            if (drain is not null) await drain();
            Disposed.TrySetResult();
        }
    }

    private static async Task RepeatedLossAsync()
    {
        using var stop = new CancellationTokenSource();
        var retry = new RetryClock();
        var supervisor = new RfcommBridgeSupervisor();
        var listeners = new List<Listener>();
        var ready = Channel.CreateUnbounded<Listener>();
        var drains = new List<TaskCompletionSource>();
        var active = 0;
        var maxActive = 0;
        var run = supervisor.RunAsync(_ =>
        {
            Check.Equal(0, active, "A new listener started before the old sessions drained.");
            maxActive = Math.Max(maxActive, ++active);
            var drain = Signal();
            drains.Add(drain);
            var listener = new Listener(async () => { await drain.Task; active--; });
            listeners.Add(listener);
            return Task.FromResult<IRfcommBridgeListener>(listener);
        }, message => { if (message.Contains("intake ready")) ready.Writer.TryWrite(listeners[^1]); }, stop.Token, retry.Delay);
        try
        {
            for (var cycle = 0; cycle < 100; cycle++)
            {
                var listener = await ready.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
                Check.True(supervisor.Endpoint is not null);
                if (cycle != 0) listeners[cycle - 1].Lose();
                Check.True(supervisor.Endpoint is not null, "An old event invalidated a newer generation.");
                listener.Lose();
                listener.Lose();
                Check.True(supervisor.Endpoint is null);
                await Bounded(listener.Disposing.Task);
                Check.Equal(cycle + 1, listeners.Count);
                Check.Equal(1, active);
                Check.True(!listener.Disposed.Task.IsCompleted);
                drains[cycle].TrySetResult();
                var step = await retry.NextAsync();
                Check.Equal(5d, step.Duration.TotalSeconds);
                Check.Equal(0, active);
                step.Continue.TrySetResult();
            }
            await ready.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            await Check.ThrowsAsync<InvalidOperationException>(() => supervisor.RunAsync(
                _ => throw new Exception("Must not start twice"), _ => { }, stop.Token));
            stop.Cancel();
            await Bounded(listeners[^1].Disposing.Task);
            Check.True(!run.IsCompleted, "Host shutdown must await the last generation's drain.");
            drains[^1].TrySetResult();
            await Bounded(run);
            Check.Equal(101, listeners.Count);
            Check.Equal(1, maxActive);
            Check.Equal(0, active);
            Check.True(supervisor.Endpoint is null && listeners.All(x => x.DisposeCalls == 1));
        }
        finally
        {
            stop.Cancel();
            foreach (var drain in drains) drain.TrySetResult();
            await Bounded(run);
        }
    }

    private static async Task StartupRecoveryAsync()
    {
        using var stop = new CancellationTokenSource();
        var retry = new RetryClock();
        var supervisor = new RfcommBridgeSupervisor();
        var listener = new Listener();
        var ready = Signal();
        var starts = 0;
        var run = supervisor.RunAsync(_ =>
        {
            if (++starts <= 5) throw new IOException("Synthetic radio off or registration failure");
            return Task.FromResult<IRfcommBridgeListener>(listener);
        }, message => { if (message.Contains("intake ready")) ready.TrySetResult(); }, stop.Token, retry.Delay);
        try
        {
            foreach (var seconds in new[] { 5d, 10, 20, 30, 30 })
            {
                var step = await retry.NextAsync();
                Check.Equal(seconds, step.Duration.TotalSeconds);
                Check.True(supervisor.Endpoint is null);
                step.Continue.TrySetResult();
            }
            await Bounded(ready.Task);
            Check.Equal(6, starts);
            Check.True(supervisor.Endpoint is not null);
            listener.Lose();
            var recoveredDelay = await retry.NextAsync();
            Check.Equal(5d, recoveredDelay.Duration.TotalSeconds);
            stop.Cancel();
            await Bounded(run);
            recoveredDelay.Continue.TrySetResult();
            Check.Equal(6, starts);
            Check.Equal(1, listener.DisposeCalls);
        }
        finally { stop.Cancel(); await Bounded(run); }
    }

    private static async Task StartupShutdownAsync()
    {
        foreach (var lateSuccess in new[] { true, false })
        {
            using var stop = new CancellationTokenSource();
            var pending = new TaskCompletionSource<IRfcommBridgeListener>(TaskCreationOptions.RunContinuationsAsynchronously);
            var listener = new Listener();
            var supervisor = new RfcommBridgeSupervisor();
            CancellationToken startupToken = default;
            var delays = 0;
            var run = supervisor.RunAsync(token => { startupToken = token; return pending.Task; }, _ => { }, stop.Token,
                (_, _) => { delays++; return Task.CompletedTask; });
            stop.Cancel();
            Check.True(startupToken.IsCancellationRequested);
            Check.True(!run.IsCompleted, "An in-flight start must not be abandoned.");
            if (lateSuccess) pending.SetResult(listener);
            else pending.SetException(new OperationCanceledException(startupToken));
            await Bounded(run);
            Check.Equal(lateSuccess ? 1 : 0, listener.DisposeCalls);
            Check.Equal(0, delays);
            Check.True(supervisor.Endpoint is null);
        }
        using var alreadyStopped = new CancellationTokenSource();
        alreadyStopped.Cancel();
        await new RfcommBridgeSupervisor().RunAsync(_ => throw new Exception("Must not start after exit"), _ => { }, alreadyStopped.Token);
    }

    private static async Task FailedCleanupAsync()
    {
        var starts = 0;
        var listener = new Listener(() => throw new IOException("Synthetic cleanup failure"));
        listener.Lose();
        var supervisor = new RfcommBridgeSupervisor();
        await Check.ThrowsAsync<IOException>(() => supervisor.RunAsync(_ =>
        {
            starts++;
            return Task.FromResult<IRfcommBridgeListener>(listener);
        }, _ => { }, CancellationToken.None, (_, _) => throw new Exception("Must not retry unproven cleanup")));
        Check.Equal(1, starts);
        Check.Equal(1, listener.DisposeCalls);
        Check.True(supervisor.Endpoint is null);

        using var stop = new CancellationTokenSource();
        var retry = new RetryClock();
        var failedStartup = new Listener();
        failedStartup.Lose();
        var run = supervisor.RunAsync(_ => Task.FromResult<IRfcommBridgeListener>(failedStartup), _ => { }, stop.Token, retry.Delay);
        await retry.NextAsync();
        stop.Cancel();
        await Bounded(run);
        Check.Equal(1, failedStartup.DisposeCalls);
        Check.True(supervisor.Endpoint is null);
    }

    private static async Task BleRadioStateAsync()
    {
        var losses = 0;
        using (var state = new BluetoothAdvertisementState(() => losses++))
        {
            state.LoseRadio();
            state.LoseRadio();
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            await Check.ThrowsAsync<IOException>(() => state.Started);
            Check.True(!state.IsRunning);
            Check.Equal(0, losses);
        }
        using (var state = new BluetoothAdvertisementState(() => losses++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            await state.Started;
            state.LoseRadio();
            state.Observe(GattServiceProviderAdvertisementStatus.Stopped, BluetoothError.Success);
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            state.LoseRadio();
            Check.Equal(1, losses);
            Check.True(!state.IsRunning);
        }
        using (var state = new BluetoothAdvertisementState(() => losses++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            state.Dispose();
            state.LoseRadio();
            Check.Equal(1, losses);
        }
    }

    private static async Task CleanupFailuresAsync()
    {
        var cleanup = new BluetoothCleanup("Synthetic transport");
        var released = new List<int>();
        cleanup.Attempt(() => { released.Add(1); throw new IOException("Synthetic event revoke failure"); });
        cleanup.Attempt(() => released.Add(2));
        await cleanup.AttemptAsync(async () => { await Task.Yield(); released.Add(3); throw new IOException("Synthetic drain failure"); });
        cleanup.Attempt(() => released.Add(4));
        Check.True(released.SequenceEqual(new[] { 1, 2, 3, 4 }));
        BluetoothCleanupException failure;
        try { cleanup.ThrowIfFailed(); throw new Exception("Cleanup errors were lost."); }
        catch (BluetoothCleanupException ex) { Check.Equal(2, ex.InnerExceptions.Count); failure = ex; }

        var rfcommStarts = 0;
        var bleStarts = 0;
        await Check.ThrowsAsync<BluetoothCleanupException>(() => new RfcommBridgeSupervisor().RunAsync(
            _ => { rfcommStarts++; throw failure; }, _ => { }, CancellationToken.None,
            (_, _) => throw new Exception("Must not retry a failed startup cleanup")));
        await Check.ThrowsAsync<BluetoothCleanupException>(() => BluetoothBeaconSupervisor.RunAsync(
            _ => { bleStarts++; throw failure; }, _ => { }, CancellationToken.None,
            (_, _) => throw new Exception("Must not retry a failed startup cleanup")));
        Check.Equal(1, rfcommStarts);
        Check.Equal(1, bleStarts);
        await Check.ThrowsAsync<BluetoothCleanupException>(() => BluetoothBeaconSupervisor.RunAsync(
            lost => { lost(); return Task.FromResult<IDisposable>(new FailedBeacon(failure)); }, _ => { }, CancellationToken.None,
            (_, _) => throw new Exception("Must not retry a failed active beacon cleanup")));
    }

    private sealed class FailedBeacon(Exception error) : IDisposable
    {
        public void Dispose() => throw error;
    }

    private sealed class Beacon(Action lost) : IDisposable
    {
        public int DisposeCalls { get; private set; }
        public void Lose() => lost();
        public void Dispose() => DisposeCalls++;
    }

    private sealed class BlockedAsrRunner : ILocalAsrRunner
    {
        public TaskCompletionSource Started { get; } = Signal();
        public TaskCompletionSource Complete { get; } = Signal();
        public CancellationToken Token { get; private set; }
        public async Task<LocalAsrProcessResult> RunAsync(System.Diagnostics.ProcessStartInfo startInfo, CancellationToken cancellationToken)
        {
            Token = cancellationToken;
            Started.TrySetResult();
            await Complete.Task.WaitAsync(cancellationToken);
            return new(0, LocalTranscriptionTests.ResultJson(), "");
        }
    }

    private static async Task ProcessingIsolationAsync()
    {
        using var root = new TestRoot();
        using var inbox = new InboxStore(root.Runtime, retainAudio: true);
        var manifest = Fixtures.Parse(Fixtures.Manifest());
        var receipt = await inbox.StoreAsync(manifest, Fixtures.Wave(), CancellationToken.None);
        var directory = inbox.Entries().Single();
        var initialManifest = File.ReadAllBytes(Path.Combine(directory, "manifest.json"));
        using var stop = new CancellationTokenSource();
        var runner = new BlockedAsrRunner();
        var options = root.Options with { NoTranscribe = false, TranscribeOnly = true, Database = null };
        var queue = new ImportQueue(inbox, new LocalRecordingTranscriber(options, runner), _ => { });
        var processing = queue.ProcessPendingOnceAsync(stop.Token);
        await Bounded(runner.Started.Task);
        var rfcommRetry = new RetryClock();
        var bleRetry = new RetryClock();
        var rfcommReady = Channel.CreateUnbounded<Listener>();
        var bleReady = Channel.CreateUnbounded<Beacon>();
        Listener? currentListener = null;
        Beacon? currentBeacon = null;
        var rfcommCount = 0;
        var bleCount = 0;
        var supervisor = new RfcommBridgeSupervisor();
        var rfcomm = supervisor.RunAsync(_ =>
        {
            rfcommCount++;
            currentListener = new Listener();
            return Task.FromResult<IRfcommBridgeListener>(currentListener);
        }, message => { if (message.Contains("intake ready")) rfcommReady.Writer.TryWrite(currentListener!); }, stop.Token, rfcommRetry.Delay);
        var ble = BluetoothBeaconSupervisor.RunAsync(lost =>
        {
            bleCount++;
            currentBeacon = new Beacon(lost);
            return Task.FromResult<IDisposable>(currentBeacon);
        }, message => { if (message.Contains("discovery ready")) bleReady.Writer.TryWrite(currentBeacon!); }, stop.Token, bleRetry.Delay);
        try
        {
            var firstRfcomm = await rfcommReady.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            var firstBle = await bleReady.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            firstRfcomm.Lose();
            firstBle.Lose();
            var rfcommOff = await rfcommRetry.NextAsync();
            var bleOff = await bleRetry.NextAsync();
            Check.True(!stop.IsCancellationRequested && !runner.Token.IsCancellationRequested && !processing.IsCompleted);
            Check.Equal("processing", inbox.ReadQueue(directory).Status);
            runner.Complete.TrySetResult();
            await Bounded(processing);
            Check.Equal("transcribed", inbox.ReadQueue(directory).Status);
            Check.Equal(receipt, await inbox.FindReceiptAsync(manifest, CancellationToken.None));
            Check.True(initialManifest.SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "manifest.json"))));
            Check.True(Fixtures.Wave().SequenceEqual(File.ReadAllBytes(Path.Combine(directory, "audio.wav"))));
            Check.True(File.Exists(Path.Combine(directory, "transcript.json")));
            Check.True(inbox.ReadQueue(directory).ImportedRecordingId is null);
            rfcommOff.Continue.TrySetResult();
            bleOff.Continue.TrySetResult();
            var secondRfcomm = await rfcommReady.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            var secondBle = await bleReady.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            Check.Equal(2, rfcommCount);
            Check.Equal(2, bleCount);
            Check.Equal(1, firstRfcomm.DisposeCalls);
            Check.Equal(1, firstBle.DisposeCalls);

            await inbox.StoreAsync(Fixtures.Parse(Fixtures.Manifest()), Fixtures.Wave(), CancellationToken.None);
            var pendingDirectory = inbox.Entries().Single(x => x != directory);
            var pending = new BlockedAsrRunner();
            var exiting = new ImportQueue(inbox, new LocalRecordingTranscriber(options, pending), _ => { }).ProcessPendingOnceAsync(stop.Token);
            await Bounded(pending.Started.Task);
            stop.Cancel();
            await Check.ThrowsAsync<OperationCanceledException>(() => Bounded(exiting));
            await Bounded(Task.WhenAll(rfcomm, ble));
            Check.Equal("failed", inbox.ReadQueue(pendingDirectory).Status);
            Check.True(inbox.ReadQueue(pendingDirectory).LastError!.Contains("Bridge stopped"));
            Check.True(!File.Exists(Path.Combine(pendingDirectory, "transcript.json")));
            Check.Equal(1, secondRfcomm.DisposeCalls);
            Check.Equal(1, secondBle.DisposeCalls);
            Check.True(!File.Exists(root.Options.Database));
        }
        finally
        {
            runner.Complete.TrySetResult();
            stop.Cancel();
            await Bounded(Task.WhenAll(rfcomm, ble));
            try { await Bounded(processing); } catch (OperationCanceledException) { }
        }
    }

    private static async Task UploadRecoveryAsync()
    {
        using var root = new TestRoot();
        using var pairing = Pairing.Setup(root.Runtime, null);
        using var inbox = new InboxStore(root.Runtime, retainAudio: true);
        using var partials = new ResumableUploadStore(root.Runtime, inbox);
        var wave = Fixtures.Wave(75000);
        new Random(51).NextBytes(wave.AsSpan(44));
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, true)) gzip.Write(wave);
        var compressed = output.ToArray();
        var manifest = Fixtures.Manifest(wave);
        using var stop = new CancellationTokenSource();
        var retry = new RetryClock();
        var supervisor = new RfcommBridgeSupervisor();
        var ready = Channel.CreateUnbounded<(Listener Lifetime, RfcommTestHost Host)>();
        (Listener Lifetime, RfcommTestHost Host) current = default;
        var run = supervisor.RunAsync(_ =>
        {
            var host = new RfcommTestHost(pairing, partials);
            var lifetime = new Listener(() => host.DisposeAsync().AsTask());
            current = (lifetime, host);
            return Task.FromResult<IRfcommBridgeListener>(lifetime);
        }, message => { if (message.Contains("intake ready")) ready.Writer.TryWrite(current); }, stop.Token, retry.Delay);
        try
        {
            var first = await ready.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            using var interrupted = await first.Host.AuthorizedAsync();
            Check.Equal(0L, (await interrupted.BeginAsync(manifest, compressed))["offset"]!.GetValue<long>());
            const int committed = 1024;
            Check.Equal((long)committed, (await interrupted.ChunkAsync(0, compressed.AsMemory(0, committed)))["offset"]!.GetValue<long>());
            await interrupted.SendAsync(new { op = "chunk", offset = committed, length = 1024 });
            await interrupted.Stream.WriteAsync(compressed.AsMemory(committed, 200));
            await interrupted.Stream.FlushAsync();
            first.Lifetime.Lose();
            var off = await retry.NextAsync();
            Check.Equal(0, inbox.Entries().Count());
            Check.Equal(1, first.Lifetime.DisposeCalls);
            Check.True(supervisor.Endpoint is null);
            Check.Equal(1, Directory.EnumerateDirectories(partials.Root).Count());
            off.Continue.TrySetResult();

            var second = await ready.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            using var resumed = await second.Host.AuthorizedAsync();
            Check.Equal((long)committed, (await resumed.BeginAsync(manifest, compressed))["offset"]!.GetValue<long>());
            await resumed.UploadChunksAsync(compressed, committed);
            var receipt = (await resumed.RequestAsync(new { op = "finish" }))["receipt"]!.ToJsonString();
            Check.Equal(1, inbox.Entries().Count());
            Check.True(wave.SequenceEqual(File.ReadAllBytes(Path.Combine(inbox.Entries().Single(), "audio.wav"))));
            second.Lifetime.Lose();
            var next = await retry.NextAsync();
            next.Continue.TrySetResult();
            var third = await ready.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10));
            using var repeated = await third.Host.AuthorizedAsync();
            Check.Equal(receipt, (await repeated.BeginAsync(manifest, compressed))["receipt"]!.ToJsonString());
            Check.Equal(1, inbox.Entries().Count());
            Check.Equal(0, Directory.EnumerateDirectories(partials.Root).Count());
            stop.Cancel();
            await Bounded(run);
            Check.Equal(1, third.Lifetime.DisposeCalls);
        }
        finally { stop.Cancel(); await Bounded(run); }
    }
}
