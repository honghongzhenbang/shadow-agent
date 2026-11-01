param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$OpenClawStateDirectory
)

$ErrorActionPreference = 'Stop'

$linkPath = Join-Path $ProjectRoot 'tools\codex-managed-current'
$linkedExecutable = Join-Path $linkPath 'bin\codex.exe'

$projectsRoot = Join-Path $OpenClawStateDirectory 'npm\projects'
$candidateRoots = @(
    Get-ChildItem -LiteralPath $projectsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'openclaw-codex-*' } |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object {
            Join-Path $_.FullName 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'
            Join-Path $_.FullName 'node_modules\@openclaw\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc'
        }
)

$targetRoot = $candidateRoots |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\codex.exe') } |
    Select-Object -First 1
if (-not $targetRoot) {
    throw 'Managed Windows Codex executable was not found. Install @openclaw/codex dependencies first.'
}

if (Test-Path -LiteralPath $linkPath) {
    $existing = Get-Item -LiteralPath $linkPath -Force
    if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "The short-path location exists and is not a junction: $linkPath"
    }
    $existingTarget = [IO.Path]::GetFullPath([string]$existing.Target)
    $requiredTarget = [IO.Path]::GetFullPath([string]$targetRoot)
    if ($existingTarget -ne $requiredTarget) {
        Remove-Item -LiteralPath $linkPath -Force
    }
}

if (-not (Test-Path -LiteralPath $linkPath)) {
    New-Item -ItemType Junction -Path $linkPath -Target $targetRoot | Out-Null
}

$versionText = (& $linkedExecutable --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Codex short-path validation failed: $linkedExecutable"
}
if ($versionText -notmatch '(\d+\.\d+\.\d+)') {
    throw "Codex short-path returned an unrecognized version: $versionText"
}
$codexVersion = [version]$Matches[1]
if ($codexVersion -lt [version]'0.149.0') {
    throw "Codex app-server 0.149.0 or newer is required, detected $codexVersion"
}

Write-Output "Codex app-server short path is ready: $linkedExecutable ($codexVersion)"
