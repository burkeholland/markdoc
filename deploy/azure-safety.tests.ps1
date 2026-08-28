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
Assert-True ($deploymentSource -match 'PostgresRotationPreviousRevision') 'Rotation state must retain the exact previous revision.'
Assert-True ($deploymentSource -match 'Resolve-RotationPreparation') 'Rotation must distinguish retained recovery state from a fresh candidate.'
Assert-True ($deploymentSource -match 'Invoke-AlreadyInitializedDatabaseRefusal') 'Already-initialized retries must run targeted cleanup before refusing.'
Assert-True ($deploymentSource -match 'Assert-ProtectedCurrentUserFileAcl') 'The production secret store must use the executable ACL helper.'
$rotationCommit = [regex]::Match(
  $deploymentSource,
  'Invoke-RotationFinalization\s+`\s+-Commit \{(?<body>[\s\S]+?)\}\s+`\s+-Verify'
)
Assert-True $rotationCommit.Success 'The rotation finalization commit block must remain structurally identifiable.'
Assert-True ($rotationCommit.Groups['body'].Value -match '-RotatePostgresPassword \$true') 'The database-changing rotation deployment must be inside compensated finalization.'
Assert-True ($rotationCommit.Groups['body'].Value -match '-CommitPostgresPassword \$true') 'The active secret and app rollout must share the same compensated finalization.'
Assert-True ($deploymentSource -match '\$rotationCleanup \+= @\{ Action = \{ Restore-PostgresSteadyStateEgress \} \}') 'Combined recovery and rotation must retain guaranteed temporary-egress cleanup.'

$aclPath = [IO.Path]::GetTempFileName()
try {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $protectedAcl = [Security.AccessControl.FileSecurity]::new()
  $protectedAcl.SetAccessRuleProtection($true, $false)
  $currentUserRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$protectedAcl.AddAccessRule($currentUserRule)
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($aclPath), $protectedAcl)
  Assert-ProtectedCurrentUserFileAcl $aclPath

  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $foreignRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $administratorsSid,
    [Security.AccessControl.FileSystemRights]::Read,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$protectedAcl.AddAccessRule($foreignRule)
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($aclPath), $protectedAcl)
  try {
    Assert-ProtectedCurrentUserFileAcl $aclPath
    throw 'Expected foreign ACL rejection.'
  } catch {
    Assert-True ($_.Exception.Message -match 'not restricted') 'The ACL helper must reject a foreign allow rule.'
  }
} finally {
  Remove-Item -LiteralPath $aclPath -Force
}

$events = [Collections.Generic.List[string]]::new()
$retained = Resolve-RotationPreparation `
  -HasRetainedCandidate $true `
  -LoadRetainedCandidate { $events.Add('load-retained'); 'retained-state' } `
  -GetFreshContext { $events.Add('get-fresh'); throw 'Fresh context must not be read.' } `
  -AssertFreshRevisionHealthy { $events.Add('health'); throw 'Old app health must not gate retained state.' } `
  -CreateFreshCandidate { $events.Add('create'); throw 'A retained candidate must not be replaced.' }
Assert-Equal 'retained-state' $retained 'A retained candidate must be returned for reconciliation.'
Assert-Equal 'load-retained' ($events -join ',') 'Retained candidate recovery must run before app health.'

$events.Clear()
try {
  Resolve-RotationPreparation `
    -HasRetainedCandidate $false `
    -LoadRetainedCandidate { $events.Add('load-retained') } `
    -GetFreshContext { $events.Add('get-fresh'); 'fresh-context' } `
    -AssertFreshRevisionHealthy { param($context) $events.Add("health-$context"); throw 'old app unhealthy' } `
    -CreateFreshCandidate { $events.Add('create') }
  throw 'Expected unhealthy fresh preflight.'
} catch {
  Assert-Equal 'old app unhealthy' $_.Exception.Message 'Fresh rotation must preserve the health preflight failure.'
}
Assert-Equal 'get-fresh,health-fresh-context' ($events -join ',') 'Fresh unhealthy preflight must refuse before candidate creation.'

$events.Clear()
$networkRules = [Collections.Generic.List[string]]::new()
$networkRules.Add('AllowApprovedPackageSetup')
$networkRules.Add('DenyOtherInternetEgress')
$networkRules.Add('UnrelatedPrivateRule')
try {
  Invoke-AlreadyInitializedDatabaseRefusal `
    -CleanupTemporaryEgress {
      $events.Add('restore-egress')
      [void]$networkRules.Remove('AllowApprovedPackageSetup')
    } `
    -RemoveBootstrapPublicIp { $events.Add('remove-named-public-ip') }
  throw 'Expected already-initialized refusal.'
} catch {
  Assert-True ($_.Exception.Message -match 'initialization already succeeded') 'Cleanup must preserve the already-initialized refusal.'
}
Assert-Equal 'restore-egress,remove-named-public-ip' ($events -join ',') 'Already-initialized retry must run both targeted cleanups before refusing.'
Assert-Equal 'DenyOtherInternetEgress,UnrelatedPrivateRule' ($networkRules -join ',') 'Already-initialized cleanup must leave unrelated NSG rules untouched.'

$events.Clear()
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
    -Commit {
      $events.Add('database-committed')
      $events.Add('resolve-image')
      throw 'image metadata failed'
    } `
    -Verify { $events.Add('verify') } `
    -Compensate { $events.Add('restore-database-and-revision') } `
    -TerminalCleanup { $events.Add('clear-candidate') }
  throw 'Expected post-database metadata failure.'
} catch {
  Assert-Equal 'image metadata failed' $_.Exception.Message 'A post-database failure must preserve the original error.'
}
Assert-Equal 'database-committed,resolve-image,restore-database-and-revision' ($events -join ',') 'Compensation must cover failures after database commit and before app finalization.'

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
Assert-True (-not $events.Contains('clear-candidate')) 'Double failure must retain all recovery state.'

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
