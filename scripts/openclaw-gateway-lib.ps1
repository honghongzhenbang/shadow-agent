function Test-OpenClawGatewayCommand {
    param($Process)
    if (-not $Process -or -not $Process.CommandLine) { return $false }
    if ($Process.ExecutablePath -and $Process.ExecutablePath -ne $NodeExecutable) { return $false }
    $entry = [regex]::Escape($OpenClawNodeEntry.Replace('/', '\'))
    $command = $Process.CommandLine.Replace('/', '\')
    $entryPattern = '(?:^|\s)(?:"' + $entry + '"|' + $entry + ')\s+gateway\s+run(?:\s|$)'
    $portPattern = '(?:^|\s)--port(?:=|\s+)"?' + [regex]::Escape([string]$OpenClawPort) + '"?(?=\s|$)'
    return $command -match $entryPattern -and $command -match $portPattern
}

function Get-OpenClawGatewayProcess {
    if (Test-Path -LiteralPath $OpenClawPidFile) {
        try {
            $processId = [int](Get-Content -LiteralPath $OpenClawPidFile -Raw).Trim()
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            if (Test-OpenClawGatewayCommand $process) {
                return $process
            }
            $nativeProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $process.CommandLine -and $nativeProcess -and $nativeProcess.Path -eq $NodeExecutable -and @(
                Get-NetTCPConnection -LocalPort $OpenClawPort -State Listen -ErrorAction SilentlyContinue |
                    Where-Object OwningProcess -eq $processId
            ).Count -gt 0) {
                return [pscustomobject]@{
                    ProcessId = $nativeProcess.Id
                    CommandLine = $null
                    VerifiedBy = 'pid-file-and-executable'
                }
            }
        } catch {
            # Fall through to listener discovery.
        }
        Remove-Item -LiteralPath $OpenClawPidFile -Force -ErrorAction SilentlyContinue
    }

    $listeners = Get-NetTCPConnection -LocalPort $OpenClawPort -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in @($listeners)) {
        $candidateId = [int]$listener.OwningProcess
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $candidateId" -ErrorAction SilentlyContinue
        if (Test-OpenClawGatewayCommand $candidate) {
            Set-Content -LiteralPath $OpenClawPidFile -Value $candidateId -Encoding ASCII
            return $candidate
        }
        $nativeCandidate = Get-Process -Id $candidateId -ErrorAction SilentlyContinue
        if (-not $candidate.CommandLine -and $nativeCandidate -and $nativeCandidate.Path -eq $NodeExecutable -and (Test-OpenClawGatewayHealth)) {
            Set-Content -LiteralPath $OpenClawPidFile -Value $candidateId -Encoding ASCII
            return [pscustomobject]@{
                ProcessId = $candidateId
                CommandLine = $null
                VerifiedBy = 'healthy-listener-and-executable'
            }
        }
    }

    if (Test-Path -LiteralPath $OpenClawStatusFile) {
        try {
            $status = Get-Content -LiteralPath $OpenClawStatusFile -Raw | ConvertFrom-Json
            $candidateId = [int]$status.pid
            $candidate = Get-Process -Id $candidateId -ErrorAction SilentlyContinue
            $details = Get-CimInstance Win32_Process -Filter "ProcessId = $candidateId" -ErrorAction SilentlyContinue
            $ownedCommand = Test-OpenClawGatewayCommand $details
            $ownedListener = -not $details.CommandLine -and $candidate -and $candidate.Path -eq $NodeExecutable -and @(
                Get-NetTCPConnection -LocalPort $OpenClawPort -State Listen -ErrorAction SilentlyContinue |
                    Where-Object OwningProcess -eq $candidateId
            ).Count -gt 0
            if (($ownedCommand -or $ownedListener) -and (Test-OpenClawGatewayHealth)) {
                Set-Content -LiteralPath $OpenClawPidFile -Value $candidateId -Encoding ASCII
                return [pscustomobject]@{
                    ProcessId = $candidateId
                    CommandLine = $null
                    VerifiedBy = 'status-file-executable-and-health'
                }
            }
        } catch {
            # A stale status file must not identify an unrelated process.
        }
    }
    return $null
}

function Test-OpenClawGatewayHealth {
    return (Get-OpenClawGatewayHealthProbe).healthy
}

function Get-OpenClawGatewayHealthProbe {
    param([int]$TimeoutSeconds = 3)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $healthy = $false
    $failure = $null
    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "http://127.0.0.1:$OpenClawPort/healthz" `
            -TimeoutSec $TimeoutSeconds
        $healthy = $response.StatusCode -eq 200
        if (-not $healthy) { $failure = "http_$($response.StatusCode)" }
    } catch {
        $failure = [string]$_.Exception.Status
        if (-not $failure) { $failure = $_.Exception.GetType().Name }
    }
    return [pscustomobject]@{ healthy = $healthy; failure = $failure; elapsedMs = $watch.ElapsedMilliseconds }
}

function Test-OpenClawRestartDue {
    param([int]$Failures, [int]$Threshold, [double]$UnhealthySeconds, [double]$MinimumSeconds)
    # A short readiness failure is not process death or a failed model run.
    return $Failures -ge $Threshold -and $UnhealthySeconds -ge $MinimumSeconds
}

function Write-OpenClawGatewayEvent {
    param([string]$Event, [hashtable]$Data = @{})
    $journal = Join-Path $OpenClawLogDirectory 'supervisor-events.jsonl'
    $entry = @{ at = (Get-Date).ToUniversalTime().ToString('o'); event = $Event; data = $Data }
    $payload = ($entry | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
    try {
        if ((Test-Path -LiteralPath $journal) -and (Get-Item -LiteralPath $journal).Length -gt 1MB) {
            Move-Item -LiteralPath $journal -Destination "$journal.previous" -Force
        }
        [IO.File]::AppendAllText($journal, $payload, (New-Object Text.UTF8Encoding($false)))
    } catch [IO.IOException], [UnauthorizedAccessException] {
        Write-Warning -WarningAction Continue "Gateway diagnostic journal write failed ($Event): $($_.Exception.GetBaseException().Message)"
    }
}

function Write-OpenClawGatewayStatus {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('starting', 'online', 'recovering', 'restarting', 'disabled', 'offline')]
        [string]$Phase,

        [Parameter(Mandatory = $true)]
        [string]$Detail,

        [int]$ProcessId = 0,

        [int]$RestartCount = 0
    )

    $status = [ordered]@{
        phase = $Phase
        detail = $Detail
        pid = if ($ProcessId -gt 0) { $ProcessId } else { $null }
        restartCount = $RestartCount
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $payload = $status | ConvertTo-Json
    $temporary = "$OpenClawStatusFile.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, $payload, (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($OpenClawStatusFile)) {
            [IO.File]::Replace($temporary, $OpenClawStatusFile, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $OpenClawStatusFile)
        }
    } catch [IO.IOException], [UnauthorizedAccessException] {
        # Status is diagnostic output, not permission to stop supervising.
        $failure = $_.Exception.GetBaseException()
        Write-Warning -WarningAction Continue "Gateway status write failed ($Phase): $($failure.Message)"
        try {
            Write-OpenClawGatewayEvent 'status_write_failed' @{
                phase = $Phase; pid = $ProcessId; restartCount = $RestartCount
                exception = $failure.GetType().FullName; hresult = $failure.HResult
            }
        } catch {
            Write-Warning -WarningAction Continue "Gateway status failure journal is unavailable: $($_.Exception.Message)"
        }
    } finally {
        if ([IO.File]::Exists($temporary)) {
            try { [IO.File]::Delete($temporary) } catch {
                Write-Warning -WarningAction Continue "Gateway status temporary file cleanup failed: $($_.Exception.Message)"
            }
        }
    }
}

function Start-OpenClawGatewayProcess {
    $launchLockPath = "$OpenClawPidFile.launch.lock"
    $launchLock = $null
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $launchLock -and (Get-Date) -lt $deadline) {
        try {
            $launchLock = [System.IO.File]::Open(
                $launchLockPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
        } catch [System.IO.IOException] {
            $existing = Get-OpenClawGatewayProcess
            if ($existing) {
                return [pscustomobject]@{
                    Process = Get-Process -Id $existing.ProcessId
                    StdoutPath = $null
                    StderrPath = $null
                    Reused = $true
                }
            }
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $launchLock) {
        throw 'Timed out acquiring the OpenClaw launch lock.'
    }

    try {
        $existing = Get-OpenClawGatewayProcess
        if ($existing) {
            return [pscustomobject]@{
                Process = Get-Process -Id $existing.ProcessId
                StdoutPath = $null
                StderrPath = $null
                Reused = $true
            }
        }

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutPath = Join-Path $OpenClawLogDirectory "gateway-$timestamp.stdout.log"
    $stderrPath = Join-Path $OpenClawLogDirectory "gateway-$timestamp.stderr.log"
    $arguments = @(
        ('"' + $OpenClawNodeEntry + '"'),
        'gateway',
        'run',
        '--port', [string]$OpenClawPort,
        '--bind', 'loopback',
        '--compact'
    )

    $process = Start-Process `
        -FilePath $NodeExecutable `
        -ArgumentList $arguments `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    Set-Content -LiteralPath $OpenClawPidFile -Value $process.Id -Encoding ASCII
    return [pscustomobject]@{
        Process = $process
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
        Reused = $false
    }
    } finally {
        $launchLock.Dispose()
        Remove-Item -LiteralPath $launchLockPath -Force -ErrorAction SilentlyContinue
    }
}

