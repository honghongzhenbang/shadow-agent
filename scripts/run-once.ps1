$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot
try {
    & node --disable-warning=ExperimentalWarning '.\src\cli.mjs' patrol
    if ($LASTEXITCODE -ne 0) {
        throw "Shadow Agent patrol failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
