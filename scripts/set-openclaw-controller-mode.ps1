param(
    [ValidateSet('Enable', 'Disable')]
    [string]$Mode = 'Enable'
)

. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')

$heartbeat = if ($Mode -eq 'Enable') {
    @{
        every = '0m'
        target = 'none'
        lightContext = $true
        isolatedSession = $true
        skipWhenBusy = $true
        timeoutSeconds = 600
    }
} else {
    @{
        every = '0m'
        target = 'none'
        lightContext = $true
        isolatedSession = $true
        skipWhenBusy = $true
        timeoutSeconds = 600
    }
}

$value = $heartbeat | ConvertTo-Json -Depth 10 -Compress
$argumentFile = Join-Path $OpenClawTempDirectory "controller-mode-$PID.json"
@('config', 'set', 'agents.defaults.heartbeat', $value, '--strict-json') |
    ConvertTo-Json -Depth 10 |
    Set-Content -LiteralPath $argumentFile -Encoding UTF8

try {
    & $NodeExecutable (Join-Path $PSScriptRoot 'openclaw-command.mjs') $argumentFile
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to set OpenClaw controller mode: $Mode"
    }
} finally {
    Remove-Item -LiteralPath $argumentFile -Force -ErrorAction SilentlyContinue
}

Write-Output "OpenClaw controller mode: $Mode"
