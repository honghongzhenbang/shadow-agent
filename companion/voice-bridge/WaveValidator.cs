using System.Buffers.Binary;
using System.Security.Cryptography;

namespace VoiceBridge;

internal static class WaveValidator
{
    public static void Validate(ReadOnlySpan<byte> audio, RecordingManifest manifest)
    {
        if (audio.Length > Protocol.MaxAudioBytes) throw new ClientFault(413, "Audio exceeds 16 MiB.");
        if (audio.Length < 44 || !audio[..4].SequenceEqual("RIFF"u8) || !audio.Slice(8, 4).SequenceEqual("WAVE"u8) ||
            U32(audio, 4) != audio.Length - 8) throw new ClientFault(400, "Invalid or incomplete RIFF/WAVE file.");
        var haveFormat = false;
        var haveData = false;
        long samples = 0;
        for (var offset = 12; offset < audio.Length;)
        {
            if (audio.Length - offset < 8) throw new ClientFault(400, "Truncated WAV chunk header.");
            var size = U32(audio, offset + 4);
            var end = (long)offset + 8 + size;
            var next = end + (size & 1);
            if (next > audio.Length) throw new ClientFault(400, "Truncated WAV chunk.");
            var id = audio.Slice(offset, 4);
            if (id.SequenceEqual("fmt "u8))
            {
                if (haveFormat || (size != 16 && size != 18)) throw new ClientFault(400, "WAV requires one PCM format chunk.");
                var format = audio.Slice(offset + 8, (int)size);
                if (U16(format, 0) != 1 || U16(format, 2) != 1 || U32(format, 4) != 16000 || U32(format, 8) != 32000 ||
                    U16(format, 12) != 2 || U16(format, 14) != 16 || (size == 18 && U16(format, 16) != 0))
                    throw new ClientFault(400, "WAV must contain PCM16 mono 16000 Hz with consistent frame and byte rates.");
                haveFormat = true;
            }
            else if (id.SequenceEqual("data"u8))
            {
                if (!haveFormat || haveData || size == 0 || size % 2 != 0) throw new ClientFault(400, "WAV requires one nonempty complete-frame data chunk after fmt.");
                haveData = true;
                samples = size / 2;
            }
            offset = (int)next;
        }
        // Android reports integer milliseconds; accept only its sub-millisecond rounding.
        if (!haveFormat || !haveData || samples != manifest.SampleCount || Math.Abs(samples * 1000.0 / 16000 - manifest.DurationMs) > 1.0)
            throw new ClientFault(400, "Declared frame count or duration differs from actual WAV data.");
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(audio), Convert.FromHexString(manifest.Sha256)))
            throw new ClientFault(400, "WAV SHA-256 differs from manifest.");
    }

    private static ushort U16(ReadOnlySpan<byte> data, int offset) => BinaryPrimitives.ReadUInt16LittleEndian(data.Slice(offset, 2));
    private static uint U32(ReadOnlySpan<byte> data, int offset) => BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(offset, 4));
}
