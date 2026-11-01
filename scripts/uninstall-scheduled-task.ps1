param(
    [string[]]$TaskName = @('PersonalShadowAgentContextService', 'PersonalShadowAgentOpenClaw', 'PersonalShadowAgentPet')
)

$ErrorActionPreference = 'Stop'
foreach ($Name in $TaskName) {
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Output "Scheduled task removed: $Name"
    }
    else {
        Write-Output "Scheduled task not found: $Name"
    }
}
