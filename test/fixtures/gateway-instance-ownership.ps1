param([string]$Library,[string]$Root)
$ErrorActionPreference = 'Stop'
. $Library
$NodeExecutable = Join-Path $Root 'tools/node.exe'
$OpenClawNodeEntry = Join-Path $Root 'tools/openclaw/openclaw.mjs'
$OpenClawPort = 19173
$OpenClawPidFile = Join-Path $Root 'gateway.pid'
$OpenClawStatusFile = Join-Path $Root 'status.json'
$script:stopped = @()
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) return $script:candidate }
function Get-NetTCPConnection { param($LocalPort,$State,$ErrorAction) return [pscustomobject]@{OwningProcess=1234} }
function Get-Process { param($Id,$ErrorAction) return [pscustomobject]@{Id=1234;Path=$NodeExecutable} }
function Test-OpenClawGatewayHealth { return $true }
function Stop-Process { param($Id,$ErrorAction) $script:stopped += $Id }
function Wait-Process { param($Id,$Timeout,$ErrorAction) }
function Assert-True($value,$message) { if(-not $value){throw $message} }

$foreign = Join-Path $Root 'different-project/openclaw.mjs'
$script:candidate = [pscustomobject]@{ProcessId=1234;ExecutablePath=$NodeExecutable;
    CommandLine=('"'+$NodeExecutable+'" "'+$foreign+'" gateway run --port '+$OpenClawPort)}
Assert-True ($null -eq (Get-OpenClawGatewayProcess)) 'Foreign gateway listener must not be adopted'
Set-Content -LiteralPath $OpenClawPidFile -Value 1234 -Encoding ASCII
Assert-True ($null -eq (Get-OpenClawGatewayProcess)) 'Stale PID must not adopt a foreign gateway'
$rejected = $false
try { Stop-OpenClawGatewayProcess -ProcessId 1234 } catch { $rejected = $true }
Assert-True $rejected 'Foreign gateway stop must be rejected'
Assert-True ($script:stopped.Count -eq 0) 'No foreign process may be stopped'

$script:candidate.CommandLine = '"'+$NodeExecutable+'" "'+$OpenClawNodeEntry+'" gateway run --port 19174'
Assert-True ($null -eq (Get-OpenClawGatewayProcess)) 'Same executable on another port must not be adopted'
$script:candidate.CommandLine = '"'+$NodeExecutable+'" "'+$OpenClawNodeEntry+'" gateway run --port '+$OpenClawPort
Assert-True ((Get-OpenClawGatewayProcess).ProcessId -eq 1234) 'Owned gateway must be found'
Stop-OpenClawGatewayProcess -ProcessId 1234
Assert-True ($script:stopped.Count -eq 1) 'Owned gateway remains stoppable'

$script:candidate.CommandLine = $null
Assert-True ((Get-OpenClawGatewayProcess).ProcessId -eq 1234) 'Opaque owned executable/listener fallback remains available'
[pscustomobject]@{passed=$true;checks=7;realProcessesStopped=0} | ConvertTo-Json -Compress
