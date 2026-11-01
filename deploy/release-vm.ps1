#requires -Version 7.2
<#
.SYNOPSIS
  Builds the selected clean main commit in ACR and waits for exact VM/public health.
.NOTES
  Mutating release, not infrastructure setup. Requires an already authenticated Azure CLI.
  No write is resubmitted on failure. Stopping this command does not cancel cloud work.
#>
param(
  [string]$ExpectedCommit = $env:RELEASE_SHA,
  # Enterprise is the release target; Professional is the pre-cutover stack, kept for rollback.
  [ValidateSet('Enterprise', 'Professional')][string]$Target = 'Enterprise',
  # Origin for the final public health check. Defaults to the target's own public origin.
  [string]$PublicOrigin = ''
)

$ErrorActionPreference = 'Stop'
# Cooperative outer phase watchdogs. Native calls and sleeps consume their
# remaining time, but synchronous PowerShell/.NET work is checked, not killed.
$PreSubmissionDeadlineSeconds = 900
$BuildPhaseDeadlineSeconds = 1350
$PostBuildVerificationDeadlineSeconds = 180
$VmPhaseDeadlineSeconds = 2400
$PublicHealthDeadlineSeconds = 30
# Native/service boundaries within those watchdogs.
$AcrBuildSubmissionTimeoutSeconds = 300
$AcrBuildTimeoutSeconds = 900
$CleanupChildTimeoutSeconds = 30

. (Join-Path $PSScriptRoot 'release-vm-evidence.ps1')

function Stop-VmRelease([string]$Message, [int]$ExitCode = 1) {
  $failure = [InvalidOperationException]::new($Message)
  $failure.Data['ReleaseExitCode'] = $ExitCode
  throw $failure
}

function Get-ReleaseRemainingSeconds($Clock, [int]$BudgetSeconds, [string]$Message) {
  $remaining = [math]::Floor($BudgetSeconds - $Clock.Elapsed.TotalSeconds)
  if ($remaining -lt 1) { Stop-VmRelease $Message 124 }
  return $remaining
}

function Assert-ReleaseDeadline($Clock, [int]$BudgetSeconds, [string]$Message) {
  [void](Get-ReleaseRemainingSeconds $Clock $BudgetSeconds $Message)
}

function Start-ReleaseBoundedSleep($Clock, [int]$BudgetSeconds, [int]$Seconds, [string]$Message) {
  $remaining = Get-ReleaseRemainingSeconds $Clock $BudgetSeconds $Message
  if ($remaining -lt $Seconds) { Stop-VmRelease $Message 124 }
  Start-Sleep -Seconds $Seconds
  Assert-ReleaseDeadline $Clock $BudgetSeconds $Message
}

function Get-ReleaseDigestLookupFailure([string]$ErrorText) {
  $statusMatches = [regex]::Matches($ErrorText,
    '(?i)\b(?:response\s+(?:status|code)|status(?:\s+code)?|http(?:/\d(?:\.\d)?)?(?:\s+(?:status(?:\s+code)?|error))?)\s*[:=]?\s*[''"]?(?<status>[1-5][0-9]{2})\b|\b(?<status>[1-5][0-9]{2})\s+(?:Server|Client)\s+Error\b|\((?<status>[1-5][0-9]{2})\)')
  $statuses = @($statusMatches | ForEach-Object { $_.Groups['status'].Value } | Select-Object -Unique)
  $status = 'none'
  if ($statuses.Count -eq 1) { $status = $statuses[0] }
  $category = 'unknown'
  # Permanent errors take precedence over transient wording in an error body.
  if ($statuses -contains '401' -or $statuses -contains '403' -or
      $ErrorText -match '(?i)\b(?:unauthorized|forbidden|AuthenticationFailed|AuthorizationFailed|InvalidAuthenticationToken|AADSTS[0-9]+|authentication required|unable to authenticate|CONNECTIVITY_FORBIDDEN_ERROR)\b|\baz login\b') {
    $category = 'auth'
  } elseif ($statuses -contains '400' -or
      $ErrorText -match '(?i)\b(?:unrecognized arguments|InvalidArgument|InvalidSubscription|SubscriptionNotFound|BadRequest|SSLError|CertificateError|InvalidURL)\b|certificate verify failed') {
    $category = 'configuration'
  } elseif ($statuses -contains '404' -or $ErrorText -match '(?i)\b(?:ManifestUnknown|RepositoryNotFound|ResourceNotFound|the requested data does not exist)\b') {
    $category = 'not_found'
  } elseif ($statuses.Count -gt 1) {
    $category = 'unknown'
  } elseif ($status -ceq '429') {
    $category = 'throttled'
  } elseif ($status -cmatch '^5[0-9]{2}$') {
    $category = 'server_error'
  } elseif ($status -ceq '408') {
    $category = 'timeout'
  } elseif ($status -cne 'none') {
    $category = 'unknown'
  } elseif ($ErrorText -match '(?i)\b(?:too\s*many\s*requests|CONNECTIVITY_TOOMANYREQUESTS_ERROR)\b') {
    $category = 'throttled'
  } elseif ($ErrorText -match '(?i)\b(?:service\s*unavailable|internal\s*server\s*error|bad\s*gateway|gateway\s*timeout)\b') {
    $category = 'server_error'
  } elseif ($ErrorText -match '(?i)\b(?:TimeoutError|ConnectTimeout|ReadTimeout|timed out)\b') {
    $category = 'timeout'
  } elseif ($ErrorText -match '(?i)\b(?:ConnectionError|ConnectionResetError|ConnectionAbortedError|NameResolutionError|RemoteDisconnected)\b|connection (?:reset|aborted|refused)|failed to (?:establish a new connection|resolve)') {
    $category = 'transport'
  }
  return @{ Category = $category; HttpStatus = $status }
}

