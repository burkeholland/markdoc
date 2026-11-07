#requires -Version 7.2
$ErrorActionPreference = 'Stop'

$script:Passed = 0

function Stop-VmRelease([string]$Message, [int]$ExitCode = 1) {
  $failure = [InvalidOperationException]::new($Message)
  $failure.Data['ReleaseExitCode'] = $ExitCode
  throw $failure
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  $script:Passed++
}

function Assert-Rejected([scriptblock]$Action, [string]$Message) {
  try {
    & $Action
  } catch [InvalidOperationException] {
    $script:Passed++
    return
  }
  throw "Assertion failed: $Message"
}

. (Join-Path $PSScriptRoot 'release-vm-evidence.ps1')

$operation = '12345678-1234-4abc-8def-1234567890ab'
$otherOperation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
$wal = '000000010000000300000025'
$archiveObject = "$wal-0123456789abcdef0123456789abcdef01234567.gz"
$block = @(
  "markdoc-release-wal-operation:$operation"
  "markdoc-release-wal-capture:${operation}:3/25002220:$wal"
  "markdoc-release-wal-switch:${operation}:true"
  "markdoc-release-wal-archive:${operation}:${wal}:$archiveObject"
  "markdoc-release-wal-restore:${operation}:true"
  "markdoc-release-wal-sql-ready:${operation}:true"
  "markdoc-release-wal-replay:${operation}:3/25002220:3/25003333"
  "markdoc-release-wal-cleanup:${operation}:true"
  "markdoc-release-wal-ready:${operation}:3/25002220:${wal}:${archiveObject}:3/25003333"
) -join "`n"
$terminal = @(
  '{"ok":true,"db":true,"collab":true,"version":"0123456789012345678901234567890123456789"}'
  'markdoc-vm-image-ready'
  "markdoc-vm-image-operation-ready:$operation"
) -join "`n"
$output = "prefix`n$block`n$terminal"
$evidence = Assert-ReleaseWalEvidence $output $operation $output.IndexOf('{')
Assert-True ($evidence.Endpoint -ceq '3/25002220') 'Captured endpoint was not returned exactly.'
Assert-True ($evidence.WalSegment -ceq $wal) 'WAL segment was not returned exactly.'
Assert-True ($evidence.ArchiveObject -ceq $archiveObject) 'Repository object was not returned exactly.'
Assert-True ($evidence.ReplayLsn -ceq '3/25003333') 'Replay LSN was not returned exactly.'

Assert-Rejected {
  [void](Assert-ReleaseWalEvidence ($output -replace "(?m)^markdoc-release-wal-archive:.*\r?\n", '') $operation $output.IndexOf('{'))
} 'Missing archive evidence was accepted.'
Assert-Rejected {
  [void](Assert-ReleaseWalEvidence ($output -replace '3/25002220', 'bad-lsn') $operation $output.IndexOf('{'))
} 'Malformed endpoint evidence was accepted.'
Assert-Rejected {
  [void](Assert-ReleaseWalEvidence ($output -replace [regex]::Escape($operation), $otherOperation) $operation $output.IndexOf('{'))
} 'Wrong operation evidence was accepted.'
Assert-Rejected {
  $reordered = $output -replace "(?m)^(markdoc-release-wal-switch:[^\r\n]+)\r?\n(markdoc-release-wal-archive:[^\r\n]+)", ('$2' + "`n" + '$1')
  [void](Assert-ReleaseWalEvidence $reordered $operation $reordered.IndexOf('{'))
} 'Reordered switch/archive evidence was accepted.'
Assert-Rejected {
  $duplicate = $output -replace 'markdoc-release-wal-switch:', "markdoc-release-wal-switch:$operation`:true`nmarkdoc-release-wal-switch:"
  [void](Assert-ReleaseWalEvidence $duplicate $operation $duplicate.IndexOf('{'))
} 'Duplicate recovery evidence was accepted.'
Assert-Rejected {
  $otherArchiveObject = "$wal-1123456789abcdef0123456789abcdef01234567.gz"
  $wrongObject = $output.Replace(
    "markdoc-release-wal-ready:${operation}:3/25002220:${wal}:${archiveObject}:3/25003333",
    "markdoc-release-wal-ready:${operation}:3/25002220:${wal}:${otherArchiveObject}:3/25003333"
  )
  [void](Assert-ReleaseWalEvidence $wrongObject $operation $wrongObject.IndexOf('{'))
} 'Wrong archived object was accepted.'
Assert-Rejected {
  $malformedObject = $output -replace [regex]::Escape($archiveObject), "$wal-0123456789abcdef0123456789abcdef0123456.gz"
  [void](Assert-ReleaseWalEvidence $malformedObject $operation $malformedObject.IndexOf('{'))
} 'Malformed repository object was accepted.'
Assert-Rejected {
  $behind = $output.Replace('3/25003333', '3/24000000')
  [void](Assert-ReleaseWalEvidence $behind $operation $behind.IndexOf('{'))
} 'Replay behind the endpoint was accepted.'
Assert-Rejected {
  [void](Assert-ReleaseWalEvidence $output $operation 0)
} 'Recovery evidence after the application boundary was accepted.'

