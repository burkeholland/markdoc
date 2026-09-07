#requires -Version 7.2
$ErrorActionPreference = 'Stop'

$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  $script:Passed++
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ($Expected -cne $Actual) {
    throw "Assertion failed: $Message Expected '$Expected', received '$Actual'."
  }
  $script:Passed++
}

function Assert-Rejected([scriptblock]$Action, [string]$Message, [string]$ExpectedMessage = '') {
  try {
    & $Action
  } catch [InvalidOperationException] {
    if ($ExpectedMessage -and $_.Exception.Message -cne $ExpectedMessage) {
      throw "Assertion failed: $Message Unexpected failure '$($_.Exception.Message)'."
    }
    $script:Passed++
    return $_.Exception
  }
  throw "Assertion failed: $Message"
}

$releasePath = Join-Path $PSScriptRoot 'release-vm.ps1'
$tokens = $null
$parseErrors = $null
$releaseAst = [Management.Automation.Language.Parser]::ParseFile(
  $releasePath,
  [ref]$tokens,
  [ref]$parseErrors
)
Assert-Equal 0 $parseErrors.Count 'The release entrypoint must parse.'

function Get-ReleaseFunctionAst([string]$Name) {
  $matches = @($releaseAst.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name
  }, $true))
  Assert-Equal 1 $matches.Count "Function $Name must remain uniquely identifiable."
  return $matches[0]
}

$entrySource = (Get-ReleaseFunctionAst 'Invoke-MarkdocVmRelease').Extent.Text
$sourceCheck = $entrySource.IndexOf('Assert-ReleaseSource $Commit')
$preflight = $entrySource.IndexOf('Assert-ReleaseDependencyPreflight $Commit')
$secondSourceCheck = $entrySource.IndexOf('Assert-ReleaseSource $Commit', $sourceCheck + 1)
$azure = $entrySource.IndexOf("Invoke-ReleaseAz @('account', 'show'")
$archive = $entrySource.IndexOf("Invoke-ReleaseStep 'git' @('archive'")
Assert-True (
  $sourceCheck -ge 0 -and
  $preflight -gt $sourceCheck -and
  $secondSourceCheck -gt $preflight -and
  $azure -gt $secondSourceCheck -and
  $archive -gt $azure
) 'The preflight must follow exact clean-source validation and finish before Azure or archive work.'
Assert-Equal 1 ([regex]::Matches($entrySource, 'Assert-ReleaseDependencyPreflight \$Commit').Count) 'The release path must invoke the preflight exactly once.'

