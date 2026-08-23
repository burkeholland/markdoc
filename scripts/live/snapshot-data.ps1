# Hot snapshot of the live server's PGlite database, without stopping it.
# Calls GET /api/admin/backup (PGlite dumpDataDir as .tar.gz, gated by BACKUP_TOKEN) and writes
#   <Out>\markdoc-pglite.tar.gz
#   <Out>\manifest.json   { sha, takenAt, bytes, documents, users, port, sha256 }
# The board's snapshot job calls this every few minutes; it is read-only for the server.
#   .\snapshot-data.ps1 -Out C:\snapshots\markdoc
# Token: -Token, else $env:BACKUP_TOKEN, else BACKUP_TOKEN= in <live worktree>\.env.local.
# Exit 0 on success, 1 on any failure. Windows PowerShell 5.1 compatible.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Port = 3000,
  [string]$Token,
  # Live worktree; its HEAD sha goes into the manifest and its .env.local is the token fallback.
  [string]$Root,
  [int]$TimeoutSec = 300
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell's download progress bar makes -OutFile 50x slower.
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Root) { $Root = Join-Path (Get-FactoryRoot) 'markdoc-live' }

$Token = Resolve-BackupToken -Token $Token -Root $Root
if (-not $Token) {
  Write-Step "no BACKUP_TOKEN: pass -Token, set `$env:BACKUP_TOKEN or add BACKUP_TOKEN= to $Root\.env.local"
  exit 1
}

$health = Get-LiveHealth -Port $Port
if (-not $health -or -not $health.db) {
  Write-Step "server on :$Port is not healthy (db=$($health.db)); nothing snapshotted"
  exit 1
}

if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
$Out = (Resolve-Path -LiteralPath $Out).Path
$tarPath = Join-Path $Out 'markdoc-pglite.tar.gz'
$tmpPath = "$tarPath.part"
$manifestPath = Join-Path $Out 'manifest.json'

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
  Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
  exit 1
}
if ($resp.StatusCode -ne 200) {
  Write-Step "backup request returned HTTP $($resp.StatusCode)"
  Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
  exit 1
}

$bytes = (Get-Item -LiteralPath $tmpPath).Length
$magic = New-Object byte[] 2
$stream = [System.IO.File]::OpenRead($tmpPath)
try { $null = $stream.Read($magic, 0, 2) } finally { $stream.Dispose() }
if ($bytes -lt 1024 -or $magic[0] -ne 0x1f -or $magic[1] -ne 0x8b) {
  Write-Step "downloaded file is not a gzip tarball ($bytes bytes); discarded"
  Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
  exit 1
}
Move-Item -LiteralPath $tmpPath -Destination $tarPath -Force

$manifest = [ordered]@{
  sha       = $sha
  takenAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  bytes     = $bytes
  documents = [int]"$($resp.Headers['X-Markdoc-Documents'])"
  users     = [int]"$($resp.Headers['X-Markdoc-Users'])"
  port      = $Port
  file      = 'markdoc-pglite.tar.gz'
  sha256    = (Get-FileHash -LiteralPath $tarPath -Algorithm SHA256).Hash.ToLower()
  durationMs = [int]((Get-Date) - $started).TotalMilliseconds
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Step ("snapshot ok: {0} bytes, {1} documents, sha {2}, {3} ms -> {4}" -f $bytes, $manifest.documents, $sha, $manifest.durationMs, $Out)
exit 0