$failure = Get-ReleaseWalFailure "markdoc-release-wal-failed:$operation`:archive:cleanup=true" $operation
Assert-True ($failure.Stage -ceq 'archive' -and $failure.Cleanup -ceq 'true') 'Bound failure evidence was not parsed.'
Assert-True ($null -eq (Get-ReleaseWalFailure "markdoc-release-wal-failed:$otherOperation`:archive:cleanup=true" $operation)) 'Wrong-operation failure evidence was accepted.'
Assert-True ($null -eq (Get-ReleaseWalFailure "markdoc-release-wal-failed:$operation`:unknown:cleanup=true" $operation)) 'Unknown failure stage was accepted.'

$spaceFailure = @(
  "markdoc-release-wal-failed:${operation}:space:cleanup=true"
  "markdoc-release-wal-space:${operation}:available=436326400:required=2253180108:reserve=2147483648"
) -join "`n"
$failure = Get-ReleaseWalFailure $spaceFailure $operation
Assert-True ($null -ne $failure -and $failure.Stage -ceq 'space') 'Low-space gate failure was not recognized.'
Assert-True ($failure.Budget -ceq 'Available 436326400 bytes; required 2253180108 bytes, including a 2147483648-byte production reserve.') 'Validated space budget was not surfaced.'
$failure = Get-ReleaseWalFailure ($spaceFailure.Replace('available=436326400', 'available=private-token')) $operation
Assert-True ($failure.Budget -ceq 'Scratch disk budget could not be verified.') 'Untrusted space values were exposed.'
$failure = Get-ReleaseWalFailure ($spaceFailure.Replace('available=436326400', 'available=8589934592')) $operation
Assert-True ($failure.Budget -ceq 'Scratch disk budget could not be verified.') 'A contradictory space failure was accepted as a measured budget.'

$diagnosticFailure = @(
  "markdoc-release-wal-failed:${operation}:sql-ready:cleanup=true"
  "markdoc-release-wal-log:${operation}:PANIC:disk-full"
  "markdoc-release-wal-log:${operation}:FATAL:recovery-target-unreached"
  "markdoc-release-wal-log:${operation}:FATAL:message-withheld"
  "markdoc-release-wal-log:${operation}:FATAL:private-token"
  "markdoc-release-wal-log:${otherOperation}:PANIC:disk-full"
) -join "`n"
$failure = Get-ReleaseWalFailure $diagnosticFailure $operation
Assert-True ($failure.Diagnostics.Count -eq 3) 'Diagnostics were not filtered to recognized operation-bound records.'
Assert-True ($failure.Diagnostics[0] -ceq 'Scratch PANIC: No space left on device.') 'Disk-full diagnostic was not surfaced safely.'
Assert-True (($failure.Diagnostics -join "`n") -notmatch 'private-token') 'Raw diagnostic content escaped the allow-list.'
$manyDiagnostics = "markdoc-release-wal-failed:${operation}:start:cleanup=true`n" +
  (("markdoc-release-wal-log:${operation}:FATAL:disk-full`n") * 20)
$failure = Get-ReleaseWalFailure $manyDiagnostics $operation
Assert-True ($failure.Diagnostics.Count -eq 10) 'Client diagnostic output was not bounded to ten records.'

$signalFailure = @(
  "markdoc-release-wal-failed:${operation}:sql-ready:cleanup=true"
  "markdoc-release-wal-log:${operation}:LOG:killed-by-signal-9"
  "markdoc-release-wal-log:${operation}:LOG:killed-by-signal-15"
  "markdoc-release-wal-log:${operation}:LOG:startup-aborted"
  "markdoc-release-wal-log:${operation}:LOG:killed-by-signal-0"
  "markdoc-release-wal-log:${operation}:LOG:killed-by-signal-999"
  "markdoc-release-wal-log:${operation}:LOG:private-token"
) -join "`n"
$failure = Get-ReleaseWalFailure $signalFailure $operation
Assert-True ($failure.Diagnostics.Count -eq 3) 'Signal diagnostics were not restricted to valid signal numbers and fixed startup reasons.'
Assert-True ($failure.Diagnostics[0] -ceq 'Scratch LOG: A server process was terminated by signal 9.') 'Signal-9 diagnosis was not surfaced.'
Assert-True ($failure.Diagnostics[2] -ceq 'Scratch LOG: Startup was aborted after a startup process failure.') 'Startup abort diagnosis was not surfaced.'

