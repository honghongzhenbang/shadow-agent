namespace VoiceBridge;

internal sealed class BluetoothCleanupException(string transport, IEnumerable<Exception> errors)
    : AggregateException($"{transport} resource cleanup failed; automatic restart is unsafe.", errors);

/// <summary>Attempt every release even if an earlier WinRT release throws.</summary>
internal sealed class BluetoothCleanup(string transport)
{
    private readonly List<Exception> errors = new();

    public void Attempt(Action release)
    {
        try { release(); }
        catch (Exception ex) { errors.Add(ex); }
    }

    public async Task AttemptAsync(Func<Task> release)
    {
        try { await release(); }
        catch (Exception ex) { errors.Add(ex); }
    }

    public void ThrowIfFailed()
    {
        if (errors.Count != 0) throw new BluetoothCleanupException(transport, errors);
    }
}
