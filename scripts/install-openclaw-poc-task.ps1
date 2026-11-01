param(
    [string]$TaskName = 'PersonalShadowAgentOpenClaw'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'run-openclaw-poc.ps1'
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

& (Join-Path $PSScriptRoot 'run-portable-node.ps1') (Join-Path $PSScriptRoot 'apply-openclaw-runtime-profile.mjs')
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to apply the source-controlled OpenClaw runtime profile.'
}

$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`"" `
    -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2)
$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description 'OpenClaw Gateway for the Personal Shadow Agent single-controller runtime.' `
    -Force | Out-Null

Remove-Item -LiteralPath (Join-Path $ProjectRoot 'runtime\openclaw-poc\gateway.disabled') -Force -ErrorAction SilentlyContinue

Write-Output "Scheduled task installed: $TaskName"