$imageSpace = "markdoc-vm-image-space-failed:${operation}:pull:available=436326400:required=6442450944:reserve=2147483648"
Assert-True ((Get-ReleaseImageSpaceFailure $imageSpace $operation) -cmatch 'Insufficient disk space before image pull; application unchanged') 'Pre-pull disk refusal was not surfaced.'
Assert-True ($null -eq (Get-ReleaseImageSpaceFailure $imageSpace $otherOperation)) 'Wrong-operation image space failure was accepted.'
Assert-True ($null -eq (Get-ReleaseImageSpaceFailure ($imageSpace.Replace('436326400', 'private-token')) $operation)) 'Raw image-space values were accepted.'
Assert-True ($null -eq (Get-ReleaseImageSpaceFailure ($imageSpace.Replace('436326400', '8589934592')) $operation)) 'Contradictory image capacity was accepted.'
Assert-True ((Get-ReleaseImageSpaceFailure "markdoc-vm-image-space-failed:${operation}:activate:reason=unavailable" $operation) -cmatch 'could not be verified before activate; application unchanged') 'Unknown activation capacity was not surfaced safely.'

$releaseSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-vm.ps1') -Raw
$deploySource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'deploy-vm-image.sh')) -Raw
$gateSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'release-wal-gate.sh')) -Raw
$workflowSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', '.github', 'workflows', 'deploy.yml')) -Raw
$readmeSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'README.md')) -Raw
$hostingSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'docs', 'vm-hosting.md')) -Raw

Assert-True ([regex]::Matches($releaseSource, "'vm', 'run-command', 'invoke'").Count -eq 1) 'Terminal release must retain one VM invocation.'
Assert-True ([regex]::Matches($releaseSource, "'acr', 'build'").Count -eq 1) 'Terminal release must retain one ACR submission.'
Assert-True ([regex]::Matches($workflowSource, 'deploy/release-vm\.ps1').Count -eq 1 -and
  $workflowSource -match '(?m)^\s*run: \./deploy/release-vm\.ps1 -ExpectedCommit \$env:RELEASE_SHA -Target Enterprise\s*$') 'The workflow must invoke the configured release entrypoint once for the pinned RELEASE_SHA.'
Assert-True ($workflowSource -match '(?m)^\s+runs-on: windows-latest\s*$' -and
  $workflowSource -match '(?m)^\s+shell: pwsh\s*$') 'The Windows release entrypoint must run with the PowerShell already installed on the hosted Windows runner.'
Assert-True ($workflowSource -notmatch '\baz\s+acr\s+build\b' -and
  $workflowSource -notmatch '\baz\s+vm\s+run-command\b') 'The workflow must not duplicate either Azure write owned by the release entrypoint.'
