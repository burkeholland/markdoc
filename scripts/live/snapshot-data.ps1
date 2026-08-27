# Hot snapshot of the live server's PGlite database, without stopping it.
# Calls GET /api/admin/backup (PGlite dumpDataDir as .tar.gz, gated by BACKUP_TOKEN) and writes
#   <Out>\markdoc-pglite.tar.gz
#   <Out>\manifest.json   { sha, takenAt, bytes, documents, users, port, sha256 }
#   <Out>\auth-secret.enc.json   AUTH_SECRET sealed under FACTORY_STATE_KEY (env-vault.mjs); absent when the key is unset
# It is read-only for the server.
#   .\snapshot-data.ps1                      -Latest (the default when -Out is omitted)
#   .\snapshot-data.ps1 -Out C:\snapshots\markdoc
# -Latest writes <DataRoot>\snapshots\latest ATOMICALLY: the snapshot goes to latest.tmp, then
# latest -> prev, latest.tmp -> latest, prev deleted - a reader that copies `latest` (the board's 15-min
# factory-state snapshot, via factory-state.nominate.json) never sees a half-written tarball. It also keeps
# the newest -Keep (3) timestamped copies in <DataRoot>\snapshots\<yyyyMMdd-HHmmss>\ and prunes
# the rest. The "Markdoc snapshot" scheduled task (install-autostart.ps1) runs this every 15 minutes.
# Token: -Token, else $env:BACKUP_TOKEN, else BACKUP_TOKEN= in <live worktree>\.env.local.
# Health: /api/health is polled (1 s) for up to -HealthTimeoutSec (60) until db=true; a cold server's first
# /api/health can take several seconds while Next.js compiles the route.
# Log: every run appends one line to <DataRoot>\snapshot.log (task #701) - the task runs hidden, so this is the
# only trace it leaves:
#   <ts> ok <bytes> bytes <documents> documents <ms> ms
#   <ts> FAILED <step>: <reason>        steps: args, prepare, token, health, download, verify, manifest, seal, swap, copy
# Every failure - an explicit check or an unhandled exception - goes through one catch, so latest.tmp and the
# .part download are removed on every path and the exit code is 1 (an existing `latest` is left untouched).
# Exit 0 on success. Windows PowerShell 5.1 compatible.
param(
  [string]$Out,
  [switch]$Latest,
  [int]$Keep = 3,
  [int]$Port = 3000,
  [string]$Token,
  # Live worktree; its HEAD sha goes into the manifest and its .env.local is the token fallback.
  [string]$Root,
  # Folder with snapshots\ and snapshot.log; defaults to <factory root>\markdoc-data. Point a rehearsal
  # (-Out <tmp> -DataRoot <tmp>) elsewhere so the live log stays clean.
  [string]$DataRoot,
  [int]$TimeoutSec = 300,
  [int]$HealthTimeoutSec = 60
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell's download progress bar makes -OutFile 50x slower.
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $DataRoot) { $DataRoot = Join-Path (Get-FactoryRoot) 'markdoc-data' }
$DataRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataRoot)
$snapshotLog = Join-Path $DataRoot 'snapshot.log'
if (-not $Root) { $Root = Get-LiveRoot -DataRoot $DataRoot }
if (-not $Out) { $Latest = $true }

# The step the run is in, named in the FAILED log line; and what to delete when it fails (the .part download
# and, with -Latest, the whole latest.tmp folder - without -Latest the caller's folder is left alone).
$script:Step = 'args'
$script:Scratch = @()

function Remove-Scratch {
  # Returns the paths that could not be removed (a handle held by a virus scanner or an indexer), so the log
  # line can name them; each is retried a few times first.
  $left = @()
  foreach ($p in $script:Scratch) {
    for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $p); $i++) {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $p) { Start-Sleep -Milliseconds 400 }
    }
    if (Test-Path -LiteralPath $p) { $left += $p }
  }
  return $left
}

