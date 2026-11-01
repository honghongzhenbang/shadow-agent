using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace VoiceBridge;

internal static class Paths
{
    public static bool IsWithin(string root, string path)
    {
        var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path));
        return relative != "." && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    public static void RejectLinks(string path)
    {
        var full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\", StringComparison.Ordinal)) throw new IOException("Runtime must use a local disk, not a network/device path.");
        for (var current = full; current is not null; current = Path.GetDirectoryName(current))
        {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(current); }
            catch (FileNotFoundException) { continue; }
            catch (DirectoryNotFoundException) { continue; }
            // Exists() follows links and misses dangling reparse points.
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Reparse points are not allowed in private runtime paths.");
        }
    }

    public static void PrivateDirectory(string path)
    {
        RejectLinks(path);
        Directory.CreateDirectory(path);
        var owner = WindowsIdentity.GetCurrent().User ?? throw new IOException("No Windows user SID available.");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        // Protect access without requesting WRITE_OWNER or taking ownership of existing folders.
        foreach (var sid in new[] { owner, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(security);
    }
}

internal sealed class RuntimeLease : IDisposable
{
    private readonly FileStream handle;

    public RuntimeLease(string root)
    {
        // Shared voice runtime also contains models and delivery files. Only the
        // pairing and inbox subdirectories need private ACLs; the lock contains no data.
        Paths.RejectLinks(root);
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, ".bridge.lock");
        Paths.RejectLinks(path);
        handle = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }

    public void Dispose() => handle.Dispose();
}

internal static class DurableFiles
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);

    public static void WriteNew(string path, ReadOnlySpan<byte> bytes)
    {
        Paths.RejectLinks(path);
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.WriteThrough);
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
    }

    public static void WriteJsonNew<T>(string path, T value) => WriteNew(path, JsonSerializer.SerializeToUtf8Bytes(value, Protocol.Json));

    public static void Move(string source, string destination, bool replace = false)
    {
        Paths.RejectLinks(source);
        Paths.RejectLinks(destination);
        for (var attempt = 0; ; attempt++)
        {
            if (MoveFileExW(source, destination, 0x8u | (replace ? 0x1u : 0u))) return;
            var error = Marshal.GetLastWin32Error();
            if (attempt == 4 || error is not (5 or 32 or 33))
                throw new IOException("Durable rename failed.", new Win32Exception(error));
            // Windows readers/scanners can briefly block atomic replacement. Never fall back to an in-place write.
            Thread.Sleep(10 << attempt);
        }
    }

    public static void ReplaceJson<T>(string path, T value)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            WriteJsonNew(temporary, value);
            Move(temporary, path, replace: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static T ReadJson<T>(string path)
    {
        Paths.RejectLinks(path);
        if (new FileInfo(path).Length > Protocol.MaxManifestBytes) throw new IOException("Oversized local JSON file.");
        return JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), Protocol.Json) ?? throw new IOException("Invalid local JSON file.");
    }

    // Only remove known files in our freshly allocated staging directory, never recurse through supplied paths.
    public static void RemoveStage(string path, params string[] files)
    {
        if (!Directory.Exists(path)) return;
        Paths.RejectLinks(path);
        foreach (var name in files)
        {
            var file = Path.Combine(path, name);
            Paths.RejectLinks(file);
            if (File.Exists(file)) File.Delete(file);
        }
        Directory.Delete(path, recursive: false);
    }
}