Assert-True ($releaseSource -match '--scripts'', "@\$walScript", "@\$vmScript"') 'The configured release must send the WAL gate before deployment in one VM invocation.'
function Get-SourceConstant([string]$Source, [string]$Name) {
  $match = [regex]::Match($Source, "(?m)^\`$$Name = (?<value>[0-9]+)\s*$")
  if (-not $match.Success) { return $null }
  return [int]$match.Groups['value'].Value
}
function Test-ReleaseBoundaryInvariants([hashtable]$Sources) {
  $release = $Sources.Release
  $workflow = $Sources.Workflow
  $readme = $Sources.Readme
  $hosting = $Sources.Hosting
  $documentation = "$($Sources.Readme)`n$($Sources.Hosting)`n$workflow"
  $timeouts = @([regex]::Matches($workflow, '(?m)^\s+timeout-minutes: (?<minutes>[0-9]+)\s*$') |
    ForEach-Object { [int]$_.Groups['minutes'].Value })
  if ((Get-SourceConstant $release 'PreSubmissionDeadlineSeconds') -ne 900 -or
      (Get-SourceConstant $release 'AcrBuildSubmissionTimeoutSeconds') -ne 300 -or
      (Get-SourceConstant $release 'AcrBuildTimeoutSeconds') -ne 900 -or
      (Get-SourceConstant $release 'BuildPhaseDeadlineSeconds') -ne 1350 -or
      (Get-SourceConstant $release 'PostBuildVerificationDeadlineSeconds') -ne 180 -or
      (Get-SourceConstant $release 'VmPhaseDeadlineSeconds') -ne 2400 -or
      (Get-SourceConstant $release 'PublicHealthDeadlineSeconds') -ne 30 -or
      (Get-SourceConstant $release 'CleanupChildTimeoutSeconds') -ne 30 -or
      $null -ne (Get-SourceConstant $release 'BuildReconciliationReserveSeconds') -or
      $null -ne (Get-SourceConstant $release 'ReportDeadlineSeconds') -or
      $null -ne (Get-SourceConstant $release 'ReleaseTerminalDeadlineSeconds')) {
    return $false
  }
  if ($timeouts.Count -ne 6 -or ($timeouts -join ',') -cne '5,99,5,5,5,79') { return $false }
  if ([regex]::Matches($release, "'acr', 'build'").Count -ne 1 -or
      [regex]::Matches($release, "'vm', 'run-command', 'invoke'").Count -ne 1 -or
      $release -notmatch '(?ms)^function Invoke-MarkdocVmRelease\(\[string\]\$Commit\) \{\r?\n\s+\$releaseClock = \[Diagnostics\.Stopwatch\]::StartNew\(\)' -or
      $release -notmatch '(?ms)^function Start-ReleaseBoundedSleep\([^\r\n]+\) \{\r?\n\s+\$remaining = Get-ReleaseRemainingSeconds \$Clock \$BudgetSeconds \$Message\r?\n\s+if \(\$remaining -lt \$Seconds\) \{ Stop-VmRelease \$Message 124 \}\r?\n\s+Start-Sleep -Seconds \$Seconds\r?\n\s+Assert-ReleaseDeadline \$Clock \$BudgetSeconds \$Message\r?\n\}' -or
      [regex]::Matches($release, 'Invoke-ReleaseAcrPoll[\s\S]{0,500}\$buildClock \$BuildPhaseDeadlineSeconds \$buildDeadlineMessage').Count -ne 2 -or
      [regex]::Matches($release, 'Start-ReleaseBoundedSleep \$buildClock \$BuildPhaseDeadlineSeconds 5 \$buildDeadlineMessage').Count -ne 4 -or
      $release -notmatch 'for \(\$attempt = 1; \$attempt -le 132; \$attempt\+\+\)' -or
      $release -notmatch '(?ms)^\s+\$digests = ConvertFrom-ReleaseJson \(Invoke-ReleaseDigestLookup.*?^\s+\$postBuildClock \$PostBuildVerificationDeadlineSeconds \$postBuildDeadlineMessage\)' -or
      $release -notmatch 'Assert-ReleaseSource \$Commit \$postBuildClock \$PostBuildVerificationDeadlineSeconds \$postBuildDeadlineMessage' -or
      $release -notmatch '\$vmLimit = Get-ReleaseRemainingSeconds \$vmClock \$VmPhaseDeadlineSeconds \$vmDeadlineMessage' -or
      $release -notmatch 'Assert-ReleaseDeadline \$vmClock \$VmPhaseDeadlineSeconds \$vmDeadlineMessage' -or
      $release -notmatch 'Get-ReleaseRemainingSeconds \$healthClock \$PublicHealthDeadlineSeconds \$healthDeadlineMessage' -or
      $release -notmatch 'Assert-ReleaseDeadline \$healthClock \$PublicHealthDeadlineSeconds \$healthDeadlineMessage' -or
      $release -notmatch '(?ms)^function Get-ReleasePublicHealth\(\[string\]\$Origin, \[int\]\$TimeoutSeconds\) \{\r?\n\s+Invoke-RestMethod .+? -TimeoutSec \$TimeoutSeconds' -or
      $release -match '(?ms)^function Get-ReleasePublicHealth\([^\r\n]+\) \{.{0,500}Invoke-ReleaseNative' -or
      $release -notmatch 'Invoke-ReleaseNative ''pwsh''[\s\S]+?\) \$Directory \$CleanupChildTimeoutSeconds\)' -or
      $release -match '\$reportClock|ReportDeadlineSeconds|ReleaseTerminalDeadlineSeconds') {
    return $false
  }
  if ($workflow -notmatch '(?ms)^concurrency:\s*\r?\n\s+group: markdoc-production\s*\r?\n\s+cancel-in-progress: false\s*$' -or
      [regex]::Matches($workflow, 'deploy/release-vm\.ps1').Count -ne 1) {
    return $false
  }
  foreach ($term in @('outer phase watchdog', 'native-command timeout', 'service timeout', 'polling bound',
      'CLI invocation cap', 'post-return elapsed assertion', 'workflow/job headroom',
      'release orchestration entry', 'HTTP request timeout', 'floored remaining time',
      'deadline overrun is rejected immediately afterward')) {
    if ($documentation -notmatch [regex]::Escape($term)) { return $false }
  }
  if ($readme -notmatch '\| Pre-submission \| Outer phase watchdog \| Release orchestration entry, 900 seconds \|' -or
      $hosting -notmatch '\| Pre-submission \| Outer phase watchdog \| Release orchestration entry, 900 seconds \|' -or
      $readme -notmatch '\| Public health \| HTTP request timeout plus post-return elapsed assertion \|' -or
      $hosting -notmatch '\| Public health \| HTTP request timeout and post-return elapsed assertion \|' -or
      $readme -notmatch '`Invoke-RestMethod -TimeoutSec` limits the HTTP request\.' -or
      $hosting -notmatch '`Invoke-RestMethod -TimeoutSec` limits the HTTP request\.' -or
      $hosting -notmatch 'A requested five-second poll delay starts only\s+when it fits the floored remaining time; any deadline overrun is rejected\s+immediately afterward\.' -or
      $hosting -notmatch 'A requested sleep starts only when it fits the floored remaining time; any deadline overrun is rejected immediately afterward\.') {
    return $false
  }
  foreach ($claimPattern in @(
      '(?i)\bscript start\b',
      '(?i)\bnative request timeout\b',
      '(?i)\b(?:bounded )?(?:sleeps?|delays?).{0,40}\b(?:refuse(?:d|s)?|cap(?:ped|s)?)\b.{0,40}\b(?:cross|crossing)\b')) {
    if ($documentation -match $claimPattern) { return $false }
  }
  foreach ($claim in @('at least 150 seconds', '365 seconds above', '4,710 seconds',
      'leaving 28 seconds',
      'enforced five-minute', 'five minutes remain for runner', 'independent worst-case phase deadlines',
      'worst-case timing plan', "No phase borrows another phase's reserve",
      'Failure reporting | 30 seconds', 'Local archive cleanup | 30 seconds',
      'guaranteed post-release-step reserve', 'cleanup phase is guaranteed to terminate in 30 seconds')) {
    if ($documentation -match [regex]::Escape($claim)) { return $false }
  }
  return $true
}

