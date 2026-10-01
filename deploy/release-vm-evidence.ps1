#requires -Version 7.2

function ConvertTo-ReleaseLsnParts([string]$Lsn) {
  if ($Lsn -cnotmatch '^(?<high>[0-9A-F]+)/(?<low>[0-9A-F]+)$') {
    Stop-VmRelease 'Release WAL evidence contains a malformed LSN.'
  }
  try {
    return @(
      [Convert]::ToUInt32($Matches.high, 16),
      [Convert]::ToUInt32($Matches.low, 16)
    )
  } catch [OverflowException] {
    Stop-VmRelease 'Release WAL evidence contains an out-of-range LSN.'
  }
}

function Assert-ReleaseWalEvidence(
  [string]$Output,
  [string]$Operation,
  [int]$TerminalEvidenceIndex
) {
  $escapedOperation = [regex]::Escape($Operation)
  $lsn = '[0-9A-F]+/[0-9A-F]+'
  $wal = '[0-9A-F]{24}'
  $archiveObject = '\k<wal>-[0-9a-f]{40}(?:\.(?:bz2|gz|lz4|zst))?'
  $pattern = "(?m)^markdoc-release-wal-operation:$escapedOperation\r?\n" +
    "markdoc-release-wal-capture:$escapedOperation`:(?<endpoint>$lsn):(?<wal>$wal)\r?\n" +
    "markdoc-release-wal-switch:$escapedOperation`:true\r?\n" +
    "markdoc-release-wal-archive:$escapedOperation`:\k<wal>:(?<archive>$archiveObject)\r?\n" +
    "markdoc-release-wal-restore:$escapedOperation`:true\r?\n" +
    "markdoc-release-wal-sql-ready:$escapedOperation`:true\r?\n" +
    "markdoc-release-wal-replay:$escapedOperation`:\k<endpoint>:(?<replay>$lsn)\r?\n" +
    "markdoc-release-wal-cleanup:$escapedOperation`:true\r?\n" +
    "markdoc-release-wal-ready:$escapedOperation`:\k<endpoint>:\k<wal>:\k<archive>:\k<replay>\r?$"
  $block = [regex]::Match($Output, $pattern)
  $allMarkers = [regex]::Matches($Output, '(?m)^markdoc-release-wal-[^\r\n]*$')
  if (-not $block.Success -or $allMarkers.Count -ne 9) {
    Stop-VmRelease 'VM result is missing exact ordered release WAL recovery evidence.'
  }
  if ($TerminalEvidenceIndex -lt 0 -or $block.Index -ge $TerminalEvidenceIndex) {
    Stop-VmRelease 'Release WAL recovery evidence did not precede application readiness.'
  }

  $endpoint = ConvertTo-ReleaseLsnParts $block.Groups['endpoint'].Value
  $replay = ConvertTo-ReleaseLsnParts $block.Groups['replay'].Value
  if ($replay[0] -lt $endpoint[0] -or
    ($replay[0] -eq $endpoint[0] -and $replay[1] -lt $endpoint[1])) {
    Stop-VmRelease 'Scratch recovery replay remained behind the captured release endpoint.'
  }

  return @{
    Endpoint = $block.Groups['endpoint'].Value
    WalSegment = $block.Groups['wal'].Value
    ArchiveObject = $block.Groups['archive'].Value
    ReplayLsn = $block.Groups['replay'].Value
  }
}

function Get-ReleaseWalFailure([string]$Output, [string]$Operation) {
  $escapedOperation = [regex]::Escape($Operation)
  $matches = [regex]::Matches(
    $Output,
    "(?m)^markdoc-release-wal-failed:$escapedOperation`:(?<stage>lock|capture|switch|archive|space|restore|start|sql-ready|replay|cleanup):cleanup=(?<cleanup>true|false)$"
  )
  if ($matches.Count -ne 1) {
    return $null
  }

  $budget = ''
  if ($matches[0].Groups['stage'].Value -ceq 'space') {
    $budget = 'Scratch disk budget could not be verified.'
  }
  $space = [regex]::Matches($Output,
    "(?m)^markdoc-release-wal-space:$escapedOperation`:available=(?<available>[0-9]{1,18}):required=(?<required>[0-9]{1,18}):reserve=(?<reserve>2147483648)$")
  if ($space.Count -eq 1) {
    $available = [long]$space[0].Groups['available'].Value
    $required = [long]$space[0].Groups['required'].Value
    $reserve = [long]$space[0].Groups['reserve'].Value
    if ($available -lt $required -and $required -ge $reserve) {
      $budget = "Available $available bytes; required $required bytes, including a $reserve-byte production reserve."
    }
  }
  $reasons = @{
    'disk-full' = 'No space left on device.'
    'no-memory' = 'Memory allocation failed.'
    'recovery-target-unreached' = 'Recovery ended before the configured target was reached.'
    'recovery-target-before-consistency' = 'The recovery target precedes the consistent recovery point.'
    'invalid-checkpoint' = 'No valid checkpoint record was found.'
    'wal-unavailable' = 'A required WAL file could not be restored.'
    'permission-denied' = 'Permission was denied.'
    'io-error' = 'An input/output error occurred.'
    'message-withheld' = 'Unrecognized server message withheld.'
    'diagnostics-unavailable' = 'Server diagnostics could not be read.'
  }
  $diagnostics = @(
    [regex]::Matches($Output,
      "(?m)^markdoc-release-wal-log:$escapedOperation`:(?<severity>WARNING|ERROR|FATAL|PANIC):(?<reason>[a-z-]{1,40})$") |
      Select-Object -Last 10 |
      ForEach-Object {
        $reason = $_.Groups['reason'].Value
        if ($reasons.ContainsKey($reason)) {
          "Scratch $($_.Groups['severity'].Value): $($reasons[$reason])"
        }
      }
  )
  return @{
    Stage = $matches[0].Groups['stage'].Value
    Cleanup = $matches[0].Groups['cleanup'].Value
    Budget = $budget
    Diagnostics = $diagnostics
  }
}

function Get-ReleaseImageSpaceFailure([string]$Output, [string]$Operation) {
  $escapedOperation = [regex]::Escape($Operation)
  $failures = [regex]::Matches($Output,
    "(?m)^markdoc-vm-image-space-failed:$escapedOperation`:(?<phase>pull|activate):(?<reason>reason=unavailable|available=(?<available>[0-9]{1,18}):required=(?<required>6442450944|2147483648):reserve=2147483648)$")
  if ($failures.Count -ne 1) { return $null }
  $failure = $failures[0]
  $phase = $failure.Groups['phase'].Value
  $reason = "Image disk budget could not be verified before $phase; application unchanged."
  if ($failure.Groups['available'].Success) {
    $available = [long]$failure.Groups['available'].Value
    $required = [long]$failure.Groups['required'].Value
    if ($available -ge $required -or
      ($phase -ceq 'pull' -and $required -ne 6442450944) -or
      ($phase -ceq 'activate' -and $required -ne 2147483648)) { return $null }
    $reason = "Insufficient disk space before image $phase; application unchanged. Available $available bytes; required $required bytes, including a 2147483648-byte production reserve."
  }
  return $reason
}
