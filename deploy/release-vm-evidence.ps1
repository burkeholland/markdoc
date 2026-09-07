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
    "(?m)^markdoc-release-wal-failed:$escapedOperation`:(?<stage>lock|capture|switch|archive|restore|start|sql-ready|replay|cleanup):cleanup=(?<cleanup>true|false)$"
  )
  if ($matches.Count -ne 1) {
    return $null
  }
  return @{
    Stage = $matches[0].Groups['stage'].Value
    Cleanup = $matches[0].Groups['cleanup'].Value
  }
}
