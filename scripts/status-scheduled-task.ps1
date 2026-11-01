param(
    [string[]]$TaskName = @('PersonalShadowAgentContextService', 'PersonalShadowAgentOpenClaw', 'PersonalShadowAgentPet')
)

$ErrorActionPreference = 'Stop'
$Results = foreach ($Name in $TaskName) {
    $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $Task) {
        [pscustomobject]@{
            TaskName = $Name
            State = 'NotFound'
            LastRunTime = $null
            LastTaskResult = $null
            NextRunTime = $null
            Execute = $null
            Arguments = $null
            WorkingDirectory = $null
        }
        continue
    }
    $Info = Get-ScheduledTaskInfo -TaskName $Name
    $Action = $Task.Actions | Select-Object -First 1
    [pscustomobject]@{
        TaskName = $Name
        State = $Task.State
        LastRunTime = $Info.LastRunTime
        LastTaskResult = $Info.LastTaskResult
        NextRunTime = $Info.NextRunTime
        Execute = $Action.Execute
        Arguments = $Action.Arguments
        WorkingDirectory = $Action.WorkingDirectory
    }
}
$Results | Format-List
