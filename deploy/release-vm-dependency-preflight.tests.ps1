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

$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw |
  ConvertFrom-Json -AsHashtable
$preflightCommand = $package['scripts']['dependency:preflight']
Assert-Equal 'node --no-warnings --experimental-strip-types scripts/dependency-policy-preflight.mts' $preflightCommand `
  'The package preflight must run on trusted Node without installed dependencies.'
Assert-True ($preflightCommand -notmatch '\btsx\b') 'The package preflight must not require the tsx development dependency.'
$currentLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package-lock.json') -Raw |
  ConvertFrom-Json -AsHashtable
Assert-Equal '3.1.5' $currentLock['packages']['node_modules/fast-uri']['version'] `
  'The current lock must remain blocked on fast-uri 3.1.5.'
Assert-Equal '6.15.3' $currentLock['packages']['node_modules/qs']['version'] `
  'The current lock must remain blocked on qs 6.15.3.'

$workflowSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\.github\workflows\deploy.yml') -Raw
$checkout = $workflowSource.IndexOf('actions/checkout@v4')
$setupNode = $workflowSource.IndexOf('actions/setup-node@v5')
$azureLogin = $workflowSource.IndexOf('azure/login@v2')
$release = $workflowSource.IndexOf('./deploy/release-vm.ps1')
Assert-Equal 1 ([regex]::Matches($workflowSource, 'actions/setup-node@v5').Count) 'The workflow must set up Node exactly once.'
Assert-Equal 1 ([regex]::Matches($workflowSource, '\./deploy/release-vm\.ps1').Count) 'The workflow must retain one release orchestrator.'
Assert-True ($workflowSource -match 'node-version:\s*22') 'The workflow must select Node 22 for native type stripping.'
Assert-True (
  $checkout -ge 0 -and
  $setupNode -gt $checkout -and
  $azureLogin -gt $setupNode -and
  $release -gt $azureLogin
) 'The clean checkout must receive Node 22 before login and the single release orchestrator.'

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

function Invoke-FreshCopyPreflight([string]$Directory, [string[]]$Arguments) {
  $npm = (Get-Command 'npm' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $quoted = @($npm, 'run', '--silent', 'dependency:preflight', '--') + $Arguments |
    ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
  $source = "`$ErrorActionPreference = 'Stop'; `$LASTEXITCODE = 1; & $($quoted -join ' '); exit `$LASTEXITCODE"
  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $Directory
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @(
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
  )) {
    $start.ArgumentList.Add($argument)
  }
  $start.Environment['NPM_CONFIG_AUDIT'] = 'false'
  $start.Environment['NPM_CONFIG_FUND'] = 'false'
  $start.Environment['NPM_CONFIG_UPDATE_NOTIFIER'] = 'false'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
      $process.Kill($true)
      throw 'Fresh-copy preflight exceeded its local test deadline.'
    }
    [void]$stderr.GetAwaiter().GetResult()
    return @{
      ExitCode = $process.ExitCode
      Output = $stdout.GetAwaiter().GetResult().Trim()
    }
  } finally {
    $process.Dispose()
  }
}

$freshRoot = Join-Path ([IO.Path]::GetTempPath()) "markdoc-dependency-fresh-$([guid]::NewGuid().ToString('N'))"
$freshScripts = Join-Path $freshRoot 'scripts'
$freshLib = Join-Path $freshScripts 'lib'
[void](New-Item -ItemType Directory -Path $freshLib -Force)
try {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Destination $freshRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\dependency-policy-preflight.mts') -Destination $freshScripts
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\scripts\lib\dependency-policy.ts') -Destination $freshLib

  $lockText = '{"name":"fresh-copy","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fresh-copy","version":"1.0.0"},"node_modules/unsafe-package":{"version":"1.2.3"}}}'
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText((Join-Path $freshRoot 'package-lock.json'), $lockText, $utf8)
  $lockIdentity = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($utf8.GetBytes($lockText))
  ).ToLowerInvariant()
  $dependencyCounts = [ordered]@{ prod = 1; dev = 0; optional = 0; peer = 0; peerOptional = 0; total = 1 }
  $passAudit = [ordered]@{
    auditReportVersion = 2
    vulnerabilities = [ordered]@{}
    metadata = [ordered]@{
      vulnerabilities = [ordered]@{ info = 0; low = 0; moderate = 0; high = 0; critical = 0; total = 0 }
      dependencies = $dependencyCounts
    }
  }
  $auditPath = Join-Path $freshRoot 'audit.json'
  [IO.File]::WriteAllText($auditPath, ($passAudit | ConvertTo-Json -Compress -Depth 8), $utf8)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $freshRoot 'node_modules'))) `
    'The fresh-copy preflight fixture must not contain node_modules.'

  $arguments = @('--lock-sha256', $lockIdentity, '--audit-json', $auditPath)
  $passExecution = Invoke-FreshCopyPreflight $freshRoot $arguments
  Assert-Equal 0 $passExecution.ExitCode 'The exact package preflight command must pass without node_modules.'
  $passResult = ConvertFrom-Json -InputObject $passExecution.Output -AsHashtable
  Assert-Equal 'pass' $passResult['status'] 'The fresh-copy preflight must accept a complete zero-finding audit.'

  $rejectedAudit = [ordered]@{
    auditReportVersion = 2
    vulnerabilities = [ordered]@{
      'unsafe-package' = [ordered]@{
        name = 'unsafe-package'
        severity = 'high'
        isDirect = $true
        via = @([ordered]@{
          source = 1
          name = 'unsafe-package'
          dependency = 'unsafe-package'
          title = 'synthetic test advisory'
          url = 'https://registry.invalid/advisory'
          severity = 'high'
          cwe = @('CWE-0')
          cvss = [ordered]@{ score = 5; vectorString = 'CVSS:3.1/AV:N' }
          range = '<99.0.0'
        })
        effects = @()
        range = '<99.0.0'
        nodes = @('node_modules/unsafe-package')
        fixAvailable = $false
      }
    }
    metadata = [ordered]@{
      vulnerabilities = [ordered]@{ info = 0; low = 0; moderate = 0; high = 1; critical = 0; total = 1 }
      dependencies = $dependencyCounts
    }
  }
  [IO.File]::WriteAllText($auditPath, ($rejectedAudit | ConvertTo-Json -Compress -Depth 8), $utf8)
  $rejectExecution = Invoke-FreshCopyPreflight $freshRoot $arguments
  Assert-Equal 1 $rejectExecution.ExitCode 'The exact package preflight command must reject a synthetic vulnerability.'
  $rejectResult = ConvertFrom-Json -InputObject $rejectExecution.Output -AsHashtable
  Assert-Equal 'rejected' $rejectResult['status'] 'The fresh-copy preflight must report a rejected policy result.'
  Assert-Equal 1 $rejectResult['counts']['high'] 'The fresh-copy rejection must retain the sanitized severity count.'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $freshRoot 'node_modules'))) `
    'The exact preflight command must not create node_modules.'
} finally {
  Remove-Item -LiteralPath $freshRoot -Recurse -Force
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
