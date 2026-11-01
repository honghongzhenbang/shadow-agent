param(
    [ValidateSet('status', 'login', 'complete', 'probe')]
    [string]$Mode = 'status',
    [string]$Scopes,
    [string]$DeviceCode
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$base = Get-ScheduledTask -TaskName 'PersonalShadowAgentContextService' -ErrorAction Stop
if ($base.Principal.LogonType -ne 'Interactive') { throw 'Expected the existing interactive-user background task.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskSid = (New-Object Security.Principal.NTAccount($base.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($taskSid -ne $identity.User.Value) { throw 'Background task belongs to another Windows user.' }
if ($Mode -eq 'login' -and -not $Scopes.Trim()) { throw 'Specify the required scopes explicitly.' }
if ($Mode -eq 'complete' -and -not $DeviceCode) { throw 'Supply the current device code after user authorization.' }

$id = [guid]::NewGuid().ToString('N')
$taskName = "ShadowFeishuAuth-$id"
$parent = [IO.Path]::GetFullPath((Join-Path $root 'runtime\feishu-auth'))
$directory = [IO.Path]::GetFullPath((Join-Path $parent $id))
if (-not $directory.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid private working directory.' }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$inputFile = Join-Path $directory 'input.json'
$outputFile = Join-Path $directory 'result.json'
$node = Join-Path $root 'tools\node-v24.19.0-win-x64\node.exe'
$worker = Join-Path $PSScriptRoot 'feishu-background-auth.mjs'
$timeout = if ($Mode -eq 'complete') { 380 } else { 90 }
try {
    # Challenges are transient, readable only by this user and SYSTEM, and removed on return.
    & icacls.exe $directory /inheritance:r /grant:r "*$($identity.User.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to protect temporary authorization files.' }
    $json = @{mode=$Mode;scopes=$Scopes;deviceCode=$DeviceCode} | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($inputFile, $json, (New-Object Text.UTF8Encoding($false)))
    $command = "& '$($node.Replace("'","''"))' '$($worker.Replace("'","''"))' '$($inputFile.Replace("'","''"))'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded" -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($timeout + 30)) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $base.Principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds($timeout)
    while (-not (Test-Path -LiteralPath $outputFile)) {
        if ((Get-Date) -gt $deadline) { throw 'Background auth probe did not return. No authorization success can be inferred.' }
        Start-Sleep -Milliseconds 200
    }
    Get-Content -LiteralPath $outputFile -Raw -Encoding UTF8
} finally {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    foreach ($file in @($inputFile, $outputFile, (Join-Path $directory 'result.tmp'))) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $directory -ErrorAction SilentlyContinue
}
