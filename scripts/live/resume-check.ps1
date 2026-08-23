# Is Markdoc back after a machine wipe? Prints a checklist and exits 0 when everything is in place,
# non-zero on the first hard failure. Fixes what it safely can (creates the live worktree, installs
# the scheduled task, starts the server, restores data from a snapshot) unless -DryRun.
#   .\resume-check.ps1            check and repair
#   .\resume-check.ps1 -DryRun    only report; change nothing, start nothing
# Environment (all optional; set by burkeholland/factory-resume/bootstrap.ps1):
#   FACTORY_MANIFEST   path to the board's manifest.json; when set, HEAD must equal its sha for this repo
#   FACTORY_SNAPSHOT   folder with markdoc-pglite.tar.gz + manifest.json, restored when the data dir is missing
#   FACTORY_ROOT       parent folder of the checkouts (default: parent of this repo)
# Also: `npm run resume-check`. Windows PowerShell 5.1 compatible. See RESUME.md.
param(
  [switch]$DryRun,
  [int]$Port = 3000,
  [int]$TimeoutSec = 180,
  # Dev-login handle used for the read-only GET /api/documents probe (creates that user if new).
  [string]$CheckLogin = 'resume-check'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$factoryRoot = Get-FactoryRoot
$liveRoot = Join-Path $factoryRoot 'markdoc-live'
$dataRoot = Join-Path $factoryRoot 'markdoc-data'
$pgliteDir = Join-Path $dataRoot 'pglite'
$script:failed = $false

function Write-Check {
  param([string]$State, [string]$Label, [string]$Detail = '')
  $mark = switch ($State) { 'ok' { '[ok]  ' } 'fix' { '[fix] ' } 'skip' { '[skip]' } 'warn' { '[warn]' } default { '[FAIL]' } }
  if ($Detail) { Write-Host ("{0} {1} - {2}" -f $mark, $Label, $Detail) } else { Write-Host ("{0} {1}" -f $mark, $Label) }
}
function Fail {
  param([string]$Label, [string]$Detail)
  Write-Check 'FAIL' $Label $Detail
  Write-Host ''
  Write-Host "resume-check: FAILED at '$Label'. See RESUME.md."
  exit 1
}

Write-Host "Markdoc resume-check $(if ($DryRun) { '(dry run) ' })- repo $repoRoot"
Write-Host "  factory root $factoryRoot"
Write-Host ''

# TODO: use the Tools team's generic helper (node <FACTORY_ROOT>/tools/bin/resume-check.mjs) for
# tools/ports/sha once it exists; it was not present when this was written, so those bits are inline.

# 1. repo present, clean enough, on the manifest sha
if (-not (Test-Path (Join-Path $repoRoot '.git'))) { Fail 'repo' "$repoRoot is not a git checkout" }
$head = (& git -C $repoRoot rev-parse HEAD).Trim()
Write-Check 'ok' 'repo' "$repoRoot at $($head.Substring(0, 9))"
if ($env:FACTORY_MANIFEST) {
  if (-not (Test-Path -LiteralPath $env:FACTORY_MANIFEST)) { Fail 'manifest' "FACTORY_MANIFEST=$($env:FACTORY_MANIFEST) not found" }
  $manifest = Get-Content -LiteralPath $env:FACTORY_MANIFEST -Raw | ConvertFrom-Json
  $want = $null
  foreach ($candidate in @($manifest.repos, $manifest.projects)) {
    if ($null -eq $candidate) { continue }
    foreach ($entry in @($candidate)) {
      $name = if ($entry.name) { $entry.name } else { $entry.repo }
      if ("$name" -match '(^|/)markdoc$') { $want = $entry.sha; break }
    }
    if ($want) { break }
  }
  if (-not $want -and $manifest.markdoc) { $want = $manifest.markdoc.sha }
  if (-not $want) { Write-Check 'skip' 'manifest sha' "no markdoc entry in $($env:FACTORY_MANIFEST)" }
  elseif ($want -ne $head) { Fail 'manifest sha' "HEAD $head but manifest wants $want (git fetch && git checkout $want)" }
  else { Write-Check 'ok' 'manifest sha' 'HEAD matches' }
} else {
  Write-Check 'skip' 'manifest sha' 'FACTORY_MANIFEST not set'
}

# 2. node + npm + deps
foreach ($tool in @('node', 'npm', 'git')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail 'tools' "$tool is not on PATH" }
}
Write-Check 'ok' 'tools' "node $(& node --version), npm $(& npm --version), git $((& git --version) -replace 'git version ', '')"

