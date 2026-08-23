# Is Markdoc back after a machine wipe? Prints a checklist and exits 0 when everything is in place,
# non-zero on the first hard failure. Fixes what it safely can (creates the live worktree, writes a
# missing .env.local, installs the scheduled tasks, starts the server, restores data from a snapshot)
# unless -DryRun. A fresh box needs nothing from a human: every .env.local value is generated or derived.
#   .\resume-check.ps1            check and repair
#   .\resume-check.ps1 -DryRun    only report; change nothing, start nothing
#   .\resume-check.ps1 -LiveRoot <dir> -DataRoot <dir> -Port <n>   rehearse against scratch folders
# Environment (all optional; set by burkeholland/factory-resume/bootstrap.ps1):
#   FACTORY_MANIFEST   path to the board's manifest.json; when set, HEAD must equal its sha for this repo
#   FACTORY_SNAPSHOT   folder with markdoc-pglite.tar.gz + manifest.json, restored when the data dir is missing
#                      (default: ../markdoc-data/snapshots/latest when that folder has a tarball)
#   FACTORY_ROOT       parent folder of the checkouts (default: parent of this repo)
# Also: `npm run resume-check`. Windows PowerShell 5.1 compatible. See RESUME.md.
# Write-Host on purpose: this is a console checklist, like the other scripts in this folder.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '')]
param(
  [switch]$DryRun,
  [int]$Port = 3000,
  [int]$TimeoutSec = 180,
  # Dev-login handle used for the read-only GET /api/documents probe (creates that user if new).
  [string]$CheckLogin = 'resume-check',
  # Live worktree and data folder. Default: <factory root>\markdoc-live and <factory root>\markdoc-data
  # (FACTORY_ROOT / Get-FactoryRoot); override both to rehearse a restore in scratch folders.
  [string]$LiveRoot,
  [string]$DataRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$factoryRoot = Get-FactoryRoot
$liveRoot = if ($LiveRoot) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LiveRoot) } else { Join-Path $factoryRoot 'markdoc-live' }
$dataRoot = if ($DataRoot) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot) } else { Join-Path $factoryRoot 'markdoc-data' }
$pgliteDir = Join-Path $dataRoot 'pglite'
$liveLog = Join-Path $dataRoot 'live.log'
$startLive = Join-Path $PSScriptRoot 'start-live.ps1'
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

# 4. .env.local with the four keys. None is a secret a human holds: AUTH_SECRET and BACKUP_TOKEN are fresh
# random strings (changing them only signs everyone out), AUTH_DEV_LOGIN is 1, PGLITE_DATA_DIR is derived.
# So missing keys are written here - create the file or append only the missing lines, never change an
# existing value - and the step is a fix, not a failure. Runs before step 7 so the server starts with the file.
$envPath = Join-Path $liveRoot '.env.local'
$envVars = Read-EnvFile -Path $envPath
$envKeys = @('AUTH_SECRET', 'AUTH_DEV_LOGIN', 'PGLITE_DATA_DIR', 'BACKUP_TOKEN')
$missing = @($envKeys | Where-Object { -not $envVars.ContainsKey($_) -or -not $envVars[$_] })
if ($missing.Count -gt 0) {
  $newLines = @(foreach ($key in $missing) {
    $value = switch ($key) {
      'AUTH_SECRET' { Get-RandomSecret }
      'BACKUP_TOKEN' { Get-RandomSecret }
      'AUTH_DEV_LOGIN' { '1' }
      'PGLITE_DATA_DIR' { $pgliteDir }
    }
    "$key=$value"
  })
  $envExists = Test-Path -LiteralPath $envPath
  $action = if ($envExists) { "append $($missing -join ', ') to $envPath" } else { "create $envPath with $($missing -join ', ')" }
  if ($DryRun) {
    Write-Check 'fix' '.env.local' "would $action (fresh secrets generated now):"
    foreach ($line in $newLines) { Write-Host "    $line" }
  } else {
    # Probe before writing: the dev server watches .env.local and answers 500 for a while after a change.
    $serverWasUp = $null -ne (Get-LiveHealth -Port $Port)
    Write-Check 'fix' '.env.local' "$action (keep these; they are the only copy of the new secrets):"
    $existing = if ($envExists) { Get-Content -LiteralPath $envPath -Raw } else { '' }
    $prefix = if ($existing -and -not $existing.EndsWith("`n")) { "`r`n" } else { '' }
    [IO.File]::AppendAllText($envPath, $prefix + (($newLines -join "`r`n") + "`r`n"), [Text.UTF8Encoding]::new($false))
    foreach ($line in $newLines) {
      Write-Host "    $line"
      $envVars[$line.Substring(0, $line.IndexOf('='))] = $line.Substring($line.IndexOf('=') + 1)
    }
    # A server that was already up started without these values (or with other ones): restart it so it
    # reads the file, otherwise its BACKUP_TOKEN would differ from .env.local and step 8 would warn.
    if ($serverWasUp) {
      Write-Check 'fix' 'server' "restarting :$Port so it picks up the new .env.local (start-live.ps1 -Restart)"
      & $startLive -Root $liveRoot -Port $Port -LogPath $liveLog -TimeoutSec $TimeoutSec -Restart | Out-Host
      if ($LASTEXITCODE -ne 0) { Fail 'server' 'start-live.ps1 -Restart did not get a 200 from /api/health' }
    }
  }
} else {
  Write-Check 'ok' '.env.local' 'AUTH_SECRET, AUTH_DEV_LOGIN, PGLITE_DATA_DIR, BACKUP_TOKEN present'
}
$token = $envVars['BACKUP_TOKEN']

