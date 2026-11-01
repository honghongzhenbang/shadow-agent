namespace VoiceBridge;

/// <summary>BLE discovery can recover independently of intake and durable processing.</summary>
internal static class BluetoothBeaconSupervisor
{
    public static async Task RunAsync(Func<Action, Task<IDisposable>> start,
        Action<string> log, CancellationToken stop,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        delay ??= Task.Delay;
        var retrySeconds = 5;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var unavailable = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                try
                {
                    // Do not abandon a pending WinRT start: its bounded startup must finish
                    // so the resulting provider is disposed even during host shutdown.
                    using var beacon = await start(() => unavailable.TrySetResult());
                    stop.ThrowIfCancellationRequested();
                    log("BLE discovery ready; intake remains independent.");
                    retrySeconds = 5;
                    await unavailable.Task.WaitAsync(stop);
                    log("BLE discovery lost; keeping intake and transcription running.");
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
                catch (BluetoothCleanupException)
                {
                    log("BLE cleanup failed; automatic restart stopped to avoid overlapping advertisements.");
                    throw;
                }
                catch (Exception ex)
                {
                    log($"BLE discovery unavailable ({ex.GetType().Name}); intake remains running.");
                }
                await delay(TimeSpan.FromSeconds(retrySeconds), stop);
                retrySeconds = Math.Min(30, retrySeconds * 2);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }
}