$boundarySources = @{ Release = $releaseSource; Workflow = $workflowSource; Readme = $readmeSource; Hosting = $hostingSource }
Assert-True (Test-ReleaseBoundaryInvariants $boundarySources) 'Release boundary implementation and documentation must describe only enforced behavior.'
$boundaryMutations = @(
  @{ Name = 'pre-submission-watchdog'; Change = { param($s) $s.Release = $s.Release.Replace('$PreSubmissionDeadlineSeconds = 900', '$PreSubmissionDeadlineSeconds = 899') } },
  @{ Name = 'build-submission-timeout'; Change = { param($s) $s.Release = $s.Release.Replace('$AcrBuildSubmissionTimeoutSeconds = 300', '$AcrBuildSubmissionTimeoutSeconds = 301') } },
  @{ Name = 'acr-service-timeout'; Change = { param($s) $s.Release = $s.Release.Replace('$AcrBuildTimeoutSeconds = 900', '$AcrBuildTimeoutSeconds = 901') } },
  @{ Name = 'build-watchdog'; Change = { param($s) $s.Release = $s.Release.Replace('$BuildPhaseDeadlineSeconds = 1350', '$BuildPhaseDeadlineSeconds = 1349') } },
  @{ Name = 'post-build-watchdog'; Change = { param($s) $s.Release = $s.Release.Replace('$PostBuildVerificationDeadlineSeconds = 180', '$PostBuildVerificationDeadlineSeconds = 179') } },
  @{ Name = 'vm-cli-cap'; Change = { param($s) $s.Release = $s.Release.Replace('$VmPhaseDeadlineSeconds = 2400', '$VmPhaseDeadlineSeconds = 2399') } },
  @{ Name = 'public-health-elapsed-check'; Change = { param($s) $s.Release = $s.Release.Replace('$PublicHealthDeadlineSeconds = 30', '$PublicHealthDeadlineSeconds = 29') } },
  @{ Name = 'cleanup-child-timeout'; Change = { param($s) $s.Release = $s.Release.Replace('$CleanupChildTimeoutSeconds = 30', '$CleanupChildTimeoutSeconds = 29') } },
  @{ Name = 'release-step-cap'; Change = { param($s) $s.Workflow = $s.Workflow.Replace('timeout-minutes: 79', 'timeout-minutes: 78') } },
  @{ Name = 'job-cap'; Change = { param($s) $s.Workflow = $s.Workflow.Replace('timeout-minutes: 99', 'timeout-minutes: 98') } },
  @{ Name = 'pre-submission-clock-anchor'; Change = { param($s) $s.Release = $s.Release.Replace('$releaseClock = [Diagnostics.Stopwatch]::StartNew()', '$releaseClock = $script:ProcessClock') } },
  @{ Name = 'sleep-fit-check-removed'; Change = { param($s) $s.Release = $s.Release.Replace('  if ($remaining -lt $Seconds) { Stop-VmRelease $Message 124 }', '') } },
  @{ Name = 'sleep-post-check-removed'; Change = { param($s) $s.Release = $s.Release.Replace('  Assert-ReleaseDeadline $Clock $BudgetSeconds $Message', '') } },
  @{ Name = 'public-health-native-child'; Change = { param($s) $s.Release = $s.Release.Replace('  Invoke-RestMethod -Uri "$Origin/api/health"', '  Invoke-ReleaseNative -Uri "$Origin/api/health"') } },
  @{ Name = 'build-clock-alias'; Change = { param($s) $s.Release = [regex]::Replace($s.Release, '(\[ref\]\$missedPolls\) )\$buildClock( \$BuildPhaseDeadlineSeconds)', '$1$releaseClock$2', 1) } },
  @{ Name = 'build-poll-sleep-removed'; Change = { param($s) $s.Release = [regex]::Replace($s.Release, '(?m)^\s*Start-ReleaseBoundedSleep \$buildClock \$BuildPhaseDeadlineSeconds 5 \$buildDeadlineMessage\s*$', '', 1) } },
  @{ Name = 'reconciliation-poll-bound'; Change = { param($s) $s.Release = $s.Release.Replace('$attempt -le 132', '$attempt -le 133') } },
  @{ Name = 'post-build-digest-clock-alias'; Change = { param($s) $s.Release = $s.Release.Replace('$postBuildClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage)', '$releaseClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage)') } },
  @{ Name = 'post-build-source-clock-alias'; Change = { param($s) $s.Release = $s.Release.Replace('Assert-ReleaseSource $Commit $postBuildClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage', 'Assert-ReleaseSource $Commit $releaseClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage') } },
  @{ Name = 'vm-clock-alias'; Change = { param($s) $s.Release = $s.Release.Replace('$vmLimit = Get-ReleaseRemainingSeconds $vmClock', '$vmLimit = Get-ReleaseRemainingSeconds $releaseClock') } },
  @{ Name = 'health-clock-alias'; Change = { param($s) $s.Release = $s.Release.Replace('Get-ReleaseRemainingSeconds $healthClock', 'Get-ReleaseRemainingSeconds $releaseClock') } },
  @{ Name = 'cleanup-child-uncapped'; Change = { param($s) $s.Release = $s.Release.Replace(') $Directory $CleanupChildTimeoutSeconds)', ') $Directory 31)') } },
  @{ Name = 'duplicate-acr-write'; Change = { param($s) $s.Release += "`n'acr', 'build'" } },
  @{ Name = 'duplicate-vm-write'; Change = { param($s) $s.Release += "`n'vm', 'run-command', 'invoke'" } },
  @{ Name = 'cancelling-workflow'; Change = { param($s) $s.Workflow = $s.Workflow.Replace('cancel-in-progress: false', 'cancel-in-progress: true') } },
  @{ Name = 'unused-build-reserve'; Change = { param($s) $s.Release += "`n`$BuildReconciliationReserveSeconds = 150" } },
  @{ Name = 'uncapped-report-claimed'; Change = { param($s) $s.Release += "`n`$ReportDeadlineSeconds = 30" } },
  @{ Name = 'nonindependent-terminal-cap'; Change = { param($s) $s.Release += "`n`$ReleaseTerminalDeadlineSeconds = 4710" } },
  @{ Name = 'build-reserve-language'; Change = { param($s) $s.Readme += "`nThe build guarantees at least 150 seconds for reconciliation." } },
  @{ Name = 'guest-margin-language'; Change = { param($s) $s.Hosting += "`nThe VM cap provides 365 seconds above guest work." } },
  @{ Name = 'post-build-reserve-language'; Change = { param($s) $s.Hosting += "`nThe post-build checks are leaving 28 seconds for validation." } },
  @{ Name = 'terminal-total-language'; Change = { param($s) $s.Readme += "`nThe phase maxima total 4,710 seconds." } },
  @{ Name = 'workflow-reserve-language'; Change = { param($s) $s.Workflow += "`n# guaranteed post-release-step reserve" } },
  @{ Name = 'report-cap-language'; Change = { param($s) $s.Readme += "`n| Failure reporting | 30 seconds |" } },
  @{ Name = 'cleanup-cap-language'; Change = { param($s) $s.Hosting += "`nThe cleanup phase is guaranteed to terminate in 30 seconds." } },
  @{ Name = 'readme-script-start-language'; Change = { param($s) $s.Readme = $s.Readme.Replace('Release orchestration entry, 900 seconds', 'Script start, 900 seconds') } },
  @{ Name = 'hosting-script-start-language'; Change = { param($s) $s.Hosting = $s.Hosting.Replace('Release orchestration entry, 900 seconds', 'Script start, 900 seconds') } },
  @{ Name = 'poll-sleep-crossing-language'; Change = { param($s) $s.Hosting = $s.Hosting.Replace('A requested five-second poll delay starts only', 'Every five-second poll delay is refused') } },
  @{ Name = 'bounded-sleep-crossing-language'; Change = { param($s) $s.Hosting = $s.Hosting.Replace('A requested sleep starts only', 'A bounded sleep is refused') } },
  @{ Name = 'digest-delay-crossing-language'; Change = { param($s) $s.Hosting += "`nThe delay is refused if it would cross the watchdog." } },
  @{ Name = 'readme-native-health-language'; Change = { param($s) $s.Readme = $s.Readme.Replace('HTTP request timeout plus', 'Native request timeout plus') } },
  @{ Name = 'hosting-native-health-language'; Change = { param($s) $s.Hosting = $s.Hosting.Replace('HTTP request timeout and', 'Native request timeout and') } }
)
foreach ($mutation in $boundaryMutations) {
  $mutated = $boundarySources.Clone()
  & $mutation.Change $mutated
  Assert-True (-not (Test-ReleaseBoundaryInvariants $mutated)) "Boundary mutation survived: $($mutation.Name)."
}
Assert-True ($releaseSource -notmatch 'Local command deadline exceeded; remote work was cancel') 'The revised deadline must not claim cancellation.'
$workflowTriggers = [regex]::Match($workflowSource, '(?ms)^on:\s*\r?\n(?<body>.*?)(?=^[a-zA-Z][a-zA-Z-]*:)')
Assert-True ($workflowTriggers.Success -and
  [regex]::Matches($workflowTriggers.Groups['body'].Value, '(?m)^  [a-zA-Z][a-zA-Z_-]*:').Count -eq 2 -and
  $workflowTriggers.Groups['body'].Value -match '(?m)^  workflow_dispatch:\s*$' -and
  $workflowTriggers.Groups['body'].Value -match '(?m)^  schedule:\s*$' -and
  [regex]::Matches($workflowTriggers.Groups['body'].Value, '(?m)^\s+- cron:').Count -eq 1 -and
  $workflowTriggers.Groups['body'].Value -match '(?m)^\s+- cron: "7 1 \* \* \*"\s*$') 'Production release must start only by hand or from the one daily schedule.'