function Get-ReleaseSafeAzFailure([Exception]$Failure) {
  $category = 'unknown'
  $status = 'none'
  if ($Failure.Data['ReleaseDigestFailureCategory'] -cin @('transport', 'timeout', 'throttled', 'server_error', 'auth', 'configuration', 'not_found', 'unknown')) {
    $category = $Failure.Data['ReleaseDigestFailureCategory']
  }
  if ($Failure.Data['ReleaseDigestFailureHttpStatus'] -cmatch '^[1-5][0-9]{2}$') {
    $status = $Failure.Data['ReleaseDigestFailureHttpStatus']
  }
  return @{ Category = $category; HttpStatus = $status }
}

function Test-ReleaseAcrFailureStatus([object]$Status) {
  return ($Status -is [string] -and $Status -cin @('Failed', 'Error', 'Timeout', 'Canceled'))
}

function Test-ReleaseAcrRunCreatedAfter([object]$Run, [DateTimeOffset]$SubmittedAt) {
  if ($Run -isnot [System.Collections.IDictionary] -or $Run['runType'] -cne 'QuickRun') {
    return $false
  }
  $rawCreateTime = $Run['createTime']
  $createdAt = [DateTimeOffset]::MinValue
  if ($rawCreateTime -is [DateTimeOffset]) {
    $createdAt = $rawCreateTime
  } elseif ($rawCreateTime -is [DateTime]) {
    if ($rawCreateTime.Kind -eq [DateTimeKind]::Unspecified) {
      $rawCreateTime = [DateTime]::SpecifyKind($rawCreateTime, [DateTimeKind]::Utc)
    }
    $createdAt = [DateTimeOffset]$rawCreateTime
  } elseif ($rawCreateTime -isnot [string] -or -not [DateTimeOffset]::TryParse(
      $rawCreateTime,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal,
      [ref]$createdAt
    )) {
    return $false
  }
  return $createdAt -gt $SubmittedAt
}

function Get-ReleaseSafeAcrErrorMessage([object]$Message) {
  if ($Message -isnot [string] -or [string]::IsNullOrWhiteSpace($Message)) {
    return 'No error message was returned by ACR.'
  }
  $safe = $Message -replace '[\r\n\t]+', ' '
  $safe = $safe -replace '(?i)\b(?:https?://)\S+', '[URL]'
  $secretAssignment = '(?i)["'']?(?<key>[A-Za-z0-9_.-]*(?:password|passwd|passphrase|access[_-]?token|refresh[_-]?token|token|secret|credential|authorization|api[_-]?key|account[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|client[_-]?secret|signature|sig)[A-Za-z0-9_.-]*)["'']?\s*[:=]\s*(?:(?:bearer|basic)\s+)?("[^"]*"|''[^'']*''|[^\s,;}\]]+)'
  $safe = $safe -replace $secretAssignment, '${key}=[redacted]'
  $safe = $safe -replace '(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*', '[redacted authentication]'
  $safe = $safe -replace '(?i)\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b', '[redacted token]'
  $safe = $safe.Trim()
  if ([string]::IsNullOrWhiteSpace($safe)) { return 'No safe error message was returned by ACR.' }
  if ($safe.Length -gt 300) { return $safe.Substring(0, 300) + '...' }
  return $safe
}

function Stop-ReleaseAcrBuildUnsuccessful(
  [string]$RunId,
  [object]$Status,
  [object]$ErrorMessage,
  [string]$RegistryName,
  [string]$ResourceGroup,
  [string]$Subscription
) {
  if ($RunId -cnotmatch '^[a-zA-Z0-9]{1,80}$') { Stop-VmRelease 'The failed ACR build run has an invalid identity.' }
  $safeStatus = 'unknown'
  if ($Status -is [string] -and $Status -cmatch '^[A-Za-z][A-Za-z0-9_-]{0,39}$') { $safeStatus = $Status }
  $summary = 'ACR build returned an unknown status'
  if (Test-ReleaseAcrFailureStatus $Status) { $summary = 'ACR image build failed' }
  $safeError = Get-ReleaseSafeAcrErrorMessage $ErrorMessage
  Write-Host "Release: ACR error: $safeError"
  Write-Host "Release: retrieve the run log (read-only): az acr task logs --registry $RegistryName --run-id $RunId --resource-group $ResourceGroup --subscription $Subscription"
  Stop-VmRelease "$summary; run ID $RunId; status $safeStatus; no VM command was sent."
}

