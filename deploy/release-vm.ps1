#requires -Version 7.2
<#
.SYNOPSIS
  Builds the selected clean main commit in ACR and waits for exact VM/public health.
.NOTES
  Mutating release, not infrastructure setup. Requires an already authenticated Azure CLI.
  No write is resubmitted on failure. Stopping this command does not cancel cloud work.
#>
param([string]$ExpectedCommit = $env:RELEASE_SHA)

$ErrorActionPreference = 'Stop'
$ReleaseDeadlineSeconds = 2100

. (Join-Path $PSScriptRoot 'release-vm-evidence.ps1')

function Stop-VmRelease([string]$Message, [int]$ExitCode = 1) {
  $failure = [InvalidOperationException]::new($Message)
  $failure.Data['ReleaseExitCode'] = $ExitCode
  throw $failure
}

function Invoke-ReleaseNative([string]$Command, [string[]]$Arguments, [string]$Directory, [int]$TimeoutSeconds) {
  $executable = (Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  # A child PowerShell handles az.cmd without shell-string argument interpolation.
  $quoted = @($executable) + $Arguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
  $source = "`$ErrorActionPreference = 'Stop'; `$PSNativeCommandUseErrorActionPreference = `$false; `$LASTEXITCODE = 1; & $($quoted -join ' '); exit `$LASTEXITCODE"
  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $Directory
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @('-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source)))) {
    $start.ArgumentList.Add($argument)
  }
  $start.Environment['AZURE_EXTENSION_USE_DYNAMIC_INSTALL'] = 'no'
  $start.Environment['AZURE_CORE_COLLECT_TELEMETRY'] = 'no'
  $start.Environment['AZURE_LOGGING_ENABLE_LOG_FILE'] = 'no'
  $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      Stop-VmRelease 'Local command deadline exceeded; remote work may still be running. Do not retry the release.' 124
    }
    # Drain both pipes, but never print native errors or VM/build logs.
    $drainMs = [math]::Max(0, $TimeoutSeconds * 1000 - [int]$clock.ElapsedMilliseconds)
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), $drainMs)) {
      Stop-VmRelease 'Native output did not close within the deadline; remote work may still be running.' 124
    }
    [void]$stderr.GetAwaiter().GetResult()
    $output = $stdout.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      Stop-VmRelease "Native command failed (exit $($process.ExitCode)); raw output withheld." $process.ExitCode
    }
    return $output.Trim()
  } finally {
    $process.Dispose()
  }
}

function Invoke-ReleaseStep([string]$Command, [string[]]$Arguments, [int]$Limit = 30) {
  $remaining = [math]::Floor($ReleaseDeadlineSeconds - $releaseClock.Elapsed.TotalSeconds)
  if ($remaining -lt 1) { Stop-VmRelease 'Release deadline exceeded; remote work may still be running. Do not retry.' 124 }
  Invoke-ReleaseNative $Command $Arguments $sourceRoot ([math]::Min($Limit, $remaining))
}

function Invoke-ReleaseStepBytes([string]$Command, [string[]]$Arguments, [int]$Limit = 30) {
  $remaining = [math]::Floor($ReleaseDeadlineSeconds - $releaseClock.Elapsed.TotalSeconds)
  if ($remaining -lt 1) { Stop-VmRelease 'Release deadline exceeded; remote work may still be running. Do not retry.' 124 }
  $timeoutSeconds = [math]::Min($Limit, $remaining)
  $executable = (Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $start = [Diagnostics.ProcessStartInfo]::new($executable)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $sourceRoot
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $buffer = [IO.MemoryStream]::new()
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.BaseStream.CopyToAsync($buffer)
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
      $process.Kill($true)
      Stop-VmRelease 'Local command deadline exceeded; remote work may still be running. Do not retry the release.' 124
    }
    $drainMs = [math]::Max(0, $timeoutSeconds * 1000 - [int]$clock.ElapsedMilliseconds)
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), $drainMs)) {
      Stop-VmRelease 'Native output did not close within the deadline; remote work may still be running.' 124
    }
    [void]$stdout.GetAwaiter().GetResult()
    [void]$stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      Stop-VmRelease "Native command failed (exit $($process.ExitCode)); raw output withheld." $process.ExitCode
    }
    return ,$buffer.ToArray()
  } finally {
    $buffer.Dispose()
    $process.Dispose()
  }
}

