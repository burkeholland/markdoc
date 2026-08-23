# Promote a commit from origin/main to the live test server, with rollback.
#   .\promote.ps1 -Sha <sha>
# Steps: fetch, verify sha is on origin/main, stop live, checkout --detach,
# npm ci (only if package.json / package-lock.json changed), delete .next,
# start-live. If health never returns 200, roll back to the previous sha.
param(
  [Parameter(Mandatory = $true)][string]$Sha,
  [string]$Root = 'C:\Dev\ai-experiments\FACTORY\markdoc-live',
  [int]$Port = 3000,
  [string]$LogPath = 'C:\Dev\ai-experiments\FACTORY\markdoc-data\live.log',
  [int]$TimeoutSec = 180
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$startLive = Join-Path $PSScriptRoot 'start-live.ps1'

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  # git writes progress to stderr; under PS 5.1 that would throw with ErrorActionPreference=Stop.
  $ErrorActionPreference = 'Continue'
  $out = & git -C $Root @GitArgs 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed: $($out -join "`n")" }
  return $out
}

function Test-DepsChanged {
  param([string]$From, [string]$To)
  $changed = @(Invoke-Git diff --name-only $From $To -- package.json package-lock.json)
  return ($changed.Count -gt 0)
}

function Invoke-NpmCi {
  Write-Step 'package.json / package-lock.json changed -> npm ci --ignore-scripts'
  Push-Location $Root
  try {
    $ErrorActionPreference = 'Continue'
    & npm ci --ignore-scripts 2>&1 | ForEach-Object { "$_" } | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Switch-LiveTo {
  # Stop, checkout, install deps if needed, clear .next, start. Returns $true on healthy.
  param([string]$From, [string]$To)
  Stop-LiveProcesses -Root $Root
  Write-Step "git checkout --detach $To"
  Invoke-Git checkout --detach $To | Out-Null
  if (Test-DepsChanged -From $From -To $To) { Invoke-NpmCi } else { Write-Step 'dependencies unchanged; skipping npm ci' }
  Remove-NextCache -Root $Root
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startLive -Root $Root -Port $Port -LogPath $LogPath -TimeoutSec $TimeoutSec -Restart | Out-Host
  return ($LASTEXITCODE -eq 0)
}

Write-Step "fetching origin in $Root"
Invoke-Git fetch origin --quiet | Out-Null

$target = (Invoke-Git rev-parse --verify "$Sha^{commit}") | Select-Object -First 1
& git -C $Root merge-base --is-ancestor $target origin/main
if ($LASTEXITCODE -ne 0) {
  Write-Step "$target is not on origin/main; refusing to promote"
  exit 1
}

$dirty = @(Invoke-Git status --porcelain --untracked-files=no)
if ($dirty.Count -gt 0) {
  Write-Step "live worktree $Root has local changes to tracked files; refusing to promote:`n$($dirty -join "`n")"
  exit 1
}

$previous = (Invoke-Git rev-parse HEAD) | Select-Object -First 1
Write-Step "promoting $previous -> $target"

if (Switch-LiveTo -From $previous -To $target) {
  Write-Step "PROMOTED: live server on :$Port now runs $target (was $previous)"
  exit 0
}

Write-Step "promotion of $target FAILED; rolling back to $previous"
Show-LogTail -LogPath $LogPath -Lines 30
if (Switch-LiveTo -From $target -To $previous) {
  Write-Step "ROLLED BACK: live server on :$Port runs $previous again"
} else {
  Write-Step "ROLLBACK FAILED: live server is down; inspect $LogPath"
}
exit 1
