<#
  Decides whether the daily run of .github/workflows/deploy.yml releases. It reads production's health without
  using a cache and compares the version there with HEAD, which the workflow checks out from main. It writes
  release=true|false and sha=<HEAD> as step outputs. Unhealthy or unreadable production ends in an error.
  It needs only Git and public HTTPS: no Azure, no secrets, no production environment.
#>
[CmdletBinding()]
param([string]$HealthUrl = 'https://markdoc.app/api/health')

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Nothing here reaches the running app: the image copies only the build output, public/, drizzle/ and a few named
# files, and no source imports these paths. Any other path counts as a change, so a doubt releases rather than skips.
function Test-ReleaseDocPath([string]$Path) {
  return $Path -cmatch '^docs/' -or $Path -cmatch '^(deploy/)?[^/]+\.md$'
}

function Get-ReleaseHealth([string]$Url) {
  try {
    return Invoke-RestMethod -Uri "${Url}?nocache=$([guid]::NewGuid().ToString('N'))" `
      -Headers @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' } `
      -TimeoutSec 20 -MaximumRetryCount 2 -RetryIntervalSec 10
  } catch {
    throw "Could not read production health from ${Url}: $($_.Exception.Message)"
  }
}

function Get-ReleaseLiveVersion($Health) {
  foreach ($field in 'ok', 'db', 'collab') {
    $value = $Health.$field
    if ($value -isnot [bool] -or -not $value) { throw "Production is not healthy: $field is not true." }
  }
  $version = $Health.version
  if ($version -isnot [string] -or $version -cnotmatch '^[0-9a-f]{40}$') {
    throw 'Production health does not report a full 40-hex version.'
  }
  return $version
}

function Get-ReleaseDecision([string]$Live, [string]$Head) {
  git merge-base --is-ancestor $Live $Head 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Production reports $Live, which is not an ancestor of main at $Head." }
  # --no-renames lists both sides, so moving a source file into docs/ still counts as a change to that source file.
  $changed = @(git -c core.quotepath=off diff --name-only --no-renames $Live $Head)
  if ($LASTEXITCODE -ne 0) { throw "Could not compare $Live with $Head." }
  $beyondDocs = @($changed | Where-Object { -not (Test-ReleaseDocPath $_) })
  return [pscustomobject]@{
    Release = $beyondDocs.Count -gt 0
    Reason = if ($beyondDocs.Count -gt 0) { "$($beyondDocs.Count) changed path(s) beyond docs" }
      elseif ($changed.Count -gt 0) { "only docs changed ($($changed.Count) path(s))" }
      else { 'nothing changed' }
    BeyondDocs = $beyondDocs
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $head = (git rev-parse --verify HEAD)
  if ($LASTEXITCODE -ne 0 -or $head -cnotmatch '^[0-9a-f]{40}$') { throw 'Could not resolve HEAD.' }

  $live = Get-ReleaseLiveVersion (Get-ReleaseHealth $HealthUrl)
  $decision = Get-ReleaseDecision $live $head

  $outcome = if ($decision.Release) { 'Releasing' } else { 'No release' }
  $lines = @("**$outcome**: $($decision.Reason).", '', "- Production: ``$live``", "- main: ``$head``")
  $lines += @($decision.BeyondDocs | Select-Object -First 20 | ForEach-Object { "- ``$_``" })
  $lines | ForEach-Object { Write-Host $_ }
  if ($env:GITHUB_STEP_SUMMARY) { $lines | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
  if ($env:GITHUB_OUTPUT) {
    @("release=$(([string]$decision.Release).ToLowerInvariant())", "sha=$head") |
      Add-Content -LiteralPath $env:GITHUB_OUTPUT
  }
}
