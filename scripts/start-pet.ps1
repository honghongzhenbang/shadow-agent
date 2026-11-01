$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Electron = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$Main = Join-Path $ProjectRoot 'desktop\main.mjs'
$TaskRunner = "$env:SystemRoot\System32\schtasks.exe"
$OpenClawDisabledFile = Join-Path $ProjectRoot 'runtime\openclaw-poc\gateway.disabled'
$ShutdownRequestFile = Join-Path $ProjectRoot 'runtime\shutdown.requested'

if (-not (Test-Path -LiteralPath $Electron)) {
    throw "Electron is not installed. Run npm install in $ProjectRoot first."
}

Remove-Item -LiteralPath $OpenClawDisabledFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ShutdownRequestFile -Force -ErrorAction SilentlyContinue

foreach ($taskName in @('PersonalShadowAgentContextService', 'PersonalShadowAgentOpenClaw')) {
    Start-Process `
        -FilePath $TaskRunner `
        -ArgumentList @('/Run', '/TN', "`"$taskName`"") `
        -WindowStyle Hidden `
        -ErrorAction SilentlyContinue | Out-Null
}

& $Electron $Main
exit $LASTEXITCODE