$checkJob = [regex]::Match($workflowSource, '(?ms)^  check:\s*\r?\n(?<body>.*?)(?=^  deploy:)').Groups['body'].Value
$deployJob = [regex]::Match($workflowSource, '(?ms)^  deploy:\s*\r?\n(?<body>.*)\z').Groups['body'].Value
Assert-True ($checkJob -match "(?m)^    if: github\.event_name == 'schedule' && github\.ref == 'refs/heads/main'\s*$" -and
  $checkJob -match '(?m)^    permissions:\s*\r?\n      contents: read\s*\r?\n    outputs:' -and
  $checkJob -notmatch '(?i)id-token|environment:|azure|\$\{\{\s*(?:vars|secrets)\.|release-vm' -and
  $checkJob -match '(?m)^\s+run: \./deploy/release-decision\.ps1\s*$') 'The daily check must run only on the schedule with no Azure or production access.'
Assert-True ($deployJob -match '(?m)^    needs: check\s*$' -and
  $deployJob -match '!cancelled\(\)' -and $deployJob -notmatch '\balways\(\)' -and
  $deployJob -match "github\.event_name == 'workflow_dispatch'" -and
  $deployJob -match "github\.event_name == 'schedule' && needs\.check\.result == 'success' && needs\.check\.outputs\.release == 'true'" -and
  $deployJob -match "github\.ref == 'refs/heads/main'" -and
  $deployJob -match '(?m)^\s+INPUT_SHA: \$\{\{ inputs\.sha \|\| needs\.check\.outputs\.sha \}\}\s*$') 'The release must always start by hand, and on the schedule only with a passing check and for the commit it compared.'
