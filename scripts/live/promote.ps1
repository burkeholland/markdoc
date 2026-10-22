# Promote a commit from origin/main to the live test server without taking its URL down.
#   .\promote.ps1 -Sha <sha>
# The live server alternates between two sibling worktrees (markdoc-live and markdoc-live-b; the current one
# is in markdoc-data\live.json, see Get-LiveRoot). Steps:
#   1. in the idle twin: checkout --detach <sha>, npm ci if package*.json changed, delete .next, copy the live
#      .env.local, start `npm run dev` in STANDBY mode (server/index.ts): loopback :<StandbyPort>, in-memory
#      database, while the old server keeps serving :<Port>;
#   2. warm it up: /api/health, /, /d/<new doc>, /api/documents, /api/templates, /api/agent/mcp-url — every route compiles now;
#   3. handover: stop the old process, POST /_standby/takeover -> the standby opens the real PGLITE_DATA_DIR and
#      listens on :<Port> with everything already compiled (~1-2 s), live.json points at the twin.
# Rollback: anything that fails before step 3 leaves the old server running untouched (gap 0) and prints
# ROLLBACK REASON; a failed handover restarts the old worktree with start-live.ps1.
# Holds <DataRoot>\promote.lock from the first change to the twin until exit so watchdog.ps1 (every minute)
# never restarts a server this script is stopping on purpose.
param(
  [Parameter(Mandatory = $true)][string]$Sha,
  # Live worktree; defaults to live.json's root, else the sibling ../markdoc-live (see common.ps1).
  [string]$Root,
  # Where live.json and live.log live; defaults to ../markdoc-data next to the repo.
  [string]$DataRoot,
  [int]$Port = 3000,
  # Loopback port the standby compiles on; never reached by anything but this script.
  [int]$StandbyPort = 3001,
  # Old server's log; defaults to <DataRoot>\live.log (live-b.log for the -b twin, see Get-LiveLogPath).
  [string]$LogPath,
  [int]$TimeoutSec = 180,
  # Never give up on a still-starting standby before it had this many seconds to come up.
  [int]$MinWaitSec = 90,
  # Testing only: accept a commit that is not on origin/main (a rehearsal against a copy, see RESUME.md).
  [switch]$AnyRef
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $DataRoot) { $DataRoot = Join-Path (Get-FactoryRoot) 'markdoc-data' }
if (-not $Root) { $Root = Get-LiveRoot -DataRoot $DataRoot }
$Twin = Get-LiveTwinRoot -Root $Root
if (-not $LogPath) { $LogPath = Get-LiveLogPath -Root $Root -DataRoot $DataRoot }
$TwinLogPath = Get-LiveLogPath -Root $Twin -DataRoot $DataRoot
$Twin = Get-LiveTwinRoot -Root $Root
$startLive = Join-Path $PSScriptRoot 'start-live.ps1'
$liveUrl = Get-LiveAccessUrl -Port $Port
$standbyBase = "http://127.0.0.1:$StandbyPort"
# The watchdog ignores a lock older than 10 min, so a crashed promote cannot block it for good.
$lockPath = Join-Path $DataRoot 'promote.lock'

