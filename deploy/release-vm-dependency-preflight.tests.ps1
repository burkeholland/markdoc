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
Assert-Equal '3.1.8' $currentLock['packages']['node_modules/fast-uri']['version'] `
  'The current lock must retain the remediated fast-uri version.'
Assert-Equal '6.16.0' $currentLock['packages']['node_modules/qs']['version'] `
  'The current lock must retain the remediated qs version.'

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

  # GHSA-vcvr-r3jv-pc5j came from npm with cvss.vectorString null (#2195); it is a finding, not malformed output.
  $nullVectorAdvisory = $rejectedAudit['vulnerabilities']['unsafe-package']['via'][0]
  $nullVectorAdvisory['cvss'] = [ordered]@{ score = 0; vectorString = $null }
  $nullVectorAdvisory['cwe'] = @()
  [IO.File]::WriteAllText($auditPath, ($rejectedAudit | ConvertTo-Json -Compress -Depth 8), $utf8)
  Assert-True ((Get-Content -LiteralPath $auditPath -Raw).Contains('"vectorString":null')) `
    'The fresh-copy fixture must carry a null CVSS vector.'
  $nullVectorExecution = Invoke-FreshCopyPreflight $freshRoot $arguments
  Assert-Equal 1 $nullVectorExecution.ExitCode 'The exact package preflight command must reject an advisory with a null CVSS vector.'
  $nullVectorResult = ConvertFrom-Json -InputObject $nullVectorExecution.Output -AsHashtable
  Assert-Equal 'rejected' $nullVectorResult['status'] 'A null CVSS vector must be a rejection, not malformed audit output.'
  Assert-Equal 'unsafe-package' $nullVectorResult['packages'][0]['name'] 'The null-vector rejection must name the package.'
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
  'Get-ReleaseAcceptedDependencyAdvisories',
  'Assert-ReleaseDependencyReport',
  'Get-ReleaseDependencyFailureDetail',
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

# Accepted advisories (#2260). Every date is built from the current UTC day, so this suite does not change when a
# real list entry expires or is deleted.
$utcToday = [DateTime]::UtcNow.Date
function Format-TestDay([datetime]$Day) {
  return $Day.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
}
$today = Format-TestDay $utcToday
$tomorrow = Format-TestDay $utcToday.AddDays(1)
$yesterday = Format-TestDay $utcToday.AddDays(-1)
# The exact bytes scripts/lib/dependency-policy.test.ts pins as ACCEPTED_OUTPUT, with only the date replaced.
$acceptedTemplate = '{"status":"accepted","counts":{"blocked":0,"info":0,"low":0,"moderate":0,"high":5,"critical":0,"vulnerabilities":5,"reported":5,"omitted":0},' +
  '"packages":[{"name":"@next/eslint-plugin-next","version":"16.3.6","status":"dependent"},{"name":"braces","version":"3.0.3","status":"accepted"},' +
  '{"name":"eslint-config-next","version":"16.3.6","status":"dependent"},{"name":"fast-glob","version":"3.3.1","status":"dependent"},' +
  '{"name":"micromatch","version":"4.0.8","status":"dependent"}],' +
  '"exceptions":[{"advisory":"GHSA-vfj7-8cjw-p6xm","package":"braces","version":"3.0.3","expires":"EXPIRES"}]}'
function New-AcceptedOutput([string]$Expires = $tomorrow) {
  return $acceptedTemplate.Replace('EXPIRES', $Expires)
}
function New-AcceptedReport([string]$Expires = $tomorrow) {
  return ConvertFrom-Json -InputObject (New-AcceptedOutput $Expires) -AsHashtable -NoEnumerate
}
function Get-AcceptedWarning([string]$Advisory, [string]$Package, [string]$Expires) {
  return "Release warning: dependency advisory accepted; advisory=$Advisory; package=$Package; expires=$Expires."
}
$script:AuditOutput = $passReport | ConvertTo-Json -Compress -Depth 4
$script:AuditThrows = $false
$script:AuditFailureOutput = $null
$script:KeptFailureOutput = $false
$script:FinalLockFails = $false
$script:Events = [Collections.Generic.List[string]]::new()
$sensitiveMarker = 'sensitive-audit-output-must-not-appear'

function Get-ReleaseCommittedLockIdentity([string]$Commit) {
  $script:Events.Add('identity')
  return 'a' * 64
}

function Invoke-ReleaseStep([string]$Command, [string[]]$Arguments, [int]$Limit = 30, [switch]$KeepFailureOutput) {
  $script:Events.Add('audit')
  $script:KeptFailureOutput = $KeepFailureOutput.IsPresent
  if ($script:AuditThrows) { throw [InvalidOperationException]::new($sensitiveMarker) }
  if ($null -ne $script:AuditFailureOutput) {
    # Mirrors Invoke-ReleaseNative when the preflight exits nonzero.
    $failure = [InvalidOperationException]::new('Native command failed (exit 1); raw output withheld.')
    $failure.Data['ReleaseExitCode'] = 1
    if ($KeepFailureOutput) { $failure.Data['ReleaseFailureOutput'] = $script:AuditFailureOutput }
    throw $failure
  }
  return $script:AuditOutput
}

function Assert-ReleaseWorkingLock([string]$ExpectedSha256) {
  $script:Events.Add('lock')
  if ($script:FinalLockFails) { throw [IO.IOException]::new($sensitiveMarker) }
}

Assert-ReleaseDependencyPreflight $commit
$script:Events.Add('azure')
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'A valid zero-count pass must continue to the first provider operation.'
Assert-True $script:KeptFailureOutput 'The preflight must ask the native boundary to keep its structured failure report.'

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

# A nonzero preflight exit may show only an allowed status and, for command_failed, a reason that fits the fixed
# reason grammar. Any other reason, including one with extra text, prints only the plain withheld message.
$script:AuditThrows = $false
function ConvertTo-TestReport([System.Collections.IDictionary]$Report) {
  return $Report | ConvertTo-Json -Compress -Depth 6
}
function New-FailedAuditReport($Reason) {
  return ConvertTo-TestReport ([ordered]@{ status = 'command_failed'; counts = $zeroCounts; packages = @(); reason = $Reason })
}
$withheld = 'Dependency preflight failed; raw output withheld.'
$lettersOnlyPat = 'abcdefghijklmnopqrstuvwxyz' * 2
$base64Credential = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('bot:FakePass9!'))
$longestReason = 'npm audit could not start (E' + ('X' * 24) + '), npm code E' + ('Y' * 24) + ' (attempt 2 of 2)'
$detailCases = [Collections.Generic.List[hashtable]]::new()
foreach ($shownReason in @(
  'npm audit exit 1',
  'npm audit exit 0',
  'npm audit exit 1, npm code ECONNRESET (attempt 2 of 2)',
  'npm audit exit 3221225477, npm code E401',
  'npm audit timed out (attempt 2 of 2)',
  'npm audit ended by signal SIGKILL',
  'npm audit ended without an exit code',
  'npm audit could not start',
  'npm audit could not start (ENOENT)',
  $longestReason
)) {
  $detailCases.Add(@{
    Why = "The reason '$shownReason' fits the reason grammar and must be shown."
    Output = New-FailedAuditReport $shownReason
    Message = "Dependency preflight failed (status command_failed; reason: $shownReason); raw output withheld."
  })
}
foreach ($hiddenReason in @(
  @{ Why = 'Free text from npm'; Reason = "npm audit exit 1 (attempt 2 of 2): npm error $sensitiveMarker"; Secret = $sensitiveMarker },
  @{ Why = 'A token made only of letters'; Reason = "npm audit exit 1, $lettersOnlyPat"; Secret = $lettersOnlyPat },
  @{ Why = 'A token made only of letters in the code position'; Reason = "npm audit exit 1, npm code E$lettersOnlyPat"; Secret = $lettersOnlyPat },
  @{
    Why = 'An upper-case token in the code position'
    Reason = "npm audit exit 1, npm code E$($lettersOnlyPat.ToUpperInvariant())"
    Secret = $lettersOnlyPat.ToUpperInvariant()
  },
  @{ Why = 'A base64 credential in the code position'; Reason = "npm audit exit 1, npm code E$base64Credential"; Secret = $base64Credential },
  @{ Why = 'A base64 credential after the reason'; Reason = "npm audit exit 1 $base64Credential"; Secret = $base64Credential },
  @{ Why = 'A code of 25 characters after the E'; Reason = 'npm audit exit 1, npm code E' + ('A' * 25); Secret = 'A' * 25 },
  @{ Why = 'A lower-case code'; Reason = 'npm audit exit 1, npm code e401'; Secret = '' },
  @{ Why = 'Text after a valid reason'; Reason = "npm audit exit 1 $sensitiveMarker"; Secret = $sensitiveMarker },
  @{ Why = 'A trailing line feed'; Reason = "npm audit exit 1`n"; Secret = '' },
  @{ Why = 'A second line'; Reason = "npm audit exit 1`n$sensitiveMarker"; Secret = $sensitiveMarker },
  @{ Why = 'A trailing carriage return and line feed'; Reason = "npm audit exit 1`r`n"; Secret = '' },
  @{ Why = 'An escape sequence'; Reason = "npm audit exit 1$([char]27)[31m"; Secret = '' },
  @{ Why = 'A trailing no-break space'; Reason = "npm audit exit 1$([char]0xA0)"; Secret = '' },
  @{ Why = 'An exit code with a leading zero'; Reason = 'npm audit exit 01'; Secret = '' },
  @{ Why = 'A negative exit code'; Reason = 'npm audit exit -1'; Secret = '' },
  @{ Why = 'An exit code longer than 10 digits'; Reason = 'npm audit exit 12345678901'; Secret = '' },
  @{ Why = 'A digit outside ASCII'; Reason = "npm audit exit $([char]0x0661)"; Secret = '' },
  @{ Why = 'A digit outside ASCII after the first digit'; Reason = "npm audit exit 1$([char]0x0661)"; Secret = '' },
  @{ Why = 'A digit outside ASCII in the attempt number'; Reason = "npm audit exit 1 (attempt $([char]0x0662) of 2)"; Secret = '' },
  @{ Why = 'A lower-case signal'; Reason = 'npm audit ended by signal sigterm'; Secret = '' },
  @{ Why = 'A different letter case'; Reason = 'NPM audit exit 1'; Secret = '' },
  @{ Why = 'An attempt number above 9'; Reason = 'npm audit exit 1 (attempt 10 of 10)'; Secret = '' },
  @{ Why = 'An empty reason'; Reason = ''; Secret = '' },
  @{ Why = 'A null reason'; Reason = $null; Secret = '' }
)) {
  $detailCases.Add(@{
    Why = "$($hiddenReason.Why) must be withheld."
    Output = New-FailedAuditReport $hiddenReason.Reason
    Message = $withheld
    Secret = $hiddenReason.Secret
  })
}
$detailCases.Add(@{
  Why = 'A reason that is not a string must be withheld.'
  Output = ConvertTo-TestReport ([ordered]@{ status = 'command_failed'; counts = $zeroCounts; packages = @(); reason = @('npm audit exit 1') })
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'A command failure without a reason must be withheld.'
  Output = ConvertTo-TestReport ([ordered]@{ status = 'command_failed'; counts = $zeroCounts; packages = @() })
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'Only the status and reason may be shown, never other report fields.'
  Output = ConvertTo-TestReport ([ordered]@{
    status = 'command_failed'
    counts = $zeroCounts
    packages = @()
    reason = 'npm audit exit 1'
    detail = $sensitiveMarker
  })
  Message = 'Dependency preflight failed (status command_failed; reason: npm audit exit 1); raw output withheld.'
})
$detailCases.Add(@{
  Why = 'A rejected audit must show its status and nothing else.'
  Output = ConvertTo-TestReport ([ordered]@{
    status = 'rejected'
    counts = $nonzeroCounts
    packages = @([ordered]@{ name = $sensitiveMarker; version = '1.0.0'; status = 'vulnerable' })
  })
  Message = 'Dependency preflight failed (status rejected); raw output withheld.'
})
$detailCases.Add(@{
  Why = 'Only a command failure may carry a reason.'
  Output = ConvertTo-TestReport ([ordered]@{ status = 'malformed_audit'; counts = $zeroCounts; packages = @(); reason = $sensitiveMarker })
  Message = 'Dependency preflight failed (status malformed_audit); raw output withheld.'
})
$detailCases.Add(@{
  Why = 'Only a command failure may carry a reason, even one that fits the reason grammar.'
  Output = ConvertTo-TestReport ([ordered]@{ status = 'malformed_audit'; counts = $zeroCounts; packages = @(); reason = 'npm audit timed out' })
  Message = 'Dependency preflight failed (status malformed_audit); raw output withheld.'
})
$detailCases.Add(@{
  Why = 'A pass status on a nonzero exit must not be shown.'
  Output = ConvertTo-TestReport $passReport
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'An accepted status on a nonzero exit must not be shown or continue.'
  Output = New-AcceptedOutput
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'An unknown status must be withheld.'
  Output = ConvertTo-TestReport ([ordered]@{ status = $sensitiveMarker; counts = $zeroCounts; packages = @() })
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'The status must match exactly.'
  Output = ConvertTo-TestReport ([ordered]@{ status = 'Command_Failed'; counts = $zeroCounts; packages = @(); reason = 'npm audit exit 1' })
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'Output that is not JSON must be withheld.'
  Output = "npm error $sensitiveMarker"
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'A JSON array must be withheld.'
  Output = '[' + (New-FailedAuditReport 'npm audit exit 1') + ']'
  Message = $withheld
})
$detailCases.Add(@{
  Why = 'Output above the release bound must be withheld.'
  Output = ConvertTo-TestReport ([ordered]@{
    status = 'command_failed'
    counts = $zeroCounts
    packages = @()
    reason = 'npm audit exit 1'
    padding = 'x' * 8192
  })
  Message = $withheld
})
foreach ($case in $detailCases) {
  $script:Events.Clear()
  $script:AuditFailureOutput = $case.Output
  $failure = Assert-Rejected {
    Assert-ReleaseDependencyPreflight $commit
    $script:Events.Add('azure')
  } $case.Why $case.Message
  Assert-Equal 1 $failure.Data['ReleaseExitCode'] "$($case.Why) The nonzero exit code must survive."
  Assert-Equal 1 @($script:Events | Where-Object { $_ -ceq 'audit' }).Count "$($case.Why) The audit must run exactly once."
  Assert-True (-not $script:Events.Contains('azure')) "$($case.Why) The release must stop before the first provider operation."
  Assert-True (-not $failure.Message.Contains($sensitiveMarker)) "$($case.Why) Raw output must stay withheld."
  if ($case.Secret) {
    Assert-True (-not $failure.Message.Contains($case.Secret)) "$($case.Why) The secret-shaped value must stay withheld."
  }
  Assert-True (-not $failure.Data.Contains('ReleaseFailureOutput')) "$($case.Why) The raw report must not leave the preflight."
}
$script:AuditFailureOutput = $null

