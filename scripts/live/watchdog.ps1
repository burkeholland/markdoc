# Restart Burke's live test server when it dies silently (task #614, after the 15:42 outage where :3000
# stopped answering with nothing in live.log and stayed down until the next promote). Runs every minute
# as the per-user Scheduled Task "Markdoc watchdog" (install-autostart.ps1); one probe per run:
#   GET /api/health on :$Port with a 10 s timeout
#   200                      -> reset the miss counter; if the last run restarted the server, log
#                               "<ts> ok after restart in N s"
#   anything else / refused  -> one miss; on the SECOND miss in a row call start-live.ps1 (idempotent:
#                               it does nothing when the server is back by then) and log
#                               "<ts> down -> restarted" (or "down -> restart FAILED: <reason>")
# It never restarts while a promote is running: promote.ps1 holds ..\markdoc-data\promote.lock for its
# duration and the watchdog skips while that file exists and is younger than -LockMaxAgeMin (an older one
# is a crashed promote and is ignored). It also skips while the newest `==== start-live` marker in the log
# is younger than -StartGraceSec, so a cold start (90 s of "connection refused" is normal) is not mistaken
# for a death. State: ..\markdoc-data\watchdog.state (JSON); log: ..\markdoc-data\watchdog.log, one line
# per event only (nothing on a healthy tick). Exit 0 always unless the restart failed (1).
#   .\watchdog.ps1                                      real server (:3000, live.json's worktree, ..\markdoc-data)
#   .\watchdog.ps1 -Root <copy> -Port 3993 -DataRoot <tmp>   test copy; touches nothing of the live server
# Windows PowerShell 5.1 compatible (the scheduled task runs powershell.exe).
param(
  # Live worktree; defaults to live.json's root, else the sibling ../markdoc-live (see Get-LiveRoot in common.ps1).
  [string]$Root,
  [int]$Port = 3000,
  # Folder with live.json, live.log / live-b.log, watchdog.log, watchdog.state and promote.lock; defaults to ../markdoc-data.
  [string]$DataRoot,
  [int]$TimeoutSec = 10,
  # Misses in a row before start-live.ps1 is called.
  [int]$Misses = 2,
  # A promote.lock older than this is a leftover of a crashed promote and no longer blocks a restart.
  [int]$LockMaxAgeMin = 10,
  # No restart while the newest `==== start-live` marker in live.log is younger than this.
  [int]$StartGraceSec = 180,
  # Passed through to start-live.ps1.
  [int]$StartTimeoutSec = 180,
  [int]$StartMinWaitSec = 90
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $DataRoot) { $DataRoot = Join-Path (Get-FactoryRoot) 'markdoc-data' }
$DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot)
if (-not $Root) { $Root = Get-LiveRoot -DataRoot $DataRoot }
$liveLog = Get-LiveLogPath -Root $Root -DataRoot $DataRoot
$watchdogLog = Join-Path $DataRoot 'watchdog.log'
$statePath = Join-Path $DataRoot 'watchdog.state'
$lockPath = Join-Path $DataRoot 'promote.lock'
$startLive = Join-Path $PSScriptRoot 'start-live.ps1'

function Write-WatchdogLog {
  param([string]$Message)
  if (-not (Test-Path -LiteralPath $DataRoot)) { New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null }
  $line = "{0} {1}" -f (Get-Date -Format 's'), $Message
  Add-Content -LiteralPath $watchdogLog -Value $line
  Write-Step $line
}

function Read-State {
  # @{ misses = <int>; downSince = <ISO string or ''>; restartedAt = <ISO string or ''> }
  $state = @{ misses = 0; downSince = ''; restartedAt = '' }
  if (-not (Test-Path -LiteralPath $statePath)) { return $state }
  try {
    $json = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($json.misses) { $state.misses = [int]$json.misses }
    if ($json.downSince) { $state.downSince = "$($json.downSince)" }
    if ($json.restartedAt) { $state.restartedAt = "$($json.restartedAt)" }
  } catch { $null = $_ }
  return $state
}

function Save-State {
  param([hashtable]$State)
  if (-not (Test-Path -LiteralPath $DataRoot)) { New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null }
  Set-Content -LiteralPath $statePath -Value ($State | ConvertTo-Json -Compress) -Encoding UTF8
}

