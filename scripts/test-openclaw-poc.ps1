param(
    [switch]$IncludeModel
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidenceDirectory = Join-Path $OpenClawEvidenceDirectory "model-$timestamp"
New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null
$commandSequence = 0

function Invoke-OpenClawJson([string[]]$Arguments, [string]$OutputName) {
    $script:commandSequence += 1
    $output = & $NodeExecutable $OpenClawNodeEntry @Arguments
    $exitCode = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $evidenceDirectory $OutputName) -Encoding UTF8
    if ($exitCode -ne 0) {
        throw "OpenClaw command failed ($exitCode): $($Arguments -join ' ')"
    }
    return ($output -join [Environment]::NewLine)
}

$healthResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$OpenClawPort/healthz" -TimeoutSec 5
$healthResponse.Content | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'http-health.json') -Encoding UTF8
if ($healthResponse.StatusCode -ne 200) {
    throw "Gateway health check failed: $($healthResponse.StatusCode)"
}

$gatewayOutput = & $NodeExecutable (Join-Path $PSScriptRoot 'test-openclaw-gateway.mjs')
$gatewayExitCode = $LASTEXITCODE
$gatewayText = $gatewayOutput -join [Environment]::NewLine
$gatewayText | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'gateway-integration.json') -Encoding UTF8
if ($gatewayExitCode -ne 0) {
    throw "OpenClaw Gateway integration failed ($gatewayExitCode)."
}
$gateway = $gatewayText | ConvertFrom-Json
if (-not $gateway.passed `
    -or $gateway.cognitiveRouteOutcome -ne 'unresolved_with_next_step' `
    -or $gateway.cognitiveRouteFallback -ne 'update_workboard_and_continue' `
    -or $gateway.externalMessageMode -ne 'authorization_required') {
    throw "OpenClaw Gateway integration returned an invalid V4 contract: $gatewayText"
}

$authReady = $false
if ($IncludeModel) {
    $authText = Invoke-OpenClawJson -Arguments @('models', 'status') -OutputName 'models-status.txt'
    $authReady = $authText -notmatch 'effective=missing|Missing auth'
}

if ($IncludeModel) {
    if (-not $authReady) {
        throw 'Codex OAuth is not ready for the model smoke test.'
    }

    $controllerSessionKey = "agent:main:shadow:codex-progress-smoke-$timestamp"
    $firstMarker = "FIRST-$timestamp"
    $secondMarker = "SECOND-$timestamp"
    $spawnText = Invoke-OpenClawJson -Arguments @(
        'agent',
        '--agent', 'main',
        '--message', "Call sessions_spawn exactly once with runtime subagent, mode run, cleanup keep, context isolated, cwd $ProjectRoot, taskName codex_progress_smoke, and task: Return exactly $firstMarker and do not call tools or modify files. Return only the sessions_spawn tool result as compact JSON. Do not wait or call any other tool.",
        '--session-key', $controllerSessionKey,
        '--thinking', 'off',
        '--timeout', '180',
        '--json'
    ) -OutputName 'codex-progression-spawn.json'
    $spawnResult = $spawnText | ConvertFrom-Json
    $spawnMeta = $spawnResult.result.meta.agentMeta
    $spawnTools = $spawnResult.result.meta.toolSummary
    $spawnPayload = $spawnResult.result.meta.finalAssistantVisibleText | ConvertFrom-Json

    if ($spawnResult.status -ne 'ok' -or $spawnMeta.agentHarnessId -ne 'codex') {
        throw "Native Codex harness spawn failed: $spawnText"
    }
    if ($spawnTools.failures -ne 0 `
        -or $spawnTools.calls -ne 1 `
        -or @($spawnTools.tools) -notcontains 'sessions_spawn' `
        -or $spawnPayload.status -ne 'accepted' `
        -or -not $spawnPayload.childSessionKey `
        -or -not $spawnPayload.runId) {
        throw "The native Codex harness did not create a bounded child session: $spawnText"
    }

    $childSessionKey = [string]$spawnPayload.childSessionKey
    $progressText = Invoke-OpenClawJson -Arguments @(
        'agent',
        '--agent', 'main',
        '--message', "For the already recorded Agent-owned child session $childSessionKey, call sessions_history exactly once with limit 10 and includeTools false. Confirm it contains $firstMarker. Then call sessions_send exactly once to that same child with message 'Return exactly $secondMarker and do not call tools or modify files.' and timeoutSeconds 0 so delivery is queued and the result remains event-driven. Do not call any other tool.",
        '--session-key', $controllerSessionKey,
        '--thinking', 'off',
        '--timeout', '240',
        '--json'
    ) -OutputName 'codex-progression-continuation.json'
    $progressResult = $progressText | ConvertFrom-Json
    $progressMeta = $progressResult.result.meta.agentMeta
    $progressTools = $progressResult.result.meta.toolSummary
    if ($progressResult.status -ne 'ok' `
        -or $progressMeta.agentHarnessId -ne 'codex' `
        -or $progressMeta.sessionId -ne $spawnMeta.sessionId `
        -or $progressTools.failures -ne 0 `
        -or $progressTools.calls -ne 2 `
        -or @($progressTools.tools) -notcontains 'sessions_history' `
        -or @($progressTools.tools) -notcontains 'sessions_send') {
        throw "The controller did not review and continue the same Codex child: $progressText"
    }

    $sessionRegistryPath = Join-Path $OpenClawStateDirectory 'agents\main\sessions\sessions.json'
    $registryEntryText = & $NodeExecutable -e @"
