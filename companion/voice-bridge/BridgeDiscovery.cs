using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;

namespace VoiceBridge;

internal static class BridgeDiscovery
{
    public static string[] CurrentEndpoints() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(nic => nic.OperationalStatus == OperationalStatus.Up &&
            nic.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211)
        .Select(nic => new { nic.NetworkInterfaceType, Properties = nic.GetIPProperties() })
        .OrderByDescending(nic => nic.Properties.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork &&
            !g.Address.Equals(IPAddress.Any)))
        .ThenBy(nic => nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? 0 : 1)
        .SelectMany(nic => nic.Properties.UnicastAddresses.Select(a => a.Address))
        .Where(IsPrivateAddress).Select(ip => $"https://{ip}:8787").Distinct().Take(4).ToArray();

    internal static bool IsPrivateAddress(IPAddress ip)
    {
        if (ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168);
    }

    public static byte[] Encode(string bridgeId, IEnumerable<string> endpoints, RfcommEndpoint? rfcomm = null)
    {
        var urls = endpoints.Select(Protocol.ServerUri).Select(uri =>
        {
            if (!IsPrivateAddress(IPAddress.Parse(uri.Host))) throw new ArgumentException("BLE endpoints must be private LAN addresses.");
            return uri.GetLeftPart(UriPartial.Authority);
        }).Distinct().Take(4).ToArray();
        // BLE contains discovery hints only, never credentials, certificate pins or audio.
        var identity = new Dictionary<string, object> { ["schemaVersion"] = 2, ["bridgeId"] = Protocol.Uuid(bridgeId, "bridgeId"), ["endpoints"] = urls };
        if (rfcomm is not null)
        {
            var parts = rfcomm.BluetoothAddress.Split(':');
            if (parts.Length != 6 || parts.Any(part => part.Length != 2 || part.Any(c => c is not (>= '0' and <= '9' or >= 'A' and <= 'F'))) ||
                rfcomm.BluetoothAddress == "00:00:00:00:00:00" || rfcomm.RfcommServiceUuid != Protocol.RfcommServiceUuid)
                throw new ArgumentException("Invalid RFCOMM discovery endpoint.");
            identity["bluetoothAddress"] = rfcomm.BluetoothAddress;
            identity["rfcommServiceUuid"] = rfcomm.RfcommServiceUuid;
        }
        var data = JsonSerializer.SerializeToUtf8Bytes(identity);
        if (data.Length > 512) throw new InvalidOperationException("Discovery value exceeded GATT attribute bounds.");
        return data;
    }
}

internal sealed class DiscoveryReadBuffer(Func<byte[]> create, Func<DateTimeOffset>? clock = null)
{
    private readonly object gate = new();
    private readonly Dictionary<string, (DateTimeOffset Created, byte[] Data)> snapshots = new();

    public byte[] Read(string client, uint offset, uint length)
    {
        lock (gate)
        {
            var now = clock?.Invoke() ?? DateTimeOffset.UtcNow;
            foreach (var key in snapshots.Where(item => now - item.Value.Created > TimeSpan.FromSeconds(10)).Select(item => item.Key).ToArray())
                snapshots.Remove(key);
            if (offset == 0)
            {
                if (snapshots.Count >= 16) snapshots.Remove(snapshots.MinBy(item => item.Value.Created).Key);
                snapshots[client] = (now, create());
            }
            if (!snapshots.TryGetValue(client, out var snapshot) || offset > snapshot.Data.Length)
                throw new ArgumentOutOfRangeException(nameof(offset));
            // A long GATT read must use the same snapshot even if Wi-Fi changes between fragments.
            return snapshot.Data.AsSpan((int)offset, (int)Math.Min(length, snapshot.Data.Length - offset)).ToArray();
        }
    }
}
