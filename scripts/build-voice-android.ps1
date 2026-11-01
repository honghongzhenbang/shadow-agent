param([switch]$Release, [switch]$Test, [switch]$Instrumentation)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$chain = Join-Path $env:USERPROFILE '.codex/toolchains'
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Join-Path $chain 'jdk-17' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $chain 'android-sdk' }
$gradle = Join-Path $chain 'gradle-8.13/bin/gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { throw 'Set up JDK 17, Android SDK 36 and Gradle 8.13; see mobile/android/README.md.' }
$tasks = @('assembleDebug')
if ($Test) { $tasks += @('testDebugUnitTest', 'lintDebug') }
if ($Instrumentation) { $tasks += 'assembleDebugAndroidTest' }
if ($Release) {
    if (-not $env:VOICE_KEYSTORE -or -not $env:VOICE_KEY_PASSWORD) { throw 'Release requires a private signing keystore and password in the environment.' }
    $tasks = @('assembleRelease')
}
& $gradle -p (Join-Path $root 'mobile/android') --no-daemon --console=plain @tasks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
