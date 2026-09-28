#requires -Version 7.2
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'release-vm-evidence.ps1')

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

function New-Item { param($ItemType, $Path) }
function Remove-Item { param($LiteralPath, [switch]$Recurse, [switch]$Force) }
function Test-Path { param($LiteralPath) return $true }
function Start-Sleep { param($Seconds) }
function Write-Host { param([string]$Object) $script:messages.Add($Object) }

function Assert-ReleaseDependencyPreflight([string]$Commit) {
  Assert-Equal $script:sha $Commit 'Release orchestration must preflight the selected commit.'
}

function Get-TestHealth {
  return @{ ok = $true; db = $true; collab = $true; version = $script:sha }
}

function Invoke-ReleaseNative([string]$Command, [string[]]$Arguments, [string]$Directory, [int]$TimeoutSeconds) {
  $script:calls.Add(@{ Command = $Command; Arguments = $Arguments; Directory = $Directory; Timeout = $TimeoutSeconds })
  Assert-True ($TimeoutSeconds -gt 0 -and $TimeoutSeconds -le $script:ReleaseDeadlineSeconds) 'Every native call must be bounded.'
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
  'vm-timeout', 'vm-native-failed', 'transport-failed', 'transport-only', 'missing-ready-marker', 'missing-local-health',
  'wrong-operation', 'nonterminal-marker', 'stderr-marker', 'wrong-local-version', 'local-health-false', 'local-health-string', 'malformed-local-json',
  'wrong-public-version', 'public-ok-false', 'public-db-false', 'public-collab-false', 'public-health-string', 'public-array',
  'public-request-failed', 'malformed-public-json', 'success', 'missing-run', 'reconcile-delayed', 'pending-then-success', 'uppercase-sha'
)
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
    $success = $case -in @('success', 'missing-run', 'reconcile-delayed', 'pending-then-success', 'uppercase-sha')
    Assert-Equal $success ($code -eq 0) "Unexpected exit outcome for $case. Log: $log"
    $log = $script:messages -join "`n"
    Assert-Equal $success ($log -match 'Release complete:') "Completion reporting mismatch for $case."
    Assert-True ($log -notmatch 'withheld response body|failed after marker|bad json') "Raw diagnostics escaped for $case."
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
  }
} finally {
  $env:RELEASE_SHA = $priorReleaseSha
}
Microsoft.PowerShell.Utility\Write-Host "VM release tests: ok ($($cases.Count) offline scenarios plus native/guest cleanup boundaries)."