function Get-LastStartMarkerAge {
  # Seconds since the newest `==== start-live <ts>` marker in the log, or $null when there is none.
  if (-not (Test-Path -LiteralPath $liveLog)) { return $null }
  $tail = @(Get-Content -LiteralPath $liveLog -Tail 400 -ErrorAction SilentlyContinue)
  $marker = @($tail | Where-Object { $_ -like '==== start-live *' } | Select-Object -Last 1)
  if ($marker.Count -eq 0) { return $null }
  if ($marker[0] -match '^==== start-live (\S+)') {
    try { return [int]((Get-Date) - [datetime]::Parse($Matches[1])).TotalSeconds } catch { return $null }
  }
  return $null
}

# 1. A promote is running: its own start-live.ps1 handles the server. Never race it.
if (Test-Path -LiteralPath $lockPath) {
  $lockAgeMin = ((Get-Date) - (Get-Item -LiteralPath $lockPath).LastWriteTime).TotalMinutes
  if ($lockAgeMin -lt $LockMaxAgeMin) {
    Write-Step ("promote.lock is {0:n1} min old (< {1}); promote in progress, skipping" -f $lockAgeMin, $LockMaxAgeMin)
    exit 0
  }
  Write-Step ("promote.lock is {0:n1} min old (>= {1}); stale, ignoring it" -f $lockAgeMin, $LockMaxAgeMin)
}

$state = Read-State
$probe = Get-LiveHealthProbe -Port $Port -TimeoutSec $TimeoutSec

# 2. Healthy: nothing to do, except closing the loop on a restart this watchdog made.
if ($probe.Status -eq 200) {
  if ($state.restartedAt) {
    $since = try { [int]((Get-Date) - [datetime]::Parse($state.downSince)).TotalSeconds } catch { -1 }
    Write-WatchdogLog "ok after restart in $since s"
  } elseif ($state.misses -gt 0) {
    Write-Step "ok again after $($state.misses) miss(es); no restart was needed"
  }
  if ($state.misses -gt 0 -or $state.restartedAt) { Save-State @{ misses = 0; downSince = ''; restartedAt = '' } }
  exit 0
}

# 3. Not healthy. A fresh start (by the logon task, a promote that just released its lock, or this
# watchdog one minute ago) is still compiling; give it its grace period before counting misses.
$startAge = Get-LastStartMarkerAge
if ($null -ne $startAge -and $startAge -lt $StartGraceSec) {
  Write-Step "no 200 from :$Port (status $($probe.Status)) but the last start-live marker is ${startAge}s old (< $StartGraceSec); still starting, skipping"
  exit 0
}

$state.misses = $state.misses + 1
if (-not $state.downSince) { $state.downSince = (Get-Date -Format 's') }
$why = if ($probe.Status -eq 0) { "no answer ($($probe.Error))" } else { "HTTP $($probe.Status)" }
if ($state.misses -lt $Misses) {
  Save-State $state
  Write-Step "miss $($state.misses)/$Misses on :$Port ($why); restart on the next miss"
  exit 0
}

# 4. Second miss in a row: restart. start-live.ps1 is idempotent (exit 0, touch nothing, if it is back).
Write-Step "miss $($state.misses)/$Misses on :$Port ($why); calling start-live.ps1"
$ErrorActionPreference = 'Continue'
$out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startLive -Root $Root -Port $Port -LogPath $liveLog `
  -TimeoutSec $StartTimeoutSec -MinWaitSec $StartMinWaitSec 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$out | Out-Host
$elapsed = try { [int]((Get-Date) - [datetime]::Parse($state.downSince)).TotalSeconds } catch { -1 }
if ($code -eq 0) {
  Write-WatchdogLog "down -> restarted (start-live.ps1 ok, $elapsed s after the first miss)"
  Save-State @{ misses = 0; downSince = $state.downSince; restartedAt = (Get-Date -Format 's') }
  exit 0
}
$reasonLine = @($out | Where-Object { $_ -match 'NOT HEALTHY: (.*)$' } | Select-Object -Last 1)
$reason = if ($reasonLine.Count -gt 0) { ($reasonLine[0] -replace '^.*NOT HEALTHY: ', '') } else { "start-live.ps1 exited with code $code" }
Write-WatchdogLog "down -> restart FAILED: $reason"
# Keep counting so the next tick tries again right away instead of waiting for two more misses.
Save-State @{ misses = $state.misses; downSince = $state.downSince; restartedAt = '' }
exit 1
