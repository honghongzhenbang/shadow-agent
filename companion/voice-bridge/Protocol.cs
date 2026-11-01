using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace VoiceBridge;

internal static class Protocol
{
    public const string ServiceUuid = "7f8d8f60-7147-4a92-a23b-0cb593d41210";
    public const string IdentityCharacteristicUuid = "7f8d8f61-7147-4a92-a23b-0cb593d41210";
    public const string RfcommServiceUuid = "7f8d8f62-7147-4a92-a23b-0cb593d41210";
    public const int MaxAudioBytes = 16 * 1024 * 1024;
    public const int MaxManifestBytes = 32 * 1024;
    public const int MaxCompressedBytes = MaxAudioBytes + 64 * 1024;
    public const int MaxRequestBytes = MaxCompressedBytes + 64 * 1024;
    public const int MaxFrameBytes = 64 * 1024;
    public const int MaxChunkBytes = 32768;
    public const long MinFreeStorageBytes = 64L * 1024 * 1024;
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = false,
        MaxDepth = 16
    };

    public static string Uuid(string? value, string name)
    {
        if (value is null || value.Length != 36 || !Guid.TryParseExact(value, "D", out var id) || id == Guid.Empty)
            throw new ClientFault(400, $"{name} must be a nonzero hyphenated UUID.");
        return id.ToString("D");
    }

    public static Uri ServerUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Port != 8787 ||
            uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0 ||
            !IPAddress.TryParse(uri.Host, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork ||
            !IsLocal(ip))
            throw new ArgumentException("serverUrl must be https://<local IPv4>:8787, without a path, query or credentials.");
        return uri;
    }

    private static bool IsLocal(IPAddress address)
    {
        var b = address.GetAddressBytes();
        return IPAddress.IsLoopback(address) || b[0] == 10 ||
            (b[0] == 172 && b[1] is >= 16 and <= 31) ||
            (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254);
    }

    public static string Utc(DateTimeOffset time) => time.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
}

internal sealed class ClientFault(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}