function Stop-OpenClawGatewayProcess {
    param(
        [int]$ProcessId,
        [int]$TimeoutSeconds = 15
    )

    if ($ProcessId -le 0) {
        Remove-Item -LiteralPath $OpenClawPidFile -Force -ErrorAction SilentlyContinue
        return
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    $nativeProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process -and -not $nativeProcess) {
        Remove-Item -LiteralPath $OpenClawPidFile -Force -ErrorAction SilentlyContinue
        return
    }
    $commandVerified = Test-OpenClawGatewayCommand $process
    $listenerVerified = -not $process.CommandLine -and $nativeProcess -and $nativeProcess.Path -eq $NodeExecutable -and @(
        Get-NetTCPConnection -LocalPort $OpenClawPort -State Listen -ErrorAction SilentlyContinue |
            Where-Object OwningProcess -eq $ProcessId
    ).Count -gt 0
    if (-not $commandVerified -and -not $listenerVerified) {
        throw "PID $ProcessId is not the expected OpenClaw Gateway process."
    }

    Stop-Process -Id $ProcessId -ErrorAction Stop
    Wait-Process -Id $ProcessId -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $OpenClawPidFile -Force -ErrorAction SilentlyContinue
}

function Wait-OpenClawGatewayHealthy {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [int]$WaitSeconds = 600
    )

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            return $false
        }
        if (Test-OpenClawGatewayHealth) {
            return $true
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    return $false
}
