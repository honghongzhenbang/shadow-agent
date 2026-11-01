param(
    [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')
. (Join-Path $PSScriptRoot 'openclaw-gateway-lib.ps1')

$taskNames = @('PersonalShadowAgentContextService', 'PersonalShadowAgentOpenClaw')
$processMarkers = @(
    'scripts\start-context-service.ps1',
    'scripts\run-openclaw-poc.ps1',
    'src\cli.mjs serve',
    'openclaw\openclaw.mjs gateway run'
)
$projectNeedle = $ProjectRoot.ToLowerInvariant()
$contextShutdownFile = Join-Path $ProjectRoot 'runtime\shutdown.requested'

function Get-ShadowRootProcesses {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $roots = @($all | Where-Object {
        $commandLine = [string]$_.CommandLine
        if (-not $commandLine) { return $false }
        $normalized = $commandLine.ToLowerInvariant()
        if (-not $normalized.Contains($projectNeedle)) { return $false }
        foreach ($marker in $processMarkers) {
            if ($normalized.Contains($marker)) { return $true }
        }
        return $false
    })
    return @{ All = $all; Roots = $roots }
}

function Get-ShadowProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$AllProcesses,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [array]$RootProcesses
    )

    $children = @{}
    foreach ($process in $AllProcesses) {
        $parentId = [int]$process.ParentProcessId
        if (-not $children.ContainsKey($parentId)) { $children[$parentId] = @() }
        $children[$parentId] += $process
    }

    $depthById = @{}
    $queue = New-Object System.Collections.Generic.Queue[object]
    foreach ($root in $RootProcesses) {
        $queue.Enqueue([pscustomobject]@{ Process = $root; Depth = 0 })
    }
    while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        $processId = [int]$item.Process.ProcessId
        $depth = [int]$item.Depth
        if ($processId -eq $PID) { continue }
        # ParentProcessId can point at a reused PID, so the snapshot is not guaranteed acyclic.
        if ($depthById.ContainsKey($processId)) { continue }
        $depthById[$processId] = $depth
        foreach ($child in @($children[$processId])) {
            if ([int]$child.SessionId -ne [int]$item.Process.SessionId) { continue }
            if ($child.CreationDate -and $item.Process.CreationDate `
                -and ([datetime]$child.CreationDate -lt [datetime]$item.Process.CreationDate)) { continue }
            $queue.Enqueue([pscustomobject]@{ Process = $child; Depth = $depth + 1 })
        }
    }

    return @($depthById.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{ ProcessId = [int]$_.Key; Depth = [int]$_.Value }
    } | Sort-Object Depth -Descending)
}

# Prevent the Gateway supervisor from replacing a child while its tree closes.
Set-Content -LiteralPath $OpenClawDisabledFile -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding ASCII
Set-Content -LiteralPath $contextShutdownFile -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding ASCII

foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
}

$graceDeadline = (Get-Date).AddSeconds([Math]::Min(5, $WaitSeconds))
do {
    Start-Sleep -Milliseconds 250
    $contextRoots = @((Get-ShadowRootProcesses).Roots | Where-Object {
        ([string]$_.CommandLine).ToLowerInvariant().Contains('src\cli.mjs serve')
    })
} while ($contextRoots.Count -gt 0 -and (Get-Date) -lt $graceDeadline)
$contextStoppedGracefully = $contextRoots.Count -eq 0

$snapshot = Get-ShadowRootProcesses
$targets = @(Get-ShadowProcessTree -AllProcesses $snapshot.All -RootProcesses $snapshot.Roots)
$stopped = @()
foreach ($target in $targets) {
    if (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        $stopped += $target.ProcessId
    }
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-ShadowRootProcesses).Roots
} while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)

if ($remaining.Count -gt 0) {
    throw "Shadow Agent background processes are still running: $($remaining.ProcessId -join ', ')"
}

Remove-Item -LiteralPath $OpenClawPidFile -Force -ErrorAction SilentlyContinue
Write-OpenClawGatewayStatus -Phase offline -Detail 'Shadow Agent was stopped from the system tray.'
Remove-Item -LiteralPath $OpenClawDisabledFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $contextShutdownFile -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
    stopped = $true
    stoppedProcessIds = @($stopped)
    stoppedTasks = $taskNames
    contextStoppedGracefully = $contextStoppedGracefully
    remainingBackgroundProcesses = 0
} | ConvertTo-Json -Compress
