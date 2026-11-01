param(
    [int]$WaitSeconds = 600
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')
. (Join-Path $PSScriptRoot 'openclaw-gateway-lib.ps1')

& (Join-Path $PSScriptRoot 'ensure-openclaw-codex-runtime.ps1') `
    -ProjectRoot $ProjectRoot `
    -OpenClawStateDirectory $OpenClawStateDirectory

Remove-Item -LiteralPath $OpenClawDisabledFile -Force -ErrorAction SilentlyContinue

function Test-OpenClawSupervisorOwned {
    if (-not (Test-Path -LiteralPath $OpenClawSupervisorLockFile)) {
        return $false
    }

    $probe = $null
    try {
        $probe = [System.IO.File]::Open(
            $OpenClawSupervisorLockFile,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        return $false
    } catch [System.IO.IOException] {
        return $true
    } finally {
        if ($probe) {
            $probe.Dispose()
        }
    }
}

$gatewayProcess = Get-OpenClawGatewayProcess
if ((Test-OpenClawGatewayHealth) -and (Test-OpenClawSupervisorOwned)) {
    $healthyId = if ($gatewayProcess) { [int]$gatewayProcess.ProcessId } else { 0 }
    Write-OpenClawGatewayStatus -Phase online -Detail 'OpenClaw Gateway is healthy.' -ProcessId $healthyId
    Write-Output "OpenClaw Gateway is already healthy under its sole supervisor. PID=$healthyId, port=$OpenClawPort"
    exit 0
}

# Every entry point launches the same supervisor. Its exclusive runtime lock
# makes duplicate launch attempts harmless; only the lock owner may create or
# restart the Gateway.
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Start-Process `
    -FilePath $powerShell `
    -ArgumentList @(
        '-NoProfile',
        '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'run-openclaw-poc.ps1')
    ) `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    Start-Sleep -Seconds 2
    $gatewayProcess = Get-OpenClawGatewayProcess
    if ((Test-OpenClawGatewayHealth) -and (Test-OpenClawSupervisorOwned)) {
        $healthyId = if ($gatewayProcess) { [int]$gatewayProcess.ProcessId } else { 0 }
        Write-OpenClawGatewayStatus -Phase online -Detail 'OpenClaw Gateway is healthy.' -ProcessId $healthyId
        Write-Output "OpenClaw Gateway is ready under its sole supervisor. PID=$healthyId, port=$OpenClawPort"
        exit 0
    }
} while ((Get-Date) -lt $deadline)

$pendingId = if ($gatewayProcess) { [int]$gatewayProcess.ProcessId } else { 0 }
Write-OpenClawGatewayStatus -Phase offline -Detail "The OpenClaw supervisor did not produce a healthy Gateway within $WaitSeconds seconds." -ProcessId $pendingId
throw "OpenClaw supervisor did not produce a healthy Gateway within $WaitSeconds seconds."