function Invoke-ReleaseNative([string]$Command, [string[]]$Arguments, [string]$Directory, [int]$TimeoutSeconds, [switch]$KeepFailureOutput, [switch]$ClassifyDigestFailure) {
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
    $errorText = $stderr.GetAwaiter().GetResult()
    $output = $stdout.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      $failure = [InvalidOperationException]::new("Native command failed (exit $($process.ExitCode)); raw output withheld.")
      $failure.Data['ReleaseExitCode'] = $process.ExitCode
      if ($ClassifyDigestFailure) {
        $diagnostic = Get-ReleaseDigestLookupFailure $errorText
        $failure.Data['ReleaseDigestFailureCategory'] = $diagnostic.Category
        $failure.Data['ReleaseDigestFailureHttpStatus'] = $diagnostic.HttpStatus
      }
      # Kept only for a caller that validates its own structured fields; it is never printed. Stderr is never kept.
      if ($KeepFailureOutput) { $failure.Data['ReleaseFailureOutput'] = $output.Trim() }
      throw $failure
    }
    return $output.Trim()
  } catch [InvalidOperationException] {
    if ($ClassifyDigestFailure -and $_.Exception.Data['ReleaseExitCode'] -eq 124 -and
        -not $_.Exception.Data.Contains('ReleaseDigestFailureCategory')) {
      $_.Exception.Data['ReleaseDigestFailureCategory'] = 'timeout'
      $_.Exception.Data['ReleaseDigestFailureHttpStatus'] = 'none'
    }
    if ($ClassifyDigestFailure -and $_.Exception.Data.Contains('ReleaseDigestFailureCategory')) {
      $_.Exception.Data['ReleaseNativeCallFailure'] = $true
    }
    throw
  } finally {
    $process.Dispose()
  }
}

function Invoke-ReleaseStep(
  [string]$Command,
  [string[]]$Arguments,
  [int]$Limit = 30,
  [switch]$KeepFailureOutput,
  [switch]$ClassifyDigestFailure,
  $DeadlineClock = $releaseClock,
  [int]$DeadlineSeconds = $PreSubmissionDeadlineSeconds,
  [string]$DeadlineMessage = 'Pre-submission deadline exceeded; no build was submitted.'
) {
  $remaining = Get-ReleaseRemainingSeconds $DeadlineClock $DeadlineSeconds $DeadlineMessage
  Invoke-ReleaseNative $Command $Arguments $sourceRoot ([math]::Min($Limit, $remaining)) -KeepFailureOutput:$KeepFailureOutput -ClassifyDigestFailure:$ClassifyDigestFailure
}

function Invoke-ReleaseStepBytes(
  [string]$Command,
  [string[]]$Arguments,
  [int]$Limit = 30,
  $DeadlineClock = $releaseClock,
  [int]$DeadlineSeconds = $PreSubmissionDeadlineSeconds,
  [string]$DeadlineMessage = 'Pre-submission deadline exceeded; no build was submitted.'
) {
  $remaining = Get-ReleaseRemainingSeconds $DeadlineClock $DeadlineSeconds $DeadlineMessage
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

function Invoke-ReleaseAz(
  [string[]]$Arguments,
  [int]$Limit = 30,
  $DeadlineClock = $releaseClock,
  [int]$DeadlineSeconds = $PreSubmissionDeadlineSeconds,
  [string]$DeadlineMessage = 'Pre-submission deadline exceeded; no build was submitted.'
) {
  Invoke-ReleaseStep 'az' ($Arguments + @('--only-show-errors', '--output', 'json')) $Limit `
    -DeadlineClock $DeadlineClock -DeadlineSeconds $DeadlineSeconds -DeadlineMessage $DeadlineMessage
}

function Invoke-ReleaseAcrPoll(
  [string[]]$Arguments,
  [ref]$MissedPolls,
  $DeadlineClock,
  [int]$DeadlineSeconds,
  [string]$DeadlineMessage,
  [int]$Limit = 30
) {
  $budgetRemaining = Get-ReleaseRemainingSeconds $DeadlineClock $DeadlineSeconds $DeadlineMessage
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $failure = $null
  $output = $null
  try {
    $output = Invoke-ReleaseStep 'az' ($Arguments + @('--only-show-errors', '--output', 'json')) ([math]::Min($Limit, $budgetRemaining)) `
      -ClassifyDigestFailure -DeadlineClock $DeadlineClock -DeadlineSeconds $DeadlineSeconds -DeadlineMessage $DeadlineMessage
  } catch [InvalidOperationException] {
    if ($_.Exception.Data['ReleaseNativeCallFailure'] -ne $true) { throw }
    $diagnostic = Get-ReleaseSafeAzFailure $_.Exception
    if ($diagnostic.Category -cnotin @('transport', 'timeout', 'throttled', 'server_error')) { throw }
    $failure = $_
  }
  # Check the phase deadline outside the per-call catch, even when the last poll succeeded.
  Assert-ReleaseDeadline $DeadlineClock $DeadlineSeconds $DeadlineMessage
  if ($failure) {
    $MissedPolls.Value++
    $elapsed = [math]::Floor($clock.Elapsed.TotalSeconds)
    Write-Host "Release: ACR read-only poll missed; category=$($diagnostic.Category); HTTP status=$($diagnostic.HttpStatus); elapsed seconds=$elapsed; consecutive missed polls=$($MissedPolls.Value)/3."
    if ($MissedPolls.Value -ge 3) { throw $failure }
    return $null
  }
  $MissedPolls.Value = 0
  return $output
}

