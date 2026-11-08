# Squish Bridge - pack the extension for Chrome (M5).
# Produces dist/squish-bridge-<version>.zip containing extension/ exactly
# as it loads unpacked. Chrome extensions are not compiled; the zip is the
# release artifact (and the sideload source if you unzip it instead).
# Usage: powershell -ExecutionPolicy Bypass -File tools/pack.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $Root "extension/manifest.json"))) { $Root = (Get-Location).Path }

$Manifest = Get-Content (Join-Path $Root "extension/manifest.json") -Raw | ConvertFrom-Json
$Version = $Manifest.version
$Dist = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$Zip = Join-Path $Dist ("squish-bridge-" + $Version + ".zip")
if (Test-Path $Zip) { Remove-Item $Zip }

Write-Host "Validating..."
node (Join-Path $Root "tools/validate.js")
if ($LASTEXITCODE -ne 0) { throw "validate.js failed. Fix the problems above before packing." }

Write-Host ("Packing " + $Zip + " ...")
Compress-Archive -Path (Join-Path $Root "extension/*") -DestinationPath $Zip
$Size = (Get-Item $Zip).Length
Write-Host ("Packed " + $Zip + " (" + $Size + " bytes).")
Write-Host "Load it via chrome://extensions, Developer mode, Load unpacked (unzip first)."
