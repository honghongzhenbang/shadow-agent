param([string]$Library, [string]$Root)
$ErrorActionPreference = 'Stop'
. $Library
$OpenClawStatusFile = Join-Path $Root 'status.json'
$OpenClawLogDirectory = Join-Path $Root 'logs'
New-Item -ItemType Directory -Path $OpenClawLogDirectory | Out-Null
$checks = [Collections.Generic.List[string]]::new()
function Confirm([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "Assertion failed: $Name" }
    $checks.Add($Name)
}
function Read-Status { Get-Content -LiteralPath $OpenClawStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json }

$detail = 'first ' + [char]0x4E2D + [char]0x6587
Write-OpenClawGatewayStatus -Phase online -Detail $detail -ProcessId 123 -RestartCount 2
$first = Read-Status
Confirm ($first.phase -eq 'online' -and $first.detail -eq $detail -and $first.pid -eq 123 -and $first.restartCount -eq 2) 'UTF8 status persists'
Write-OpenClawGatewayStatus -Phase recovering -Detail 'previous intact status' -ProcessId 123 -RestartCount 2
$prior = [IO.File]::ReadAllText($OpenClawStatusFile)
$lock = [IO.File]::Open($OpenClawStatusFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$thrown = $null; $warnings = @()
try {
    try { $warnings = @(Write-OpenClawGatewayStatus -Phase restarting -Detail 'locked diagnostic output' -RestartCount 3 3>&1) }
    catch { $thrown = $_ }
} finally { $lock.Dispose() }
Confirm ([IO.File]::ReadAllText($OpenClawStatusFile) -eq $prior) 'locked status stays byte-identical'
Confirm ($null -eq $thrown -and $warnings.Count -gt 0) 'status contention warns without throwing'
$entry = Get-Content -LiteralPath (Join-Path $OpenClawLogDirectory 'supervisor-events.jsonl') -Encoding UTF8 | Select-Object -Last 1 | ConvertFrom-Json
Confirm ($entry.event -eq 'status_write_failed' -and $entry.data.phase -eq 'restarting') 'status failure journaled'
Write-OpenClawGatewayStatus -Phase online -Detail 'after lock release' -ProcessId 456 -RestartCount 3
Confirm ((Read-Status).pid -eq 456) 'later status resumes'

$journal = Join-Path $OpenClawLogDirectory 'supervisor-events.jsonl'
$beforeJournal = [IO.File]::ReadAllText($journal)
$journalLock = [IO.File]::Open($journal, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { $warnings = @(Write-OpenClawGatewayEvent 'process_started' @{pid=456} 3>&1) }
finally { $journalLock.Dispose() }
Confirm ($warnings.Count -gt 0 -and [IO.File]::ReadAllText($journal) -eq $beforeJournal) 'journal contention is nonfatal'
Write-OpenClawGatewayEvent 'health_recovered' @{pid=456}
$latest = Get-Content -LiteralPath $journal -Encoding UTF8 | Select-Object -Last 1 | ConvertFrom-Json
Confirm ($latest.event -eq 'health_recovered') 'journal resumes'

$original = $OpenClawStatusFile
$OpenClawStatusFile = Join-Path $Root 'missing-parent\status.json'
$warnings = @(Write-OpenClawGatewayStatus -Phase offline -Detail 'missing diagnostic directory' 3>&1)
Confirm ($warnings.Count -gt 0 -and -not (Test-Path -LiteralPath $OpenClawStatusFile)) 'missing directory is nonfatal'
$OpenClawStatusFile = $original
[IO.File]::Move($journal, "$journal.saved")
[IO.Directory]::CreateDirectory($journal) | Out-Null
$lock = [IO.File]::Open($original, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try { $warnings = @(Write-OpenClawGatewayStatus -Phase offline -Detail 'both diagnostics unavailable' 3>&1) }
finally { $lock.Dispose() }
Confirm ($warnings.Count -ge 2) 'both failures warn without terminating'
Confirm (@(Get-ChildItem -LiteralPath $Root -Filter '*.tmp').Count -eq 0) 'own temporary files removed'
$invalid = $false
try { Write-OpenClawGatewayStatus -Phase invalid -Detail 'bad caller' } catch { $invalid = $true }
Confirm $invalid 'invalid phase still rejected'
[pscustomobject]@{passed=$true;checks=$checks} | ConvertTo-Json -Depth 5
