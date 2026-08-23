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

function Wait-LiveHealth {
  # Polls /api/health once a second until it answers 200 with db=true or $TimeoutSec passes. Returns the
  # last body ($null when nothing ever answered). A cold Next.js server compiles the route on the first
  # hit and can take well over Get-LiveHealth's 5 s on that request, so a single probe is not enough.
  param([int]$Port, [int]$TimeoutSec = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $health = $null
  while ($true) {
    $health = Get-LiveHealth -Port $Port
    if ($health -and $health.db -eq $true) { return $health }
    if ((Get-Date) -ge $deadline) { return $health }
    Start-Sleep -Seconds 1
  }
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

function Read-EnvFile {
  # KEY=value lines of a dotenv file as a hashtable (comments and blanks skipped, quotes stripped).
  param([string]$Path)
  $vars = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $vars }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $value = $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    $vars[$key] = $value
  }
  return $vars
}

function Resolve-BackupToken {
  # -Token, else $env:BACKUP_TOKEN, else BACKUP_TOKEN= from <Root>\.env.local.
  param([string]$Token, [string]$Root)
  if ($Token) { return $Token }
  if ($env:BACKUP_TOKEN) { return $env:BACKUP_TOKEN }
  $vars = Read-EnvFile -Path (Join-Path $Root '.env.local')
  if ($vars.ContainsKey('BACKUP_TOKEN')) { return $vars['BACKUP_TOKEN'] }
  return $null
}

function Get-RandomSecret {
  # 32 random bytes as base64url (no padding): fits AUTH_SECRET and BACKUP_TOKEN.
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-BackupMeta {
  # { documents, users } from GET /api/admin/backup?meta=1, or $null.
  param([int]$Port, [string]$Token)
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/admin/backup?meta=1" `
      -Headers @{ 'X-Backup-Token' = $Token } -TimeoutSec 30
    if ($resp.StatusCode -eq 200) { return ($resp.Content | ConvertFrom-Json) }
  } catch {
    $null = $_
  }
  return $null
}

function Get-DocumentsAsDevUser {
  # Signs in with the development login (csrf -> /api/auth/callback/dev) and returns the parsed
  # GET /api/documents body, or $null on any failure. Same dance as scripts/smoke.mts.
  param([int]$Port, [string]$Login = 'resume-check')
  $base = "http://localhost:$Port"
  try {
    $csrf = Invoke-RestMethod -UseBasicParsing -Uri "$base/api/auth/csrf" -SessionVariable session -TimeoutSec 30
    $form = @{ csrfToken = $csrf.csrfToken; login = $Login; redirect = 'false' }
    # The callback answers 302; pwsh 7 throws on that with -MaximumRedirection 0, 5.1 does not. The
    # session cookie is in $session either way.
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/auth/callback/dev" -Method Post -Body $form `
        -WebSession $session -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction SilentlyContinue
    } catch { $null = $_ }
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/documents" -WebSession $session -TimeoutSec 30
    if ($resp.StatusCode -eq 200) { return ($resp.Content | ConvertFrom-Json) }
  } catch {
    $null = $_
  }
  return $null
}

