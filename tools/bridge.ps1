# Squish Bridge - run the bridge server in the background (v0.5).
# The bridge must be up for pairing and driving; this keeps it off your
# terminal with a log and a pidfile, honoring SQUISH_BRIDGE_* env as usual.
# Usage: powershell -ExecutionPolicy Bypass -File tools/bridge.ps1 start|stop|restart|status

param([string]$Action = "status")

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Bridge = Join-Path $Root "bridge"
$PidFile = Join-Path $Bridge "bridge.pid"
$LogFile = Join-Path $Bridge "bridge.log"
$Port = if ($env:SQUISH_BRIDGE_PORT) { [int]$env:SQUISH_BRIDGE_PORT } else { 3031 }

function Test-BridgePort {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
  } catch {
    return $null
  }
}

function Get-RecordedPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -Raw).Trim()
  $pidNum = 0
  if (-not [int]::TryParse($raw, [ref]$pidNum)) { return $null }
  try {
    $p = Get-Process -Id $pidNum -ErrorAction Stop
    if ($p.ProcessName -eq "node") { return $pidNum }
    return $null
  } catch {
    return $null
  }
}

function Start-Bridge {
  $existing = Get-RecordedPid
  if ($existing) {
    Write-Host "Bridge already running (pid $existing)."
    Show-Status
    return
  }
  if (Test-BridgePort) {
    Write-Host "Port $Port already answers but no pidfile exists - a bridge started by hand is holding it. Stop that one first."
    exit 1
  }
  $proc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Bridge `
    -RedirectStandardOutput $LogFile -WindowStyle Hidden -PassThru
  Set-Content -Path $PidFile -Value $proc.Id -NoNewline
  Start-Sleep -Milliseconds 2000
  $health = Test-BridgePort
  if (-not $health) {
    Write-Host "Bridge (pid $($proc.Id)) did not answer on port $Port. Log tail:"
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 10 }
    exit 1
  }
  Write-Host "Bridge running (pid $($proc.Id), v$($health.version)). Log: $LogFile"
  if (Test-Path $LogFile) { Get-Content $LogFile | Select-String -Pattern "pairs at|dials at|trusts" }
}

function Stop-Bridge {
  $pidNum = Get-RecordedPid
  if (-not $pidNum) {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    if (Test-BridgePort) {
      Write-Host "Port $Port answers but no recorded pid - a hand-started bridge is holding it. Stop that terminal instead."
      exit 1
    }
    Write-Host "Bridge is not running."
    return
  }
  Stop-Process -Id $pidNum -Force
  Remove-Item $PidFile -Force
  Write-Host "Bridge stopped (was pid $pidNum)."
}

function Show-Status {
  $pidNum = Get-RecordedPid
  $health = Test-BridgePort
  if ($pidNum) { Write-Host "pid: $pidNum (node alive)" } else { Write-Host "pid: none recorded" }
  if ($health) {
    Write-Host "port ${Port}: answering (v$($health.version))"
    try {
      $st = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/status" -TimeoutSec 3
      if ($st.addrs) { Write-Host ("agent dials at: " + (($st.addrs | ForEach-Object { "ws://${_}:$Port" }) -join ", ")) }
      Write-Host "devices: $($st.devices), connected: $($st.connected.Count)"
    } catch {
      # /health answered; status is a bonus.
    }
  } else {
    Write-Host "port ${Port}: not answering"
  }
}

switch ($Action.ToLower()) {
  "start" { Start-Bridge }
  "stop" { Stop-Bridge }
  "restart" { Stop-Bridge; Start-Bridge }
  "status" { Show-Status }
  default { Write-Host "Usage: tools/bridge.ps1 start|stop|restart|status"; exit 1 }
}