# Accepted advisories (#2260): the release continues only on an accepted report that holds together, and prints one
# fixed line per accepted advisory. Write-Host is replaced here so every line the preflight prints is seen.
$script:HostLines = [Collections.Generic.List[string]]::new()
function Write-Host { $script:HostLines.Add(($args -join ' ')) }

function Invoke-AcceptedPreflight([string]$Output) {
  $script:Events.Clear()
  $script:HostLines.Clear()
  $script:AuditOutput = $Output
  Assert-ReleaseDependencyPreflight $commit
  $script:Events.Add('azure')
}

$acceptedLine = Get-AcceptedWarning 'GHSA-vfj7-8cjw-p6xm' 'braces' $tomorrow
Invoke-AcceptedPreflight (New-AcceptedOutput)
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'A valid accepted report must continue to the first provider operation.'
Assert-Equal 1 $script:HostLines.Count 'An accepted report with one advisory must print exactly one line.'
Assert-Equal $acceptedLine $script:HostLines[0] 'The accepted advisory line must have the fixed format.'
Assert-True ($acceptedLine -cmatch '\ARelease warning: dependency advisory accepted; advisory=GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}; package=[a-z0-9@/._-]+; expires=[0-9]{4}-[0-9]{2}-[0-9]{2}\.\z') `
  'The accepted advisory line must fit its documented grammar.'

# An expiry of today in UTC is still accepted by the release's own clock. The case repeats only if the UTC day changed
# while it ran.
do {
  $dayBefore = [DateTime]::UtcNow.Date
  $todayFailure = $null
  try { Invoke-AcceptedPreflight (New-AcceptedOutput (Format-TestDay $dayBefore)) } catch { $todayFailure = $_ }
} while ([DateTime]::UtcNow.Date -ne $dayBefore)
if ($todayFailure) { throw $todayFailure }
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'An expiry of today in UTC must continue.'
Assert-Equal (Get-AcceptedWarning 'GHSA-vfj7-8cjw-p6xm' 'braces' (Format-TestDay $dayBefore)) ($script:HostLines -join "`n") `
  'An expiry of today in UTC must print its one line.'

