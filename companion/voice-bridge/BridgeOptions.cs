namespace VoiceBridge;

internal sealed record BridgeOptions(
    string Mode, string RepoRoot, string RuntimeRoot, string? BridgeId,
    bool NoTranscribe, string? Database, string NodePath, string? ListenIp = null, bool TranscribeOnly = false,
    bool RetainAudio = false, bool SpeakerClusters = false)
{
    public static BridgeOptions Parse(string[] args)
    {
        var flags = new HashSet<string>(StringComparer.Ordinal);
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Length; i++)
        {
            var key = args[i];
            if (key is "--probe" or "--rfcomm-probe" or "--setup" or "--serve" or "--check" or "--help" or "--no-transcribe" or "--transcribe-only" or "--retain-audio" or "--speaker-clusters")
            {
                if (!flags.Add(key)) throw new ArgumentException($"Duplicate option: {key}");
            }
            else if (key is "--repo-root" or "--runtime-root" or "--bridge-id" or "--database" or "--node" or "--listen-ip")
            {
                if (++i >= args.Length || args[i].StartsWith("--", StringComparison.Ordinal) || !values.TryAdd(key, args[i]))
                    throw new ArgumentException($"Missing or duplicate option: {key}");
            }
            else throw new ArgumentException($"Unknown option: {key}");
        }
        var modes = flags.Where(x => x is not ("--no-transcribe" or "--transcribe-only" or "--retain-audio" or "--speaker-clusters")).ToArray();
        if (modes.Length > 1) throw new ArgumentException("Choose exactly one of --probe, --rfcomm-probe, --setup, --serve, --check, --help.");
        var mode = modes.SingleOrDefault() ?? "--help";
        if (flags.Contains("--retain-audio") && mode != "--serve")
            throw new ArgumentException("--retain-audio is serve-only.");
        if (flags.Contains("--speaker-clusters") && (mode != "--serve" || !flags.Contains("--transcribe-only")))
            throw new ArgumentException("--speaker-clusters requires --serve --transcribe-only.");
        var repo = Path.GetFullPath(values.GetValueOrDefault("--repo-root") ?? FindRepo());
        var runtime = Path.GetFullPath(values.GetValueOrDefault("--runtime-root") ?? "runtime/voice", repo);
        if (string.Equals(repo.TrimEnd(Path.DirectorySeparatorChar), runtime.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) ||
            (Paths.IsWithin(repo, runtime) && !Paths.IsWithin(Path.Combine(repo, "runtime"), runtime)))
            throw new ArgumentException("Keep private runtime data under ignored runtime/ or outside the repository.");
        if (mode != "--setup" && values.ContainsKey("--bridge-id"))
            throw new ArgumentException("--bridge-id is setup-only. Existing pairing is never silently changed.");
        if (mode != "--serve" && (flags.Contains("--no-transcribe") || flags.Contains("--transcribe-only") || values.ContainsKey("--database") || values.ContainsKey("--node") || values.ContainsKey("--listen-ip")))
            throw new ArgumentException("--no-transcribe, --transcribe-only, --database, --node and --listen-ip are serve-only.");
        if (flags.Contains("--transcribe-only") && (flags.Contains("--no-transcribe") || values.ContainsKey("--database") || values.ContainsKey("--node")))
            throw new ArgumentException("--transcribe-only cannot be combined with --no-transcribe, --database or --node; local transcription never imports into an Agent or database.");
        if (values.TryGetValue("--listen-ip", out var listenIp) &&
            (!System.Net.IPAddress.TryParse(listenIp, out var listenAddress) || listenAddress.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork))
            throw new ArgumentException("--listen-ip requires an IPv4 bind address.");
        return new(mode, repo, runtime, values.GetValueOrDefault("--bridge-id"),
            flags.Contains("--no-transcribe"), values.TryGetValue("--database", out var db) ? Path.GetFullPath(db, repo) : null,
            values.GetValueOrDefault("--node") ?? "node", values.GetValueOrDefault("--listen-ip"), flags.Contains("--transcribe-only"), flags.Contains("--retain-audio"), flags.Contains("--speaker-clusters"));
    }

    private static string FindRepo()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
                if (File.Exists(Path.Combine(dir.FullName, "scripts", "voice-input.mjs"))) return dir.FullName;
        return Directory.GetCurrentDirectory();
    }
}
