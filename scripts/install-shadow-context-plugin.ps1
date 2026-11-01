$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $ProjectRoot 'openclaw\shadow-work'
$Target = Join-Path $ProjectRoot 'runtime\openclaw-poc\state\extensions\shadow-work'
$SharedSource = Join-Path $ProjectRoot 'src\knowledge-policy.mjs'
$SharedTarget = Join-Path $ProjectRoot 'runtime\openclaw-poc\state\src\knowledge-policy.mjs'

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Shadow Context plugin source not found: $Source"
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Source 'src') -Destination $Target -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Source 'openclaw.plugin.json') -Destination $Target -Force
Copy-Item -LiteralPath (Join-Path $Source 'package.json') -Destination $Target -Force
New-Item -ItemType Directory -Path (Split-Path -Parent $SharedTarget) -Force | Out-Null
Copy-Item -LiteralPath $SharedSource -Destination $SharedTarget -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src\task-progress-plan.mjs') -Destination (Join-Path (Split-Path -Parent $SharedTarget) 'task-progress-plan.mjs') -Force
foreach ($Module in @('user-profile-view.mjs', 'context-delivery.mjs', 'utils.mjs', 'graph-model.mjs',
    'task-owner.mjs', 'work-sessions.mjs', 'information-delivery.mjs', 'active-information.mjs', 'operation-delivery-view.mjs')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot "src\$Module") -Destination (Join-Path (Split-Path -Parent $SharedTarget) $Module) -Force
}
Write-Output "Shadow Context plugin installed: $Target"