# 5. data dir (restore from the snapshot if missing: $env:FACTORY_SNAPSHOT, else ../markdoc-data/snapshots/latest)
$snapshotDir = $env:FACTORY_SNAPSHOT
if (-not $snapshotDir) { $snapshotDir = Join-Path $dataRoot 'snapshots\latest' }
if (-not (Test-Path (Join-Path $pgliteDir 'PG_VERSION'))) {
  if (Test-Path (Join-Path $snapshotDir 'markdoc-pglite.tar.gz')) {
    if ($DryRun) { Write-Check 'fix' 'data dir' "$pgliteDir missing; would run restore-data.ps1 -From $snapshotDir -SkipServer" }
    else {
      Write-Check 'fix' 'data dir' "restoring $pgliteDir from $snapshotDir"
      & (Join-Path $PSScriptRoot 'restore-data.ps1') -From $snapshotDir -DataDir $pgliteDir -SkipServer
      if ($LASTEXITCODE -ne 0) { Fail 'data dir' 'restore-data.ps1 failed' }
    }
  } elseif (Get-LiveHealth -Port $Port) {
    Write-Check 'warn' 'data dir' "$pgliteDir has no PG_VERSION but :$Port answers - PGLITE_DATA_DIR may point elsewhere"
  } else {
    Write-Check 'warn' 'data dir' "$pgliteDir missing and no tarball in $snapshotDir (set FACTORY_SNAPSHOT): the server will start EMPTY (PGlite creates the folder). Restore later with restore-data.ps1 -From <snapshot>"
  }
} else {
  $files = @(Get-ChildItem -LiteralPath $pgliteDir -Recurse -File -ErrorAction SilentlyContinue)
  $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
  Write-Check 'ok' 'data dir' "$pgliteDir ($($files.Count) files, $mb MB)"
}

# 6. scheduled tasks ("Markdoc live server" at logon, "Markdoc snapshot" every 15 min)
$taskNames = @('Markdoc live server', 'Markdoc snapshot')
$missingTasks = @($taskNames | Where-Object { -not (Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue) })
if ($missingTasks.Count -gt 0) {
  $installer = Join-Path $liveRoot 'scripts\live\install-autostart.ps1'
  # Prefer the live worktree's copy (tasks then point at the permanent location), unless it predates the snapshot task.
  if (-not (Test-Path $installer) -or -not (Select-String -LiteralPath $installer -Pattern 'Markdoc snapshot' -Quiet)) { $installer = Join-Path $PSScriptRoot 'install-autostart.ps1' }
  if ($DryRun) { Write-Check 'fix' 'scheduled tasks' "missing $($missingTasks -join ', '); would run $installer" }
  else {
    Write-Check 'fix' 'scheduled tasks' "registering $($missingTasks -join ', ') via $installer"
    & $installer | Out-Host
    $still = @($taskNames | Where-Object { -not (Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue) })
    if ($still.Count -gt 0) { Fail 'scheduled tasks' "install-autostart.ps1 did not register $($still -join ', ')" }
  }
} else {
  foreach ($n in $taskNames) {
    $task = Get-ScheduledTask -TaskName $n
    Write-Check 'ok' 'scheduled task' "'$n' ($($task.State)) -> $($task.Actions[0].Arguments -replace '.*-File ', '')"
  }
}

