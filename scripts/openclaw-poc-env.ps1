$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$NodeDirectory = Join-Path $ProjectRoot 'tools\node-v24.19.0-win-x64'
$NodeExecutable = Join-Path $NodeDirectory 'node.exe'
$OpenClawRoot = Join-Path $ProjectRoot 'tools\openclaw-runtime\node_modules\openclaw'
$OpenClaw = Join-Path $ProjectRoot 'tools\openclaw-runtime\node_modules\.bin\openclaw.cmd'
$OpenClawNodeEntry = Join-Path $OpenClawRoot 'openclaw.mjs'
$OpenClawRuntimeRoot = Join-Path $ProjectRoot 'runtime\openclaw-poc'
$OpenClawStateDirectory = Join-Path $OpenClawRuntimeRoot 'state'
$OpenClawWorkspaceDirectory = Join-Path $OpenClawRuntimeRoot 'workspace'
$OpenClawLogDirectory = Join-Path $OpenClawRuntimeRoot 'logs'
$OpenClawEvidenceDirectory = Join-Path $OpenClawRuntimeRoot 'evidence'
$OpenClawTempDirectory = Join-Path $OpenClawRuntimeRoot 'tmp'
$OpenClawPidFile = Join-Path $OpenClawRuntimeRoot 'gateway.pid'
$OpenClawSupervisorLockFile = Join-Path $OpenClawRuntimeRoot 'supervisor.lock'
$OpenClawStatusFile = Join-Path $OpenClawRuntimeRoot 'gateway-status.json'
$OpenClawDisabledFile = Join-Path $OpenClawRuntimeRoot 'gateway.disabled'
$OpenClawPort = 19011

$requiredPaths = @(
    $NodeExecutable,
    $OpenClaw,
    $OpenClawNodeEntry,
    (Join-Path $OpenClawStateDirectory 'openclaw.json')
)

foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "OpenClaw PoC 缺少文件：$requiredPath"
    }
}

$runtimeConfig = [IO.File]::ReadAllText((Join-Path $OpenClawStateDirectory 'openclaw.json')) | ConvertFrom-Json
if ($null -ne $runtimeConfig.gateway.port) {
    $configuredPort = 0
    if (-not [int]::TryParse([string]$runtimeConfig.gateway.port, [ref]$configuredPort) -or
        $configuredPort -lt 1 -or $configuredPort -gt 65535) {
        throw 'OpenClaw gateway.port must be an integer from 1 to 65535.'
    }
    $OpenClawPort = $configuredPort
}

New-Item -ItemType Directory -Force -Path $OpenClawLogDirectory, $OpenClawEvidenceDirectory, $OpenClawTempDirectory | Out-Null

$env:PATH = "$NodeDirectory;$env:PATH"
$env:OPENCLAW_STATE_DIR = $OpenClawStateDirectory
$env:OPENCLAW_CONFIG_PATH = Join-Path $OpenClawStateDirectory 'openclaw.json'
$env:OPENCLAW_WORKSPACE_DIR = $OpenClawWorkspaceDirectory
$env:OPENCLAW_GATEWAY_PORT = [string]$OpenClawPort
