$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'azure-safety.ps1')

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ($Expected -ne $Actual) {
    throw "$Message Expected '$Expected', received '$Actual'."
  }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$deploymentSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'azure.ps1') -Raw
Assert-True ($deploymentSource -match '\$temporaryPackageEgress = \[bool\]\(\$InitializeDatabase -or \$ConfigureRecovery\)') 'Initialization and recovery must both register temporary-egress cleanup.'
Assert-True ($deploymentSource -match 'Restore-PostgresSteadyStateEgress') 'The deployment path must invoke restrictive-egress restoration.'
Assert-True ($deploymentSource -match "nsg rule delete[\s\S]+?AllowApprovedPackageSetup") 'Egress cleanup must modify only the temporary package rule.'
Assert-True ($deploymentSource -match "DenyOtherInternetEgress[\s\S]+?destinationAddressPrefix -ne 'Internet'") 'Egress cleanup must verify the steady-state Internet deny rule.'
Assert-True ($deploymentSource -match 'Invoke-RotationFinalization') 'The deployment path must use compensated rotation finalization.'

$events = [Collections.Generic.List[string]]::new()
try {
  Invoke-OperationWithGuaranteedCleanup `
    -Context 'Initialization deployment' `
    -Operation { $events.Add('initialize'); throw 'initialize failed' } `
    -CleanupActions @(
      @{ Action = { $events.Add('restore-egress') } },
      @{ Action = { $events.Add('remove-public-ip') } }
    )
  throw 'Expected initialization failure.'
} catch {
  Assert-Equal 'initialize failed' $_.Exception.Message 'Initialization must rethrow the original error.'
}
Assert-Equal 'initialize,restore-egress,remove-public-ip' ($events -join ',') 'Initialization must run both cleanups.'

$events.Clear()
try {
  Invoke-OperationWithGuaranteedCleanup `
    -Context 'Recovery deployment' `
    -Operation { $events.Add('recovery'); throw 'recovery failed' } `
    -CleanupActions @(
      @{ Action = { $events.Add('restore-egress') } }
    )
  throw 'Expected recovery failure.'
} catch {
  Assert-Equal 'recovery failed' $_.Exception.Message 'Recovery must rethrow the original error.'
}
Assert-Equal 'recovery,restore-egress' ($events -join ',') 'Recovery must restore restrictive egress.'

$events.Clear()
try {
  Invoke-OperationWithGuaranteedCleanup `
    -Context 'Recovery deployment' `
    -Operation { $events.Add('recovery'); throw 'primary failure' } `
    -CleanupActions @(
      @{ Action = { $events.Add('restore-egress'); throw 'cleanup failure' } }
    )
  throw 'Expected combined failure.'
} catch {
  Assert-True ($_.Exception -is [AggregateException]) 'A primary plus cleanup failure must be aggregated.'
  Assert-True ($_.Exception.Message -match 'primary failure') 'The combined failure must include the primary error.'
  Assert-True ($_.Exception.Message -match 'cleanup failure') 'The combined failure must include the cleanup error.'
}
Assert-Equal 'recovery,restore-egress' ($events -join ',') 'Cleanup must run after the primary failure.'

$events.Clear()
try {
  Invoke-RotationFinalization `
    -Commit { $events.Add('commit'); 'result' } `
    -Verify { param($result) $events.Add("verify-$result") } `
    -Compensate { $events.Add('compensate') } `
    -TerminalCleanup { $events.Add('clear-candidate') } `
    -SimulatePostChangeFailure
  throw 'Expected simulated post-change failure.'
} catch {
  Assert-True ($_.Exception.Message -match 'Simulated failure during credential rollout') 'The injected failure must be preserved.'
}
Assert-Equal 'commit,compensate' ($events -join ',') 'Post-change injection must compensate after commit and before verification or cleanup.'

$events.Clear()
$result = Invoke-RotationFinalization `
  -Commit { $events.Add('commit'); 'result' } `
  -Verify { param($value) $events.Add("verify-$value") } `
  -Compensate { $events.Add('compensate') } `
  -TerminalCleanup { param($value) $events.Add("clear-$value") }
Assert-Equal 'result' $result 'Successful finalization must return the commit result.'
Assert-Equal 'commit,verify-result,clear-result' ($events -join ',') 'Candidate cleanup must follow verified health.'

$events.Clear()
try {
  Invoke-RotationFinalization `
    -Commit { $events.Add('commit'); throw 'commit failed' } `
    -Verify { $events.Add('verify') } `
    -Compensate { $events.Add('compensate') } `
    -TerminalCleanup { $events.Add('clear-candidate') }
  throw 'Expected commit failure.'
} catch {
  Assert-Equal 'commit failed' $_.Exception.Message 'A compensated commit failure must preserve the original error.'
}
Assert-Equal 'commit,compensate' ($events -join ',') 'Failed commit must compensate without clearing the candidate.'

$events.Clear()
try {
  Invoke-RotationFinalization `
    -Commit { $events.Add('commit'); throw 'commit failed' } `
    -Verify { $events.Add('verify') } `
    -Compensate { $events.Add('compensate'); throw 'compensation failed' } `
    -TerminalCleanup { $events.Add('clear-candidate') }
  throw 'Expected aggregate rotation failure.'
} catch {
  Assert-True ($_.Exception -is [AggregateException]) 'Rollout plus compensation failure must be aggregated.'
  Assert-True ($_.Exception.Message -match 'commit failed') 'Aggregate rotation failure must include rollout error.'
  Assert-True ($_.Exception.Message -match 'compensation failed') 'Aggregate rotation failure must include compensation error.'
}
Assert-Equal 'commit,compensate' ($events -join ',') 'Failed compensation must leave the candidate intact.'

$events.Clear()
try {
  Invoke-RotationFinalization `
    -Commit { $events.Add('commit'); 'result' } `
    -Verify { $events.Add('verify') } `
    -Compensate { $events.Add('compensate') } `
    -TerminalCleanup { $events.Add('clear-candidate'); throw 'cleanup failed' }
  throw 'Expected terminal cleanup failure.'
} catch {
  Assert-Equal 'cleanup failed' $_.Exception.Message 'Terminal cleanup failure must remain explicit.'
}
Assert-Equal 'commit,verify,clear-candidate' ($events -join ',') 'A terminal cleanup failure must not roll back a healthy revision.'

Write-Host 'azure safety tests: ok'
