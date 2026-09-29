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
Assert-True ([regex]::Matches($workflowSource, 'deploy/release-vm\.ps1').Count -eq 1 -and
  $workflowSource -match '(?m)^\s*run: \./deploy/release-vm\.ps1 -ExpectedCommit \$env:GITHUB_SHA\s*$') 'The workflow must invoke the configured release entrypoint once for the checked-out exact GITHUB_SHA.'
Assert-True ($workflowSource -match '(?m)^\s+runs-on: windows-latest\s*$' -and
  $workflowSource -match '(?m)^\s+shell: pwsh\s*$') 'The Windows release entrypoint must run with the PowerShell already installed on the hosted Windows runner.'
Assert-True ($workflowSource -notmatch '\baz\s+acr\s+build\b' -and
  $workflowSource -notmatch '\baz\s+vm\s+run-command\b') 'The workflow must not duplicate either Azure write owned by the release entrypoint.'
Assert-True ($releaseSource -match '--scripts'', "@\$walScript", "@\$vmScript"') 'The configured release must send the WAL gate before deployment in one VM invocation.'
Assert-True ($releaseSource -match '\$ReleaseDeadlineSeconds = 2100' -and
  $releaseSource -notmatch 'Local command deadline exceeded; remote work was cancel') 'The revised deadline must stay explicit without claiming cancellation.'
$releaseDeadline = [regex]::Match($releaseSource, '(?m)^\$ReleaseDeadlineSeconds = (?<seconds>[0-9]+)\s*$')
$workflowTimeout = [regex]::Match($workflowSource, '(?m)^\s+timeout-minutes: (?<minutes>[0-9]+)\s*$')
Assert-True ($releaseDeadline.Success -and $workflowTimeout.Success) 'Release and runner deadlines must remain statically identifiable.'
$runnerMarginSeconds = ([int]$workflowTimeout.Groups['minutes'].Value * 60) - [int]$releaseDeadline.Groups['seconds'].Value
Assert-True ($runnerMarginSeconds -ge 60 -and $runnerMarginSeconds -le 600) 'The workflow timeout must exceed the configured release deadline by a small bounded runner margin.'
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
Assert-True ($gateSource -notmatch '(?i)pg_basebackup|checkpoint|systemctl\s+(restart|stop)\s+postgres|archive_command|cp\s+.*pg_wal') 'Gate must not copy WAL or alter/restart the primary.'
Assert-True ($gateSource -notmatch 'markdoc-restore-check\.lock|markdoc-restore-check\.XXXXXX') 'Release cleanup must not claim the long-term restore-check instance.'

Write-Host "release VM evidence tests passed: $script:Passed assertions"
