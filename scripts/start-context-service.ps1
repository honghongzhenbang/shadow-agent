param(
    [int]$RestartDelaySeconds = 10
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Node = Join-Path $ProjectRoot 'tools\node-v24.19.0-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $Node)) {
    throw 'The validated bundled Node runtime is missing; do not write the shared SQLite database using an arbitrary PATH runtime.'
}
$LogDirectory = Join-Path $ProjectRoot 'logs'
$SupervisorLog = Join-Path $LogDirectory 'context-service-supervisor.log'
$ShutdownRequestFile = Join-Path $ProjectRoot 'runtime\shutdown.requested'
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
Remove-Item -LiteralPath $ShutdownRequestFile -Force -ErrorAction SilentlyContinue

while ($true) {
    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $StdoutLog = Join-Path $LogDirectory "context-service-$Stamp.stdout.log"
    $StderrLog = Join-Path $LogDirectory "context-service-$Stamp.stderr.log"
    $Arguments = @(
        '--disable-warning=ExperimentalWarning'
        (Join-Path $ProjectRoot 'src\cli.mjs')
        'serve'
    )

    Add-Content -LiteralPath $SupervisorLog -Value "[$(Get-Date -Format o)] Starting Shadow Agent context service." -Encoding UTF8
    $Process = Start-Process `
        -FilePath $Node `
        -ArgumentList $Arguments `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -Wait `
        -PassThru

    Add-Content `
        -LiteralPath $SupervisorLog `
        -Value "[$(Get-Date -Format o)] Context service exited with code $($Process.ExitCode); restarting in $RestartDelaySeconds seconds." `
        -Encoding UTF8
    Start-Sleep -Seconds $RestartDelaySeconds
}
