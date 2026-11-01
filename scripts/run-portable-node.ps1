param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$NodeArguments
)

. (Join-Path $PSScriptRoot 'openclaw-poc-env.ps1')

if (-not $NodeArguments -or $NodeArguments.Count -eq 0) {
    throw 'At least one Node script or argument is required.'
}

& $NodeExecutable @NodeArguments
exit $LASTEXITCODE
