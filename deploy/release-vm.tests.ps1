#requires -Version 7.2
param([switch]$DigestLookupOnly, [string[]]$DigestLookupCase = @())

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'release-vm-evidence.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "markdoc-digest-tests-$([guid]::NewGuid().ToString('N'))"
$priorEnvironment = @{}
foreach ($name in @('PATH', 'AZURE_CONFIG_DIR', 'MARKDOC_DIGEST_CASE', 'MARKDOC_DIGEST_COUNT', 'MARKDOC_DIGEST_VALUE')) {
  $priorEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
[void](New-Item -ItemType Directory -Path $testRoot)
[void](New-Item -ItemType Directory -Path (Join-Path $testRoot 'azure'))
$env:AZURE_CONFIG_DIR = Join-Path $testRoot 'azure'
$env:PATH = "$testRoot;$env:PATH"
$env:MARKDOC_DIGEST_COUNT = Join-Path $testRoot 'count'
[IO.File]::WriteAllText((Join-Path $testRoot 'az.cmd'), "@echo off`r`n`"$PSHOME\pwsh.exe`" -NoProfile -NonInteractive -File `"%~dp0fake-az.ps1`" %*`r`nexit /b %errorlevel%`r`n")
[IO.File]::WriteAllText((Join-Path $testRoot 'fake-az.ps1'), @'
$ErrorActionPreference = 'Stop'
$commandKey = ($args | Select-Object -First 3) -join ' '
if ($commandKey -cne 'acr manifest list-metadata' -or
    $args -notcontains '--only-show-errors' -or $args -notcontains '--subscription' -or
    $args -contains '--resource-group' -or $args -contains '--debug' -or $args -contains '--verbose' -or
    $env:AZURE_EXTENSION_USE_DYNAMIC_INSTALL -cne 'no' -or
    $env:AZURE_CORE_COLLECT_TELEMETRY -cne 'no' -or $env:AZURE_LOGGING_ENABLE_LOG_FILE -cne 'no' -or
    @(Get-ChildItem -LiteralPath $env:AZURE_CONFIG_DIR -Force).Count -ne 0) {
  throw 'Fake az permits only the isolated read-only digest lookup.'
}
$count = 0
if (Test-Path -LiteralPath $env:MARKDOC_DIGEST_COUNT) {
  $count = [int](Get-Content -LiteralPath $env:MARKDOC_DIGEST_COUNT -Raw)
}
$count++
[IO.File]::WriteAllText($env:MARKDOC_DIGEST_COUNT, [string]$count)
$case = $env:MARKDOC_DIGEST_CASE
$errorText = ''
switch ($case) {
  'digest-throttled-twice' { $errorText = 'ERROR: HTTP status: 429' }
  'digest-auth' { $errorText = 'ERROR: Status Code: 401' }
  'digest-auth-exit-124' { $errorText = 'ERROR: Status Code: 401' }
  'digest-unknown' { $errorText = 'ERROR: unrecognized failure' }
  'digest-secret' { $errorText = 'ERROR: secret body without a known category' }
  'digest-configuration' { $errorText = 'ERROR: HTTP status: 400' }
  'digest-not-found' { $errorText = 'ERROR: HTTP status: 404' }
  'digest-conflicting-status' { $errorText = "ERROR: HTTP status: 503`nHTTP status: 401" }
  'digest-ambiguous-status' { $errorText = "ERROR: HTTP status: 503`nHTTP status: 502" }
  'digest-unknown-http' { $errorText = 'ERROR: HTTP status: 409 ReadTimeout' }
  'digest-auth-transient' { $errorText = 'ERROR: HTTP status: 503 Unauthorized ConnectionError' }
  'digest-configuration-transient' { $errorText = 'ERROR: HTTP status: 503 SSLError: certificate verify failed ConnectionError' }
  default {
    if ($count -eq 1) {
      $errorText = 'ERROR: HTTP status: 503'
      if ($case -eq 'digest-transport-success') { $errorText = 'ERROR: ConnectionError: connection reset' }
      if ($case -eq 'digest-timeout-success') { $errorText = 'ERROR: ReadTimeout: request timed out' }
      if ($case -eq 'digest-http-timeout-success') { $errorText = 'ERROR: HTTP status: 408' }
      if ($case -eq 'digest-native-timeout') { Start-Sleep -Seconds 60 }
    }
  }
}
[Console]::Error.WriteLine('FAKE_DIGEST_SECRET_2211 https://private.example.test/token?credential=FAKE_DIGEST_SECRET_2211')
if ($errorText) {
  [Console]::Out.WriteLine('FAKE_DIGEST_SECRET_2211 response body')
  [Console]::Error.WriteLine($errorText)
  if ($case -eq 'digest-auth-exit-124') { exit 124 }
  exit 1
}
switch ($case) {
  'digest-retry-missing' { [Console]::Out.WriteLine('[]') }
  'digest-retry-ambiguous' { [Console]::Out.WriteLine('["' + $env:MARKDOC_DIGEST_VALUE + '","' + $env:MARKDOC_DIGEST_VALUE + '"]') }
  'digest-retry-malformed' { [Console]::Out.WriteLine('["sha256:bad"]') }
  'digest-retry-null' { [Console]::Out.WriteLine('null') }
  'digest-retry-scalar' { [Console]::Out.WriteLine('"' + $env:MARKDOC_DIGEST_VALUE + '"') }
  'digest-retry-tag-raced' { [Console]::Out.WriteLine('["sha256:' + ('b' * 64) + '"]') }
  default { [Console]::Out.WriteLine('["' + $env:MARKDOC_DIGEST_VALUE + '"]') }
}
exit 0
'@)

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ($Expected -cne $Actual) { throw "$Message Expected '$Expected', received '$Actual'." }
}

$path = Join-Path $PSScriptRoot 'release-vm.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
Assert-Equal 0 @($parseErrors).Count 'Entrypoint must parse.'
Assert-Equal '$env:RELEASE_SHA' $ast.ParamBlock.Parameters[0].DefaultValue.Extent.Text 'Entrypoint must default to the Board-selected SHA.'
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
    # Extract functions without executing the release; preserve their script-relative root.
    $definition = $statement.Extent.Text.Replace('$PSScriptRoot', ("'" + $PSScriptRoot.Replace("'", "''") + "'"))
    . ([scriptblock]::Create($definition))
  }
}

