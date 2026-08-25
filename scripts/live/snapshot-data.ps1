# Hot snapshot of the live server's PGlite database, without stopping it.
# Calls GET /api/admin/backup (PGlite dumpDataDir as .tar.gz, gated by BACKUP_TOKEN) and writes
#   <Out>\markdoc-pglite.tar.gz
#   <Out>\manifest.json   { sha, takenAt, bytes, documents, users, port, sha256 }
#   <Out>\auth-secret.enc.json   AUTH_SECRET sealed under FACTORY_STATE_KEY (env-vault.mjs); absent when the key is unset
# It is read-only for the server.
#   .\snapshot-data.ps1                      -Latest (the default when -Out is omitted)
#   .\snapshot-data.ps1 -Out C:\snapshots\markdoc
# -Latest writes <factory>\markdoc-data\snapshots\latest ATOMICALLY: the snapshot goes to latest.tmp, then
# latest -> prev, latest.tmp -> latest, prev deleted - a reader that copies `latest` (the board's 15-min
# factory-state snapshot, via factory-state.nominate.json) never sees a half-written tarball. It also keeps
# the newest -Keep (3) timestamped copies in <factory>\markdoc-data\snapshots\<yyyyMMdd-HHmmss>\ and prunes
# the rest. The "Markdoc snapshot" scheduled task (install-autostart.ps1) runs this every 15 minutes.
# Token: -Token, else $env:BACKUP_TOKEN, else BACKUP_TOKEN= in <live worktree>\.env.local.
# Health: /api/health is polled (1 s) for up to -HealthTimeoutSec (60) until db=true; a cold server's first
# /api/health can take several seconds while Next.js compiles the route.
# Exit 0 on success, 1 on any failure (an existing `latest` is left untouched). Windows PowerShell 5.1 compatible.
param(
  [string]$Out,
  [switch]$Latest,
  [int]$Keep = 3,
  [int]$Port = 3000,
  [string]$Token,
  # Live worktree; its HEAD sha goes into the manifest and its .env.local is the token fallback.
  [string]$Root,
  [int]$TimeoutSec = 300,
  [int]$HealthTimeoutSec = 60
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell's download progress bar makes -OutFile 50x slower.
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) { $Root = Join-Path (Get-FactoryRoot) 'markdoc-live' }
if (-not $Out) { $Latest = $true }
if ($Latest -and $Out) { Write-Step "-Latest and -Out are exclusive"; exit 1 }

$snapRoot = $null
if ($Latest) {
  $snapRoot = Join-Path (Get-FactoryRoot) 'markdoc-data\snapshots'
  if (-not (Test-Path $snapRoot)) { New-Item -ItemType Directory -Path $snapRoot -Force | Out-Null }
  $Out = Join-Path $snapRoot 'latest.tmp'
  # Leftover from a run that was killed mid-download.
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
}

$Token = Resolve-BackupToken -Token $Token -Root $Root
if (-not $Token) {
  Write-Step "no BACKUP_TOKEN: pass -Token, set `$env:BACKUP_TOKEN or add BACKUP_TOKEN= to $Root\.env.local"
  exit 1
}

$health = Wait-LiveHealth -Port $Port -TimeoutSec $HealthTimeoutSec
if (-not $health -or $health.db -ne $true) {
  Write-Step "server on :$Port is not healthy after ${HealthTimeoutSec}s (db=$($health.db)); nothing snapshotted"
  exit 1
}

if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
$Out = (Resolve-Path -LiteralPath $Out).Path
$tarPath = Join-Path $Out 'markdoc-pglite.tar.gz'
$tmpPath = "$tarPath.part"
$manifestPath = Join-Path $Out 'manifest.json'
function Remove-PartialDownload {
  Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
  # With -Latest the whole latest.tmp folder is scratch; without it, leave the caller's folder alone.
  if ($Latest) { Remove-Item -LiteralPath $Out -Recurse -Force -ErrorAction SilentlyContinue }
}

$sha = $null
if (Test-Path (Join-Path $Root '.git')) {
  try { $sha = (& git -C $Root rev-parse HEAD 2>$null).Trim() } catch { $sha = $null }
}

Write-Step "GET http://localhost:$Port/api/admin/backup -> $tarPath"
$started = Get-Date
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/admin/backup" `
    -Headers @{ 'X-Backup-Token' = $Token } -OutFile $tmpPath -PassThru -TimeoutSec $TimeoutSec
} catch {
  Write-Step "backup request failed: $($_.Exception.Message)"
  Remove-PartialDownload
  exit 1
}
if ($resp.StatusCode -ne 200) {
  Write-Step "backup request returned HTTP $($resp.StatusCode)"
  Remove-PartialDownload
  exit 1
}

$bytes = (Get-Item -LiteralPath $tmpPath).Length
$magic = New-Object byte[] 2
$stream = [System.IO.File]::OpenRead($tmpPath)
try { $null = $stream.Read($magic, 0, 2) } finally { $stream.Dispose() }
if ($bytes -lt 1024 -or $magic[0] -ne 0x1f -or $magic[1] -ne 0x8b) {
  Write-Step "downloaded file is not a gzip tarball ($bytes bytes); discarded"
  Remove-PartialDownload
  exit 1
}
Move-Item -LiteralPath $tmpPath -Destination $tarPath -Force

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
  $latestDir = Join-Path $snapRoot 'latest'
  $prevDir = Join-Path $snapRoot 'prev'
  # Swap: a reader copying `latest` sees the old complete folder, a brief absence, or the new complete folder.
  if (Test-Path -LiteralPath $prevDir) { Remove-Item -LiteralPath $prevDir -Recurse -Force }
  if (Test-Path -LiteralPath $latestDir) { Move-Item -LiteralPath $latestDir -Destination $prevDir }
  Move-Item -LiteralPath $Out -Destination $latestDir
  if (Test-Path -LiteralPath $prevDir) { Remove-Item -LiteralPath $prevDir -Recurse -Force }
  $Out = $latestDir

  # Timestamped copy (local time of takenAt) and prune to the newest -Keep.
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

Write-Step ("snapshot ok: {0} bytes, {1} documents, sha {2}, {3} ms -> {4}" -f $bytes, $manifest.documents, $sha, $manifest.durationMs, $Out)
exit 0
