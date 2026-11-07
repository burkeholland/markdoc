#requires -Version 7.2
# Run: pwsh -NoProfile -File deploy/release-decision.tests.ps1
$ErrorActionPreference = 'Stop'
$script:Passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  $script:Passed++
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern, [string]$Message) {
  $thrown = $null
  try { & $Action } catch { $thrown = $_.Exception.Message }
  Assert-True ($thrown -cmatch $Pattern) "$Message (got: $thrown)"
}

$scriptPath = Join-Path $PSScriptRoot 'release-decision.ps1'
. $scriptPath

foreach ($doc in 'docs/a.md', 'docs/screens/a.png', 'README.md', 'CHANGELOG.md', 'deploy/github-actions-setup.md') {
  Assert-True (Test-ReleaseDocPath $doc) "$doc is documentation."
}
foreach ($code in 'src/a.md', 'public/a.md', 'extensions/markdoc/README.md', 'deploy/nested/a.md', 'deploy/release-vm.ps1',
    'docs', 'mydocs/a.md', 'README.mdx', 'README.MD', '.github/workflows/deploy.yml', 'package-lock.json', 'drizzle/0001.sql') {
  Assert-True (-not (Test-ReleaseDocPath $code)) "$code is not documentation."
}

$sha = 'a' * 40
$healthy = [pscustomobject]@{ ok = $true; db = $true; collab = $true; version = $sha }
Assert-True ((Get-ReleaseLiveVersion $healthy) -ceq $sha) 'A healthy response returns its version.'
foreach ($field in 'ok', 'db', 'collab') {
  foreach ($bad in $false, 'true', 1, $null) {
    $health = $healthy.PSObject.Copy()
    $health.$field = $bad
    Assert-Throws { Get-ReleaseLiveVersion $health } "$field is not true" "$field=$bad must not count as healthy."
  }
}
foreach ($bad in $null, 'dev', ('A' * 40), ('a' * 39), 7) {
  $health = $healthy.PSObject.Copy()
  $health.version = $bad
  Assert-Throws { Get-ReleaseLiveVersion $health } 'full 40-hex version' "version=$bad must be refused."
}
Assert-Throws { Get-ReleaseLiveVersion '<html>maintenance</html>' } 'ok is not true' 'A non-JSON body must be refused.'
Assert-Throws { Get-ReleaseHealth 'http://127.0.0.1:9/api/health' } 'Could not read production health' 'An unreachable endpoint must be an error.'

$repo = Join-Path ([IO.Path]::GetTempPath()) "markdoc-release-decision-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $repo | Out-Null
Push-Location $repo
try {
  function Invoke-Git { git -c user.name=test -c user.email=test@example.invalid -c core.autocrlf=false @args 2>&1 | Out-Null; if ($LASTEXITCODE) { throw "git $args failed" } }
  function Add-Commit([string]$Path, [string]$Text) {
    $dir = Split-Path $Path
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -LiteralPath $Path -Value $Text
    Invoke-Git add -A
    Invoke-Git commit -m $Path
    return (git rev-parse HEAD)
  }
  Invoke-Git init -q -b main
  $live = Add-Commit 'src/app.ts' 'one'

  $decision = Get-ReleaseDecision $live $live
  Assert-True (-not $decision.Release -and $decision.Reason -ceq 'nothing changed') 'The same commit does not release.'

  $docsOnly = Add-Commit 'docs/guide.md' 'guide'
  $docsOnly = Add-Commit 'README.md' 'readme'
  $decision = Get-ReleaseDecision $live $docsOnly
  Assert-True (-not $decision.Release -and $decision.Reason -cmatch '^only docs changed') 'A docs-only diff does not release.'

  $code = Add-Commit 'src/app.ts' 'two'
  $decision = Get-ReleaseDecision $live $code
  Assert-True ($decision.Release -and $decision.BeyondDocs -ccontains 'src/app.ts') 'A code diff releases.'

  $reverted = Add-Commit 'src/app.ts' 'one'
  $decision = Get-ReleaseDecision $docsOnly $reverted
  Assert-True (-not $decision.Release -and $decision.Reason -ceq 'nothing changed') 'A commit with no net change does not release.'

  Invoke-Git mv src/app.ts docs/app.ts
  Invoke-Git commit -m move
  $decision = Get-ReleaseDecision $docsOnly (git rev-parse HEAD)
  Assert-True ($decision.Release -and $decision.BeyondDocs -ccontains 'src/app.ts') 'Moving source into docs/ releases.'

  $tip = git rev-parse HEAD
  Invoke-Git checkout -q -b other $live
  $other = Add-Commit 'src/other.ts' 'other'
  Invoke-Git checkout -q main
  Assert-Throws { Get-ReleaseDecision $other $tip } 'not an ancestor' 'A version off main must be an error.'
  Assert-Throws { Get-ReleaseDecision ('0' * 40) $tip } 'not an ancestor' 'An unknown version must be an error.'
  Assert-Throws { Get-ReleaseDecision $tip $live } 'not an ancestor' 'Production ahead of main must be an error.'
} finally {
  Pop-Location
  Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "release decision tests passed: $script:Passed assertions"
