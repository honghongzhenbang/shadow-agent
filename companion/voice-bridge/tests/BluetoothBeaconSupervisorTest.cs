namespace VoiceBridge.Tests;

internal static class BluetoothBeaconSupervisorTest
{
    private sealed class Beacon(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }

    public static async Task RunAsync()
    {
        using (var stop = new CancellationTokenSource())
        {
            var starts = 0;
            var disposals = 0;
            var delays = new List<double>();
            var resumed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var task = BluetoothBeaconSupervisor.RunAsync(lost =>
            {
                starts++;
                Check.Equal(starts - 1, disposals);
                if (starts == 1) { lost(); lost(); }
                else resumed.TrySetResult();
                return Task.FromResult<IDisposable>(new Beacon(() => disposals++));
            }, _ => { }, stop.Token, (wait, token) =>
            {
                token.ThrowIfCancellationRequested();
                delays.Add(wait.TotalSeconds);
                return Task.CompletedTask;
            });
            await resumed.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Check.True(!task.IsCompleted);
            Check.Equal(2, starts);
            Check.Equal(1, disposals);
            Check.Equal(5d, delays.Single());
            stop.Cancel();
            await task.WaitAsync(TimeSpan.FromSeconds(3));
            Check.Equal(2, disposals);
            Check.Equal(2, starts);
        }
        using (var stop = new CancellationTokenSource())
        {
            var delays = new List<double>();
            var starts = 0;
            await BluetoothBeaconSupervisor.RunAsync(_ =>
            {
                starts++;
                throw new InvalidOperationException("Synthetic unavailable adapter");
            }, _ => { }, stop.Token, (wait, token) =>
            {
                delays.Add(wait.TotalSeconds);
                if (delays.Count == 5) stop.Cancel();
                token.ThrowIfCancellationRequested();
                return Task.CompletedTask;
            });
            Check.Equal(5, starts);
            Check.True(delays.SequenceEqual(new double[] { 5, 10, 20, 30, 30 }));
        }
        using (var stop = new CancellationTokenSource())
        {
            var started = new TaskCompletionSource<IDisposable>(TaskCreationOptions.RunContinuationsAsynchronously);
            var disposed = false;
            var task = BluetoothBeaconSupervisor.RunAsync(_ => started.Task, _ => { }, stop.Token);
            stop.Cancel();
            started.SetResult(new Beacon(() => disposed = true));
            await task.WaitAsync(TimeSpan.FromSeconds(3));
            Check.True(disposed);
        }
    }
}