function Get-WebErrorText {
  # "HTTP 401 Unauthorized" when the server answered, else the exception text (refused, timed out).
  param($ErrorRecord)
  $response = $ErrorRecord.Exception.Response
  if ($response -and $response.StatusCode) { return "HTTP $([int]$response.StatusCode) $($response.StatusCode)" }
  return $ErrorRecord.Exception.Message
}

$started = Get-Date
try {
  if ($Latest -and $Out) { throw '-Latest and -Out are exclusive' }

  $snapRoot = $null
  if ($Latest) {
    $script:Step = 'prepare'
    $snapRoot = Join-Path $DataRoot 'snapshots'
    if (-not (Test-Path $snapRoot)) { New-Item -ItemType Directory -Path $snapRoot -Force | Out-Null }
    $Out = Join-Path $snapRoot 'latest.tmp'
    # Leftover from a run that was killed mid-download (the 10-min execution cap, a reboot).
    if (Test-Path -LiteralPath $Out) {
      Write-Step "removing $Out left by an earlier run"
      Remove-Item -LiteralPath $Out -Recurse -Force
    }
  }

  $script:Step = 'token'
  $Token = Resolve-BackupToken -Token $Token -Root $Root
  if (-not $Token) { throw "no BACKUP_TOKEN: pass -Token, set `$env:BACKUP_TOKEN or add BACKUP_TOKEN= to $Root\.env.local" }

  $script:Step = 'health'
  $health = Wait-LiveHealth -Port $Port -TimeoutSec $HealthTimeoutSec
  if (-not $health -or $health.db -ne $true) {
    throw "server on :$Port is not healthy after ${HealthTimeoutSec}s (db=$($health.db)); nothing snapshotted"
  }

  $script:Step = 'prepare'
  if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
  $Out = (Resolve-Path -LiteralPath $Out).Path
  $tarPath = Join-Path $Out 'markdoc-pglite.tar.gz'
  $tmpPath = "$tarPath.part"
  $manifestPath = Join-Path $Out 'manifest.json'
  $script:Scratch = if ($Latest) { @($tmpPath, $Out) } else { @($tmpPath) }

  $sha = $null
  if (Test-Path (Join-Path $Root '.git')) {
    try { $sha = (& git -C $Root rev-parse HEAD 2>$null).Trim() } catch { $sha = $null }
  }

  $script:Step = 'download'
  Write-Step "GET http://localhost:$Port/api/admin/backup -> $tarPath"
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/admin/backup" `
      -Headers @{ 'X-Backup-Token' = $Token } -OutFile $tmpPath -PassThru -TimeoutSec $TimeoutSec
  } catch {
    throw "backup request failed: $(Get-WebErrorText $_)"
  }
  if ($resp.StatusCode -ne 200) { throw "backup request returned HTTP $($resp.StatusCode)" }

  $script:Step = 'verify'
  $bytes = (Get-Item -LiteralPath $tmpPath).Length
  $magic = New-Object byte[] 2
  $stream = [System.IO.File]::OpenRead($tmpPath)
  try { $null = $stream.Read($magic, 0, 2) } finally { $stream.Dispose() }
  if ($bytes -lt 1024 -or $magic[0] -ne 0x1f -or $magic[1] -ne 0x8b) {
    throw "downloaded file is not a gzip tarball ($bytes bytes); discarded"
  }
  Move-Item -LiteralPath $tmpPath -Destination $tarPath -Force

  $script:Step = 'manifest'
  $taken = Get-Date
  $manifest = [ordered]@{
    sha       = $sha
    takenAt   = $taken.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    bytes     = $bytes
    documents = [int]"$($resp.Headers['X-Markdoc-Documents'])"
    users     = [int]"$($resp.Headers['X-Markdoc-Users'])"
    port      = $Port
    file      = 'markdoc-pglite.tar.gz'
    sha256    = (Get-FileHash -LiteralPath $tarPath -Algorithm SHA256).Hash.ToLower()
    durationMs = [int]((Get-Date) - $started).TotalMilliseconds
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  # AUTH_SECRET travels with the snapshot sealed under FACTORY_STATE_KEY (env-vault.mjs), so a restore after a wipe
  # can keep everyone's session instead of regenerating the key. Never in the clear: factory-state refuses secrets.
  # Skipped quietly (exit 3) when the key is unset or .env.local has no AUTH_SECRET; a failure here never fails the snapshot.
  $script:Step = 'seal'
  $vaultPath = Join-Path $Out 'auth-secret.enc.json'
  $envPath = Join-Path $Root '.env.local'
  $ErrorActionPreference = 'Continue'
  $vaultOut = & node (Join-Path $PSScriptRoot 'env-vault.mjs') seal --env $envPath --name AUTH_SECRET --out $vaultPath 2>&1
  $vaultCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($vaultCode -eq 0) { Write-Step "AUTH_SECRET sealed into the snapshot (FACTORY_STATE_KEY)" }
  elseif ($vaultCode -eq 3) { Write-Step "AUTH_SECRET not carried in the snapshot ($vaultOut); a restore will regenerate it and sign users out once" }
  else { Write-Step "warning: env-vault.mjs exit ${vaultCode}: $vaultOut" }

  if ($Latest) {
    $script:Step = 'swap'
    $latestDir = Join-Path $snapRoot 'latest'
    $prevDir = Join-Path $snapRoot 'prev'
    # Swap: a reader copying `latest` sees the old complete folder, a brief absence, or the new complete folder.
    if (Test-Path -LiteralPath $prevDir) { Remove-Item -LiteralPath $prevDir -Recurse -Force }
    if (Test-Path -LiteralPath $latestDir) { Move-Item -LiteralPath $latestDir -Destination $prevDir }
    Move-Item -LiteralPath $Out -Destination $latestDir
    # latest.tmp is now `latest`: from here a failure must not delete the snapshot.
    $script:Scratch = @()
    if (Test-Path -LiteralPath $prevDir) { Remove-Item -LiteralPath $prevDir -Recurse -Force }
    $Out = $latestDir

    # Timestamped copy (local time of takenAt) and prune to the newest -Keep.
    $script:Step = 'copy'
    $stamp = $taken.ToString('yyyyMMdd-HHmmss')
    $stampDir = Join-Path $snapRoot $stamp
    if (-not (Test-Path -LiteralPath $stampDir)) { New-Item -ItemType Directory -Path $stampDir -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $latestDir 'markdoc-pglite.tar.gz'), (Join-Path $latestDir 'manifest.json') -Destination $stampDir -Force
    if (Test-Path -LiteralPath (Join-Path $latestDir 'auth-secret.enc.json')) { Copy-Item -LiteralPath (Join-Path $latestDir 'auth-secret.enc.json') -Destination $stampDir -Force }
    $stamped = @(Get-ChildItem -LiteralPath $snapRoot -Directory | Where-Object { $_.Name -match '^\d{8}-\d{4,6}$' } | Sort-Object Name -Descending)
    foreach ($old in ($stamped | Select-Object -Skip $Keep)) {
      Write-Step "pruning $($old.FullName)"
      Remove-Item -LiteralPath $old.FullName -Recurse -Force
    }
  }

  Write-OpsLog -Path $snapshotLog -Message ("ok {0} bytes {1} documents {2} ms" -f $bytes, $manifest.documents, $manifest.durationMs)
  Write-Step ("snapshot ok: {0} bytes, {1} documents, sha {2}, {3} ms -> {4}" -f $bytes, $manifest.documents, $sha, $manifest.durationMs, $Out)
  exit 0
} catch {
  $reason = "$($_.Exception.Message)" -replace '\s+', ' '
  $left = @(Remove-Scratch)
  $note = if ($left.Count -gt 0) { " (could not remove: $($left -join ', '))" } else { '' }
  Write-OpsLog -Path $snapshotLog -Message "FAILED $($script:Step): $reason$note"
  exit 1
}