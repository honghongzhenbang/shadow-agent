param(
    [string]$TaskName = 'PersonalShadowAgentContextService',
    [string]$PetTaskName = 'PersonalShadowAgentPet',
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'start-context-service.ps1'
$PetLauncher = Join-Path $PSScriptRoot 'start-pet.ps1'
$Electron = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path -LiteralPath $Electron)) {
    throw "Electron is not installed. Run npm install in $ProjectRoot first."
}

foreach ($ExistingTaskName in @($TaskName, 'PersonalShadowAgentOpenClaw', $PetTaskName)) {
    if (Get-ScheduledTask -TaskName $ExistingTaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $ExistingTaskName -ErrorAction SilentlyContinue
    }
}

$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`"" `
    -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description 'Incremental evidence collector and temporal context graph service. OpenClaw is the sole controller.' `
    -Force | Out-Null

Write-Output "Scheduled task installed: $TaskName"


$PetAction = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PetLauncher`"" `
    -WorkingDirectory $ProjectRoot

Register-ScheduledTask `
    -TaskName $PetTaskName `
    -Action $PetAction `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description 'Shadow Agent floating task companion.' `
    -Force | Out-Null

Write-Output "Scheduled task installed: $PetTaskName"

& (Join-Path $PSScriptRoot 'install-shadow-context-plugin.ps1')
& (Join-Path $PSScriptRoot 'install-openclaw-poc-task.ps1')

if ($StartNow) {
    foreach ($InstalledTaskName in @($TaskName, 'PersonalShadowAgentOpenClaw', $PetTaskName)) {
        Start-ScheduledTask -TaskName $InstalledTaskName
        Write-Output "Scheduled task started: $InstalledTaskName"
    }
}
