namespace VoiceBridge;

internal interface IRfcommBridgeListener : IAsyncDisposable
{
    RfcommEndpoint? Endpoint { get; }
    Task Unavailable { get; }
}

/// <summary>Owns one registration at a time, never the inbox or processing lifetime.</summary>
internal sealed class RfcommBridgeSupervisor
{
    private IRfcommBridgeListener? current;
    private int running;

    public RfcommEndpoint? Endpoint => Volatile.Read(ref current)?.Endpoint;

    public async Task RunAsync(Func<CancellationToken, Task<IRfcommBridgeListener>> start,
        Action<string> log, CancellationToken stop,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        if (Interlocked.Exchange(ref running, 1) != 0)
            throw new InvalidOperationException("RFCOMM supervisor is already running.");
        delay ??= Task.Delay;
        var retrySeconds = 5;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                IRfcommBridgeListener? listener = null;
                try
                {
                    // Await ownership even if startup completes after shutdown was requested.
                    listener = await start(stop);
                    stop.ThrowIfCancellationRequested();
                    if (listener.Unavailable.IsCompleted || listener.Endpoint is null)
                        throw new IOException("RFCOMM lost during startup.");
                    Volatile.Write(ref current, listener);
                    retrySeconds = 5;
                    log("RFCOMM TLS intake ready; authenticated OS pairing required.");
                    await listener.Unavailable.WaitAsync(stop);
                    log("RFCOMM unavailable; local processing and durable uploads remain intact.");
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
                catch (BluetoothCleanupException)
                {
                    log("RFCOMM cleanup failed; automatic restart stopped to avoid overlapping listeners.");
                    throw;
                }
                catch (Exception ex)
                {
                    log($"RFCOMM unavailable ({ex.GetType().Name}); retrying independently of local processing.");
                }
                finally
                {
                    Volatile.Write(ref current, null);
                    // Drain sessions/leases before rebinding. A failed cleanup must not start
                    // another listener whose predecessor may still own the service/socket.
                    if (listener is not null)
                    {
                        try { await listener.DisposeAsync(); }
                        catch (Exception ex)
                        {
                            log($"RFCOMM cleanup failed ({ex.GetType().Name}); automatic restart stopped.");
                            throw;
                        }
                    }
                }
                await delay(TimeSpan.FromSeconds(retrySeconds), stop);
                retrySeconds = Math.Min(30, retrySeconds * 2);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        finally { Volatile.Write(ref current, null); Volatile.Write(ref running, 0); }
    }
}