# 7. server healthy (start it if not)
$health = Get-LiveHealth -Port $Port
if (-not $health) {
  if ($DryRun) { Write-Check 'fix' 'server' "nothing on :$Port; would run start-live.ps1 -Port $Port" }
  else {
    Write-Check 'fix' 'server' "starting via start-live.ps1 (up to ${TimeoutSec}s)"
    & $startLive -Root $liveRoot -Port $Port -LogPath $liveLog -TimeoutSec $TimeoutSec | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'server' 'start-live.ps1 did not get a 200 from /api/health' }
    $health = Get-LiveHealth -Port $Port
  }
}
if ($health) {
  if (-not $health.db) { Fail 'server' "/api/health answers but db=$($health.db)" }
  Write-Check 'ok' 'server' "/api/health 200 on :$Port (db=$($health.db) collab=$($health.collab) version=$($health.version))"

  # 8. backup route reachable with the token, documents listable with the dev login
  $meta = if ($token) { Get-BackupMeta -Port $Port -Token $token } else { $null }
  if ($meta) { Write-Check 'ok' 'backup route' "GET /api/admin/backup?meta=1: $($meta.documents) documents, $($meta.users) users" }
  elseif (-not $token) { Write-Check 'skip' 'backup route' 'no BACKUP_TOKEN in .env.local' }
  else { Write-Check 'warn' 'backup route' "GET /api/admin/backup?meta=1 did not answer 200 (server older than the route, or BACKUP_TOKEN differs from .env.local)" }

  $docs = Get-DocumentsAsDevUser -Port $Port -Login $CheckLogin
  if ($null -eq $docs) { Fail 'documents' "GET /api/documents with the dev login '$CheckLogin' failed (is AUTH_DEV_LOGIN=1?)" }
  Write-Check 'ok' 'documents' "GET /api/documents as @$CheckLogin -> $(@($docs.documents).Count) documents"

  # 9. the 15-min snapshot is landing: ../markdoc-data/snapshots/latest/manifest.json < 30 min old. A warning,
  # not a failure: right after a restore the first run of the task may still be up to 15 min away.
  $latestManifest = Join-Path $dataRoot 'snapshots\latest\manifest.json'
  if (-not (Test-Path -LiteralPath $latestManifest)) {
    Write-Check 'warn' 'snapshot' "$latestManifest missing - the 'Markdoc snapshot' task has not run yet (Start-ScheduledTask 'Markdoc snapshot' to force one)"
  } else {
    $ageMin = [math]::Round(((Get-Date) - (Get-Item -LiteralPath $latestManifest).LastWriteTime).TotalMinutes, 1)
    $takenAt = try { (Get-Content -LiteralPath $latestManifest -Raw | ConvertFrom-Json).takenAt } catch { '?' }
    if ($ageMin -gt 30) { Write-Check 'warn' 'snapshot' "$latestManifest is $ageMin min old (takenAt $takenAt); the 'Markdoc snapshot' task should refresh it every 15 min" }
    else { Write-Check 'ok' 'snapshot' "snapshots\latest\manifest.json is $ageMin min old (takenAt $takenAt)" }
  }
} elseif ($DryRun) {
  Write-Check 'skip' 'documents' 'server not running (dry run)'
}

Write-Host ''
Write-Host "resume-check: OK$(if ($DryRun) { ' (dry run; nothing changed)' })"
exit 0