Invoke-AcceptedPreflight (ConvertTo-TestReport $passReport)
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'A plain pass must still continue.'
Assert-Equal 0 $script:HostLines.Count 'A plain pass must print nothing.'

$dayAfterTomorrow = Format-TestDay $utcToday.AddDays(2)
$twoAdvisories = New-AcceptedReport
$twoAdvisories['exceptions'] = @(
  $twoAdvisories['exceptions'][0],
  [ordered]@{ advisory = 'GHSA-2222-3333-4444'; package = 'braces'; version = '3.0.3'; expires = $dayAfterTomorrow }
)
Invoke-AcceptedPreflight (ConvertTo-TestReport $twoAdvisories)
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'Two accepted advisories on one package must continue.'
Assert-Equal ($acceptedLine + "`n" + (Get-AcceptedWarning 'GHSA-2222-3333-4444' 'braces' $dayAfterTomorrow)) ($script:HostLines -join "`n") `
  'Each accepted advisory must print its own line, in report order, and nothing else.'

$twoNodes = New-AcceptedReport
$twoNodes['packages'] += [ordered]@{ name = 'braces'; version = '3.0.3'; status = 'accepted' }
$twoNodes['counts']['reported'] = 6
Invoke-AcceptedPreflight (ConvertTo-TestReport $twoNodes)
Assert-Equal 'identity,audit,lock,azure' ($script:Events -join ',') 'Two lock nodes of the accepted package must continue.'
Assert-Equal $acceptedLine ($script:HostLines -join "`n") 'Two lock nodes of the accepted package must print one line for the one advisory.'

