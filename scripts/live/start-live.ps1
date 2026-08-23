# Idempotent start of Burke's live test server (http://localhost:3000).
# - If /api/health already answers 200: exit 0, touch nothing.
# - Otherwise: kill stale node processes from the live worktree, delete .next,
#   start `npm run dev` hidden with output appended to the log, wait for 200.
# Exit 0 on healthy, 1 on timeout (prints the log tail).
param(
  [string]$Root = 'C:\Dev\ai-experiments\FACTORY\markdoc-live',
  [int]$Port = 3000,
  [string]$LogPath = 'C:\Dev\ai-experiments\FACTORY\markdoc-data\live.log',
  [int]$TimeoutSec = 180,
  # Skip the "already healthy" short-circuit and always restart (used by promote.ps1).
  [switch]$Restart
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $Restart) {
  $health = Get-LiveHealth -Port $Port
  if ($health) {
    Write-Step "already healthy on :$Port (db=$($health.db) collab=$($health.collab)); nothing to do"
    exit 0
  }
}

if (-not (Test-Path (Join-Path $Root 'package.json'))) {
  Write-Step "no package.json in $Root"
  exit 1
}

Stop-LiveProcesses -Root $Root
Remove-NextCache -Root $Root

$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if ((Test-Path $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 20MB) {
  $rotated = "$LogPath.1"
  Write-Step "rotating $LogPath -> $rotated"
  Move-Item -LiteralPath $LogPath -Destination $rotated -Force
}
Add-Content -LiteralPath $LogPath -Value ("==== start-live {0} root={1} port={2} ====" -f (Get-Date -Format 's'), $Root, $Port)

$env:PORT = "$Port"
# cmd.exe handles appending both streams to one file; Start-Process alone cannot.
$cmdLine = '/d /c "npm run dev >> "' + $LogPath + '" 2>&1"'
Write-Step "starting 'npm run dev' in $Root (log: $LogPath)"
$proc = Start-Process -FilePath "$env:ComSpec" -ArgumentList $cmdLine -WorkingDirectory $Root -WindowStyle Hidden -PassThru
Write-Step "launcher PID $($proc.Id)"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $health = Get-LiveHealth -Port $Port
  if ($health) {
    $pids = @(Get-LiveProcesses -Root $Root | ForEach-Object { $_.ProcessId }) -join ','
    Write-Step "healthy on :$Port (db=$($health.db) collab=$($health.collab)) node PIDs: $pids"
    exit 0
  }
  if ($proc.HasExited) {
    Write-Step "launcher exited early with code $($proc.ExitCode)"
    break
  }
}

Write-Step "server did not answer 200 on /api/health within ${TimeoutSec}s"
Show-LogTail -LogPath $LogPath -Lines 30
exit 1
