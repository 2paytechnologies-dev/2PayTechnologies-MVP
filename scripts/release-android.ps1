# Builds the signed merchant APK and publishes it to the website's download page.
#   powershell -ExecutionPolicy Bypass -File scripts/release-android.ps1
# Needs the toolchain and signing key in ~/.2pay-android (see android/app/build.gradle). Then commit + push so Vercel serves it.
param(
  [string]$MinVersion = "2.0.0",
  [string]$Notes = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$home2pay = Join-Path $env:USERPROFILE ".2pay-android"
$env:JAVA_HOME = Join-Path $home2pay "tools\jdk17"
$env:ANDROID_HOME = Join-Path $home2pay "tools\android-sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

$gradle = Get-Content (Join-Path $root "android\app\build.gradle") -Raw
if ($gradle -notmatch "versionName '([^']+)'") { throw "versionName not found in build.gradle" }
$version = $Matches[1]

Push-Location (Join-Path $root "android")
try { & .\gradlew.bat testDebugUnitTest assembleRelease --no-daemon --console=plain; if ($LASTEXITCODE -ne 0) { throw "gradle failed" } } finally { Pop-Location }

$built = Join-Path $root "android\app\build\outputs\apk\release\app-release.apk"
$bt = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") | Sort-Object Name | Select-Object -Last 1
$verify = & (Join-Path $bt.FullName "apksigner.bat") verify --print-certs $built | Out-String
if ($verify -notmatch "Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})") { throw "APK is not signed" }
Write-Host "Signed by $($Matches[1])"

$name = "2pay-merchant-$version.apk"
$dist = Join-Path $root "android\dist"; New-Item -ItemType Directory -Force $dist | Out-Null
$pub = Join-Path $root "public\downloads"; New-Item -ItemType Directory -Force $pub | Out-Null
Copy-Item $built (Join-Path $dist $name) -Force
Copy-Item $built (Join-Path $pub $name) -Force

$hash = (Get-FileHash (Join-Path $pub $name) -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item (Join-Path $pub $name)).Length
$json = [ordered]@{ version = $version; minVersion = $MinVersion; apk = "/downloads/$name"; notes = $Notes; sha256 = $hash; size = $size } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $pub "latest.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Published $name ($size bytes, sha256 $hash). Commit public/downloads and push to release it."