$script:FinalLockFails = $true
[void](Assert-Rejected {
  Invoke-AcceptedPreflight (New-AcceptedOutput)
} 'A lock mutation after an accepted audit must stop the release.' 'Dependency preflight failed; raw output withheld.')
Assert-Equal 'identity,audit,lock' ($script:Events -join ',') 'A post-audit lock mutation must stop an accepted release before any provider operation.'
Assert-Equal 0 $script:HostLines.Count 'A release that stops must not print an accepted advisory.'
$script:FinalLockFails = $false

function Add-TestDependents($Report, [int]$Count) {
  foreach ($index in 1..$Count) {
    $Report['packages'] += [ordered]@{ name = "dependent-$index"; version = '1.0.0'; status = 'dependent' }
  }
  $Report['counts']['reported'] = $Report['packages'].Count
}
$nextYear = $utcToday.Year + 1
$arabicIndicTomorrow = -join ($tomorrow.ToCharArray() | ForEach-Object {
  if ($_ -ge [char]'0' -and $_ -le [char]'9') { [char](0x0660 + [int]$_ - 48) } else { $_ }
})
$malformedAccepted = @(
  @{ Why = 'An extra top-level key'; Change = { param($r) $r['detail'] = $sensitiveMarker } },
  @{ Why = 'A missing exceptions key'; Change = { param($r) $r.Remove('exceptions') } },
  @{ Why = 'A pass status that carries exceptions'; Change = { param($r) $r['status'] = 'pass' } },
  @{ Why = 'A status in another letter case'; Change = { param($r) $r['status'] = 'Accepted' } },
  @{ Why = 'An extra count'; Change = { param($r) $r['counts']['unknown'] = 0 } },
  @{ Why = 'A missing count'; Change = { param($r) $r['counts'].Remove('omitted') } },
  @{ Why = 'A count that is text'; Change = { param($r) $r['counts']['high'] = '5' } },
  @{ Why = 'A count that is not a whole number'; Change = { param($r) $r['counts']['high'] = 5.5 } },
  @{ Why = 'A negative count'; Change = { param($r) $r['counts']['info'] = -1; $r['counts']['high'] = 6 } },
  @{ Why = 'A blocked count above 0'; Change = { param($r) $r['counts']['blocked'] = 1 } },
  @{ Why = 'A critical count above 0'; Change = { param($r) $r['counts']['critical'] = 1 } },
  @{ Why = 'A critical count above 0 that the total includes'; Change = { param($r) $r['counts']['critical'] = 1; $r['counts']['high'] = 4 } },
  @{ Why = 'An omitted count above 0'; Change = { param($r) $r['counts']['omitted'] = 1 } },
  @{ Why = 'Severity counts below the total'; Change = { param($r) $r['counts']['high'] = 4 } },
  @{ Why = 'Severity counts above the total'; Change = { param($r) $r['counts']['low'] = 1 } },
  @{ Why = 'A total of 0'; Change = { param($r) $r['counts']['high'] = 0; $r['counts']['vulnerabilities'] = 0 } },
  @{ Why = 'A total above the reported packages'; Change = { param($r) $r['counts']['high'] = 6; $r['counts']['vulnerabilities'] = 6 } },
  @{ Why = 'A reported count below the package list'; Change = { param($r) $r['counts']['reported'] = 4 } },
  @{ Why = 'A reported count above the package list'; Change = { param($r) $r['counts']['reported'] = 6 } },
  @{ Why = 'An empty package list'; Change = { param($r) $r['packages'] = @(); $r['counts']['reported'] = 0 } },
  @{ Why = 'A package list that is an object'; Change = { param($r) $r['packages'] = $r['packages'][1] } },
  @{ Why = 'More packages than the report may list'; Change = { param($r) Add-TestDependents $r 21 } },
  @{ Why = 'A package with an extra key'; Change = { param($r) $r['packages'][0]['detail'] = $sensitiveMarker } },
  @{ Why = 'A package without a version'; Change = { param($r) $r['packages'][0].Remove('version') } },
  @{ Why = 'A package that is null'; Change = { param($r) $r['packages'][0] = $null } },
  @{ Why = 'A package status from a rejected report'; Change = { param($r) $r['packages'][0]['status'] = 'vulnerable' } },
  @{ Why = 'A package status in another letter case'; Change = { param($r) $r['packages'][0]['status'] = 'Dependent' } },
  @{ Why = 'A status with a character that culture rules ignore'; Change = { param($r) $r['status'] = "acc$([char]0x00AD)epted" } },
  @{ Why = 'A status followed by a character that culture rules ignore'; Change = { param($r) $r['status'] = "accepted$([char]0x00AD)" } },
  @{ Why = 'A complete pass report that carries exceptions'; Change = {
    param($r)
    $r['status'] = 'pass'
    $r['packages'] = @()
    foreach ($field in @($r['counts'].Keys)) { $r['counts'][$field] = 0 }
  } },
  @{ Why = 'A package status with a character that culture rules ignore'; Change = { param($r) $r['packages'][1]['status'] = "accepted$([char]0x200B)" } },
  @{ Why = 'A package name with a space'; Change = { param($r) $r['packages'][0]['name'] = "fast glob $sensitiveMarker" } },
  @{ Why = 'A package name that is not text'; Change = { param($r) $r['packages'][0]['name'] = 7 } },
  @{ Why = 'A package version with a space'; Change = { param($r) $r['packages'][0]['version'] = "16.3.6 $sensitiveMarker" } },
  @{ Why = 'An empty exception list'; Change = { param($r) $r['exceptions'] = @() } },
  @{ Why = 'An empty exception list with no accepted package'; Change = { param($r) $r['exceptions'] = @(); $r['packages'][1]['status'] = 'dependent' } },
  @{ Why = 'An exception list that is an object'; Change = { param($r) $r['exceptions'] = $r['exceptions'][0] } },
  @{ Why = 'An exception that is null'; Change = { param($r) $r['exceptions'] = @($null) } },
  @{ Why = 'An exception with an extra key'; Change = { param($r) $r['exceptions'][0]['reason'] = $sensitiveMarker } },
  @{ Why = 'An exception without a version'; Change = { param($r) $r['exceptions'][0].Remove('version') } },
  @{ Why = 'An advisory id in upper case'; Change = { param($r) $r['exceptions'][0]['advisory'] = 'GHSA-VFJ7-8CJW-P6XM' } },
  @{ Why = 'An advisory id that is too short'; Change = { param($r) $r['exceptions'][0]['advisory'] = 'GHSA-vfj7-8cjw-p6x' } },
  @{ Why = 'An advisory id with a letter outside its alphabet'; Change = { param($r) $r['exceptions'][0]['advisory'] = 'GHSA-vfj7-8cjw-p6xa' } },
  @{ Why = 'A CVE id in place of the advisory id'; Change = { param($r) $r['exceptions'][0]['advisory'] = 'CVE-2026-93687' } },
  @{ Why = 'An advisory id with a trailing line feed'; Change = { param($r) $r['exceptions'][0]['advisory'] = "GHSA-vfj7-8cjw-p6xm`n" } },
  @{ Why = 'An advisory id followed by other text'; Change = { param($r) $r['exceptions'][0]['advisory'] = "GHSA-vfj7-8cjw-p6xm; $sensitiveMarker" } },
  @{ Why = 'An advisory id that is not text'; Change = { param($r) $r['exceptions'][0]['advisory'] = @('GHSA-vfj7-8cjw-p6xm') } },
  @{ Why = 'An exception package in upper case'; Change = { param($r) $r['exceptions'][0]['package'] = 'Braces'; $r['packages'][1]['name'] = 'Braces' } },
  @{ Why = 'An exception package followed by other text'; Change = {
    param($r)
    $r['exceptions'][0]['package'] = "braces; $sensitiveMarker"
    $r['packages'][1]['name'] = "braces; $sensitiveMarker"
  } },
  @{ Why = 'An exception package with a line feed'; Change = { param($r) $r['exceptions'][0]['package'] = "braces`n" } },
  @{ Why = 'An empty exception package'; Change = { param($r) $r['exceptions'][0]['package'] = '' } },
  @{ Why = 'An exception version with other text'; Change = { param($r) $r['exceptions'][0]['version'] = "3.0.3 $sensitiveMarker" } },
  @{ Why = 'An expiry date of yesterday in UTC'; Change = { param($r) $r['exceptions'][0]['expires'] = $yesterday } },
  @{ Why = 'An expiry date a year ago'; Change = { param($r) $r['exceptions'][0]['expires'] = Format-TestDay $utcToday.AddYears(-1) } },
  @{ Why = 'A month that does not exist'; Change = { param($r) $r['exceptions'][0]['expires'] = "$nextYear-13-01" } },
  @{ Why = 'A day that does not exist'; Change = { param($r) $r['exceptions'][0]['expires'] = "$nextYear-02-30" } },
  @{ Why = 'A date with a time'; Change = { param($r) $r['exceptions'][0]['expires'] = "${tomorrow}T00:00:00Z" } },
  @{ Why = 'A date in another order'; Change = {
    param($r)
    $r['exceptions'][0]['expires'] = $utcToday.AddDays(1).ToString('dd-MM-yyyy', [Globalization.CultureInfo]::InvariantCulture)
  } },
  @{ Why = 'A date with slashes'; Change = { param($r) $r['exceptions'][0]['expires'] = $tomorrow.Replace('-', '/') } },
  @{ Why = 'A date with digits outside ASCII'; Change = { param($r) $r['exceptions'][0]['expires'] = $arabicIndicTomorrow } },
  @{ Why = 'A date with a trailing line feed'; Change = { param($r) $r['exceptions'][0]['expires'] = "$tomorrow`n" } },
  @{ Why = 'A date followed by other text'; Change = { param($r) $r['exceptions'][0]['expires'] = "$tomorrow $sensitiveMarker" } },
  @{ Why = 'A date that is a number'; Change = { param($r) $r['exceptions'][0]['expires'] = 29991231 } },
  @{ Why = 'The same advisory twice'; Change = { param($r) $r['exceptions'] = @($r['exceptions'][0], $r['exceptions'][0]) } },
  @{ Why = 'An exception whose package is only a dependent'; Change = { param($r) $r['packages'][1]['status'] = 'dependent' } },
  @{ Why = 'An exception whose version is not the accepted package version'; Change = { param($r) $r['exceptions'][0]['version'] = '3.0.2' } },
  @{ Why = 'An exception for a package that is not in the list'; Change = { param($r) $r['exceptions'][0]['package'] = 'picomatch' } },
  @{ Why = 'An accepted package that no exception names'; Change = { param($r) $r['packages'][4]['status'] = 'accepted' } },
  @{ Why = 'An accepted package at another version than its exception'; Change = {
    param($r)
    $r['packages'] += [ordered]@{ name = 'braces'; version = '3.0.2'; status = 'accepted' }
    $r['counts']['reported'] = 6
  } },
  @{ Why = 'A second exception without an accepted package'; Change = {
    param($r)
    $r['exceptions'] += [ordered]@{ advisory = 'GHSA-2222-3333-4444'; package = 'micromatch'; version = '4.0.8'; expires = $tomorrow }
  } },
  @{ Why = 'A second exception at a version that no accepted package has'; Change = {
    param($r)
    $r['exceptions'] += [ordered]@{ advisory = 'GHSA-2222-3333-4444'; package = 'braces'; version = '3.0.2'; expires = $tomorrow }
  } }
)
foreach ($case in $malformedAccepted) {
  $report = New-AcceptedReport
  & $case.Change $report
  $output = ConvertTo-TestReport $report
  # Ordinal, because PowerShell's -cne compares by culture rules and treats some different characters as equal.
  Assert-True (-not [string]::Equals($output, (New-AcceptedOutput), [StringComparison]::Ordinal)) `
    "$($case.Why): the fixture must differ from the valid accepted report."
  $failure = Assert-Rejected {
    Invoke-AcceptedPreflight $output
  } "$($case.Why) in an accepted report must stop the release." 'Dependency preflight failed; raw output withheld.'
  Assert-Equal 1 @($script:Events | Where-Object { $_ -ceq 'audit' }).Count "$($case.Why): the audit must run exactly once."
  Assert-True (-not $script:Events.Contains('azure')) "$($case.Why): the release must stop before the first provider operation."
  Assert-Equal 0 $script:HostLines.Count "$($case.Why): nothing may be printed."
  Assert-True (-not $failure.Message.Contains($sensitiveMarker)) "$($case.Why): raw output must stay withheld."
}

foreach ($invalidOutput in @(
  ((New-AcceptedOutput) + "`n" + $sensitiveMarker),
  ('[' + (New-AcceptedOutput) + ']'),
  (New-AcceptedOutput).Replace('"status":"accepted"', '"status":"accepted","status":"pass"')
)) {
  [void](Assert-Rejected {
    Invoke-AcceptedPreflight $invalidOutput
  } 'Output that is not exactly one accepted report must stop the release.' 'Dependency preflight failed; raw output withheld.')
  Assert-True (-not $script:Events.Contains('azure')) 'Output that is not exactly one accepted report must stop before the first provider operation.'
  Assert-Equal 0 $script:HostLines.Count 'Output that is not exactly one accepted report must print nothing.'
}

