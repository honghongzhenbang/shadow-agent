using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

namespace VoiceBridge.Tests;

internal static class BluetoothAdvertisementStateTest
{
    public static async Task RunAsync()
    {
        var notifications = 0;
        using (var state = new BluetoothAdvertisementState(() => notifications++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.Created, BluetoothError.Success);
            state.Observe(GattServiceProviderAdvertisementStatus.Aborted, BluetoothError.Success);
            Check.True(!state.Started.IsCompleted && !state.IsRunning);
            Check.Equal(0, notifications);
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            await state.Started;
            Check.True(state.IsRunning);
            state.Observe(GattServiceProviderAdvertisementStatus.Aborted, BluetoothError.Success);
            state.Observe(GattServiceProviderAdvertisementStatus.Stopped, BluetoothError.Success);
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            Check.Equal(1, notifications);
            Check.True(!state.IsRunning);
        }
        using (var state = new BluetoothAdvertisementState(() => notifications++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.StartedWithoutAllAdvertisementData, BluetoothError.Success);
            Check.True(!state.Started.IsCompleted);
            state.Observe(GattServiceProviderAdvertisementStatus.Stopped, BluetoothError.Success);
            Check.True(!state.Started.IsCompleted);
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            await state.Started;
            state.Observe(GattServiceProviderAdvertisementStatus.StartedWithoutAllAdvertisementData, BluetoothError.Success);
            Check.Equal(2, notifications);
            Check.True(!state.IsRunning);
        }
        using (var state = new BluetoothAdvertisementState(() => notifications++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.Aborted, BluetoothError.RadioNotAvailable);
            await Check.ThrowsAsync<InvalidOperationException>(() => state.Started);
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            Check.True(!state.IsRunning);
            Check.Equal(2, notifications);
        }
        using (var state = new BluetoothAdvertisementState(() => notifications++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.Aborted, BluetoothError.Success);
            await Check.ThrowsAsync<TimeoutException>(() => state.Started.WaitAsync(TimeSpan.FromMilliseconds(20)));
            Check.True(!state.IsRunning);
            Check.Equal(2, notifications);
        }
        using (var state = new BluetoothAdvertisementState(() => notifications++))
        {
            state.Observe(GattServiceProviderAdvertisementStatus.Started, BluetoothError.Success);
            await state.Started;
            state.Dispose();
            state.Observe(GattServiceProviderAdvertisementStatus.Stopped, BluetoothError.Success);
            Check.True(!state.IsRunning);
            Check.Equal(2, notifications);
        }
    }
}