# Exercise the real native boundary with harmless local children, never Azure.
$native = ${function:Invoke-ReleaseNative}
if (-not $DigestLookupOnly) {
$output = & $native 'pwsh' @('-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write("native output"); [Console]::Error.Write("withheld stderr"); exit 0') $PSScriptRoot 10
Assert-Equal 'native output' $output 'Native output must exclude stderr.'
$output = & $native 'pwsh' @('-NoProfile', '-NonInteractive', '-Command', '[Console]::Error.Write(("x" * 131072)); [Console]::Out.Write("drained")') $PSScriptRoot 10
Assert-Equal 'drained' $output 'A full stderr pipe must not deadlock or leak into stdout.'
try {
  & $native 'pwsh' @('-NoProfile', '-NonInteractive', '-File', $path, '-ExpectedCommit', 'not-a-sha') $PSScriptRoot 10
  throw 'Expected invalid terminal invocation to fail.'
} catch [InvalidOperationException] {
  Assert-Equal 1 $_.Exception.Data['ReleaseExitCode'] 'The real -File entrypoint must return nonzero for invalid input before any Azure call.'
}
try {
  & $native 'pwsh' @('-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write("withheld stdout"); [Console]::Error.Write("withheld stderr"); exit 17') $PSScriptRoot 10
  throw 'Expected native failure.'
} catch [InvalidOperationException] {
  Assert-Equal 17 $_.Exception.Data['ReleaseExitCode'] 'Native exit code must survive.'
  Assert-True ($_.Exception.Message -notmatch 'withheld (stdout|stderr)') 'Native error must not expose raw output.'
  Assert-True (-not $_.Exception.Data.Contains('ReleaseFailureOutput')) 'Native failure output must not be kept unless a caller asks for it.'
  Assert-True (-not $_.Exception.Data.Contains('ReleaseDigestFailureCategory')) 'Other native failures must not opt into digest classification.'
}
try {
  & $native 'pwsh' @('-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write(" structured stdout "); [Console]::Error.Write("withheld stderr"); exit 17') $PSScriptRoot 10 -KeepFailureOutput
  throw 'Expected native failure.'
} catch [InvalidOperationException] {
  Assert-Equal 17 $_.Exception.Data['ReleaseExitCode'] 'Native exit code must survive when failure output is kept.'
  Assert-Equal 'structured stdout' $_.Exception.Data['ReleaseFailureOutput'] 'A caller that asks for it must receive only trimmed stdout.'
  Assert-True ($_.Exception.Message -notmatch 'structured stdout|withheld stderr') 'Kept failure output must not reach the error message.'
}
try {
  & $native 'pwsh' @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') $PSScriptRoot 1
  throw 'Expected timeout.'
} catch [InvalidOperationException] {
  Assert-Equal 124 $_.Exception.Data['ReleaseExitCode'] 'Native timeout must fail.'
}

function Invoke-RestMethod {
  param($Uri, $Method, $TimeoutSec, $MaximumRedirection, $Headers, $ErrorAction)
  Assert-Equal 'https://markdoc.app/api/health' $Uri 'Health must not use a liveness-only probe.'
  Assert-Equal 'Get' $Method 'Public health must not write.'
  Assert-Equal 0 $MaximumRedirection 'Public health must reject redirects to another target.'
  Assert-Equal 7 $TimeoutSec 'Public health must pass the caller deadline to HTTP.'
  Assert-Equal 'no-cache' $Headers['Cache-Control'] 'Public health must request fresh evidence.'
  return [pscustomobject]@{ ok = $true; db = $true; collab = $true; version = '0123456789abcdef0123456789abcdef01234567' }
}
$public = ConvertFrom-ReleaseJson (Get-ReleasePublicHealth 'https://markdoc.app' 7)
Assert-ReleaseHealth $public '0123456789abcdef0123456789abcdef01234567' 'Public'

$guestSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\infra\deploy-vm-image.sh') -Raw
$cleanup = [regex]::Match($guestSource, '(?ms)^cleanup\(\) \{.*?^\}')
Assert-True $cleanup.Success 'Guest cleanup function must remain identifiable.'
Assert-Equal 1 ([regex]::Matches($guestSource, '(?m)^\s*echo markdoc-vm-image-ready$').Count) 'Guest ready marker must have one emission point.'
Assert-True ($cleanup.Value -match 'rm -rf "\$rollback_dir"[\s\S]+echo markdoc-vm-image-ready') 'Guest readiness must follow cleanup.'
Assert-Equal 2 ([regex]::Matches($guestSource, 'all\(health\.get\(key\) is True for key in \("ok", "db", "collab"\)\)').Count) 'Both local health decisions must require boolean true.'
Assert-True ($guestSource -match 'if \[ "\$#" -ne 5 \]') 'Guest deployment must require the operation-scoped five-argument workflow.'

$bash = (Get-Command bash -CommandType Application | Select-Object -First 1).Source
Assert-True (Test-Path -LiteralPath $bash) 'Guest cleanup checks require the existing Git for Windows Bash.'
[void](& $native $bash @('-n', (Join-Path $PSScriptRoot '..\infra\deploy-vm-image.sh')) $PSScriptRoot 10)
foreach ($cleanupExit in @(0, 23)) {
  $cleanupTest = @"
set -euo pipefail
docker() { return 0; }
rm() { return $cleanupExit; }
deployment_succeeded=true
registry=unused
rollback_dir=unused
health='{"ok":true,"db":true,"collab":true,"version":"test"}'
operation_id=11111111-1111-1111-1111-111111111111
$($cleanup.Value)
cleanup
"@
  if ($cleanupExit -eq 0) {
    $result = & $native $bash @('-c', $cleanupTest) $PSScriptRoot 10
    Assert-True ($result.EndsWith("markdoc-vm-image-ready`nmarkdoc-vm-image-operation-ready:11111111-1111-1111-1111-111111111111")) 'Successful guest cleanup must emit terminal readiness.'
  } else {
    try {
      & $native $bash @('-c', $cleanupTest) $PSScriptRoot 10
      throw 'Expected guest cleanup failure.'
    } catch [InvalidOperationException] {
      Assert-Equal 23 $_.Exception.Data['ReleaseExitCode'] 'Guest cleanup failure must remain nonzero.'
    }
  }
}
}