const fs=require('fs');
const registry=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const entry=registry[process.argv[2]];
if(!entry) process.exit(2);
process.stdout.write(JSON.stringify({sessionId:entry.sessionId,compactionCount:entry.compactionCount,totalTokens:entry.totalTokens}));
"@ $sessionRegistryPath $controllerSessionKey
    if ($LASTEXITCODE -ne 0) {
        throw "Controller session registry entry is missing for $controllerSessionKey"
    }
    $registryEntry = $registryEntryText | ConvertFrom-Json
    if ($registryEntry.sessionId -ne $spawnMeta.sessionId) {
        throw "Controller session registry and model result disagree: $registryEntryText"
    }

    $historyEvidencePath = Join-Path $evidenceDirectory 'codex-progression-child-history.json'
    $progressProofText = & $NodeExecutable (Join-Path $PSScriptRoot 'verify-openclaw-codex-progression.mjs') `
        $controllerSessionKey $childSessionKey $firstMarker $secondMarker $historyEvidencePath
    if ($LASTEXITCODE -ne 0) {
        throw "Codex child progression history verification failed: $($progressProofText -join [Environment]::NewLine)"
    }
    $progressProof = ($progressProofText -join [Environment]::NewLine) | ConvertFrom-Json
}

$summary = [ordered]@{
    passed = $true
    testedAt = (Get-Date).ToString('o')
    gatewayPort = $OpenClawPort
    contextPlugin = 'passed'
    workFocus = 'passed'
    cognitiveRouting = 'passed'
    contextQueryMs = $gateway.contextQueryMs
    cognitiveRouteMs = $gateway.cognitiveRouteMs
    legacyToolsAbsent = $true
    workboardRead = 'passed'
    codexOAuth = if ($IncludeModel) {
        if ($authReady) { 'ready' } else { 'pending' }
    } else { 'not-checked' }
    modelSmoke = if ($IncludeModel) { 'passed' } else { 'skipped' }
    codexProgression = if ($IncludeModel) {
        [ordered]@{
            status = 'passed'
            controllerSessionKey = $controllerSessionKey
            controllerSessionId = $spawnMeta.sessionId
            childSessionKey = $childSessionKey
            childRunId = $spawnPayload.runId
            model = $progressProof.model
            firstMarker = $progressProof.firstMarker
            secondMarker = $progressProof.secondMarker
            continuationSource = $progressProof.continuationSource
            verificationAttempts = $progressProof.verificationAttempts
            firstTurnPromptTokens = $spawnMeta.promptTokens
            secondTurnPromptTokens = $progressMeta.promptTokens
            compactionCount = $registryEntry.compactionCount
        }
    } else { 'skipped' }
    evidenceDirectory = $evidenceDirectory
}
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'summary.json') -Encoding UTF8
$summary | ConvertTo-Json -Depth 10