$preflightAst = Get-ReleaseFunctionAst 'Assert-ReleaseDependencyPreflight'
$auditCalls = @($preflightAst.Body.FindAll({
  param($node)
  $node -is [Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -ceq 'Invoke-ReleaseStep' -and
    $node.Extent.Text -match "'npm'"
}, $true))
Assert-Equal 1 $auditCalls.Count 'The preflight must contain one package-manager invocation.'
$auditSource = $auditCalls[0].Extent.Text
Assert-True (
  $auditSource -match "'dependency:preflight'" -and
  $auditSource.Contains("'--lock-sha256', `$lockIdentity") -and
  $auditSource -match "'--run-audit'" -and
  $auditSource -notmatch '--audit-json'
) 'The package-manager invocation must use the in-memory audit mode bound to the committed lock identity.'
$ancestor = $auditCalls[0].Parent
while ($ancestor -and $ancestor -ne $preflightAst) {
  Assert-True ($ancestor -isnot [Management.Automation.Language.LoopStatementAst]) 'The audit invocation must not be inside a retry loop.'
  $ancestor = $ancestor.Parent
}

foreach ($name in @(
  'ConvertFrom-ReleaseJson',
  'Get-ReleaseSha256',
  'Assert-ReleaseWorkingLock',
  'Get-ReleaseCommittedLockIdentity',
  'Test-ReleaseExactKeys',
  'Assert-ReleaseDependencyReport',
  'Assert-ReleaseDependencyPreflight'
)) {
  . ([scriptblock]::Create((Get-ReleaseFunctionAst $name).Extent.Text))
}

function Stop-VmRelease([string]$Message, [int]$ExitCode = 1) {
  $failure = [InvalidOperationException]::new($Message)
  $failure.Data['ReleaseExitCode'] = $ExitCode
  throw $failure
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "markdoc-release-preflight-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $testRoot)
$sourceRoot = $testRoot
$commit = '0123456789abcdef0123456789abcdef01234567'
$committedBytes = [Text.UTF8Encoding]::new($false).GetBytes("{`"lockfileVersion`":3}`n")
$script:ByteCommand = $null
$script:ByteArguments = $null

function Invoke-ReleaseStepBytes([string]$Command, [string[]]$Arguments, [int]$Limit = 30) {
  $script:ByteCommand = $Command
  $script:ByteArguments = $Arguments
  return ,$committedBytes
}

try {
  [IO.File]::WriteAllBytes((Join-Path $testRoot 'package-lock.json'), $committedBytes)
  $identity = Get-ReleaseCommittedLockIdentity $commit
  $expectedIdentity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($committedBytes)).ToLowerInvariant()
  Assert-Equal $expectedIdentity $identity 'The release identity must hash the exact committed bytes.'
  Assert-Equal 'git' $script:ByteCommand 'Committed lock materialization must use Git.'
  Assert-Equal 'cat-file' $script:ByteArguments[0] 'Committed lock materialization must read the blob without text conversion.'
  Assert-Equal 'blob' $script:ByteArguments[1] 'Committed lock materialization must request exact blob bytes.'
  Assert-Equal "$commit`:package-lock.json" $script:ByteArguments[2] 'The dependency lock must be selected from the already verified commit.'

  [IO.File]::WriteAllBytes(
    (Join-Path $testRoot 'package-lock.json'),
    [Text.UTF8Encoding]::new($false).GetBytes("{`"lockfileVersion`":3,`"mutated`":true}`n")
  )
  [void](Assert-Rejected {
    [void](Get-ReleaseCommittedLockIdentity $commit)
  } 'A working lock mismatch must fail before audit execution.')
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}

$zeroCounts = [ordered]@{
  blocked = 0
  info = 0
  low = 0
  moderate = 0
  high = 0
  critical = 0
  vulnerabilities = 0
  reported = 0
  omitted = 0
}
$passReport = [ordered]@{
  status = 'pass'
  counts = $zeroCounts
  packages = @()
}
$script:AuditOutput = $passReport | ConvertTo-Json -Compress -Depth 4
$script:AuditThrows = $false
$script:FinalLockFails = $false
$script:Events = [Collections.Generic.List[string]]::new()
$sensitiveMarker = 'sensitive-audit-output-must-not-appear'

function Get-ReleaseCommittedLockIdentity([string]$Commit) {
  $script:Events.Add('identity')
  return 'a' * 64
}

function Invoke-ReleaseStep([string]$Command, [string[]]$Arguments, [int]$Limit = 30) {
  $script:Events.Add('audit')
  if ($script:AuditThrows) { throw [InvalidOperationException]::new($sensitiveMarker) }
  return $script:AuditOutput
}

function Assert-ReleaseWorkingLock([string]$ExpectedSha256) {
  $script:Events.Add('lock')
  if ($script:FinalLockFails) { throw [IO.IOException]::new($sensitiveMarker) }
}

Assert-ReleaseDependencyPreflight $commit
$script:Events.Add('azure')
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'A valid zero-count pass must continue to the first provider operation.'

$script:Events.Clear()
$script:FinalLockFails = $true
$mutationFailure = Assert-Rejected {
  Assert-ReleaseDependencyPreflight $commit
  $script:Events.Add('azure')
} 'A lock mutation after the audit must stop provider continuation.' 'Dependency preflight failed; raw output withheld.'
Assert-Equal 'identity,audit,lock' ($script:Events -join ',') 'A post-audit lock mutation must fail before the first provider operation.'
Assert-Equal 1 @($script:Events | Where-Object { $_ -ceq 'audit' }).Count 'Mutation failure must not retry the audit.'
Assert-True (-not $mutationFailure.Message.Contains($sensitiveMarker)) 'Mutation failure must withhold internal output.'

$script:FinalLockFails = $false
$nonzeroCounts = [ordered]@{}
foreach ($field in $zeroCounts.Keys) { $nonzeroCounts[$field] = $zeroCounts[$field] }
$nonzeroCounts['high'] = 1
foreach ($invalidOutput in @(
  (([ordered]@{ status = 'rejected'; counts = $zeroCounts; packages = @() }) | ConvertTo-Json -Compress -Depth 4),
  (([ordered]@{ status = 'pass'; counts = $nonzeroCounts; packages = @() }) | ConvertTo-Json -Compress -Depth 4),
  ($script:AuditOutput + "`n" + $sensitiveMarker)
)) {
  $script:Events.Clear()
  $script:AuditOutput = $invalidOutput
  $failure = Assert-Rejected {
    Assert-ReleaseDependencyPreflight $commit
    $script:Events.Add('azure')
  } 'A non-pass, nonzero-count or extra-output report must fail closed.' 'Dependency preflight failed; raw output withheld.'
  Assert-Equal 1 @($script:Events | Where-Object { $_ -ceq 'audit' }).Count 'A rejected report must invoke the audit exactly once.'
  Assert-True (-not $script:Events.Contains('azure')) 'A rejected report must stop before the first provider operation.'
  Assert-True (-not $failure.Message.Contains($sensitiveMarker)) 'A rejected report must not expose raw output.'
}

$script:Events.Clear()
$script:AuditThrows = $true
$commandFailure = Assert-Rejected {
  Assert-ReleaseDependencyPreflight $commit
  $script:Events.Add('azure')
} 'A package-manager failure must fail closed.' 'Dependency preflight failed; raw output withheld.'
Assert-Equal 1 @($script:Events | Where-Object { $_ -ceq 'audit' }).Count 'A package-manager failure must not retry.'
Assert-True (-not $script:Events.Contains('azure')) 'A package-manager failure must stop before the first provider operation.'
Assert-True (-not $commandFailure.Message.Contains($sensitiveMarker)) 'A package-manager failure must withhold raw output.'

Write-Host "release VM dependency preflight tests passed: $script:Passed assertions"
