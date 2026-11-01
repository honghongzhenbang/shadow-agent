param(
    [int]$StartupWaitSeconds = 600,
    [int]$HealthCheckSeconds = 15,
    [int]$FailureThreshold = 3,
    [int]$UnhealthyRestartSeconds = 120,
    [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')
. (Join-Path $PSScriptRoot 'openclaw-gateway-lib.ps1')

& (Join-Path $PSScriptRoot 'ensure-openclaw-codex-runtime.ps1') `
    -ProjectRoot $ProjectRoot `
    -OpenClawStateDirectory $OpenClawStateDirectory

$supervisorLock = $null
try {
    $supervisorLock = [System.IO.File]::Open(
        $OpenClawSupervisorLockFile,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch [System.IO.IOException] {
    Write-Output 'Another OpenClaw supervisor already owns the runtime lock.'
    exit 0
}

$supervisorMetadata = [Text.Encoding]::UTF8.GetBytes((@{
    pid = $PID
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress))
$supervisorLock.SetLength(0)
$supervisorLock.Write($supervisorMetadata, 0, $supervisorMetadata.Length)
$supervisorLock.Flush($true)

$restartCount = 0
try {
while ($true) {
    if (Test-Path -LiteralPath $OpenClawDisabledFile) {
        Write-OpenClawGatewayStatus -Phase disabled -Detail 'OpenClaw was disabled manually.' -RestartCount $restartCount
        Start-Sleep -Seconds 5
        continue
    }

    $gatewayProcess = Get-OpenClawGatewayProcess
    if (-not $gatewayProcess) {
        & $NodeExecutable (Join-Path $ProjectRoot 'scripts\apply-shadow-policy-boundary.mjs') $ProjectRoot
        if ($LASTEXITCODE -ne 0) { throw 'Shadow policy boundary validation failed; Gateway was not started.' }
        & $NodeExecutable (Join-Path $ProjectRoot 'scripts\apply-codex-session-read-boundary.mjs') $ProjectRoot
        if ($LASTEXITCODE -ne 0) { throw 'Codex transcript boundary validation failed; Gateway was not started.' }
        & $NodeExecutable (Join-Path $ProjectRoot 'scripts\apply-run-wait-presence.mjs') $ProjectRoot
        if ($LASTEXITCODE -ne 0) { throw 'Run presence validation failed; Gateway was not started.' }
        & $NodeExecutable (Join-Path $ProjectRoot 'scripts\apply-codex-shell-alias.mjs') $ProjectRoot
        if ($LASTEXITCODE -ne 0) { throw 'Codex shell projection validation failed; Gateway was not started.' }
        Write-OpenClawGatewayStatus -Phase starting -Detail 'Starting OpenClaw Gateway. A cold start can take several minutes.' -RestartCount $restartCount
        $launch = Start-OpenClawGatewayProcess
        Write-OpenClawGatewayEvent 'process_started' @{ pid = $launch.Process.Id; stdout = $launch.StdoutPath; restartCount = $restartCount }
        $gatewayProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($launch.Process.Id)" -ErrorAction SilentlyContinue
    } elseif (Test-OpenClawGatewayHealth) {
        Write-OpenClawGatewayStatus -Phase online -Detail 'OpenClaw Gateway is healthy.' -ProcessId $gatewayProcess.ProcessId -RestartCount $restartCount
    } else {
        Write-OpenClawGatewayStatus -Phase starting -Detail 'OpenClaw Gateway is completing its cold start.' -ProcessId $gatewayProcess.ProcessId -RestartCount $restartCount
    }

    if (-not $gatewayProcess -or -not (Wait-OpenClawGatewayHealthy -ProcessId $gatewayProcess.ProcessId -WaitSeconds $StartupWaitSeconds)) {
        $failedId = if ($gatewayProcess) { [int]$gatewayProcess.ProcessId } else { 0 }
        Write-OpenClawGatewayEvent 'startup_failed' @{ pid = $failedId; waitSeconds = $StartupWaitSeconds; alive = [bool](Get-Process -Id $failedId -ErrorAction SilentlyContinue) }
        Write-OpenClawGatewayStatus -Phase restarting -Detail 'OpenClaw did not pass its startup health check and will retry.' -ProcessId $failedId -RestartCount $restartCount
        if ($failedId -gt 0) {
            Stop-OpenClawGatewayProcess -ProcessId $failedId
        }
        $restartCount += 1
        Start-Sleep -Seconds $RestartDelaySeconds
        continue
    }

    Write-OpenClawGatewayStatus -Phase online -Detail 'OpenClaw Gateway is healthy.' -ProcessId $gatewayProcess.ProcessId -RestartCount $restartCount
    $consecutiveFailures = 0
    $unhealthySince = $null
    $nativeGateway = Get-Process -Id $gatewayProcess.ProcessId -ErrorAction SilentlyContinue
    $stopReason = 'process_exit'
    while (Get-Process -Id $gatewayProcess.ProcessId -ErrorAction SilentlyContinue) {
        Start-Sleep -Seconds $HealthCheckSeconds
        if (Test-Path -LiteralPath $OpenClawDisabledFile) {
            $stopReason = 'manual_stop'
            Write-OpenClawGatewayEvent 'stop_requested' @{ pid = $gatewayProcess.ProcessId; reason = $stopReason }
            Stop-OpenClawGatewayProcess -ProcessId $gatewayProcess.ProcessId
            break
        }
        $probe = Get-OpenClawGatewayHealthProbe
        if ($probe.healthy) {
            if ($consecutiveFailures -gt 0) {
                Write-OpenClawGatewayEvent 'health_recovered' @{ pid = $gatewayProcess.ProcessId; failures = $consecutiveFailures; elapsedMs = $probe.elapsedMs }
            }
            $consecutiveFailures = 0
            $unhealthySince = $null
            Write-OpenClawGatewayStatus -Phase online -Detail 'OpenClaw Gateway is healthy.' -ProcessId $gatewayProcess.ProcessId -RestartCount $restartCount
            continue
        }

        $consecutiveFailures += 1
        if (-not $unhealthySince) { $unhealthySince = Get-Date }
        $unhealthySeconds = ((Get-Date) - $unhealthySince).TotalSeconds
        Write-OpenClawGatewayEvent 'health_failed' @{ pid = $gatewayProcess.ProcessId; failures = $consecutiveFailures; unhealthySeconds = $unhealthySeconds; failure = $probe.failure; elapsedMs = $probe.elapsedMs }
        Write-OpenClawGatewayStatus `
            -Phase recovering `
            -Detail "OpenClaw health probe is unavailable ($consecutiveFailures failures). Confirming liveness before restart." `
            -ProcessId $gatewayProcess.ProcessId `
            -RestartCount $restartCount
        if (Test-OpenClawRestartDue -Failures $consecutiveFailures -Threshold $FailureThreshold -UnhealthySeconds $unhealthySeconds -MinimumSeconds $UnhealthyRestartSeconds) {
            $confirmation = Get-OpenClawGatewayHealthProbe -TimeoutSeconds 15
            if ($confirmation.healthy) {
                Write-OpenClawGatewayEvent 'restart_avoided' @{ pid = $gatewayProcess.ProcessId; elapsedMs = $confirmation.elapsedMs }
                $consecutiveFailures = 0
                $unhealthySince = $null
                continue
            }
            $stopReason = 'sustained_health_failure'
            Write-OpenClawGatewayEvent 'stop_requested' @{ pid = $gatewayProcess.ProcessId; reason = $stopReason; unhealthySeconds = $unhealthySeconds; confirmationFailure = $confirmation.failure }
            Stop-OpenClawGatewayProcess -ProcessId $gatewayProcess.ProcessId
            break
        }
    }

    $exitCode = $null
    try { if ($nativeGateway -and $nativeGateway.HasExited) { $exitCode = $nativeGateway.ExitCode } } catch { }
    Write-OpenClawGatewayEvent 'process_stopped' @{ pid = $gatewayProcess.ProcessId; reason = $stopReason; exitCode = $exitCode }

    if (-not (Test-Path -LiteralPath $OpenClawDisabledFile)) {
        $restartCount += 1
        Write-OpenClawGatewayStatus -Phase restarting -Detail 'OpenClaw exited and will restart automatically.' -RestartCount $restartCount
        Start-Sleep -Seconds $RestartDelaySeconds
    }
}
} finally {
    $supervisorLock.Dispose()
}
