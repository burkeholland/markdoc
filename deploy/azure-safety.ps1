function New-CombinedOperationException {
  param(
    [Parameter(Mandatory)]
    [string]$Message,

    [Parameter(Mandatory)]
    [Management.Automation.ErrorRecord]$PrimaryError,

    [Parameter(Mandatory)]
    [Management.Automation.ErrorRecord[]]$SecondaryErrors
  )

  $exceptions = [Collections.Generic.List[Exception]]::new()
  $exceptions.Add($PrimaryError.Exception)
  foreach ($errorRecord in $SecondaryErrors) {
    $exceptions.Add($errorRecord.Exception)
  }
  return [AggregateException]::new($Message, $exceptions.ToArray())
}

function Invoke-OperationWithGuaranteedCleanup {
  param(
    [Parameter(Mandatory)]
    [string]$Context,

    [Parameter(Mandatory)]
    [scriptblock]$Operation,

    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [hashtable[]]$CleanupActions
  )

  $result = $null
  $primaryError = $null
  try {
    $result = & $Operation
  } catch {
    $primaryError = $_
  }

  $cleanupErrors = [Collections.Generic.List[Management.Automation.ErrorRecord]]::new()
  foreach ($cleanup in $CleanupActions) {
    try {
      [void](& $cleanup.Action)
    } catch {
      $cleanupErrors.Add($_)
    }
  }

  if ($primaryError) {
    if ($cleanupErrors.Count -gt 0) {
      $details = $cleanupErrors | ForEach-Object { $_.Exception.Message }
      throw (New-CombinedOperationException `
        -Message "$Context failed: $($primaryError.Exception.Message) Cleanup also failed: $($details -join '; ')" `
        -PrimaryError $primaryError `
        -SecondaryErrors $cleanupErrors.ToArray())
    }
    throw $primaryError
  }

  if ($cleanupErrors.Count -gt 0) {
    if ($cleanupErrors.Count -eq 1) {
      throw $cleanupErrors[0]
    }
    $first = $cleanupErrors[0]
    $remaining = $cleanupErrors.ToArray()[1..($cleanupErrors.Count - 1)]
    throw (New-CombinedOperationException `
      -Message "$Context cleanup failed: $(($cleanupErrors | ForEach-Object { $_.Exception.Message }) -join '; ')" `
      -PrimaryError $first `
      -SecondaryErrors $remaining)
  }

  return $result
}

function Assert-ProtectedCurrentUserFileAcl {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $file = [IO.FileInfo]::new($Path)
  $acl = [IO.FileSystemAclExtensions]::GetAccessControl(
    $file,
    [Security.AccessControl.AccessControlSections]::Access
  )
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = @(
    $acl.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    )
  )
  if ($rules.Count -eq 0) {
    throw 'The production secrets store ACL has no readable access rules.'
  }
  $foreignAllow = @(
    $rules | Where-Object {
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.IdentityReference -ne $currentSid
    }
  )
  if (-not $acl.AreAccessRulesProtected -or $foreignAllow.Count -gt 0) {
    throw 'The production secrets store ACL is not restricted to the current Windows user.'
  }
}

function Resolve-RotationPreparation {
  param(
    [Parameter(Mandatory)]
    [bool]$HasRetainedCandidate,

    [Parameter(Mandatory)]
    [scriptblock]$LoadRetainedCandidate,

    [Parameter(Mandatory)]
    [scriptblock]$GetFreshContext,

    [Parameter(Mandatory)]
    [scriptblock]$AssertFreshRevisionHealthy,

    [Parameter(Mandatory)]
    [scriptblock]$CreateFreshCandidate
  )

  if ($HasRetainedCandidate) {
    return & $LoadRetainedCandidate
  }

  $freshContext = & $GetFreshContext
  [void](& $AssertFreshRevisionHealthy $freshContext)
  return & $CreateFreshCandidate $freshContext
}

function Invoke-AlreadyInitializedDatabaseRefusal {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$CleanupTemporaryEgress,

    [Parameter(Mandatory)]
    [scriptblock]$RemoveBootstrapPublicIp
  )

  $refusal = [InvalidOperationException]::new(
    'PostgreSQL initialization already succeeded; use ordinary deployment or explicit password rotation.'
  )
  [void](Invoke-OperationWithGuaranteedCleanup `
    -Context 'Already-initialized PostgreSQL cleanup' `
    -Operation { throw $refusal } `
    -CleanupActions @(
      @{ Action = $CleanupTemporaryEgress },
      @{ Action = $RemoveBootstrapPublicIp }
    ))
}

function Invoke-RotationFinalization {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$Commit,

    [Parameter(Mandatory)]
    [scriptblock]$Verify,

    [Parameter(Mandatory)]
    [scriptblock]$Compensate,

    [Parameter(Mandatory)]
    [scriptblock]$TerminalCleanup,

    [switch]$SimulatePostChangeFailure
  )

  $result = $null
  try {
    $result = & $Commit
    if ($SimulatePostChangeFailure) {
      throw [InvalidOperationException]::new('Simulated failure during credential rollout after PostgreSQL and Key Vault accepted the candidate.')
    }
    [void](& $Verify $result)
  } catch {
    $primaryError = $_
    try {
      [void](& $Compensate $primaryError)
    } catch {
      throw (New-CombinedOperationException `
        -Message "Database credential rollout failed: $($primaryError.Exception.Message) Compensation also failed: $($_.Exception.Message)" `
        -PrimaryError $primaryError `
        -SecondaryErrors @($_))
    }
    throw $primaryError
  }

  [void](& $TerminalCleanup $result)
  return $result
}
