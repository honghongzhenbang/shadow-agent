param(
    [string]$RuntimeRoot = 'runtime/voice-diarization',
    [string]$Python = 'D:/anaconda/python.exe',
    [ValidateSet('cuda','vulkan')][string]$Backend = 'cuda'
)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($RuntimeRoot)
New-Item -ItemType Directory -Path $root -Force | Out-Null
$binary = if ($Backend -eq 'cuda') {
    @{ Name='nemo-speech-0.2.0-windows-x86_64-cuda.zip'; Size=102183465; Hash='9ffe5e842c39a7d3211f3b2c3b3aa1bca8c0b2455d96d961ed5f22ec5108f98d'; Url='https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-cuda.zip' }
} else {
    @{ Name='nemo-speech-0.2.0-windows-x86_64-vulkan.zip'; Size=19302464; Hash='edf15a04ba98740aa0ab75ae4681ac7ad0a488b22b35ce2cbebd10590bb1c1e1'; Url='https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-vulkan.zip' }
}
$items = @(
    $binary,
    @{ Name='Nemotron-3-Diarization.q8_0.gguf'; Size=107012128; Hash='08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1'; Url='https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/f667ed73aee57d40cc39428eb768b4fd87a0a29e/Nemotron-3-Diarization.q8_0.gguf' }
)
foreach ($item in $items) {
    $target = Join-Path $root $item.Name
    if (!(Test-Path -LiteralPath $target)) {
        & $Python (Join-Path $PSScriptRoot 'download_artifact.py') $item.Url $target $item.Size $item.Hash
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($item.Name)" }
    }
    if ((Get-Item -LiteralPath $target).Length -ne $item.Size -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.Hash) {
        throw "Existing artifact failed integrity check: $($item.Name)"
    }
}
$archive = Join-Path $root $items[0].Name
$destination = Join-Path $root $(if ($Backend -eq 'cuda') {'native'} else {'native-vulkan'})
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $zip.Entries) {
        $resolved = [System.IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
        if (!$resolved.StartsWith("$destination\", [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
    }
} finally { $zip.Dispose() }
if (!(Test-Path -LiteralPath $destination)) { Expand-Archive -LiteralPath $archive -DestinationPath $destination }
$items | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $root "artifacts-$Backend.json")
Get-ChildItem -LiteralPath $destination -Recurse -Filter 'nemo-speech.exe' | Select-Object FullName