# 3. live worktree detached at main's sha
$mainSha = (& git -C $repoRoot rev-parse main 2>$null)
if (-not $mainSha) { $mainSha = $head } else { $mainSha = $mainSha.Trim() }
if (-not (Test-Path (Join-Path $liveRoot 'package.json'))) {
  if ($DryRun) { Write-Check 'fix' 'live worktree' "missing; would run: git worktree add --detach $liveRoot $mainSha" }
  else {
    Write-Check 'fix' 'live worktree' "creating $liveRoot at $($mainSha.Substring(0, 9))"
    & git -C $repoRoot worktree add --detach $liveRoot $mainSha | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'live worktree' 'git worktree add failed' }
  }
} else {
  $liveSha = (& git -C $liveRoot rev-parse HEAD).Trim()
  $branch = (& git -C $liveRoot symbolic-ref -q --short HEAD 2>$null)
  if ($branch) { Fail 'live worktree' "$liveRoot is on branch '$branch'; it must be detached (git -C $liveRoot checkout --detach)" }
  if ($liveSha -ne $mainSha) { Write-Check 'warn' 'live worktree' "detached at $($liveSha.Substring(0, 9)), main is $($mainSha.Substring(0, 9)) (promote.ps1 moves it)" }
  else { Write-Check 'ok' 'live worktree' "$liveRoot detached at $($liveSha.Substring(0, 9))" }
}
if (Test-Path (Join-Path $liveRoot 'package.json')) {
  if (-not (Test-Path (Join-Path $liveRoot 'node_modules\next'))) {
    if ($DryRun) { Write-Check 'fix' 'live deps' "missing; would run: npm ci --ignore-scripts in $liveRoot" }
    else {
      Write-Check 'fix' 'live deps' "npm ci --ignore-scripts in $liveRoot"
      Push-Location $liveRoot
      try { & npm ci --ignore-scripts | Out-Host } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { Fail 'live deps' 'npm ci failed' }
    }
  } else { Write-Check 'ok' 'live deps' 'node_modules present' }
}

# 4. .env.local with the three keys
$envPath = Join-Path $liveRoot '.env.local'
$envVars = Read-EnvFile -Path $envPath
$missing = @('AUTH_SECRET', 'AUTH_DEV_LOGIN', 'PGLITE_DATA_DIR', 'BACKUP_TOKEN') | Where-Object { -not $envVars.ContainsKey($_) -or -not $envVars[$_] }
if ($missing.Count -gt 0) {
  Write-Check 'FAIL' '.env.local' "$envPath is missing $($missing -join ', '). Add these lines (fresh secrets generated now):"
  foreach ($key in $missing) {
    $value = switch ($key) {
      'AUTH_SECRET' { New-RandomSecret }
      'BACKUP_TOKEN' { New-RandomSecret }
      'AUTH_DEV_LOGIN' { '1' }
      'PGLITE_DATA_DIR' { $pgliteDir }
    }
    Write-Host "    $key=$value"
  }
  Fail '.env.local' 'see the lines above (RESUME.md > Secrets)'
}
Write-Check 'ok' '.env.local' 'AUTH_SECRET, AUTH_DEV_LOGIN, PGLITE_DATA_DIR, BACKUP_TOKEN present'
$token = $envVars['BACKUP_TOKEN']

