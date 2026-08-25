# Idempotent start of Burke's live test server (http://localhost:3000).
# - If /api/health already answers 200: exit 0, touch nothing.
# - Otherwise: kill stale node processes from the live worktree, delete .next,
#   start `npm run dev` hidden with output appended to the log, wait for ok:true,db:true.
#   While waiting, "connection refused" and any 5xx count as "still starting" (a cold Next.js
#   server compiles on the first hit and may answer 500 meanwhile); the wait is at least
#   -MinWaitSec, at most -TimeoutSec, and ends early only if the launcher process exits.
# Exit 0 on healthy, 1 otherwise (prints a "NOT HEALTHY: <reason>" line and the log tail).
param(
  # Live worktree; defaults to the sibling ../markdoc-live (see Get-FactoryRoot in common.ps1).
  [string]$Root,
  [int]$Port = 3000,
  # Defaults to ../markdoc-data/live.log next to the repo.
  [string]$LogPath,
  [int]$TimeoutSec = 180,
  # Never give up on a still-running server before this many seconds, whatever -TimeoutSec says.
  [int]$MinWaitSec = 90,
  # Skip the "already healthy" short-circuit and always restart (used by promote.ps1).
  [switch]$Restart
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) { $Root = Join-Path (Get-FactoryRoot) 'markdoc-live' }
if (-not $LogPath) { $LogPath = Join-Path (Get-FactoryRoot) 'markdoc-data\live.log' }

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

$result = Wait-LiveStartup -Port $Port -TimeoutSec $TimeoutSec -MinWaitSec $MinWaitSec -Process $proc -LogPath $LogPath
if ($result.Healthy) {
  $health = $result.Health
  $pids = @(Get-LiveProcesses -Root $Root | ForEach-Object { $_.ProcessId }) -join ','
  Write-Step "healthy on :$Port after $($result.Elapsed)s (db=$($health.db) collab=$($health.collab)) node PIDs: $pids"
  exit 0
}

# promote.ps1 reads this line for its rollback reason; keep the "NOT HEALTHY:" prefix.
Write-Step "NOT HEALTHY: $($result.Reason)"
Show-LogTail -LogPath $LogPath -Lines 30
exit 1