$script:sha = '0123456789abcdef0123456789abcdef01234567'
$script:digest = 'sha256:' + ('a' * 64)
$script:ReleaseDeadlineSeconds = 2100
$script:subscription = '332d0c98-694c-48a0-91f3-465de6ac30a5'
$script:tenant = 'f1fde69f-c8d3-4b94-adeb-02d045b37f6a'
$script:registry = 'markdocacrmnd542unepl56.azurecr.io'
$script:resourceRoot = "/subscriptions/$subscription/resourceGroups/markdoc-rg/providers"
$script:calls = [Collections.Generic.List[object]]::new()
$script:messages = [Collections.Generic.List[string]]::new()
$script:scenario = ''
$script:publicCount = 0
$script:pollCount = 0
$script:reconcileCount = 0
$script:sourceChecks = 0
$script:submissionTag = ''
$script:sleeps = [Collections.Generic.List[int]]::new()
$env:MARKDOC_DIGEST_VALUE = $script:digest

function New-Item { param($ItemType, $Path) }
function Remove-Item { param($LiteralPath, [switch]$Recurse, [switch]$Force) }
function Test-Path { param($LiteralPath) return $true }
function Start-Sleep { param($Seconds) $script:sleeps.Add($Seconds) }
function Write-Host { param([string]$Object) $script:messages.Add($Object) }

function Assert-ReleaseDependencyPreflight([string]$Commit) {
  Assert-Equal $script:sha $Commit 'Release orchestration must preflight the selected commit.'
}

function Get-TestHealth {
  return @{ ok = $true; db = $true; collab = $true; version = $script:sha }
}