Assert-True ($deployJob -match '(?m)^\s+environment: production\s*$' -and
  $deployJob -match 'uses: azure/login@v2' -and $deployJob -match 'deploy/release-vm\.ps1') 'Production access must stay in the release job.'
Assert-True ($workflowSource -match '(?m)^\s+environment: production\s*$' -and
  $workflowSource -match '(?ms)^concurrency:\s*\r?\n\s+group: markdoc-production\s*\r?\n\s+cancel-in-progress: false\s*$') 'The workflow must retain the production environment and non-cancelling concurrency.'
Assert-True ([regex]::Matches($workflowSource, 'uses: azure/login@v2').Count -eq 1 -and
  [regex]::Matches($workflowSource, '\$\{\{\s*vars\.').Count -eq 3 -and
  $workflowSource -notmatch '\$\{\{\s*secrets\.' -and
  $workflowSource -match '(?m)^  id-token: write\s*$' -and
  $workflowSource -match '(?m)^\s+client-id: \$\{\{ vars\.AZURE_CLIENT_ID \}\}\s*$' -and
  $workflowSource -match '(?m)^\s+tenant-id: \$\{\{ vars\.AZURE_TENANT_ID \}\}\s*$' -and
  $workflowSource -match '(?m)^\s+subscription-id: \$\{\{ vars\.AZURE_SUBSCRIPTION_ID \}\}\s*$') 'The workflow must retain one OIDC login with only the established Azure identity.'
