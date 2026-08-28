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