function Invoke-ReleaseAz([string[]]$Arguments, [int]$Limit = 30) {
  Invoke-ReleaseStep 'az' ($Arguments + @('--only-show-errors', '--output', 'json')) $Limit
}

function ConvertFrom-ReleaseJson([string]$Text) {
  try {
    return ConvertFrom-Json -InputObject $Text -AsHashtable -NoEnumerate -ErrorAction Stop
  } catch [ArgumentException] {
    Stop-VmRelease 'Malformed JSON response; raw output withheld.'
  }
}

function Assert-ReleaseSource([string]$Commit) {
  $branch = Invoke-ReleaseStep 'git' @('rev-parse', '--abbrev-ref', 'HEAD')
  if ($branch -cne 'main') { Stop-VmRelease 'Wrong branch: a release requires the clean main checkout (not a feature branch or detached HEAD).' }
  $head = Invoke-ReleaseStep 'git' @('rev-parse', '--verify', 'HEAD')
  if ($head -cne $Commit) { Stop-VmRelease 'Wrong HEAD: checked-out source does not match the expected full commit.' }
  $dirty = Invoke-ReleaseStep 'git' @('status', '--porcelain=v1', '--untracked-files=all')
  if ($dirty) { Stop-VmRelease 'Dirty checkout: commit or remove source changes before releasing.' }
}

function Get-ReleaseSha256([byte[]]$Bytes) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Assert-ReleaseWorkingLock([string]$ExpectedSha256) {
  $workingLock = [IO.File]::ReadAllBytes((Join-Path $sourceRoot 'package-lock.json'))
  if ((Get-ReleaseSha256 $workingLock) -cne $ExpectedSha256) {
    Stop-VmRelease 'Dependency lock does not match the selected commit.'
  }
}

function Get-ReleaseCommittedLockIdentity([string]$Commit) {
  [byte[]]$committedLock = Invoke-ReleaseStepBytes 'git' @('cat-file', 'blob', "$Commit`:package-lock.json")
  if ($committedLock.Length -eq 0) { Stop-VmRelease 'Selected commit has an empty dependency lock.' }
  $identity = Get-ReleaseSha256 $committedLock
  Assert-ReleaseWorkingLock $identity
  return $identity
}

function Test-ReleaseExactKeys($Value, [string[]]$Expected) {
  if ($Value -isnot [System.Collections.IDictionary] -or $Value.Count -ne $Expected.Count) { return $false }
  $actual = @($Value.Keys)
  foreach ($key in $Expected) {
    if ($actual -cnotcontains $key) { return $false }
  }
  return $true
}

function Assert-ReleaseDependencyReport($Report) {
  $countFields = @('blocked', 'info', 'low', 'moderate', 'high', 'critical', 'vulnerabilities', 'reported', 'omitted')
  if (-not (Test-ReleaseExactKeys $Report @('status', 'counts', 'packages')) -or
      $Report['status'] -isnot [string] -or $Report['status'] -cne 'pass' -or
      -not (Test-ReleaseExactKeys $Report['counts'] $countFields) -or
      $Report['packages'] -isnot [array] -or $Report['packages'].Count -ne 0) {
    Stop-VmRelease 'Dependency preflight did not return the required pass report.'
  }
  foreach ($field in $countFields) {
    $count = $Report['counts'][$field]
    if (($count -isnot [int] -and $count -isnot [long]) -or $count -ne 0) {
      Stop-VmRelease 'Dependency preflight did not return the required pass report.'
    }
  }
}

