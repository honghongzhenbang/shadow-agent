param(
    [string]$DestinationRoot
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
    $DestinationRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'shadow-agent-backups'
}
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupName = "shadow-agent-source-$Stamp"
$StageRoot = Join-Path $DestinationRoot $BackupName
$ArchivePath = "$StageRoot.zip"

$Directories = @(
    'src',
    'desktop',
    'openclaw',
    'scripts',
    'skills',
    'test',
    'config',
    'docs',
    'knowledge'
)
$Files = @(
    '.gitignore',
    'README.md',
    'package.json',
    'package-lock.json'
)

New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
foreach ($Directory in $Directories) {
    $Source = Join-Path $ProjectRoot $Directory
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination $StageRoot -Recurse -Force
    }
}
foreach ($File in $Files) {
    $Source = Join-Path $ProjectRoot $File
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination $StageRoot -Force
    }
}

$Manifest = Get-ChildItem -LiteralPath $StageRoot -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
        $RelativePath = $_.FullName.Substring($StageRoot.Length + 1)
        [pscustomobject]@{
            path = $RelativePath
            size = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
$Manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $StageRoot 'SOURCE-MANIFEST.json') -Encoding utf8

Compress-Archive -LiteralPath $StageRoot -DestinationPath $ArchivePath -CompressionLevel Optimal -Force
$ArchiveHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()

[pscustomobject]@{
    source = $ProjectRoot
    snapshot = $StageRoot
    archive = $ArchivePath
    archiveSha256 = $ArchiveHash
    fileCount = $Manifest.Count
} | ConvertTo-Json -Depth 3
