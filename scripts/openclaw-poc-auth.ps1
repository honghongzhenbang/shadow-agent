. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')

$CodexHome = Join-Path $OpenClawStateDirectory 'agents\main\agent\codex-home'
$CodexExecutable = Join-Path $ProjectRoot 'tools\codex-managed-current\bin\codex.exe'

& (Join-Path $PSScriptRoot 'ensure-openclaw-codex-runtime.ps1') `
    -ProjectRoot $ProjectRoot `
    -OpenClawStateDirectory $OpenClawStateDirectory

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$env:CODEX_HOME = $CodexHome

Write-Host "正在登录 Shadow Agent 独立 Codex Home：$CodexHome" -ForegroundColor Cyan
& $CodexExecutable login --device-auth

if ($LASTEXITCODE -eq 0) {
    Write-Host 'Shadow Agent 独立 Codex 授权完成。' -ForegroundColor Green
} else {
    Write-Host "授权未完成，退出码：$LASTEXITCODE" -ForegroundColor Red
}
