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

Assert-True ([regex]::Matches($releaseSource, "'vm', 'run-command', 'invoke'").Count -eq 1) 'Terminal release must retain one VM invocation.'
Assert-True ([regex]::Matches($releaseSource, "'acr', 'build'").Count -eq 1) 'Terminal release must retain one ACR submission.'
Assert-True ([regex]::Matches($workflowSource, 'deploy/release-vm\.ps1').Count -eq 1 -and
  $workflowSource -match '(?m)^\s*run: \./deploy/release-vm\.ps1 -ExpectedCommit \$env:GITHUB_SHA\s*$') 'The workflow must invoke the configured release entrypoint once for the checked-out exact GITHUB_SHA.'
Assert-True ($workflowSource -match '(?m)^\s+runs-on: windows-latest\s*$' -and
  $workflowSource -match '(?m)^\s+shell: pwsh\s*$') 'The Windows release entrypoint must run with the PowerShell already installed on the hosted Windows runner.'
Assert-True ($workflowSource -notmatch '\baz\s+acr\s+build\b' -and
  $workflowSource -notmatch '\baz\s+vm\s+run-command\b') 'The workflow must not duplicate either Azure write owned by the release entrypoint.'
Assert-True ($releaseSource -match '--scripts'', "@\$walScript", "@\$vmScript"') 'The configured release must send the WAL gate before deployment in one VM invocation.'
function Get-ReleaseConstant([string]$Name) {
  $match = [regex]::Match($releaseSource, "(?m)^\`$$Name = (?<seconds>[0-9]+)\s*$")
  Assert-True $match.Success "Release deadline constant $Name must remain statically identifiable."
  return [int]$match.Groups['seconds'].Value
}
function Test-ReleaseDeadlinePlan([hashtable]$Plan) {
  $nativePreSubmissionMaximum = 780
  $digestMaximum = 62
  $finalSourceMaximum = 90
  $guestPhaseMaximum = 2035
  return $Plan.PreSubmission -ge $nativePreSubmissionMaximum -and
    $Plan.BuildSubmission -eq 90 -and
    $Plan.AcrService -eq 900 -and
    $Plan.BuildReserve -ge 150 -and
    $Plan.BuildPhase -ge ($Plan.BuildSubmission + $Plan.AcrService + $Plan.BuildReserve) -and
    $Plan.PostBuild -ge ($digestMaximum + $finalSourceMaximum) -and
    $Plan.Vm -ge $guestPhaseMaximum -and
    $Plan.Health -ge 20 -and
    $Plan.Report -ge 1 -and
    $Plan.Cleanup -ge 1 -and
    $Plan.Terminal -eq ($Plan.PreSubmission + $Plan.BuildPhase + $Plan.PostBuild + $Plan.Vm + $Plan.Health + $Plan.Report + $Plan.Cleanup) -and
    ($Plan.ReleaseStepMinutes * 60) -ge $Plan.Terminal -and
    (($Plan.JobMinutes * 60) - (($Plan.SetupMinutes | Measure-Object -Sum).Sum * 60) - ($Plan.ReleaseStepMinutes * 60)) -ge 300
}
$timeouts = @([regex]::Matches($workflowSource, '(?m)^\s+timeout-minutes: (?<minutes>[0-9]+)\s*$') |
  ForEach-Object { [int]$_.Groups['minutes'].Value })
Assert-True ($timeouts.Count -eq 5) 'The workflow must retain one job, three setup-step and one release-step timeout.'
$deadlinePlan = @{
  PreSubmission = Get-ReleaseConstant 'PreSubmissionDeadlineSeconds'
  BuildSubmission = Get-ReleaseConstant 'AcrBuildSubmissionTimeoutSeconds'
  AcrService = Get-ReleaseConstant 'AcrBuildTimeoutSeconds'
  BuildReserve = Get-ReleaseConstant 'BuildReconciliationReserveSeconds'
  BuildPhase = Get-ReleaseConstant 'BuildPhaseDeadlineSeconds'
  PostBuild = Get-ReleaseConstant 'PostBuildVerificationDeadlineSeconds'
  Vm = Get-ReleaseConstant 'VmPhaseDeadlineSeconds'
  Health = Get-ReleaseConstant 'PublicHealthDeadlineSeconds'
  Report = Get-ReleaseConstant 'ReportDeadlineSeconds'
  Cleanup = Get-ReleaseConstant 'CleanupDeadlineSeconds'
  Terminal = Get-ReleaseConstant 'ReleaseTerminalDeadlineSeconds'
  JobMinutes = $timeouts[0]
  SetupMinutes = @($timeouts[1], $timeouts[2], $timeouts[3])
  ReleaseStepMinutes = $timeouts[4]
}
Assert-True (Test-ReleaseDeadlinePlan $deadlinePlan) 'Release phase and workflow deadlines must satisfy every worst-case inequality.'
Assert-True ($deadlinePlan.PreSubmission -eq 900 -and $deadlinePlan.BuildPhase -eq 1140 -and
  $deadlinePlan.PostBuild -eq 180 -and $deadlinePlan.Vm -eq 2400 -and
  $deadlinePlan.Health -eq 30 -and $deadlinePlan.Report -eq 30 -and $deadlinePlan.Cleanup -eq 30 -and
  $deadlinePlan.Terminal -eq 4710 -and $deadlinePlan.ReleaseStepMinutes -eq 79 -and
  $deadlinePlan.JobMinutes -eq 99 -and ($deadlinePlan.SetupMinutes -join ',') -ceq '5,5,5') 'The reviewed release deadline table changed unexpectedly.'