Assert-True ($workflowSource -notmatch '(?i)\bretr(?:y|ies)\b') 'The workflow must not add an automatic retry around the single guarded release.'
Assert-True ($releaseSource -match '\$vmOrigin = ''https://markdoc-burkeholland\.eastus2\.cloudapp\.azure\.com''' -and
  $releaseSource -match '\$origin = ''https://markdoc\.app''' -and
  $releaseSource -match 'Assert-ReleaseHealth \$health \$Commit ''Public''') 'The configured release must retain exact public health verification.'
Assert-True ($deploySource.IndexOf('MARKDOC_RELEASE_WAL_GATE_OPERATION') -lt $deploySource.IndexOf('rollback_dir=') -and
  $deploySource.IndexOf('MARKDOC_RELEASE_WAL_GATE_OPERATION') -lt $deploySource.IndexOf('aad_token=')) 'Guest deployment must check the exact receipt before mutable work.'
Assert-True ($gateSource -match "pg_create_restore_point\(" -and
  $gateSource -match "pg_switch_wal\(\)" -and
  $gateSource -match 'archive_status/\$\{wal_object\}\.done' -and
  $gateSource -match 'repo-ls "\$archive_path"') 'Gate must await local acknowledgement and the exact remote repository object.'
Assert-True ($gateSource -match '--type=name' -and $gateSource -match '--target="\$restore_point"' -and
  $gateSource -match '--repo=1' -and $gateSource -match "archive_mode = off" -and
  $gateSource -match "listen_addresses = ''") 'Restore must target the endpoint in the proven repository with archive off and no listener.'
Assert-True ($gateSource -notmatch '--lock-timeout' -and
  $gateSource -match 'run_silent "\$restore_timeout" sudo -u postgres pgbackrest' -and
  $gateSource -match 'flock -n 9') 'Release and restore contention must remain bounded without unsupported pgBackRest options.'
Assert-True ($gateSource -notmatch '(?i)pg_basebackup|systemctl\s+(restart|stop)\s+postgres|archive_command|cp\s+.*pg_wal' -and
  $gateSource -notmatch '(?i)-c\s+[''"]checkpoint') 'Gate must not copy WAL or alter/restart the primary.'
Assert-True ($gateSource -notmatch 'markdoc-restore-check\.lock|markdoc-restore-check\.XXXXXX') 'Release cleanup must not claim the long-term restore-check instance.'

Write-Host "release VM evidence tests passed: $script:Passed assertions; $($boundaryMutations.Count) boundary mutations rejected"