function Assert-ReleaseDependencyPreflight([string]$Commit) {
  try {
    $lockIdentity = Get-ReleaseCommittedLockIdentity $Commit
    $output = Invoke-ReleaseStep 'npm' @(
      'run', '--silent', 'dependency:preflight', '--',
      '--lock-sha256', $lockIdentity, '--run-audit'
    ) 300
    if ([Text.Encoding]::UTF8.GetByteCount($output) -gt 8192) {
      Stop-VmRelease 'Dependency preflight output exceeded its release bound.'
    }
    Assert-ReleaseDependencyReport (ConvertFrom-ReleaseJson $output)
    Assert-ReleaseWorkingLock $lockIdentity
  } catch {
    $code = 1
    if ($_.Exception.Data.Contains('ReleaseExitCode')) { $code = $_.Exception.Data['ReleaseExitCode'] }
    Stop-VmRelease 'Dependency preflight failed; raw output withheld.' $code
  }
}

function Assert-ReleaseHealth($Health, [string]$Commit, [string]$Location) {
  if ($Health -isnot [System.Collections.IDictionary]) { Stop-VmRelease "$Location health is not a JSON object." }
  foreach ($field in @('ok', 'db', 'collab')) {
    if ($Health[$field] -isnot [bool] -or $Health[$field] -ne $true) {
      Stop-VmRelease "$Location health requires ok, db and collab to be boolean true."
    }
  }
  if ($Health['version'] -isnot [string] -or $Health['version'] -cne $Commit) {
    Stop-VmRelease "$Location health version does not match the expected full commit."
  }
}