# A valid accepted report above the 8192-byte release bound stops before it is read.
$oversized = New-AcceptedReport
$oversized['packages'] = @($oversized['packages'][1]) + @(1..24 | ForEach-Object {
  [ordered]@{ name = ('d' * 200) + "-$_"; version = ('1' * 120); status = 'dependent' }
})
$oversized['counts']['reported'] = 25
$oversizedOutput = ConvertTo-TestReport $oversized
Assert-True ([Text.Encoding]::UTF8.GetByteCount($oversizedOutput) -gt 8192) 'The oversized fixture must exceed the release bound.'
Assert-Equal 1 @(Get-ReleaseAcceptedDependencyAdvisories $oversized -UtcToday $utcToday).Count 'The oversized fixture must be valid apart from its size.'
[void](Assert-Rejected {
  Invoke-AcceptedPreflight $oversizedOutput
} 'An accepted report above the release bound must stop the release.' 'Dependency preflight failed; raw output withheld.')
Assert-Equal 0 $script:HostLines.Count 'An oversized accepted report must print nothing.'

# The expiry comparison with the day supplied as a parameter. An expiry of "today" holds for the whole UTC day and
# stops at the next UTC midnight, whatever the local time zone or culture of the machine.
$reportMessage = 'Dependency preflight did not return the required pass report.'
$expiresToday = New-AcceptedReport $today
Assert-Equal 1 @(Get-ReleaseAcceptedDependencyAdvisories $expiresToday -UtcToday $utcToday).Count 'An expiry of today must be accepted at the first moment of the UTC day.'
Assert-Equal 1 @(Get-ReleaseAcceptedDependencyAdvisories $expiresToday -UtcToday $utcToday.AddDays(1).AddTicks(-1)).Count `
  'An expiry of today must be accepted at the last moment of the UTC day.'
[void](Assert-Rejected {
  Get-ReleaseAcceptedDependencyAdvisories $expiresToday -UtcToday $utcToday.AddDays(1)
} 'An expiry of today must be rejected from the next UTC midnight.' $reportMessage)
[void](Assert-Rejected {
  Get-ReleaseAcceptedDependencyAdvisories (New-AcceptedReport $yesterday) -UtcToday $utcToday
} 'An expiry of yesterday must be rejected.' $reportMessage)
Assert-Equal 'GHSA-vfj7-8cjw-p6xm' @(Get-ReleaseAcceptedDependencyAdvisories (New-AcceptedReport $tomorrow) -UtcToday $utcToday)[0]['advisory'] `
  'The validated exception must be returned for printing.'
