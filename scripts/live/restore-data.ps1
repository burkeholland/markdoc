# Restore the live server's PGlite database from a snapshot made by snapshot-data.ps1.
#   .\restore-data.ps1 -From C:\snapshots\markdoc
# Stops the live server, moves the current data dir aside (pglite.bak-<timestamp>, never deleted),
# extracts the tarball with PGlite's own loader (restore-data.mjs), restarts the server via
# start-live.ps1 and verifies: /api/health db:true, GET /api/admin/backup?meta=1 documents ==
# manifest.documents, GET /api/documents with the dev login answers 200.
# -SkipServer: only do the data-dir part (nothing is stopped or started) — for a first restore
# before the server exists, or for a throwaway data dir in a test. NEVER point -DataDir at a
# directory a running server has open.
# Exit 0 on success, 1 on failure (the previous data dir is still in the .bak folder).
param(
  [Parameter(Mandatory = $true)][string]$From,
  # PGlite directory to replace; defaults to ../markdoc-data/pglite next to the repo.
  [string]$DataDir,
  # Live worktree (for stop/start); defaults to ../markdoc-live.
  [string]$Root,
  [int]$Port = 3000,
  [string]$Token,
  [int]$TimeoutSec = 180,
  [switch]$SkipServer
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $Root) { $Root = Join-Path (Get-FactoryRoot) 'markdoc-live' }
if (-not $DataDir) { $DataDir = Join-Path (Get-FactoryRoot) 'markdoc-data\pglite' }

$From = (Resolve-Path -LiteralPath $From).Path
$tarPath = Join-Path $From 'markdoc-pglite.tar.gz'
$manifestPath = Join-Path $From 'manifest.json'
if (-not (Test-Path -LiteralPath $tarPath)) { Write-Step "no markdoc-pglite.tar.gz in $From"; exit 1 }
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
else { Write-Step "warning: no manifest.json in $From; document count will not be verified" }
if ($manifest -and $manifest.sha256) {
  $actual = (Get-FileHash -LiteralPath $tarPath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $manifest.sha256) { Write-Step "tarball sha256 $actual does not match manifest $($manifest.sha256)"; exit 1 }
}

if (-not $SkipServer) {
  Write-Step "stopping live server in $Root"
  Stop-LiveProcesses -Root $Root
  if (Get-LiveHealth -Port $Port) { Write-Step "something still answers on :$Port after stopping $Root; refusing to touch $DataDir"; exit 1 }
}

$parent = Split-Path -Parent $DataDir
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
if (Test-Path -LiteralPath $DataDir) {
  $bak = "$DataDir.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Write-Step "moving current $DataDir -> $bak"
  Move-Item -LiteralPath $DataDir -Destination $bak
}

Write-Step "extracting $tarPath -> $DataDir (PGlite loadDataDir)"
# Native stderr under 2>&1 would become a terminating error with 'Stop' on PowerShell 5.1.
$ErrorActionPreference = 'Continue'
$out = & node (Join-Path $PSScriptRoot 'restore-data.mjs') --tar $tarPath --data-dir $DataDir 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$out | ForEach-Object { Write-Host "  $_" }
if ($code -ne 0) { Write-Step "restore-data.mjs failed with exit $code (cwd $repoRoot)"; exit 1 }
$result = ($out | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json
if ($manifest -and $null -ne $manifest.documents -and [int]$result.documents -ne [int]$manifest.documents) {
  Write-Step "restored $($result.documents) documents but the manifest records $($manifest.documents)"
  exit 1
}
Write-Step "data dir restored: $($result.documents) documents, $($result.users) users"

if ($SkipServer) { exit 0 }

& (Join-Path $PSScriptRoot 'start-live.ps1') -Root $Root -Port $Port -TimeoutSec $TimeoutSec -Restart
if ($LASTEXITCODE -ne 0) { Write-Step "server did not come back after restore"; exit 1 }
$health = Get-LiveHealth -Port $Port
if (-not $health -or -not $health.db) { Write-Step "/api/health db is not true after restore"; exit 1 }

$Token = Resolve-BackupToken -Token $Token -Root $Root
if ($Token) {
  $meta = Get-BackupMeta -Port $Port -Token $Token
  if (-not $meta) { Write-Step "GET /api/admin/backup?meta=1 failed after restore"; exit 1 }
  if ($manifest -and $null -ne $manifest.documents -and [int]$meta.documents -ne [int]$manifest.documents) {
    Write-Step "server reports $($meta.documents) documents, manifest records $($manifest.documents)"
    exit 1
  }
  Write-Step "server reports $($meta.documents) documents (manifest: $($manifest.documents))"
} else {
  Write-Step "warning: no BACKUP_TOKEN available; skipped the server-side document count check"
}
$docs = Get-DocumentsAsDevUser -Port $Port
if ($null -eq $docs) { Write-Step "GET /api/documents with the dev login failed"; exit 1 }
Write-Step "GET /api/documents ok ($(@($docs.documents).Count) documents for the check user)"
Write-Step "restore complete"
exit 0