function Invoke-ReleaseNative([string]$Command, [string[]]$Arguments, [string]$Directory, [int]$TimeoutSeconds, [switch]$KeepFailureOutput, [switch]$ClassifyDigestFailure) {
  $script:calls.Add(@{ Command = $Command; Arguments = $Arguments; Directory = $Directory; Timeout = $TimeoutSeconds })
  Assert-True ($TimeoutSeconds -gt 0 -and $TimeoutSeconds -le $script:ReleaseDeadlineSeconds) 'Every native call must be bounded.'
  Assert-True (-not $KeepFailureOutput) 'Only the dependency preflight may keep native failure output.'
  $isDigestLookup = $Command -ceq 'az' -and (($Arguments | Select-Object -First 3) -join ' ' -ceq 'acr manifest list-metadata')
  Assert-True (-not $ClassifyDigestFailure -or $isDigestLookup) 'Only the digest lookup may classify native failure output.'
  if ($isDigestLookup -and $script:scenario.StartsWith('digest-')) {
    Assert-Equal (Join-Path $testRoot 'az.cmd') (Get-Command az -CommandType Application | Select-Object -First 1).Source 'Fake az must be first on PATH.'
    try {
      if ($ClassifyDigestFailure) {
        return & $native $Command $Arguments $Directory $TimeoutSeconds -ClassifyDigestFailure
      }
      return & $native $Command $Arguments $Directory $TimeoutSeconds
    } catch [InvalidOperationException] {
      Assert-True (($_.Exception.Message + ($_.Exception.Data.Values -join ' ')) -notmatch 'FAKE_DIGEST_SECRET_2211|private\.example\.test|response body') 'Raw native failure output must not survive in the exception.'
      if ($script:scenario -eq 'digest-deadline') {
        $script:ReleaseDeadlineSeconds = [math]::Floor($releaseClock.Elapsed.TotalSeconds) + 1
      }
      throw
    }
  }
  if ($Command -ceq 'git') {
    switch ($Arguments[0]) {
      'rev-parse' {
        if ($Arguments -contains '--abbrev-ref') {
          if ($script:scenario -eq 'wrong-branch') { return 'task-other' }
          if ($script:scenario -eq 'detached') { return 'HEAD' }
          return 'main'
        }
        $script:sourceChecks++
        if ($script:scenario -eq 'wrong-head' -or ($script:scenario -eq 'changed-after-build' -and $script:sourceChecks -ge 3)) { return ('b' * 40) }
        return $script:sha
      }
      'status' {
        if ($script:scenario -eq 'dirty') { return ' M source.ts' }
        if ($script:scenario -eq 'untracked') { return '?? extra.txt' }
        return ''
      }
      'archive' {
        Assert-Equal $script:sha $Arguments[-1] 'Archive must use the explicit full commit.'
        if ($script:scenario -eq 'archive-failed') { Stop-VmRelease 'Archive failed.' 31 }
        return ''
      }
      default { throw 'Unexpected mocked git command.' }
    }
  }
  if ($Command -ceq 'tar') { return '' }
  Assert-Equal 'az' $Command 'Only the existing native tools may be used.'
  Assert-True ($Arguments -contains '--only-show-errors') 'Azure calls must suppress raw diagnostic logs.'
  Assert-True ($Arguments -notcontains '--debug' -and $Arguments -notcontains '--verbose') 'Azure debug/verbose logs must never be requested.'
  $commandKey = ($Arguments | Select-Object -First 3) -join ' '
  if ($commandKey.StartsWith('account show ')) {
    if ($script:scenario -eq 'account-failed') { Stop-VmRelease 'Account lookup failed.' 19 }
    $account = @{ id = $script:subscription; tenantId = $script:tenant; state = 'Enabled'; environmentName = 'AzureCloud' }
    if ($script:scenario -eq 'wrong-subscription') { $account.id = 'different' }
    if ($script:scenario -eq 'wrong-tenant') { $account.tenantId = 'different' }
    if ($script:scenario -eq 'wrong-cloud') { $account.environmentName = 'different' }
    if ($script:scenario -eq 'disabled-subscription') { $account.state = 'Disabled' }
    return ConvertTo-Json -InputObject $account -Compress
  }
  Assert-True ($Arguments -contains '--subscription' -and $Arguments -contains $script:subscription) 'Every resource operation must pin the subscription.'
  if ($commandKey -ceq 'acr manifest list-metadata') {
    Assert-True ($Arguments -notcontains '--resource-group') 'Manifest lookup must not pass the unsupported resource-group option.'
  } else {
    Assert-True ($Arguments -contains '--resource-group' -and $Arguments -contains 'markdoc-rg') 'Every resource operation must pin the hyphenated group.'
  }
  if ($commandKey.StartsWith('acr show ')) {
    $info = @{ id = "$script:resourceRoot/Microsoft.ContainerRegistry/registries/markdocacrmnd542unepl56"; loginServer = $script:registry }
    if ($script:scenario -eq 'wrong-registry') { $info.loginServer = 'different.azurecr.io' }
    return ConvertTo-Json -InputObject $info -Compress
  }
  if ($commandKey.StartsWith('vm show ')) {
    $info = @{ id = "$script:resourceRoot/Microsoft.Compute/virtualMachines/markdoc-pg"; os = 'Linux'; nics = @("$script:resourceRoot/Microsoft.Network/networkInterfaces/markdoc-pg-nic") }
    if ($script:scenario -eq 'wrong-vm') { $info.id = 'different' }
    return ConvertTo-Json -InputObject $info -Compress
  }
  if ($commandKey -ceq 'network public-ip show') {
    $info = @{
      id = "$script:resourceRoot/Microsoft.Network/publicIPAddresses/markdoc-web-ip"
      fqdn = 'markdoc-burkeholland.eastus2.cloudapp.azure.com'
      configuration = "$script:resourceRoot/Microsoft.Network/networkInterfaces/markdoc-pg-nic/ipConfigurations/primary"
    }
    if ($script:scenario -eq 'old-origin') { $info.fqdn = 'retired.azurecontainerapps.io' }
    if ($script:scenario -eq 'wrong-ip-association') { $info.configuration = 'different' }
    return ConvertTo-Json -InputObject $info -Compress
  }
  if ($commandKey.StartsWith('acr build ')) {
    Assert-True ($Arguments -contains "APP_VERSION=$script:sha") 'Build must embed the exact commit.'
    Assert-True ($Arguments -contains "markdoc:$script:sha" -and $Arguments -contains "markdoc:$($script:sha.Substring(0, 12))") 'Existing full and short tags must be retained.'
    Assert-True ($Arguments -contains '--no-wait' -and $Arguments -contains '--no-logs') 'Submission must be asynchronous without streaming build logs.'
    Assert-Equal '600' $Arguments[[array]::IndexOf($Arguments, '--timeout') + 1] 'ACR must have enough time for the measured production build.'
    Assert-True (@($Arguments | Where-Object { $_ -cmatch '^markdoc:release-[0-9a-f]{32}$' }).Count -eq 1) 'A lost submission response must have one unique tag for reconciliation.'
    $script:submissionTag = @($Arguments | Where-Object { $_ -cmatch '^markdoc:release-[0-9a-f]{32}$' })[0].Substring(8)
    $dockerfile = $Arguments[[array]::IndexOf($Arguments, '--file') + 1]
    Assert-True ($dockerfile -match 'markdoc-release-[0-9a-f]+\\Dockerfile$') 'Build must use only the isolated exact archive.'
    if ($script:scenario -eq 'build-submit-failed') { Stop-VmRelease 'Build submission failed.' 32 }
    if ($script:scenario -eq 'build-submit-timeout') { Stop-VmRelease 'Submission acceptance unknown.' 124 }
    if ($script:scenario -eq 'missing-run') { return '{}' }
    return '{"runId":"build123"}'
  }
  if ($commandKey -ceq 'acr task list-runs') {
    $script:reconcileCount++
    Assert-True ($Arguments -notcontains '--run-type' -and $Arguments -contains '50') 'Reconciliation must inspect a bounded CLI-compatible run window.'
    if ($script:scenario -eq 'reconcile-missing') { return '[]' }
    if ($script:scenario -eq 'reconcile-delayed' -and $script:reconcileCount -eq 1) { return '[]' }
    $run = @{
      runId = 'build123'; runType = 'QuickRun'; status = 'Queued'
      outputImages = @(@{ registry = $script:registry; repository = 'markdoc'; tag = $script:submissionTag; digest = $null })
    }
    if ($script:scenario -eq 'reconcile-malformed-run') { $run.runId = 'not valid!' }
    if ($script:scenario -eq 'reconcile-ambiguous') {
      return ConvertTo-Json -InputObject @($run, $run) -Depth 5 -Compress
    }
    return ConvertTo-Json -InputObject @($run) -Depth 5 -Compress
  }
  if ($commandKey -ceq 'acr task show-run') {
    $script:pollCount++
    $status = 'Succeeded'
    if ($script:scenario -eq 'build-failed') { $status = 'Failed' }
    if ($script:scenario -eq 'build-timeout') { $status = 'Timeout' }
    if ($script:scenario -eq 'build-unknown-status') { $status = 'Unexpected' }
    if ($script:scenario -eq 'pending-then-success' -and $script:pollCount -eq 1) { $status = 'Running' }
    $run = @{
      runId = 'build123'; status = $status
      outputImages = @(@{ registry = $script:registry; repository = 'markdoc'; tag = $script:sha; digest = $script:digest })
    }
    if ($script:scenario -eq 'wrong-run') { $run.runId = 'other' }
    if ($script:scenario -eq 'tag-raced') { $run.outputImages[0].digest = 'sha256:' + ('b' * 64) }
    return ConvertTo-Json -InputObject $run -Depth 5 -Compress
  }
  if ($commandKey -ceq 'acr manifest list-metadata') {
    Assert-True ($Arguments -contains "[?tags != null && contains(tags, '$script:sha')].digest") 'Digest lookup must filter by full SHA without taking the first ambiguous match.'
    if ($script:scenario -eq 'ambiguous-digest') { return ConvertTo-Json -InputObject @($script:digest, $script:digest) -Compress }
    if ($script:scenario -eq 'missing-digest') { return '[]' }
    if ($script:scenario -eq 'null-digest') { return 'null' }
    if ($script:scenario -eq 'malformed-digest') { return '["sha256:bad"]' }
    if ($script:scenario -eq 'scalar-digest') { return ConvertTo-Json -InputObject $script:digest -Compress }
    return ConvertTo-Json -InputObject @($script:digest) -Compress
  }
  if ($commandKey -ceq 'vm run-command invoke') {
    Assert-True ($Arguments -contains 'RunShellScript' -and $Arguments -notcontains '--no-wait') 'VM command must wait for terminal guest evidence.'
    $parameterIndex = [array]::IndexOf($Arguments, '--parameters')
    $parameters = $Arguments[($parameterIndex + 1)..($parameterIndex + 5)]
    Assert-Equal $script:registry $parameters[0] 'Guest registry must be pinned.'
    Assert-Equal "$script:registry/markdoc@$script:digest" $parameters[1] 'Guest image must be immutable.'
    Assert-Equal $script:sha $parameters[2] 'Guest version must be the selected commit.'
    Assert-Equal $script:tenant $parameters[3] 'Guest tenant must be pinned.'
    $operation = $parameters[4]
    Assert-True ($operation -cmatch '^[0-9a-f-]{36}$') 'Guest invocation must have its own UUID.'
    Assert-True (($script:messages -join "`n").Contains($operation)) 'Guest identity must be printed before the command is sent.'
    if ($script:scenario -eq 'vm-timeout') { Stop-VmRelease 'VM command timed out.' 124 }
    if ($script:scenario -eq 'vm-native-failed') { Stop-VmRelease 'VM command failed.' 33 }
    $health = Get-TestHealth
    if ($script:scenario -eq 'wrong-local-version') { $health.version = 'old' }
    if ($script:scenario -eq 'local-health-false') { $health.db = $false }
    if ($script:scenario -eq 'local-health-string') { $health.ok = 'true' }
    $healthText = ConvertTo-Json -InputObject $health -Compress
    if ($script:scenario -eq 'malformed-local-json') { $healthText = '{bad json}' }
    $endpoint = '3/25002220'
    $wal = '000000010000000300000025'
    $archive = "$wal-0123456789abcdef0123456789abcdef01234567.gz"
    $replay = '3/25003333'
    $walEvidence = @(
      "markdoc-release-wal-operation:$operation",
      "markdoc-release-wal-capture:$operation`:$endpoint`:$wal",
      "markdoc-release-wal-switch:$operation`:true",
      "markdoc-release-wal-archive:$operation`:$wal`:$archive",
      "markdoc-release-wal-restore:$operation`:true",
      "markdoc-release-wal-sql-ready:$operation`:true",
      "markdoc-release-wal-replay:$operation`:$endpoint`:$replay",
      "markdoc-release-wal-cleanup:$operation`:true",
      "markdoc-release-wal-ready:$operation`:$endpoint`:$wal`:$archive`:$replay"
    ) -join "`n"
    $stdout = "$walEvidence`n$healthText`nmarkdoc-vm-image-ready`nmarkdoc-vm-image-operation-ready:$operation"
    if ($script:scenario -eq 'retention-warning') {
      $stdout = "$walEvidence`nmarkdoc-vm-image-warning:${operation}:retention-failed`n$healthText`nmarkdoc-vm-image-ready`nmarkdoc-vm-image-operation-ready:$operation"
    }
    if ($script:scenario -eq 'image-space') {
      $stdout = "$walEvidence`nmarkdoc-vm-image-space-failed:${operation}:pull:available=436326400:required=6442450944:reserve=2147483648"
    }
    if ($script:scenario -eq 'wal-diagnostic') {
      $stdout = "markdoc-release-wal-failed:${operation}:sql-ready:cleanup=true`nmarkdoc-release-wal-log:${operation}:PANIC:disk-full`nmarkdoc-release-wal-log:${operation}:FATAL:private-token"
    }
    if ($script:scenario -eq 'transport-only') { $stdout = '' }
    if ($script:scenario -eq 'missing-ready-marker') { $stdout = $healthText }
    if ($script:scenario -eq 'missing-local-health') { $stdout = "markdoc-vm-image-ready`nmarkdoc-vm-image-operation-ready:$operation" }
    if ($script:scenario -eq 'wrong-operation') { $stdout = $stdout.Replace($operation, 'other') }
    if ($script:scenario -eq 'nonterminal-marker') { $stdout += "`nfailed after marker" }
    $message = "Enable succeeded:`n[stdout]`n$stdout`n`n[stderr]`n"
    if ($script:scenario -eq 'stderr-marker') { $message = "Enable succeeded:`n[stdout]`n`n[stderr]`n$stdout" }
    $code = 'ProvisioningState/succeeded'
    if ($script:scenario -eq 'transport-failed') { $code = 'ProvisioningState/failed' }
    return ConvertTo-Json -InputObject @{ value = @(@{ code = $code; message = $message }) } -Depth 5 -Compress
  }
  throw 'Unexpected Azure command: tests permit only the existing release route.'
}