[void](Assert-Rejected {
  Assert-ReleaseDependencyReport (New-AcceptedReport $yesterday)
} 'The report check must reject a past expiry with the same message as a bad pass report.' $reportMessage)
[void](Assert-Rejected {
  Assert-ReleaseDependencyReport ([ordered]@{ status = 'pass'; counts = $nonzeroCounts; packages = @() })
} 'A bad pass report must keep its message.' $reportMessage)
Assert-Equal 0 @(Assert-ReleaseDependencyReport (ConvertFrom-Json -InputObject (ConvertTo-TestReport $passReport) -AsHashtable -NoEnumerate)).Count `
  'A plain pass report must return no accepted advisory.'

# th-TH uses the Buddhist calendar and ar-SA the Umm al-Qura calendar: a parse that followed the culture would read
# another year.
$savedCulture = [Threading.Thread]::CurrentThread.CurrentCulture
try {
  foreach ($cultureName in @('th-TH', 'ar-SA', 'tr-TR')) {
    [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo($cultureName)
    Assert-Equal 1 @(Get-ReleaseAcceptedDependencyAdvisories (New-AcceptedReport $today) -UtcToday $utcToday).Count `
      "An expiry of today must be accepted under the $cultureName culture."
    [void](Assert-Rejected {
      Get-ReleaseAcceptedDependencyAdvisories (New-AcceptedReport $yesterday) -UtcToday $utcToday
    } "An expiry of yesterday must be rejected under the $cultureName culture." $reportMessage)
  }
} finally {
  [Threading.Thread]::CurrentThread.CurrentCulture = $savedCulture
}