$deadlineMutations = @(
  @{ Name = 'pre-submission-native'; Change = { param($p) $p.PreSubmission = 779 } },
  @{ Name = 'build-submission'; Change = { param($p) $p.BuildSubmission = 91 } },
  @{ Name = 'acr-service'; Change = { param($p) $p.AcrService = 901 } },
  @{ Name = 'reconciliation-reserve'; Change = { param($p) $p.BuildReserve = 149 } },
  @{ Name = 'build-phase'; Change = { param($p) $p.BuildPhase = 1139 } },
  @{ Name = 'digest-and-source'; Change = { param($p) $p.PostBuild = 151 } },
  @{ Name = 'vm-and-result'; Change = { param($p) $p.Vm = 2034 } },
  @{ Name = 'public-health'; Change = { param($p) $p.Health = 19 } },
  @{ Name = 'report'; Change = { param($p) $p.Report = 0 } },
  @{ Name = 'cleanup'; Change = { param($p) $p.Cleanup = 0 } },
  @{ Name = 'release-step'; Change = { param($p) $p.ReleaseStepMinutes = 78 } },
  @{ Name = 'runner-margin'; Change = { param($p) $p.JobMinutes = 98 } }
)
foreach ($mutation in $deadlineMutations) {
  $mutated = $deadlinePlan.Clone()
  if ($mutated.SetupMinutes -is [array]) { $mutated.SetupMinutes = @($mutated.SetupMinutes) }
  & $mutation.Change $mutated
  Assert-True (-not (Test-ReleaseDeadlinePlan $mutated)) "Deadline mutation survived: $($mutation.Name)."
}
Assert-True ([regex]::Matches($releaseSource, 'Invoke-ReleaseAcrPoll[\s\S]{0,500}\$buildClock \$BuildPhaseDeadlineSeconds \$buildDeadlineMessage').Count -eq 2) 'Both tag reconciliation and normal completion must use the same build-phase clock and deadline.'
Assert-True ($releaseSource -match 'Start-ReleaseBoundedSleep \$buildClock \$BuildPhaseDeadlineSeconds 5 \$buildDeadlineMessage') 'Build poll sleeps must not overshoot the build phase.'
Assert-True ($releaseSource -match 'Invoke-ReleaseDigestLookup[\s\S]+?\$postBuildClock \$PostBuildVerificationDeadlineSeconds \$postBuildDeadlineMessage' -and
  $releaseSource -match 'Assert-ReleaseSource \$Commit \$postBuildClock \$PostBuildVerificationDeadlineSeconds \$postBuildDeadlineMessage') 'Digest verification and final source recheck must share the post-build proof deadline.'
Assert-True ($releaseSource -match '\$vmLimit = Get-ReleaseRemainingSeconds \$vmClock \$VmPhaseDeadlineSeconds \$vmDeadlineMessage' -and
  $releaseSource -match 'Assert-ReleaseDeadline \$vmClock \$VmPhaseDeadlineSeconds \$vmDeadlineMessage') 'VM transport and result verification must share one enforced phase.'
Assert-True ($releaseSource -match 'Get-ReleaseRemainingSeconds \$healthClock \$PublicHealthDeadlineSeconds \$healthDeadlineMessage' -and
  $releaseSource -match 'Assert-ReleaseDeadline \$healthClock \$PublicHealthDeadlineSeconds \$healthDeadlineMessage') 'Public health must retain its independent enforced deadline.'
Assert-True ($releaseSource -match '\$reportClock = \[Diagnostics\.Stopwatch\]::StartNew\(\)' -and
  $releaseSource -match '\$reportClock\.Elapsed\.TotalSeconds -ge \$ReportDeadlineSeconds' -and
  $releaseSource -match 'Invoke-ReleaseNative ''pwsh''[\s\S]+?\$CleanupDeadlineSeconds') 'Reporting and cleanup must have explicit termination bounds.'
Assert-True ($releaseSource -notmatch 'Local command deadline exceeded; remote work was cancel') 'The revised deadline must not claim cancellation.'
$workflowTriggers = [regex]::Match($workflowSource, '(?ms)^on:\s*\r?\n(?<body>.*?)(?=^[a-zA-Z][a-zA-Z-]*:)')
Assert-True ($workflowTriggers.Success -and
  [regex]::Matches($workflowTriggers.Groups['body'].Value, '(?m)^  [a-zA-Z][a-zA-Z_-]*:').Count -eq 1 -and
  $workflowTriggers.Groups['body'].Value -match '(?m)^  workflow_dispatch:\s*$') 'Production release must remain manual-only.'
Assert-True ($workflowSource -match '(?m)^\s+environment: production\s*$' -and
  $workflowSource -match '(?ms)^concurrency:\s*\r?\n\s+group: markdoc-production\s*\r?\n\s+cancel-in-progress: false\s*$') 'The workflow must retain the production environment and non-cancelling concurrency.'
Assert-True ([regex]::Matches($workflowSource, 'uses: azure/login@v2').Count -eq 1 -and
  [regex]::Matches($workflowSource, '\$\{\{\s*secrets\.').Count -eq 3 -and
  $workflowSource -notmatch '\$\{\{\s*vars\.' -and
  $workflowSource -match '(?m)^  id-token: write\s*$' -and
  $workflowSource -match '(?m)^\s+client-id: \$\{\{ secrets\.AZURE_CLIENT_ID \}\}\s*$' -and
  $workflowSource -match '(?m)^\s+tenant-id: \$\{\{ secrets\.AZURE_TENANT_ID \}\}\s*$' -and
  $workflowSource -match '(?m)^\s+subscription-id: \$\{\{ secrets\.AZURE_SUBSCRIPTION_ID \}\}\s*$') 'The workflow must retain one OIDC login with only the established Azure identity.'
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

Write-Host "release VM evidence tests passed: $script:Passed assertions; $($deadlineMutations.Count) deadline mutations rejected"