function Get-ReleasePublicHealth([string]$Origin, [int]$TimeoutSeconds) {
  $script:publicCount++
  Assert-Equal 'https://markdoc.app' $Origin 'Public health must use the exact stable origin.'
  Assert-True ($TimeoutSeconds -gt 0 -and $TimeoutSeconds -le 20) 'Public health must have a bounded timeout.'
  Assert-True (($script:messages -join "`n") -match 'guest ready; waiting') 'Public health must follow guest readiness.'
  Assert-True (($script:messages -join "`n") -notmatch 'Release complete:') 'Completion must not precede public health.'
  if ($script:scenario -eq 'public-request-failed') { throw [Net.Http.HttpRequestException]::new('withheld response body') }
  if ($script:scenario -eq 'malformed-public-json') { return '{bad json}' }
  if ($script:scenario -eq 'public-array') { return '[]' }
  $health = Get-TestHealth
  if ($script:scenario -eq 'wrong-public-version') { $health.version = 'old' }
  if ($script:scenario -eq 'public-health-string') { $health.ok = 'true' }
  foreach ($field in @('ok', 'db', 'collab')) {
    if ($script:scenario -eq "public-$field-false") { $health[$field] = $false }
  }
  return ConvertTo-Json -InputObject $health -Compress
}

$cases = @(
  'missing-sha', 'malformed-sha', 'short-sha', 'conflicting-sha', 'wrong-branch', 'detached', 'wrong-head', 'dirty', 'untracked',
  'account-failed', 'wrong-subscription', 'wrong-tenant', 'wrong-cloud', 'disabled-subscription',
  'wrong-registry', 'wrong-vm', 'old-origin', 'wrong-ip-association', 'archive-failed',
  'build-submit-failed', 'build-submit-timeout', 'reconcile-missing', 'reconcile-ambiguous', 'reconcile-malformed-run',
  'build-failed', 'build-timeout', 'build-unknown-status', 'wrong-run',
  'ambiguous-digest', 'missing-digest', 'null-digest', 'malformed-digest', 'scalar-digest', 'tag-raced', 'changed-after-build',
  'vm-timeout', 'vm-native-failed', 'transport-failed', 'transport-only', 'missing-ready-marker', 'missing-local-health', 'image-space', 'wal-diagnostic',
  'wrong-operation', 'nonterminal-marker', 'stderr-marker', 'wrong-local-version', 'local-health-false', 'local-health-string', 'malformed-local-json',
  'wrong-public-version', 'public-ok-false', 'public-db-false', 'public-collab-false', 'public-health-string', 'public-array',
  'public-request-failed', 'malformed-public-json', 'success', 'missing-run', 'reconcile-delayed', 'pending-then-success', 'uppercase-sha', 'retention-warning'
)
$digestCases = @(
  @{ Name = 'digest-server-success'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Success = $true },
  @{ Name = 'digest-throttled-twice'; Category = 'throttled'; Status = '429'; Calls = 2; Retry = 1 },
  @{ Name = 'digest-auth'; Category = 'auth'; Status = '401'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-auth-exit-124'; Category = 'auth'; Status = '401'; Calls = 1; Retry = 0; ExitCode = 124 },
  @{ Name = 'digest-unknown'; Category = 'unknown'; Status = 'none'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-secret'; Category = 'unknown'; Status = 'none'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-retry-missing'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Reason = 'absent, ambiguous or malformed digest' },
  @{ Name = 'digest-retry-ambiguous'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Reason = 'absent, ambiguous or malformed digest' },
  @{ Name = 'digest-configuration'; Category = 'configuration'; Status = '400'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-not-found'; Category = 'not_found'; Status = '404'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-transport-success'; Category = 'transport'; Status = 'none'; Calls = 2; Retry = 1; Success = $true },
  @{ Name = 'digest-timeout-success'; Category = 'timeout'; Status = 'none'; Calls = 2; Retry = 1; Success = $true },
  @{ Name = 'digest-http-timeout-success'; Category = 'timeout'; Status = '408'; Calls = 2; Retry = 1; Success = $true },
  @{ Name = 'digest-native-timeout'; Category = 'timeout'; Status = 'none'; Calls = 2; Retry = 1; Success = $true },
  @{ Name = 'digest-retry-malformed'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Reason = 'absent, ambiguous or malformed digest' },
  @{ Name = 'digest-retry-null'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Reason = 'absent, ambiguous or malformed digest' },
  @{ Name = 'digest-retry-scalar'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Reason = 'absent, ambiguous or malformed digest' },
  @{ Name = 'digest-retry-tag-raced'; Category = 'server_error'; Status = '503'; Calls = 2; Retry = 1; Reason = 'does not match this successful build run' },
  @{ Name = 'digest-deadline'; Category = 'server_error'; Status = '503'; Calls = 1; Retry = 0; Reason = 'No time remains for the ACR digest lookup retry; no VM command was sent' },
  @{ Name = 'digest-conflicting-status'; Category = 'auth'; Status = 'none'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-ambiguous-status'; Category = 'unknown'; Status = 'none'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-unknown-http'; Category = 'unknown'; Status = '409'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-auth-transient'; Category = 'auth'; Status = '503'; Calls = 1; Retry = 0 },
  @{ Name = 'digest-configuration-transient'; Category = 'configuration'; Status = '503'; Calls = 1; Retry = 0 }
)
if ($DigestLookupCase.Count -gt 0) {
  Assert-True ([bool]$DigestLookupOnly) 'Selecting digest cases requires -DigestLookupOnly.'
  foreach ($name in $DigestLookupCase) {
    Assert-True ($name -cin @($digestCases | ForEach-Object { $_.Name })) "Unknown digest test case: $name."
  }
  $digestCases = @($digestCases | Where-Object { $_.Name -cin $DigestLookupCase })
}
$existingCaseCount = $cases.Count
if ($DigestLookupOnly) { $cases = @() }
$cases += @($digestCases | ForEach-Object { $_.Name })
$digestFailures = [Collections.Generic.List[string]]::new()
$priorReleaseSha = $env:RELEASE_SHA
try {
  foreach ($case in $cases) {
    $script:scenario = $case
    $script:calls.Clear()
    $script:messages.Clear()
    $script:publicCount = 0
    $script:pollCount = 0
    $script:reconcileCount = 0
    $script:sourceChecks = 0
    $script:submissionTag = ''
    $script:sleeps.Clear()
    $script:ReleaseDeadlineSeconds = 2100
    $env:MARKDOC_DIGEST_CASE = $case
    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $env:MARKDOC_DIGEST_COUNT) {
      Microsoft.PowerShell.Management\Remove-Item -LiteralPath $env:MARKDOC_DIGEST_COUNT -Force
    }
    $env:RELEASE_SHA = $null
    $commit = $script:sha
    if ($case -eq 'missing-sha') { $commit = '' }
    if ($case -eq 'malformed-sha') { $commit = 'z' * 40 }
    if ($case -eq 'short-sha') { $commit = $commit.Substring(0, 12) }
    if ($case -eq 'conflicting-sha') { $env:RELEASE_SHA = 'b' * 40 }
    if ($case -eq 'uppercase-sha') { $commit = $commit.ToUpperInvariant() }
    $code = 0
    try {
      Invoke-MarkdocVmRelease $commit
    } catch [InvalidOperationException] {
      if (-not $_.Exception.Data.Contains('ReleaseExitCode')) { throw }
      $code = $_.Exception.Data['ReleaseExitCode']
    }
    $digestCase = @($digestCases | Where-Object { $_.Name -ceq $case }) | Select-Object -First 1
    $success = $case -in @('success', 'missing-run', 'reconcile-delayed', 'pending-then-success', 'uppercase-sha', 'retention-warning') -or ($digestCase -and $digestCase.Success -eq $true)
    $log = $script:messages -join "`n"
    try {
    Assert-Equal $success ($code -eq 0) "Unexpected exit outcome for $case. Log: $log"
    $log = $script:messages -join "`n"
    Assert-Equal $success ($log -match 'Release complete:') "Completion reporting mismatch for $case."
    Assert-True ($log -notmatch 'withheld response body|failed after marker|bad json|private-token') "Raw diagnostics escaped for $case."
    if ($case -eq 'retention-warning') {
      Assert-True ($log -match 'Release warning: old-image retention failed; the healthy application was not rolled back') 'Retention warning was not surfaced without failing release.'
    }
    if ($case -eq 'image-space') {
      Assert-True ($log -match 'Insufficient disk space before image pull; application unchanged') "Image capacity refusal was not surfaced distinctly. Log: $log"
    }
    if ($case -eq 'wal-diagnostic') {
      Assert-True ($log -match 'Scratch PANIC: No space left on device') 'Scratch server diagnostic was not surfaced through the release boundary.'
    }
    $builds = @($script:calls | Where-Object { ($_.Arguments | Select-Object -First 2) -join ' ' -ceq 'acr build' })
    $invocations = @($script:calls | Where-Object { ($_.Arguments | Select-Object -First 3) -join ' ' -ceq 'vm run-command invoke' })
    Assert-True ($builds.Count -le 1 -and $invocations.Count -le 1) "No write may be automatically retried for $case."
    if ($success) {
      Assert-Equal 1 $builds.Count "Successful case must build once: $case."
      Assert-Equal 1 $invocations.Count "Successful case must deploy once: $case."
      Assert-Equal 1 $script:publicCount "Successful case must verify exact public health: $case."
    }
    if ($cases.IndexOf($case) -lt $cases.IndexOf('build-submit-failed')) {
      Assert-Equal 0 $builds.Count "Preflight failure must precede every cloud write: $case."
    }
    if ($cases.IndexOf($case) -lt $cases.IndexOf('vm-timeout')) {
      Assert-Equal 0 $invocations.Count "Build/source/digest failure must not reach the guest: $case."
    }
    if ($cases.IndexOf($case) -lt $cases.IndexOf('wrong-public-version')) {
      Assert-Equal 0 $script:publicCount "Guest failure must not reach public health: $case."
    }
    $expectedNativeCodes = @{ 'account-failed' = 19; 'archive-failed' = 31; 'build-submit-failed' = 32; 'vm-native-failed' = 33; 'build-submit-timeout' = 124; 'vm-timeout' = 124 }
    if ($expectedNativeCodes.ContainsKey($case)) {
      Assert-Equal $expectedNativeCodes[$case] $code "Exact native error code must survive for $case. Log: $log"
    }
    if ($digestCase) {
      $diagnostic = "Release: ACR digest lookup failed; category=$($digestCase.Category); HTTP status=$($digestCase.Status)."
      $retry = 'Release: ACR digest lookup retry 1/1 in 2 seconds; read-only lookup only.'
      Assert-True ($script:messages.Contains($diagnostic)) "Missing safe diagnostic for $case. Log: $log"
      Assert-Equal $digestCase.Calls ([int](Get-Content -LiteralPath $env:MARKDOC_DIGEST_COUNT -Raw)) "Digest call count mismatch for $case."
      Assert-Equal $digestCase.Retry @($script:messages | Where-Object { $_ -ceq $retry }).Count "Retry line count mismatch for $case."
      Assert-Equal $digestCase.Retry @($script:sleeps | Where-Object { $_ -eq 2 }).Count "Retry must use the fixed two-second delay for $case."
      $failureLines = 1
      if ($case -eq 'digest-throttled-twice') { $failureLines = 2 }
      Assert-Equal $failureLines @($script:messages | Where-Object { $_ -ceq $diagnostic }).Count "Failure line count mismatch for $case."
      Assert-True ($log -notmatch 'FAKE_DIGEST_SECRET_2211|private\.example\.test|credential=|response body') "Fake secret escaped for $case."
      Assert-Equal 1 $builds.Count "A digest failure must never repeat the build for $case."
      Assert-Equal ([int]$success) $invocations.Count "Failed digest checks must never reach the VM for $case."
      if ($digestCase.Reason) { Assert-True ($log.Contains($digestCase.Reason)) "Digest validation reason missing for $case. Log: $log" }
      if ($case -eq 'digest-deadline') { Assert-Equal 124 $code 'Insufficient retry deadline must retain timeout exit code.' }
      if ($success) {
        Assert-True ($log.IndexOf($diagnostic) -lt $log.IndexOf('Release: guest invocation')) 'Digest diagnostics must precede the guest invocation.'
        Assert-True ($log.IndexOf($retry) -lt $log.IndexOf('Release: guest invocation')) 'Digest retry must precede the guest invocation.'
      } elseif ($case -ne 'digest-deadline' -and -not $digestCase.Reason) {
        $expectedExit = 1
        if ($digestCase.ExitCode) { $expectedExit = $digestCase.ExitCode }
        Assert-Equal $expectedExit $code 'Native digest failure exit code must survive.'
      }
      Microsoft.PowerShell.Utility\Write-Host "PASS: $case ($($digestCase.Calls) lookup calls, $($digestCase.Retry) retry lines)"
    }
    } catch {
      if (-not $digestCase) { throw }
      $digestFailures.Add($case)
      Microsoft.PowerShell.Utility\Write-Host "FAIL: $case - $($_.Exception.Message)"
    }
  }
} finally {
  $env:RELEASE_SHA = $priorReleaseSha
}
if ($digestFailures.Count -gt 0) { throw "Digest lookup tests: $($digestFailures.Count)/$($digestCases.Count) failed: $($digestFailures -join ', ')." }
if ($DigestLookupOnly) {
  Microsoft.PowerShell.Utility\Write-Host "Digest lookup tests: ok ($($digestCases.Count) offline fake-az scenarios)."
} else {
  Microsoft.PowerShell.Utility\Write-Host "VM release tests: ok ($existingCaseCount existing + $($digestCases.Count) new = $($cases.Count) offline scenarios plus native/guest cleanup boundaries)."
}
} finally {
  foreach ($name in $priorEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $priorEnvironment[$name])
  }
  if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $testRoot) {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