function Invoke-Git {
  param([string]$In, [Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  # git writes progress to stderr; under PS 5.1 that would throw with ErrorActionPreference=Stop.
  $ErrorActionPreference = 'Continue'
  $out = & git -C $In @GitArgs 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed: $($out -join "`n")" }
  return $out
}

function Invoke-NpmCi {
  param([string]$In)
  Write-Step "package.json / package-lock.json changed -> npm ci --ignore-scripts in $In"
  Push-Location $In
  try {
    $ErrorActionPreference = 'Continue'
    & npm ci --ignore-scripts 2>&1 | ForEach-Object { "$_" } | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Invoke-Warm {
  # One GET against the standby; compiles the route. Returns the HTTP status (0 = no answer).
  param([string]$Path, [Microsoft.PowerShell.Commands.WebRequestSession]$Session)
  $t0 = Get-Date
  $status = 0
  try {
    $params = @{ UseBasicParsing = $true; Uri = "$standbyBase$Path"; TimeoutSec = 150; MaximumRedirection = 0; ErrorAction = 'SilentlyContinue' }
    if ($Session) { $params.WebSession = $Session }
    $resp = Invoke-WebRequest @params
    if ($resp) { $status = [int]$resp.StatusCode }
  } catch {
    $response = $_.Exception.Response
    if ($response -and $response.StatusCode) { $status = [int]$response.StatusCode }
  }
  Write-Step ("  warm {0,-28} HTTP {1} in {2:n1}s" -f $Path, $status, ((Get-Date) - $t0).TotalSeconds)
  return $status
}

function Start-Standby {
  # Launches `npm run dev` in the twin in standby mode; returns the launcher process.
  $logDir = Split-Path -Parent $TwinLogPath
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  Add-Content -LiteralPath $TwinLogPath -Value ("==== start-live {0} root={1} port={2} standby={3} ====" -f (Get-Date -Format 's'), $Twin, $Port, $StandbyPort)
  $env:PORT = "$Port"
  $env:STANDBY_PORT = "$StandbyPort"
  try {
    # run-live.cmd: both streams to the log, `==== exit code N` marker when the process ends (it becomes the live server).
    $cmdLine = '/d /c ""' + (Join-Path $PSScriptRoot 'run-live.cmd') + '" "' + $TwinLogPath + '""'
    Write-Step "starting standby 'npm run dev' in $Twin on 127.0.0.1:$StandbyPort (log: $TwinLogPath)"
    return (Start-Process -FilePath "$env:ComSpec" -ArgumentList $cmdLine -WorkingDirectory $Twin -WindowStyle Hidden -PassThru)
  } finally {
    Remove-Item Env:STANDBY_PORT -ErrorAction SilentlyContinue
  }
}

function Invoke-WarmUp {
  # Compiles the routes a user or the board hits first. Returns '' when all is well, else the reason.
  $status = Invoke-Warm -Path '/'
  if ($status -ge 500 -or $status -eq 0) { return "warm-up GET / answered HTTP $status" }
  $session = $null
  $docId = $null
  try {
    $csrf = Invoke-RestMethod -UseBasicParsing -Uri "$standbyBase/api/auth/csrf" -SessionVariable session -TimeoutSec 150
    $form = @{ csrfToken = $csrf.csrfToken; login = 'promote-warmup'; redirect = 'false' }
    try {
      $null = Invoke-WebRequest -UseBasicParsing -Uri "$standbyBase/api/auth/callback/dev" -Method Post -Body $form `
        -WebSession $session -MaximumRedirection 0 -TimeoutSec 150 -ErrorAction SilentlyContinue
    } catch { $null = $_ }
    $body = @{ title = 'promote warm-up'; content = "# Warm-up`n`nCompiles the editor route.`n" } | ConvertTo-Json
    $created = Invoke-RestMethod -UseBasicParsing -Uri "$standbyBase/api/documents" -Method Post -Body $body -ContentType 'application/json' -WebSession $session -TimeoutSec 150
    $docId = $created.document.id
    Write-Step "  warm dev login + POST /api/documents -> $docId"
  } catch {
    Write-Step "  warm dev login / create document failed ($($_.Exception.Message)); /d/<id> is warmed unauthenticated"
  }
  $routes = @('/api/documents?q=warm', '/api/templates', '/api/agent/mcp-url')
  if ($docId) { $routes = @("/d/$docId") + $routes } else { $routes = @('/d/promote-warmup') + $routes }
  foreach ($r in $routes) {
    $status = Invoke-Warm -Path $r -Session $session
    if ($status -ge 500 -or $status -eq 0) { return "warm-up GET $r answered HTTP $status" }
  }
  return ''
}

function Invoke-Takeover {
  # Stops the old server and tells the standby to open the real database and listen on :Port.
  Stop-LiveProcesses -Root $Root
  $t0 = Get-Date
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$standbyBase/_standby/takeover" -Method Post -TimeoutSec 60
    Write-Step ("takeover answered HTTP {0} in {1:n2}s: {2}" -f [int]$resp.StatusCode, ((Get-Date) - $t0).TotalSeconds, $resp.Content)
    return ($resp.StatusCode -eq 200)
  } catch {
    Write-Step "takeover failed: $($_.Exception.Message)"
    return $false
  }
}

function Restore-OldServer {
  Stop-LiveProcesses -Root $Twin
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startLive -Root $Root -Port $Port -LogPath $LogPath `
    -TimeoutSec $TimeoutSec -MinWaitSec $MinWaitSec -Restart 2>&1 | ForEach-Object { "$_" }
  $out | Out-Host
  return ($LASTEXITCODE -eq 0)
}

Write-Step "fetching origin in $Root"
Invoke-Git -In $Root fetch origin --quiet | Out-Null

$target = $null
try { $target = (Invoke-Git -In $Root rev-parse --verify --quiet "$Sha^{commit}") | Select-Object -First 1 } catch { $target = $null }
if ($target -and -not $AnyRef) { & git -C $Root merge-base --is-ancestor $target origin/main }
if (-not $target -or (-not $AnyRef -and $LASTEXITCODE -ne 0)) {
  Write-Step "$Sha is not on origin/main; refusing to promote"
  exit 1
}

$dirty = @(Invoke-Git -In $Root status --porcelain --untracked-files=no)
if ($dirty.Count -gt 0) {
  Write-Step "live worktree $Root has local changes to tracked files; refusing to promote:`n$($dirty -join "`n")"
  exit 1
}

$previous = (Invoke-Git -In $Root rev-parse HEAD) | Select-Object -First 1
Write-Step "promoting $previous -> $target (live: $Root, standby: $Twin)"

$lockDir = Split-Path -Parent $lockPath
if (-not (Test-Path -LiteralPath $lockDir)) { New-Item -ItemType Directory -Path $lockDir -Force | Out-Null }
Set-Content -LiteralPath $lockPath -Value ("pid={0} sha={1} started={2}" -f $PID, $target, (Get-Date -Format 's')) -Encoding UTF8
try {
  # 1. the twin: a second worktree of the same repo, detached, with its own node_modules.
  if (-not (Test-Path (Join-Path $Twin 'package.json'))) {
    Write-Step "creating twin worktree $Twin"
    Invoke-Git -In $Root worktree add --detach $Twin $target | Out-Null
    Invoke-NpmCi -In $Twin
  }
  $twinDirty = @(Invoke-Git -In $Twin status --porcelain --untracked-files=no)
  if ($twinDirty.Count -gt 0) {
    Write-Step "twin worktree $Twin has local changes to tracked files; refusing to promote:`n$($twinDirty -join "`n")"
    exit 1
  }
  Stop-LiveProcesses -Root $Twin
  $twinPrevious = (Invoke-Git -In $Twin rev-parse HEAD) | Select-Object -First 1
  Write-Step "git checkout --detach $target in $Twin"
  Invoke-Git -In $Twin checkout --detach $target | Out-Null
  $depsChanged = @(Invoke-Git -In $Twin diff --name-only $twinPrevious $target -- package.json package-lock.json).Count -gt 0
  if ($depsChanged -or -not (Test-Path (Join-Path $Twin 'node_modules\next\package.json'))) { Invoke-NpmCi -In $Twin } else { Write-Step 'dependencies unchanged; skipping npm ci' }
  Remove-NextCache -Root $Twin
  $envFile = Join-Path $Root '.env.local'
  if (Test-Path -LiteralPath $envFile) { Copy-Item -LiteralPath $envFile -Destination (Join-Path $Twin '.env.local') -Force }
  else { Write-Step "no .env.local in $Root; the standby starts with the environment only" }

  # 2. standby up and warm while the old server keeps serving.
  $proc = Start-Standby
  Write-Step "standby launcher PID $($proc.Id)"
  $result = Wait-LiveStartup -Port $StandbyPort -TimeoutSec $TimeoutSec -MinWaitSec $MinWaitSec -Process $proc -LogPath $TwinLogPath
  $reason = ''
  if (-not $result.Healthy) { $reason = "standby never healthy: $($result.Reason)" }
  else {
    Write-Step "standby healthy after $($result.Elapsed)s; warming routes"
    $reason = Invoke-WarmUp
  }
  if ($reason) {
    Write-Step "promotion of $target FAILED before the handover; the live server on :$Port was never stopped"
    Write-Step "ROLLBACK REASON: $reason"
    Show-LogTail -LogPath $TwinLogPath -Lines 30
    Stop-LiveProcesses -Root $Twin
    exit 1
  }

  # 3. handover.
  $swapStarted = Get-Date
  $healthy = $false
  if (Invoke-Takeover) {
    $up = Wait-LiveStartup -Port $Port -TimeoutSec 30 -MinWaitSec 0 -Process $proc -LogPath $TwinLogPath -PollSec 1
    $healthy = $up.Healthy
    if (-not $healthy) { $reason = "after takeover: $($up.Reason)" }
  } else { $reason = 'standby did not take over the port' }

  if ($healthy) {
    Write-LiveState -Root $Twin -Sha $target -Port $Port -DataRoot $DataRoot
    Write-Step ("PROMOTED: {0} now runs {1} from {2} (was {3} in {4}); handover {5:n1}s" -f $liveUrl, $target, $Twin, $previous, $Root, ((Get-Date) - $swapStarted).TotalSeconds)
    exit 0
  }

  Write-Step "promotion of $target FAILED during the handover; restarting $previous in $Root"
  Write-Step "ROLLBACK REASON: $reason"
  Show-LogTail -LogPath $TwinLogPath -Lines 30
  if (Restore-OldServer) {
    Write-Step "ROLLED BACK: live server on :$Port runs $previous again from $Root"
  } else {
    Write-Step "ROLLBACK FAILED: live server is down; inspect $LogPath"
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
