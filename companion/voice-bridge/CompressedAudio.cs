using System.Buffers.Binary;
using System.IO.Compression;

namespace VoiceBridge;

internal static class CompressedAudio
{
    public static async Task<byte[]> ReadBoundedAsync(Stream input, int limit, CancellationToken ct)
    {
        using var output = new MemoryStream();
        var buffer = new byte[65536];
        int read;
        while ((read = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, limit - output.Length + 1)), ct)) != 0)
        {
            if (output.Length + read > limit) throw new ClientFault(413, "Payload exceeds its size limit.");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    public static async Task<byte[]> DecodeAsync(byte[] compressed, CancellationToken ct)
    {
        if (compressed.Length > Protocol.MaxCompressedBytes) throw new ClientFault(413, "Compressed payload too large.");
        if (compressed.Length < 18 || compressed[0] != 0x1f || compressed[1] != 0x8b || compressed[2] != 8 || (compressed[3] & 0xe0) != 0)
            throw new ClientFault(400, "Invalid gzip payload.");
        try
        {
            using var input = new MemoryStream(compressed, writable: false);
            using var gzip = new GZipStream(input, CompressionMode.Decompress);
            var audio = await ReadBoundedAsync(gzip, Protocol.MaxAudioBytes, ct);
            // GZipStream can accept a truncated trailer. Require a complete single-file
            // gzip member with its original size and CRC, as emitted by GZIPOutputStream.
            var size = BinaryPrimitives.ReadUInt32LittleEndian(compressed.AsSpan(compressed.Length - 4));
            var crc = BinaryPrimitives.ReadUInt32LittleEndian(compressed.AsSpan(compressed.Length - 8));
            if (size != audio.Length || crc != Crc32(audio)) throw new ClientFault(400, "Invalid gzip trailer.");
            return audio;
        }
        catch (InvalidDataException) { throw new ClientFault(400, "Invalid gzip payload."); }
    }

    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(i =>
    {
        var crc = (uint)i;
        for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320u : 0);
        return crc;
    }).ToArray();

    private static uint Crc32(ReadOnlySpan<byte> bytes)
    {
        var crc = uint.MaxValue;
        foreach (var value in bytes) crc = CrcTable[(crc ^ value) & 0xff] ^ (crc >> 8);
        return ~crc;
    }
}
