[CmdletBinding(DefaultParameterSetName = 'Help')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Listen')][switch]$Listen,
    [Parameter(ParameterSetName = 'Listen')][Nullable[double]]$Seconds,
    [Parameter(ParameterSetName = 'Listen')][switch]$UntilStopped,
    [Parameter(ParameterSetName = 'Listen')][Nullable[int]]$Device,
    [Parameter(Mandatory = $true, ParameterSetName = 'Replay')][string]$Replay,
    [Parameter(Mandatory = $true, ParameterSetName = 'Resume')][string]$Resume,
    [string]$OutputRoot,
    [switch]$Import,
    [string]$Database,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$arguments = @('-I', '-B', (Join-Path $root 'scripts\voice-runtime\listen.py'), '--capture-only')
if ($Import) { throw 'Capture now queues through the main intake. Do not enable a second direct importer.' }
$localConfig = Join-Path $root 'config/agent.local.json'
$voice = if (Test-Path -LiteralPath $localConfig) { (Get-Content -Raw -LiteralPath $localConfig -Encoding UTF8 | ConvertFrom-Json).voice } else { $null }
$python = if ($voice.python) { $voice.python } else { 'D:/anaconda/python.exe' }
if ($voice.assetsRoot) { $env:SHADOW_VOICE_ASSETS_ROOT = $voice.assetsRoot; $arguments += @('--model-dir', (Join-Path $voice.assetsRoot 'models')) }
$env:SHADOW_VOICE_PYTHON = $python
if ($Listen) {
    if (($null -eq $Seconds) -and -not $UntilStopped) { throw 'Specify -Seconds or -UntilStopped. No microphone was opened.' }
    if (($null -ne $Seconds) -and $UntilStopped) { throw 'Choose -Seconds or -UntilStopped, not both.' }
    $arguments += '--microphone'
    if ($null -ne $Seconds) { $arguments += @('--seconds', $Seconds.ToString([Globalization.CultureInfo]::InvariantCulture)) }
    if ($UntilStopped) { $arguments += '--until-stopped' }
    if ($null -ne $Device) { $arguments += @('--device', [string]$Device) }
} elseif ($Replay) { $arguments += @('--replay', $Replay) }
elseif ($Resume) { $arguments += @('--resume', $Resume) }
else { $arguments += '--help' }
if ($OutputRoot) { $arguments += @('--output-root', $OutputRoot) }
if ($Import) { $arguments += '--import' }
if ($Database) { $arguments += @('--database', $Database) }
if ($NodePath) { $arguments += @('--node', $NodePath) }

# Intentionally foreground: visible recording status and Ctrl+C are part of consent.
& $python @arguments
exit $LASTEXITCODE