function Get-ReleasePublicHealth([string]$Origin, [int]$TimeoutSeconds) {
  Invoke-RestMethod -Uri "$Origin/api/health" -Method Get -TimeoutSec $TimeoutSeconds `
    -MaximumRedirection 0 -Headers @{ 'Cache-Control' = 'no-cache' } -ErrorAction Stop |
    ConvertTo-Json -Depth 5 -Compress
}

function Invoke-MarkdocVmRelease([string]$Commit) {
  $releaseClock = [Diagnostics.Stopwatch]::StartNew()
  $sourceRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
  $subscription = '332d0c98-694c-48a0-91f3-465de6ac30a5'
  $tenant = 'f1fde69f-c8d3-4b94-adeb-02d045b37f6a'
  $group = 'markdoc-rg'
  $acr = 'markdocacrmnd542unepl56'
  $registry = 'markdocacrmnd542unepl56.azurecr.io'
  $vm = 'markdoc-pg'
  $publicIp = 'markdoc-web-ip'
  $azureFqdn = 'markdoc-burkeholland.eastus2.cloudapp.azure.com'
  $origin = 'https://markdoc.app'
  $resourceRoot = "/subscriptions/$subscription/resourceGroups/$group/providers"
  $vmId = "$resourceRoot/Microsoft.Compute/virtualMachines/$vm"
  $nativeScope = @('--subscription', $subscription, '--resource-group', $group)
  $subscriptionScope = @('--subscription', $subscription)
  $context = $null
  $releaseStage = 'source validation'
  $buildRun = $null
  $operation = $null
  try {
    if ($Commit -cnotmatch '^[0-9a-fA-F]{40}$') { Stop-VmRelease 'ExpectedCommit or RELEASE_SHA must be a full 40-hex Git commit.' }
    $Commit = $Commit.ToLowerInvariant()
    if ($env:RELEASE_SHA -and $env:RELEASE_SHA -ine $Commit) { Stop-VmRelease 'ExpectedCommit conflicts with RELEASE_SHA.' }
    Assert-ReleaseSource $Commit

    $releaseStage = 'dependency preflight'
    Assert-ReleaseDependencyPreflight $Commit
    Assert-ReleaseSource $Commit

    $releaseStage = 'Azure context and target validation'
    Write-Host "Release: validating the existing VM target for $Commit."
    $account = ConvertFrom-ReleaseJson (Invoke-ReleaseAz @('account', 'show', '--query', '{id:id,tenantId:tenantId,state:state,environmentName:environmentName}'))
    if ($account.id -ine $subscription -or $account.tenantId -ine $tenant -or $account.state -cne 'Enabled' -or $account.environmentName -cne 'AzureCloud') {
      Stop-VmRelease 'Wrong Azure context: expected the configured enabled subscription/tenant in AzureCloud. No account was changed.'
    }
    $registryInfo = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('acr', 'show', '--name', $acr, '--query', '{id:id,loginServer:loginServer}') + $nativeScope))
    if ($registryInfo.id -ine "$resourceRoot/Microsoft.ContainerRegistry/registries/$acr" -or $registryInfo.loginServer -cne $registry) {
      Stop-VmRelease 'Registry identity does not match the configured VM release target.'
    }
    $vmInfo = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('vm', 'show', '--name', $vm, '--query', '{id:id,os:storageProfile.osDisk.osType,nics:networkProfile.networkInterfaces[].id}') + $nativeScope))
    $ipInfo = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('network', 'public-ip', 'show', '--name', $publicIp, '--query', '{id:id,fqdn:dnsSettings.fqdn,configuration:ipConfiguration.id}') + $nativeScope))
    $nicId = "$resourceRoot/Microsoft.Network/networkInterfaces/markdoc-pg-nic"
    if ($vmInfo.id -ine $vmId -or $vmInfo.os -cne 'Linux' -or @($vmInfo.nics) -inotcontains $nicId -or
        $ipInfo.id -ine "$resourceRoot/Microsoft.Network/publicIPAddresses/$publicIp" -or
        $ipInfo.configuration -ine "$nicId/ipConfigurations/primary" -or $ipInfo.fqdn -cne $azureFqdn) {
      Stop-VmRelease 'VM/public IP association or public origin does not match the configured stable target.'
    }

    $releaseStage = 'exact source archive'
    $context = Join-Path ([IO.Path]::GetTempPath()) "markdoc-release-$([guid]::NewGuid().ToString('N'))"
    [void](New-Item -ItemType Directory -Path $context)
    [void](Invoke-ReleaseStep 'git' @('archive', '--format=tar', "--output=$context\source.tar", $Commit))
    [void](Invoke-ReleaseStep 'tar' @('-xf', "$context\source.tar", '-C', $context))
    Remove-Item -LiteralPath "$context\source.tar"
    $vmScript = Join-Path $context 'infra\deploy-vm-image.sh'
    $walScript = Join-Path $context 'infra\release-wal-gate.sh'
    if (-not (Test-Path -LiteralPath (Join-Path $context 'Dockerfile')) -or
      -not (Test-Path -LiteralPath $vmScript) -or -not (Test-Path -LiteralPath $walScript)) {
      Stop-VmRelease 'Selected source archive lacks the Dockerfile or release guest scripts.'
    }
    Assert-ReleaseSource $Commit
    $releaseStage = 'ACR build submission'
    # A unique additional tag can identify a submission even if the run-ID response is lost.
    $submissionTag = "release-$([guid]::NewGuid().ToString('N'))"
    Write-Host "Release: ACR submission $acr/markdoc:$submissionTag (run ID not yet returned)."
    Write-Host 'Stopping the CLI does not cancel cloud work. Reconcile this submission before any retry.'
    [void](Invoke-ReleaseAz (@(
      'acr', 'build', '--registry', $acr, '--image', "markdoc:$Commit", '--image', "markdoc:$($Commit.Substring(0, 12))",
      '--image', "markdoc:$submissionTag", '--build-arg', "APP_VERSION=$Commit",
      '--file', (Join-Path $context 'Dockerfile'), $context, '--timeout', '600',
      '--no-wait', '--no-logs'
    ) + $nativeScope) 90)

    $releaseStage = 'ACR build reconciliation'
    for ($attempt = 1; $attempt -le 132; $attempt++) {
      $runs = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@(
        'acr', 'task', 'list-runs', '--registry', $acr, '--top', '50',
        '--query', '[].{runId:runId,runType:runType,status:status,outputImages:outputImages}'
      ) + $nativeScope))
      if ($runs -isnot [array]) {
        Stop-VmRelease 'ACR build reconciliation did not return a run list.'
      }
      $matches = @(
        $runs | Where-Object {
          $_ -is [System.Collections.IDictionary] -and
          $_['runType'] -ceq 'QuickRun' -and
          @($_['outputImages'] | Where-Object {
            $_ -is [System.Collections.IDictionary] -and $_['tag'] -ceq $submissionTag
          }).Count -eq 1
        }
      )
      if ($matches.Count -gt 1) {
        Stop-VmRelease 'The unique ACR submission tag matched more than one build run.'
      }
      if ($matches.Count -eq 1) {
        $buildRun = $matches[0]['runId']
        if ($buildRun -isnot [string] -or $buildRun -cnotmatch '^[a-zA-Z0-9]{1,80}$') {
          Stop-VmRelease 'The reconciled ACR build run has an invalid identity.'
        }
        break
      }
      if ($attempt -lt 132) { Start-Sleep -Seconds 5 }
    }
    if (-not $buildRun) {
      Stop-VmRelease 'ACR submission acceptance is unknown after unique-tag reconciliation. Do not retry.'
    }
    Write-Host "Release: ACR run $buildRun; registry $acr."
    $releaseStage = 'ACR build completion'
    do {
      if ($releaseClock.Elapsed.TotalSeconds -ge 750) { Stop-VmRelease 'Build wait exceeded the terminal budget; remote build may continue. No VM command was sent.' 124 }
      $run = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('acr', 'task', 'show-run', '--registry', $acr, '--run-id', $buildRun, '--query', '{runId:runId,status:status,outputImages:outputImages}') + $nativeScope))
      if ($run.runId -cne $buildRun) { Stop-VmRelease 'ACR returned a different run identity.' }
      if ($run.status -ceq 'Succeeded') { break }
      if ($run.status -cnotin @('Queued', 'Started', 'Running')) { Stop-VmRelease 'ACR build failed or returned an unknown status.' }
      Start-Sleep -Seconds 5
    } while ($true)

    $releaseStage = 'immutable image identity'
    $digests = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('acr', 'manifest', 'list-metadata', '--registry', $acr, '--name', 'markdoc',
      '--query', "[?tags != null && contains(tags, '$Commit')].digest") + $subscriptionScope))
    if ($digests -isnot [array] -or $digests.Count -ne 1 -or $digests[0] -isnot [string] -or $digests[0] -cnotmatch '^sha256:[0-9a-f]{64}$') {
      Stop-VmRelease 'The exact commit tag has an absent, ambiguous or malformed digest.'
    }
    $digest = $digests[0]
    $builtImages = @($run.outputImages | Where-Object { $_.registry -ceq $registry -and $_.repository -ceq 'markdoc' -and $_.tag -ceq $Commit })
    if ($builtImages.Count -ne 1 -or $builtImages[0].digest -cne $digest) { Stop-VmRelease 'The exact tag digest does not match this successful build run.' }
    $image = "$registry/markdoc@$digest"
    Assert-ReleaseSource $Commit
    $releaseStage = 'VM guest deployment'
    $operation = [guid]::NewGuid().ToString()
    Write-Host "Release: image $image"
    Write-Host "Release: guest invocation $operation; VM $vmId; started $([DateTime]::UtcNow.ToString('o'))."
    Write-Host 'ARM operation ID is not exposed by invoke. The guest ID is recorded in the submitted script parameters and guest output.'
    Write-Host 'Timeout/failure is unverified, not cancellation or automatic rollback. Do not submit another release.'
    $vmLimit = [math]::Floor(($ReleaseDeadlineSeconds - 30) - $releaseClock.Elapsed.TotalSeconds)
    if ($vmLimit -lt 1) { Stop-VmRelease 'No time remains for a VM invocation and public health.' 124 }
    $result = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('vm', 'run-command', 'invoke', '--name', $vm, '--command-id', 'RunShellScript',
      '--scripts', "@$walScript", "@$vmScript", '--parameters', $registry, $image, $Commit, $tenant, $operation) + $nativeScope) $vmLimit)
    $messages = @($result.value)
    if ($messages.Count -ne 1 -or $messages[0].code -cne 'ProvisioningState/succeeded' -or $messages[0].message -isnot [string]) {
      Stop-VmRelease 'VM transport did not return the expected completed result.'
    }
    $message = $messages[0].message.Replace("`r`n", "`n")
    $stdout = [regex]::Match($message, '(?s)\[stdout\]\n(?<output>.*?)\n\[stderr\](?<error>.*)$')
    if (-not $stdout.Success) { Stop-VmRelease 'VM result is missing distinct guest stdout/stderr evidence.' }
    $terminal = [regex]::Match($stdout.Groups['output'].Value.TrimEnd(),
      "(?m)^(?<health>\{[^\r\n]+\})\nmarkdoc-vm-image-ready\nmarkdoc-vm-image-operation-ready:$operation\z")
    if (-not $terminal.Success) {
      $walFailure = Get-ReleaseWalFailure $stdout.Groups['output'].Value $operation
      if ($walFailure) {
        Stop-VmRelease "Release WAL gate failed during $($walFailure.Stage); owned cleanup=$($walFailure.Cleanup)."
      }
      Stop-VmRelease 'VM transport succeeded without exact terminal guest-ready and local-health evidence.'
    }
    [void](Assert-ReleaseWalEvidence $stdout.Groups['output'].Value $operation $terminal.Index)
    Assert-ReleaseHealth (ConvertFrom-ReleaseJson $terminal.Groups['health'].Value) $Commit 'Local'
    $releaseStage = 'public health after guest ready (no automatic rollback)'
    Write-Host 'Release: guest ready; waiting for exact public health.'
    $healthLimit = [math]::Min(20, [math]::Floor($ReleaseDeadlineSeconds - $releaseClock.Elapsed.TotalSeconds))
    if ($healthLimit -lt 1) { Stop-VmRelease 'No time remains to verify public health; guest deployment may be active.' 124 }
    $health = ConvertFrom-ReleaseJson (Get-ReleasePublicHealth $origin $healthLimit)
    Assert-ReleaseHealth $health $Commit 'Public'
    Write-Host "Release complete: $origin reports ok/db/collab true and version $Commit."
  } catch {
    # Fail closed at the terminal boundary without leaking a CLI/HTTP error body.
    $code = 1
    $reason = "Unexpected $($_.Exception.GetType().Name); raw output withheld."
    if ($_.Exception.Data.Contains('ReleaseExitCode')) {
      $code = $_.Exception.Data['ReleaseExitCode']
      $reason = $_.Exception.Message
    }
    Write-Host "Release failed/unverified at ${releaseStage}: $reason"
    if ($buildRun) { Write-Host "ACR run: $buildRun; registry: $acr." }
    if ($operation) { Write-Host "Guest invocation: $operation; VM: $vmId. Cloud work may outlive this command; no retry was submitted." }
    Stop-VmRelease 'Release did not reach verified completion.' $code
  } finally {
    if ($context -and (Test-Path -LiteralPath $context)) { Remove-Item -LiteralPath $context -Recurse -Force }
  }
}

try {
  Invoke-MarkdocVmRelease $ExpectedCommit
} catch [InvalidOperationException] {
  if ($_.Exception.Data.Contains('ReleaseExitCode')) { exit $_.Exception.Data['ReleaseExitCode'] }
  throw
}
