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

$releaseSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-vm.ps1') -Raw
$deploySource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'deploy-vm-image.sh')) -Raw
$gateSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'release-wal-gate.sh')) -Raw
$workflowSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', '.github', 'workflows', 'deploy.yml')) -Raw

Assert-True ([regex]::Matches($releaseSource, "'vm', 'run-command', 'invoke'").Count -eq 1) 'Terminal release must retain one VM invocation.'
Assert-True ([regex]::Matches($releaseSource, "'acr', 'build'").Count -eq 1) 'Terminal release must retain one ACR submission.'
Assert-True ($releaseSource -match '--scripts'', "@\$walScript", "@\$vmScript"' -and
  $workflowSource -match '--scripts @infra/release-wal-gate\.sh @infra/deploy-vm-image\.sh') 'Both callers must send the gate before deployment in one invocation.'
Assert-True ($workflowSource.Contains(':([0-9A-F]{24}):\1-[0-9a-f]{40}')) 'The workflow must bind the remote archive object to the captured WAL segment.'
Assert-True ($releaseSource -match '\$ReleaseDeadlineSeconds = 2100' -and
  $releaseSource -notmatch 'Local command deadline exceeded; remote work was cancel') 'The revised deadline must stay explicit without claiming cancellation.'
Assert-True ($deploySource.IndexOf('MARKDOC_RELEASE_WAL_GATE_OPERATION') -lt $deploySource.IndexOf('rollback_dir=') -and
  $deploySource.IndexOf('MARKDOC_RELEASE_WAL_GATE_OPERATION') -lt $deploySource.IndexOf('aad_token=')) 'Guest deployment must check the exact receipt before mutable work.'
Assert-True ($gateSource -match "pg_current_wal_flush_lsn\(\)" -and
  $gateSource -match "pg_switch_wal\(\)" -and
  $gateSource -match 'archive_status/\$\{wal_object\}\.done' -and
  $gateSource -match 'repo-ls "\$archive_path"') 'Gate must await local acknowledgement and the exact remote repository object.'
Assert-True ($gateSource -match '--type=lsn' -and $gateSource -match '--target="\$endpoint"' -and
  $gateSource -match '--repo=1' -and $gateSource -match "archive_mode = off" -and
  $gateSource -match "listen_addresses = ''") 'Restore must target the endpoint in the proven repository with archive off and no listener.'
Assert-True ($gateSource -match '--lock-timeout=0' -and $gateSource -match 'flock -n 9') 'Release and pgBackRest contention must fail without unbounded waiting.'
Assert-True ($gateSource -notmatch '(?i)pg_basebackup|checkpoint|systemctl\s+(restart|stop)\s+postgres|archive_command|cp\s+.*pg_wal') 'Gate must not copy WAL or alter/restart the primary.'
Assert-True ($gateSource -notmatch 'markdoc-restore-check\.lock|markdoc-restore-check\.XXXXXX') 'Release cleanup must not claim the long-term restore-check instance.'

Write-Host "release VM evidence tests passed: $script:Passed assertions"
