param(
    [Parameter(Mandatory = $true)][string]$Python311,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [switch]$DownloadModel
)
$ErrorActionPreference = 'Stop'
$Python311 = (Resolve-Path -LiteralPath $Python311).Path
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'venv')) {
    throw 'Use a new dedicated runtime directory; reuse an existing validated environment by configuration instead.'
}
& $Python311 -I -c "import sys; assert sys.version_info[:2] == (3,11), 'CPython 3.11 required'"
if ($LASTEXITCODE -ne 0) { throw 'Python version check failed' }
& $Python311 -I -m venv (Join-Path $RuntimeRoot 'venv')
if ($LASTEXITCODE -ne 0) { throw 'Environment creation failed' }
$Python = Join-Path $RuntimeRoot 'venv/Scripts/python.exe'
& $Python -I -m pip install --index-url https://download.pytorch.org/whl/cu126 'torch==2.10.0+cu126' 'torchaudio==2.10.0+cu126'
if ($LASTEXITCODE -ne 0) { throw 'CUDA wheel installation failed' }
& $Python -I -m pip install --index-url https://pypi.org/simple 'transformers==5.17.0' 'accelerate==1.11.0' 'numpy==1.26.4' 'soundfile==0.13.1' 'psutil==7.1.0' 'librosa==0.11.0' 'huggingface-hub==1.30.0'
if ($LASTEXITCODE -ne 0) { throw 'Fun dependencies failed' }
& $Python -I -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Dependency consistency failed' }
& $Python -I -m pip freeze | Out-File -LiteralPath (Join-Path $RuntimeRoot 'requirements.resolved.txt') -Encoding utf8
if ($DownloadModel) {
    & $Python -I -c "from huggingface_hub import snapshot_download; import sys; snapshot_download('FunAudioLLM/Fun-ASR-Nano-2512-hf',revision='d93b302ee7fd505e1b3576120fc142fc6f7820e1',local_dir=sys.argv[1])" (Join-Path $RuntimeRoot 'model')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned model download failed' }
}
Write-Output 'Installed only. Run the offline transcription/isolated ingestion acceptance before enabling Fun.'
