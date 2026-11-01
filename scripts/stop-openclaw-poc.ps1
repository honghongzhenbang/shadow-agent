$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')
. (Join-Path $PSScriptRoot 'openclaw-gateway-lib.ps1')

Set-Content -LiteralPath $OpenClawDisabledFile -Value (Get-Date).ToUniversalTime().ToString('o') -Encoding ASCII
$process = Get-OpenClawGatewayProcess
if (-not $process) {
    Write-OpenClawGatewayStatus -Phase disabled -Detail 'OpenClaw was disabled manually.'
    Write-Output 'OpenClaw Gateway was not running. Disabled state was recorded.'
    exit 0
}

$processId = [int]$process.ProcessId
Stop-OpenClawGatewayProcess -ProcessId $processId
Write-OpenClawGatewayStatus -Phase disabled -Detail 'OpenClaw was disabled manually.'
Write-Output "OpenClaw Gateway stopped. PID=$processId"