function Invoke-ReleaseDigestLookup([string[]]$Arguments, $DeadlineClock, [int]$DeadlineSeconds, [string]$DeadlineMessage) {
  for ($attempt = 0; $attempt -le 1; $attempt++) {
    try {
      return Invoke-ReleaseStep 'az' ($Arguments + @('--only-show-errors', '--output', 'json')) -ClassifyDigestFailure `
        -DeadlineClock $DeadlineClock -DeadlineSeconds $DeadlineSeconds -DeadlineMessage $DeadlineMessage
    } catch {
      $diagnostic = Get-ReleaseSafeAzFailure $_.Exception
      $category = $diagnostic.Category
      $status = $diagnostic.HttpStatus
      Write-Host "Release: ACR digest lookup failed; category=$category; HTTP status=$status."
      if ($attempt -eq 1 -or $category -cnotin @('transport', 'timeout', 'throttled', 'server_error')) { throw }
      $remaining = Get-ReleaseRemainingSeconds $DeadlineClock $DeadlineSeconds $DeadlineMessage
      if ($remaining -lt 3) {
        Stop-VmRelease 'No time remains for the ACR digest lookup retry; no VM command was sent.' 124
      }
      Write-Host 'Release: ACR digest lookup retry 1/1 in 2 seconds; read-only lookup only.'
      Start-ReleaseBoundedSleep $DeadlineClock $DeadlineSeconds 2 $DeadlineMessage
    }
  }
}

function ConvertFrom-ReleaseJson([string]$Text) {
  try {
    return ConvertFrom-Json -InputObject $Text -AsHashtable -NoEnumerate -ErrorAction Stop
  } catch [ArgumentException] {
    Stop-VmRelease 'Malformed JSON response; raw output withheld.'
  }
}

function Assert-ReleaseSource(
  [string]$Commit,
  $DeadlineClock = $releaseClock,
  [int]$DeadlineSeconds = $PreSubmissionDeadlineSeconds,
  [string]$DeadlineMessage = 'Pre-submission deadline exceeded; no build was submitted.'
) {
  $branch = Invoke-ReleaseStep 'git' @('rev-parse', '--abbrev-ref', 'HEAD') `
    -DeadlineClock $DeadlineClock -DeadlineSeconds $DeadlineSeconds -DeadlineMessage $DeadlineMessage
  if ($branch -cne 'main') { Stop-VmRelease 'Wrong branch: a release requires the clean main checkout (not a feature branch or detached HEAD).' }
  $head = Invoke-ReleaseStep 'git' @('rev-parse', '--verify', 'HEAD') `
    -DeadlineClock $DeadlineClock -DeadlineSeconds $DeadlineSeconds -DeadlineMessage $DeadlineMessage
  if ($head -cne $Commit) { Stop-VmRelease 'Wrong HEAD: checked-out source does not match the expected full commit.' }
  $dirty = Invoke-ReleaseStep 'git' @('status', '--porcelain=v1', '--untracked-files=all') `
    -DeadlineClock $DeadlineClock -DeadlineSeconds $DeadlineSeconds -DeadlineMessage $DeadlineMessage
  if ($dirty) { Stop-VmRelease 'Dirty checkout: commit or remove source changes before releasing.' }
}

function Remove-ReleaseContext([string]$Context, [string]$Directory) {
  if (-not $Context -or -not (Test-Path -LiteralPath $Context)) { return }
  $escaped = $Context.Replace("'", "''")
  [void](Invoke-ReleaseNative 'pwsh' @(
    '-NoProfile', '-NonInteractive', '-Command',
    "Remove-Item -LiteralPath '$escaped' -Recurse -Force -ErrorAction Stop"
  ) $Directory $CleanupChildTimeoutSeconds)
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

# Validates the only report other than the plain pass that a release continues on: status "accepted", which the policy
# prints when every finding is covered by ACCEPTED_ADVISORIES in scripts/lib/dependency-policy.ts. The policy script is
# not trusted here: every key, count, pattern and date is checked again, and only values that passed a fixed pattern
# are returned for printing. The clock is a parameter so the offline tests can set it; the release never passes it.
function Get-ReleaseAcceptedDependencyAdvisories($Report, [datetime]$UtcToday = [DateTime]::UtcNow.Date) {
  # The same message as a bad pass report, so a bad accepted report tells a reader of the log nothing more.
  $invalid = 'Dependency preflight did not return the required pass report.'
  $countFields = @('blocked', 'info', 'low', 'moderate', 'high', 'critical', 'vulnerabilities', 'reported', 'omitted')
  $versionPattern = '\A[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}\z'
  if (-not (Test-ReleaseExactKeys $Report @('status', 'counts', 'packages', 'exceptions')) -or
      $Report['status'] -isnot [string] -or $Report['status'] -cnotmatch '\Aaccepted\z' -or
      -not (Test-ReleaseExactKeys $Report['counts'] $countFields) -or
      $Report['packages'] -isnot [array] -or $Report['exceptions'] -isnot [array]) {
    Stop-VmRelease $invalid
  }
  $counts = $Report['counts']
  $packages = $Report['packages']
  $exceptions = $Report['exceptions']
  foreach ($field in $countFields) {
    $count = $counts[$field]
    if (($count -isnot [int] -and $count -isnot [long]) -or $count -lt 0) { Stop-VmRelease $invalid }
  }
  # Nothing blocked, critical or left out, and the counts agree with each other and with the package list.
  if ($counts['blocked'] -ne 0 -or $counts['critical'] -ne 0 -or $counts['omitted'] -ne 0 -or
      $packages.Count -lt 1 -or $packages.Count -gt 25 -or $counts['reported'] -ne $packages.Count -or
      $counts['vulnerabilities'] -lt 1 -or $counts['vulnerabilities'] -gt $counts['reported'] -or
      ($counts['info'] + $counts['low'] + $counts['moderate'] + $counts['high']) -ne $counts['vulnerabilities'] -or
      $exceptions.Count -lt 1) {
    Stop-VmRelease $invalid
  }
  foreach ($package in $packages) {
    if (-not (Test-ReleaseExactKeys $package @('name', 'version', 'status')) -or
        $package['name'] -isnot [string] -or $package['name'].Length -gt 214 -or
        $package['name'] -cnotmatch '\A(?:@[0-9A-Za-z][0-9A-Za-z._-]*/)?[0-9A-Za-z][0-9A-Za-z._-]*\z' -or
        $package['version'] -isnot [string] -or $package['version'] -cnotmatch $versionPattern -or
        $package['status'] -isnot [string] -or $package['status'] -cnotmatch '\A(?:accepted|dependent)\z') {
      Stop-VmRelease $invalid
    }
  }
  $advisories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($exception in $exceptions) {
    if (-not (Test-ReleaseExactKeys $exception @('advisory', 'package', 'version', 'expires')) -or
        $exception['advisory'] -isnot [string] -or
        $exception['advisory'] -cnotmatch '\AGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\z' -or
        $exception['package'] -isnot [string] -or $exception['package'].Length -gt 214 -or
        $exception['package'] -cnotmatch '\A(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*\z' -or
        $exception['version'] -isnot [string] -or $exception['version'] -cnotmatch $versionPattern -or
        $exception['expires'] -isnot [string] -or $exception['expires'] -cnotmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z') {
      Stop-VmRelease $invalid
    }
    # The date must be a real calendar day that is today or later in UTC, and each advisory may appear once per package version.
    $expires = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($exception['expires'], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::None, [ref]$expires) -or
        $expires -lt $UtcToday.Date -or -not $advisories.Add("$($exception['advisory']) $($exception['package']) $($exception['version'])")) {
      Stop-VmRelease $invalid
    }
    $covered = @($packages | Where-Object {
      $_['status'] -ceq 'accepted' -and $_['name'] -ceq $exception['package'] -and $_['version'] -ceq $exception['version']
    })
    if ($covered.Count -lt 1) { Stop-VmRelease $invalid }
  }
  # Every package marked accepted must be the exact package and version of one of the exceptions.
  foreach ($package in $packages) {
    if ($package['status'] -cne 'accepted') { continue }
    $covering = @($exceptions | Where-Object {
      $_['package'] -ceq $package['name'] -and $_['version'] -ceq $package['version']
    })
    if ($covering.Count -lt 1) { Stop-VmRelease $invalid }
  }
  return $exceptions
}

# Returns nothing for the plain pass report and the accepted advisories for an accepted report. Any other report stops.
function Assert-ReleaseDependencyReport($Report) {
  if ($Report -is [System.Collections.IDictionary] -and $Report['status'] -is [string] -and $Report['status'] -ceq 'accepted') {
    return Get-ReleaseAcceptedDependencyAdvisories $Report
  }
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

# Shows only the failed preflight's status and, for command_failed, a reason that matches the fixed grammar of
# FAILURE_REASON_PATTERN in scripts/lib/dependency-policy.ts. A reason that does not match withholds everything.
function Get-ReleaseDependencyFailureDetail([Exception]$Failure) {
  try {
    $output = $Failure.Data['ReleaseFailureOutput']
    if ($output -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($output) -gt 8192) { return '' }
    $report = ConvertFrom-Json -InputObject $output -AsHashtable -NoEnumerate -ErrorAction Stop
    if ($report -isnot [System.Collections.IDictionary]) { return '' }
    $status = $report['status']
    if ($status -isnot [string] -or
        $status -cnotmatch '\A(rejected|invalid_request|invalid_lock|lock_mismatch|malformed_audit|command_failed|stale_audit)\z') {
      return ''
    }
    if ($status -cne 'command_failed') { return " (status $status)" }
    $reason = $report['reason']
    if ($reason -is [string] -and
        $reason -cmatch '\Anpm audit (?:exit (?:0|[1-9][0-9]{0,9})|ended by signal SIG[A-Z0-9]{1,12}|ended without an exit code|timed out|could not start(?: \(E[A-Z0-9_]{1,24}\))?)(?:, npm code E[A-Z0-9_]{1,24})?(?: \(attempt [1-9] of [1-9]\))?\z') {
      return " (status $status; reason: $reason)"
    }
    return ''
  } catch {
    return ''
  }
}

function Assert-ReleaseDependencyPreflight([string]$Commit) {
  try {
    $lockIdentity = Get-ReleaseCommittedLockIdentity $Commit
    $output = Invoke-ReleaseStep 'npm' @(
      'run', '--silent', 'dependency:preflight', '--',
      '--lock-sha256', $lockIdentity, '--run-audit'
    ) 300 -KeepFailureOutput
    if ([Text.Encoding]::UTF8.GetByteCount($output) -gt 8192) {
      Stop-VmRelease 'Dependency preflight output exceeded its release bound.'
    }
    $accepted = @(Assert-ReleaseDependencyReport (ConvertFrom-ReleaseJson $output))
    Assert-ReleaseWorkingLock $lockIdentity
    # Each value was matched against a fixed pattern above. Nothing else from the audit is printed.
    foreach ($advisory in $accepted) {
      Write-Host "Release warning: dependency advisory accepted; advisory=$($advisory['advisory']); package=$($advisory['package']); expires=$($advisory['expires'])."
    }
  } catch {
    $code = 1
    if ($_.Exception.Data.Contains('ReleaseExitCode')) { $code = $_.Exception.Data['ReleaseExitCode'] }
    $detail = Get-ReleaseDependencyFailureDetail $_.Exception
    Stop-VmRelease "Dependency preflight failed$detail; raw output withheld." $code
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

function Get-MarkdocReleaseTarget([string]$Name, [string]$PublicOrigin = '') {
  $targets = @{
    Enterprise = @{
      Subscription = 'f40011a4-4708-4843-9b04-e1eac4ad0ebf'
      Acr = 'markdocacr7nkilqfckcukm'
      VmOrigin = 'https://markdoc-burkeholland-ent-f40011a4.eastus2.cloudapp.azure.com'
      # Until markdoc.app points at this VM, its Azure name proxies /api/health to the app.
      Origin = 'https://markdoc.app'
    }
    Professional = @{
      Subscription = '332d0c98-694c-48a0-91f3-465de6ac30a5'
      Acr = 'markdocacrmnd542unepl56'
      VmOrigin = 'https://markdoc-burkeholland.eastus2.cloudapp.azure.com'
      # The VM hostname 308-redirects here, so public health must hit the canonical origin directly.
      Origin = 'https://markdoc.app'
    }
  }
  if (-not $targets.ContainsKey($Name)) { Stop-VmRelease "Unknown release target '$Name'." 2 }
  $selected = $targets[$Name]
  if ($PublicOrigin) {
    if ($PublicOrigin -notmatch '^https://[a-z0-9.-]+$') { Stop-VmRelease 'PublicOrigin must be an https origin without a path.' 2 }
    $selected.Origin = $PublicOrigin
  }
  $selected.Name = $Name
  $selected.Tenant = 'f1fde69f-c8d3-4b94-adeb-02d045b37f6a'
  $selected.Group = 'markdoc-rg'
  $selected.Registry = "$($selected.Acr).azurecr.io"
  return $selected
}

function Invoke-MarkdocVmRelease([string]$Commit, [string]$TargetName = 'Enterprise', [string]$OriginOverride = '') {
  $releaseClock = [Diagnostics.Stopwatch]::StartNew()
  $preSubmissionDeadlineMessage = 'Pre-submission deadline exceeded; no build was submitted.'
  $buildDeadlineMessage = 'Build phase deadline exceeded; remote build may continue. No VM command was sent.'
  $postBuildDeadlineMessage = 'Post-build verification deadline exceeded; no VM command was sent.'
  $vmDeadlineMessage = 'VM/result verification deadline exceeded; guest work may continue and public health was not accepted.'
  $healthDeadlineMessage = 'Public health deadline exceeded; guest deployment may be active.'
  $sourceRoot = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
  $target = Get-MarkdocReleaseTarget $TargetName $OriginOverride
  $subscription = $target.Subscription
  $tenant = $target.Tenant
  $group = $target.Group
  $acr = $target.Acr
  $registry = $target.Registry
  $vm = 'markdoc-pg'
  $publicIp = 'markdoc-web-ip'
  $vmOrigin = $target.VmOrigin
  $origin = $target.Origin
  $resourceRoot = "/subscriptions/$subscription/resourceGroups/$group/providers"
  $vmId = "$resourceRoot/Microsoft.Compute/virtualMachines/$vm"
  $nativeScope = @('--subscription', $subscription, '--resource-group', $group)
  $subscriptionScope = @('--subscription', $subscription)
  $context = $null
  $releaseStage = 'source validation'
  $buildRun = $null
  $operation = $null
  $releaseVerified = $false
  $terminalFailure = $null
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
        $ipInfo.configuration -ine "$nicId/ipConfigurations/primary" -or "https://$($ipInfo.fqdn)" -cne $vmOrigin) {
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
    Assert-ReleaseDeadline $releaseClock $PreSubmissionDeadlineSeconds $preSubmissionDeadlineMessage

    $buildClock = [Diagnostics.Stopwatch]::StartNew()
    $releaseStage = 'ACR build submission'
    # A unique additional tag can identify a submission even if the run-ID response is lost.
    $submissionTag = "release-$([guid]::NewGuid().ToString('N'))"
    $buildSubmittedAt = [DateTimeOffset]::UtcNow
    Write-Host "Release: ACR submission $acr/markdoc:$submissionTag (run ID not yet returned)."
    Write-Host 'Stopping the CLI does not cancel cloud work. Reconcile this submission before any retry.'
    $submissionOutput = Invoke-ReleaseAz (@(
      'acr', 'build', '--registry', $acr, '--image', "markdoc:$Commit", '--image', "markdoc:$($Commit.Substring(0, 12))",
      '--image', "markdoc:$submissionTag", '--build-arg', "APP_VERSION=$Commit",
      '--file', (Join-Path $context 'Dockerfile'), $context, '--timeout', "$AcrBuildTimeoutSeconds",
      '--no-wait', '--no-logs'
    ) + $nativeScope) $AcrBuildSubmissionTimeoutSeconds $buildClock $BuildPhaseDeadlineSeconds $buildDeadlineMessage
    $submission = $null
    if (-not [string]::IsNullOrWhiteSpace($submissionOutput)) {
      $submission = ConvertFrom-Json -InputObject $submissionOutput -AsHashtable -NoEnumerate -ErrorAction SilentlyContinue
    }
    if ($submission -is [System.Collections.IDictionary] -and
        $submission['runId'] -is [string] -and $submission['runId'] -cmatch '^[a-zA-Z0-9]{1,80}$') {
      $buildRun = $submission['runId']
      Write-Host "Release: ACR submission returned run ID $buildRun."
    } else {
      Write-Host 'Release: ACR submission did not return a usable run ID; reconciling by unique tag and submission time.'
    }

    if (-not $buildRun) {
      $releaseStage = 'ACR build reconciliation'
      $missedPolls = 0
      for ($attempt = 1; $attempt -le 132; $attempt++) {
        $poll = Invoke-ReleaseAcrPoll (@(
          'acr', 'task', 'list-runs', '--registry', $acr, '--top', '50',
          '--query', '[].{runId:runId,runType:runType,status:status,createTime:createTime,runErrorMessage:runErrorMessage,outputImages:outputImages}'
        ) + $nativeScope) ([ref]$missedPolls) $buildClock $BuildPhaseDeadlineSeconds $buildDeadlineMessage
        if ($null -eq $poll) {
          if ($attempt -lt 132) {
            Start-ReleaseBoundedSleep $buildClock $BuildPhaseDeadlineSeconds 5 $buildDeadlineMessage
          }
          continue
        }
        $runs = ConvertFrom-ReleaseJson $poll
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
          $matchedRun = $matches[0]
          $buildRun = $matchedRun['runId']
          if ($buildRun -isnot [string] -or $buildRun -cnotmatch '^[a-zA-Z0-9]{1,80}$') {
            Stop-VmRelease 'The reconciled ACR build run has an invalid identity.'
          }
          if (Test-ReleaseAcrFailureStatus $matchedRun['status']) {
            Stop-ReleaseAcrBuildUnsuccessful $buildRun $matchedRun['status'] $matchedRun['runErrorMessage'] $acr $group $subscription
          }
          break
        }

        # A timestamp may identify one terminal failure for reporting, but never a deployable image.
        $createdRuns = @($runs | Where-Object { Test-ReleaseAcrRunCreatedAfter $_ $buildSubmittedAt })
        if ($createdRuns.Count -eq 1 -and (Test-ReleaseAcrFailureStatus $createdRuns[0]['status'])) {
          $failedRun = $createdRuns[0]
          $buildRun = $failedRun['runId']
          if ($buildRun -isnot [string] -or $buildRun -cnotmatch '^[a-zA-Z0-9]{1,80}$') {
            Stop-VmRelease 'The newly created failed ACR run has an invalid identity.'
          }
          Stop-ReleaseAcrBuildUnsuccessful $buildRun $failedRun['status'] $failedRun['runErrorMessage'] $acr $group $subscription
        }
        if ($attempt -lt 132) {
          Start-ReleaseBoundedSleep $buildClock $BuildPhaseDeadlineSeconds 5 $buildDeadlineMessage
        }
      }
    }
    if (-not $buildRun) {
      Stop-VmRelease 'ACR submission acceptance is unknown after unique-tag reconciliation. Do not retry.'
    }
    Write-Host "Release: ACR run $buildRun; registry $acr."
    $releaseStage = 'ACR build completion'
    $missedPolls = 0
    do {
      $poll = Invoke-ReleaseAcrPoll (@('acr', 'task', 'show-run', '--registry', $acr, '--run-id', $buildRun, '--query', '{runId:runId,status:status,runErrorMessage:runErrorMessage,outputImages:outputImages}') + $nativeScope) `
        ([ref]$missedPolls) $buildClock $BuildPhaseDeadlineSeconds $buildDeadlineMessage
      if ($null -eq $poll) {
        Start-ReleaseBoundedSleep $buildClock $BuildPhaseDeadlineSeconds 5 $buildDeadlineMessage
        continue
      }
      $run = ConvertFrom-ReleaseJson $poll
      if ($run.runId -cne $buildRun) { Stop-VmRelease 'ACR returned a different run identity.' }
      if ($run.status -ceq 'Succeeded') { break }
      if ($run.status -cnotin @('Queued', 'Started', 'Running')) {
        Stop-ReleaseAcrBuildUnsuccessful $buildRun $run.status $run.runErrorMessage $acr $group $subscription
      }
      Start-ReleaseBoundedSleep $buildClock $BuildPhaseDeadlineSeconds 5 $buildDeadlineMessage
    } while ($true)
    Assert-ReleaseDeadline $buildClock $BuildPhaseDeadlineSeconds $buildDeadlineMessage

    $postBuildClock = [Diagnostics.Stopwatch]::StartNew()
    $releaseStage = 'immutable image identity'
    $digests = ConvertFrom-ReleaseJson (Invoke-ReleaseDigestLookup (@('acr', 'manifest', 'list-metadata', '--registry', $acr, '--name', 'markdoc',
      '--query', "[?tags != null && contains(tags, '$Commit')].digest") + $subscriptionScope) `
      $postBuildClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage)
    if ($digests -isnot [array] -or $digests.Count -ne 1 -or $digests[0] -isnot [string] -or $digests[0] -cnotmatch '^sha256:[0-9a-f]{64}$') {
      Stop-VmRelease 'The exact commit tag has an absent, ambiguous or malformed digest.'
    }
    $digest = $digests[0]
    $builtImages = @($run.outputImages | Where-Object { $_.registry -ceq $registry -and $_.repository -ceq 'markdoc' -and $_.tag -ceq $Commit })
    if ($builtImages.Count -ne 1 -or $builtImages[0].digest -cne $digest) { Stop-VmRelease 'The exact tag digest does not match this successful build run.' }
    $image = "$registry/markdoc@$digest"
    Assert-ReleaseSource $Commit $postBuildClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage
    Assert-ReleaseDeadline $postBuildClock $PostBuildVerificationDeadlineSeconds $postBuildDeadlineMessage

    $vmClock = [Diagnostics.Stopwatch]::StartNew()
    $releaseStage = 'VM guest deployment'
    $operation = [guid]::NewGuid().ToString()
    Write-Host "Release: image $image"
    Write-Host "Release: guest invocation $operation; VM $vmId; started $([DateTime]::UtcNow.ToString('o'))."
    Write-Host 'ARM operation ID is not exposed by invoke. The guest ID is recorded in the submitted script parameters and guest output.'
    Write-Host 'Timeout/failure is unverified, not cancellation or automatic rollback. Do not submit another release.'
    $vmLimit = Get-ReleaseRemainingSeconds $vmClock $VmPhaseDeadlineSeconds $vmDeadlineMessage
    $result = ConvertFrom-ReleaseJson (Invoke-ReleaseAz (@('vm', 'run-command', 'invoke', '--name', $vm, '--command-id', 'RunShellScript',
      '--scripts', "@$walScript", "@$vmScript", '--parameters', $registry, $image, $Commit, $tenant, $operation) + $nativeScope) `
      $vmLimit $vmClock $VmPhaseDeadlineSeconds $vmDeadlineMessage)
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
      $spaceFailure = Get-ReleaseImageSpaceFailure $stdout.Groups['output'].Value $operation
      if ($spaceFailure) { Stop-VmRelease $spaceFailure }
      $walFailure = Get-ReleaseWalFailure $stdout.Groups['output'].Value $operation
      if ($walFailure) {
        $details = @($walFailure.Budget) + @($walFailure.Diagnostics)
        $details = @($details | Where-Object { $_ })
        $reason = "Release WAL gate failed during $($walFailure.Stage); owned cleanup=$($walFailure.Cleanup)."
        if ($details.Count -gt 0) { $reason += "`n" + ($details -join "`n") }
        Stop-VmRelease $reason
      }
      Stop-VmRelease 'VM transport succeeded without exact terminal guest-ready and local-health evidence.'
    }
    [void](Assert-ReleaseWalEvidence $stdout.Groups['output'].Value $operation $terminal.Index)
    Assert-ReleaseHealth (ConvertFrom-ReleaseJson $terminal.Groups['health'].Value) $Commit 'Local'
    $retentionWarnings = [regex]::Matches($stdout.Groups['output'].Value,
      "(?m)^markdoc-vm-image-warning:$operation`:retention-failed$")
    if ($retentionWarnings.Count -gt 0) {
      Write-Host 'Release warning: old-image retention failed; the healthy application was not rolled back. Reconcile disk capacity before another release.'
    }
    Assert-ReleaseDeadline $vmClock $VmPhaseDeadlineSeconds $vmDeadlineMessage

    $healthClock = [Diagnostics.Stopwatch]::StartNew()
    $releaseStage = 'public health after guest ready (no automatic rollback)'
    Write-Host 'Release: guest ready; waiting for exact public health.'
    $healthLimit = [math]::Min(20, (Get-ReleaseRemainingSeconds $healthClock $PublicHealthDeadlineSeconds $healthDeadlineMessage))
    $health = ConvertFrom-ReleaseJson (Get-ReleasePublicHealth $origin $healthLimit)
    Assert-ReleaseHealth $health $Commit 'Public'
    Assert-ReleaseDeadline $healthClock $PublicHealthDeadlineSeconds $healthDeadlineMessage
    $releaseVerified = $true
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
    $terminalFailure = [InvalidOperationException]::new('Release did not reach verified completion.')
    $terminalFailure.Data['ReleaseExitCode'] = $code
  } finally {
    try {
      Remove-ReleaseContext $context $sourceRoot
    } catch {
      $cleanupCode = 1
      if ($_.Exception.Data.Contains('ReleaseExitCode')) { $cleanupCode = $_.Exception.Data['ReleaseExitCode'] }
      Write-Host 'Release failed/unverified at local cleanup: source-archive removal child did not complete within its native timeout.'
      if (-not $terminalFailure) {
        $terminalFailure = [InvalidOperationException]::new('Release did not reach verified completion.')
        $terminalFailure.Data['ReleaseExitCode'] = $cleanupCode
      }
    }
  }
  if ($terminalFailure) { throw $terminalFailure }
  if (-not $releaseVerified) { Stop-VmRelease 'Release did not reach verified completion.' }
  Write-Host "Release complete: $origin reports ok/db/collab true and version $Commit."
}

try {
  Invoke-MarkdocVmRelease $ExpectedCommit $Target $PublicOrigin
} catch [InvalidOperationException] {
  if ($_.Exception.Data.Contains('ReleaseExitCode')) { exit $_.Exception.Data['ReleaseExitCode'] }
  throw
}
