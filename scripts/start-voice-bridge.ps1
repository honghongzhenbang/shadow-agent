[CmdletBinding(DefaultParameterSetName = 'Help')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Probe')][switch]$Probe,
    [Parameter(Mandatory = $true, ParameterSetName = 'RfcommProbe')][switch]$RfcommProbe,
    [Parameter(Mandatory = $true, ParameterSetName = 'Setup')][switch]$Setup,
    [Parameter(Mandatory = $true, ParameterSetName = 'Serve')][switch]$Serve,
    [Parameter(Mandatory = $true, ParameterSetName = 'Check')][switch]$Check,
    [Parameter(ParameterSetName = 'Setup')][string]$BridgeId,
    [Parameter(ParameterSetName = 'Serve')][switch]$NoTranscribe,
    [Parameter(ParameterSetName = 'Serve')][switch]$TranscribeOnly,
    [Parameter(ParameterSetName = 'Serve')][switch]$RetainAudio,
    [Parameter(ParameterSetName = 'Serve')][switch]$SpeakerClusters,
    [Parameter(ParameterSetName = 'Serve')][string]$Database,
    [Parameter(ParameterSetName = 'Serve')][string]$NodePath,
    [Parameter(ParameterSetName = 'Serve')][string]$ListenIp,
    [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'companion\voice-bridge\VoiceBridge.csproj'
$arguments = @()
if ($Probe) { $arguments += '--probe' }
elseif ($RfcommProbe) { $arguments += '--rfcomm-probe' }
elseif ($Setup) { $arguments += '--setup' }
elseif ($Serve) { $arguments += '--serve' }
elseif ($Check) { $arguments += '--check' }
else { $arguments += '--help' }
$arguments += @('--repo-root', $repoRoot)
if ($RuntimeRoot) { $arguments += @('--runtime-root', $RuntimeRoot) }
if ($BridgeId) { $arguments += @('--bridge-id', $BridgeId) }
if ($NoTranscribe) { $arguments += '--no-transcribe' }
if ($TranscribeOnly) { $arguments += '--transcribe-only' }
if ($RetainAudio) { $arguments += '--retain-audio' }
if ($SpeakerClusters) { $arguments += '--speaker-clusters' }
if ($Database) { $arguments += @('--database', $Database) }
if ($NodePath) { $arguments += @('--node', $NodePath) }
if ($ListenIp) { $arguments += @('--listen-ip', $ListenIp) }

if ($Check) {
    # Isolate both bin and obj so a running receiver's DLL is never rebuilt.
    $artifacts = Join-Path (Split-Path -Parent $project) 'bin\check'
    try {
        $buildOutput = & dotnet build $project --configuration Release --artifacts-path $artifacts --nologo --verbosity quiet --disable-build-servers 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Isolated check build failed.' }
    }
    catch {
        [ordered]@{
            mode = 'check'
            status = 'failed'
            scope = 'local_pc_only'
            stages = @([ordered]@{
                stage = 'build'
                status = 'failed'
                code = 'isolated_build_failed'
                message = 'The isolated diagnostic build failed; no runtime check was performed.'
                suggestion = 'Verify the .NET 8 SDK and build VoiceBridge.csproj using --artifacts-path companion/voice-bridge/bin/check. Do not rebuild the running receiver output.'
            })
        } | ConvertTo-Json -Depth 5
        exit 1
    }
    & dotnet (Join-Path $artifacts 'bin\VoiceBridge\release\VoiceBridge.dll') @arguments
}
else {
    & dotnet run --project $project --configuration Release --no-launch-profile -- @arguments
}
exit $LASTEXITCODE