# The release's own clock is the UTC day, and nothing on the release path passes another one.
$acceptedAst = Get-ReleaseFunctionAst 'Get-ReleaseAcceptedDependencyAdvisories'
$clockParameter = @($acceptedAst.Parameters | Where-Object { $_.Name.VariablePath.UserPath -ceq 'UtcToday' })
Assert-Equal 1 $clockParameter.Count 'The accepted report check must take its clock as one parameter.'
Assert-Equal '[DateTime]::UtcNow.Date' $clockParameter[0].DefaultValue.Extent.Text 'The expiry clock must default to the current UTC day.'
Assert-True ($acceptedAst.Extent.Text -notmatch '(?i)Get-Date|::Now\b|::Today\b|ToLocalTime|\$env:') `
  'The accepted report check must not read local time or the environment.'
Assert-Equal 0 ([regex]::Matches($releaseAst.Extent.Text, '-UtcToday')).Count 'The release must never pass its own expiry clock.'
Assert-Equal 1 ([regex]::Matches($releaseAst.Extent.Text, 'Get-ReleaseAcceptedDependencyAdvisories \$Report')).Count `
  'The accepted report check must be called from one place, with the report alone.'
Assert-Equal 1 ([regex]::Matches($releaseAst.Extent.Text, 'Release warning: dependency advisory accepted')).Count `
  'The accepted advisory line must be printed from one place.'
$detailSource = (Get-ReleaseFunctionAst 'Get-ReleaseDependencyFailureDetail').Extent.Text
Assert-True (-not $detailSource.Contains('accepted')) 'An accepted status must never be shown as a failure detail.'

Remove-Item -LiteralPath Function:\Write-Host

Write-Host "release VM dependency preflight tests passed: $script:Passed assertions"