# 5. data dir (restore from the snapshot if missing)
if (-not (Test-Path (Join-Path $pgliteDir 'PG_VERSION'))) {
  if ($env:FACTORY_SNAPSHOT -and (Test-Path (Join-Path $env:FACTORY_SNAPSHOT 'markdoc-pglite.tar.gz'))) {
    if ($DryRun) { Write-Check 'fix' 'data dir' "$pgliteDir missing; would run restore-data.ps1 -From $($env:FACTORY_SNAPSHOT) -SkipServer" }
    else {
      Write-Check 'fix' 'data dir' "restoring $pgliteDir from $($env:FACTORY_SNAPSHOT)"
      & (Join-Path $PSScriptRoot 'restore-data.ps1') -From $env:FACTORY_SNAPSHOT -DataDir $pgliteDir -SkipServer
      if ($LASTEXITCODE -ne 0) { Fail 'data dir' 'restore-data.ps1 failed' }
    }
  } elseif (Get-LiveHealth -Port $Port) {
    Write-Check 'warn' 'data dir' "$pgliteDir has no PG_VERSION but :$Port answers - PGLITE_DATA_DIR may point elsewhere"
  } else {
    Write-Check 'warn' 'data dir' "$pgliteDir missing and FACTORY_SNAPSHOT not set: the server will start EMPTY. Restore later with restore-data.ps1 -From <snapshot>"
  }
} else {
  $files = @(Get-ChildItem -LiteralPath $pgliteDir -Recurse -File -ErrorAction SilentlyContinue)
  $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
  Write-Check 'ok' 'data dir' "$pgliteDir ($($files.Count) files, $mb MB)"
}

# 6. scheduled task
$task = Get-ScheduledTask -TaskName 'Markdoc live server' -ErrorAction SilentlyContinue
if (-not $task) {
  $installer = Join-Path $liveRoot 'scripts\live\install-autostart.ps1'
  if (-not (Test-Path $installer)) { $installer = Join-Path $PSScriptRoot 'install-autostart.ps1' }
  if ($DryRun) { Write-Check 'fix' 'scheduled task' "missing; would run $installer" }
  else {
    Write-Check 'fix' 'scheduled task' "registering via $installer"
    & $installer | Out-Host
    if (-not (Get-ScheduledTask -TaskName 'Markdoc live server' -ErrorAction SilentlyContinue)) { Fail 'scheduled task' 'install-autostart.ps1 did not register it' }
  }
} else {
  Write-Check 'ok' 'scheduled task' "'Markdoc live server' -> $($task.Actions[0].Arguments -replace '.*-File ', '')"
}

# 7. server healthy (start it if not)
$health = Get-LiveHealth -Port $Port
if (-not $health) {
  if ($DryRun) { Write-Check 'fix' 'server' "nothing on :$Port; would run start-live.ps1 -Port $Port" }
  else {
    Write-Check 'fix' 'server' "starting via start-live.ps1 (up to ${TimeoutSec}s)"
    & (Join-Path $PSScriptRoot 'start-live.ps1') -Root $liveRoot -Port $Port -TimeoutSec $TimeoutSec | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'server' 'start-live.ps1 did not get a 200 from /api/health' }
    $health = Get-LiveHealth -Port $Port
  }
}
if ($health) {
  if (-not $health.db) { Fail 'server' "/api/health answers but db=$($health.db)" }
  Write-Check 'ok' 'server' "/api/health 200 on :$Port (db=$($health.db) collab=$($health.collab) version=$($health.version))"

  # 8. backup route reachable with the token, documents listable with the dev login
  $meta = Get-BackupMeta -Port $Port -Token $token
  if ($meta) { Write-Check 'ok' 'backup route' "GET /api/admin/backup?meta=1: $($meta.documents) documents, $($meta.users) users" }
  else { Write-Check 'warn' 'backup route' "GET /api/admin/backup?meta=1 did not answer 200 (server older than the route, or BACKUP_TOKEN differs from .env.local)" }

  $docs = Get-DocumentsAsDevUser -Port $Port -Login $CheckLogin
  if ($null -eq $docs) { Fail 'documents' "GET /api/documents with the dev login '$CheckLogin' failed (is AUTH_DEV_LOGIN=1?)" }
  Write-Check 'ok' 'documents' "GET /api/documents as @$CheckLogin -> $(@($docs.documents).Count) documents"
} elseif ($DryRun) {
  Write-Check 'skip' 'documents' 'server not running (dry run)'
}

Write-Host ''
Write-Host "resume-check: OK$(if ($DryRun) { ' (dry run; nothing changed)' })"
exit 0
