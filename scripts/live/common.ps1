# Shared helpers for the live-server ops scripts. Dot-source from a sibling script:
#   . (Join-Path $PSScriptRoot 'common.ps1')
# Compatible with Windows PowerShell 5.1 (the scheduled task runs powershell.exe).

function Get-FactoryRoot {
  # Directory the repo and its sibling checkouts (markdoc-live, markdoc-data) live in.
  # $env:FACTORY_ROOT if set, else the parent of the repo root. This file is <repo>\scripts\live\common.ps1,
  # so the repo root is two levels up and the factory root three. Twin of scripts/lib/factory-root.mjs.
  if ($env:FACTORY_ROOT) { return (Resolve-Path -LiteralPath $env:FACTORY_ROOT).Path }
  $repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  return (Split-Path $repoRoot -Parent)
}

function Write-Step {
  param([string]$Message)
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

function Get-LiveHealth {
  # Returns the parsed /api/health body on HTTP 200, otherwise $null.
  param([int]$Port)
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/health" -TimeoutSec 5
    if ($resp.StatusCode -eq 200) { return ($resp.Content | ConvertFrom-Json) }
  } catch {
    $null = $_  # connection refused / timeout while starting is expected
  }
  return $null
}

function Get-LiveProcesses {
  # node.exe processes whose command line mentions the live worktree folder name.
  param([string]$Root)
  $marker = Split-Path -Leaf $Root
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$marker*" }
}

function Stop-LiveProcesses {
  param([string]$Root)
  $procs = @(Get-LiveProcesses -Root $Root)
  if ($procs.Count -eq 0) { Write-Step "no stale node processes for $(Split-Path -Leaf $Root)"; return }
  foreach ($p in $procs) {
    Write-Step "stopping node PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  # Give the port a moment to be released.
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline -and @(Get-LiveProcesses -Root $Root).Count -gt 0) { Start-Sleep -Milliseconds 250 }
}

function Remove-NextCache {
  param([string]$Root)
  $next = Join-Path $Root '.next'
  if (Test-Path $next) {
    Write-Step "deleting $next"
    Remove-Item -LiteralPath $next -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Show-LogTail {
  param([string]$LogPath, [int]$Lines = 30)
  if (Test-Path $LogPath) {
    Write-Host "---- last $Lines lines of $LogPath ----"
    Get-Content -LiteralPath $LogPath -Tail $Lines
    Write-Host '----'
  } else {
    Write-Host "(no log at $LogPath)"
  }
}
