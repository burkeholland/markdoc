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

function Set-ProtectedCurrentUserFileAcl {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $protectedAcl = [Security.AccessControl.FileSecurity]::new()
  $protectedAcl.SetAccessRuleProtection($true, $false)
  $currentUserRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$protectedAcl.AddAccessRule($currentUserRule)
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $protectedAcl)
  Assert-ProtectedCurrentUserFileAcl $Path
}

function Get-ProtectedSecretStoreOperationMutexName {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $canonicalPath = [IO.Path]::GetFullPath($Path).ToUpperInvariant()
  $pathBytes = [Text.Encoding]::UTF8.GetBytes($canonicalPath)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $pathHash = $hasher.ComputeHash($pathBytes)
    $hashText = [Convert]::ToHexString($pathHash)
    return "Local\Markdoc.AzureProduction.$hashText"
  } finally {
    $hasher.Dispose()
    [Array]::Clear($pathBytes, 0, $pathBytes.Length)
    if ($pathHash) {
      [Array]::Clear($pathHash, 0, $pathHash.Length)
    }
  }
}

function Enter-ProtectedSecretStoreOperation {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $mutexName = Get-ProtectedSecretStoreOperationMutexName $Path
  $mutex = [Threading.Mutex]::new($false, $mutexName)
  $acquired = $false
  $recoveredAbandonedOwner = $false
  try {
    try {
      $acquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $acquired = $true
      $recoveredAbandonedOwner = $true
    }
    if (-not $acquired) {
      throw [InvalidOperationException]::new(
        'Another Markdoc production operation owns this secrets store.'
      )
    }

    return [pscustomobject]@{
      Mutex = $mutex
      Acquired = $true
      RecoveredAbandonedOwner = $recoveredAbandonedOwner
    }
  } catch {
    try {
      if ($acquired) {
        $mutex.ReleaseMutex()
      }
    } finally {
      $mutex.Dispose()
    }
    throw
  }
}

function Exit-ProtectedSecretStoreOperation {
  param(
    [AllowNull()]
    [object]$Ownership
  )

  if (-not $Ownership) {
    return
  }

  try {
    if ($Ownership.Acquired) {
      $Ownership.Mutex.ReleaseMutex()
      $Ownership.Acquired = $false
    }
  } finally {
    $Ownership.Mutex.Dispose()
  }
}

function Assert-SecureStringStore {
  param(
    [Parameter(Mandatory)]
    [object]$Store,

    [Parameter(Mandatory)]
    [string[]]$ExpectedProperties
  )

  foreach ($propertyName in $ExpectedProperties) {
    $property = $Store.PSObject.Properties[$propertyName]
    if (-not $property -or $property.Value -isnot [Security.SecureString]) {
      throw "The production secrets store property $propertyName must be a DPAPI-encrypted SecureString."
    }
  }
}

function Save-ProtectedSecureStringStore {
  param(
    [Parameter(Mandatory)]
    [string]$Path,

    [Parameter(Mandatory)]
    [object]$Store,

    [scriptblock]$ExportStore = {
      param($InputObject, [string]$OutputPath)
      $InputObject | Export-Clixml -LiteralPath $OutputPath -Force
    },

    [scriptblock]$ImportStore = {
      param([string]$InputPath)
      Import-Clixml -LiteralPath $InputPath
    },

    [scriptblock]$ReplaceFile = {
      param([string]$SourcePath, [string]$DestinationPath, [string]$BackupPath)
      [IO.File]::Replace($SourcePath, $DestinationPath, $BackupPath, $true)
    }
  )

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not [IO.File]::Exists($resolvedPath)) {
    throw "Production secrets store not found: $resolvedPath"
  }

  Assert-ProtectedCurrentUserFileAcl $resolvedPath
  $expectedProperties = @($Store.PSObject.Properties.Name)
  Assert-SecureStringStore -Store $Store -ExpectedProperties $expectedProperties

  $directory = [IO.Path]::GetDirectoryName($resolvedPath)
  $fileName = [IO.Path]::GetFileName($resolvedPath)
  $nonce = [guid]::NewGuid().ToString('N')
  $temporaryPath = [IO.Path]::Combine($directory, ".$fileName.$nonce.tmp")
  $backupPath = [IO.Path]::Combine($directory, ".$fileName.$nonce.bak")
  $replacementAttempted = $false
  $finalValidated = $false
  $primaryError = $null
  $restorationError = $null

  try {
    $temporaryFile = [IO.File]::Open(
      $temporaryPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $temporaryFile.Dispose()
    Set-ProtectedCurrentUserFileAcl $temporaryPath

    [void](& $ExportStore $Store $temporaryPath)
    Assert-ProtectedCurrentUserFileAcl $temporaryPath
    $saved = & $ImportStore $temporaryPath
    Assert-SecureStringStore -Store $saved -ExpectedProperties $expectedProperties

    $replacementAttempted = $true
    [void](& $ReplaceFile $temporaryPath $resolvedPath $backupPath)

    Assert-ProtectedCurrentUserFileAcl $resolvedPath
    $saved = & $ImportStore $resolvedPath
    Assert-SecureStringStore -Store $saved -ExpectedProperties $expectedProperties
    $finalValidated = $true
  } catch {
    $primaryError = $_
  } finally {
    if ($replacementAttempted -and -not $finalValidated -and [IO.File]::Exists($backupPath)) {
      try {
        if ([IO.File]::Exists($resolvedPath)) {
          $failedReplacementPath = "$temporaryPath.failed"
          [IO.File]::Replace($backupPath, $resolvedPath, $failedReplacementPath, $true)
          if ([IO.File]::Exists($failedReplacementPath)) {
            [IO.File]::Delete($failedReplacementPath)
          }
        } else {
          [IO.File]::Move($backupPath, $resolvedPath)
        }
        Assert-ProtectedCurrentUserFileAcl $resolvedPath
      } catch {
        $restorationError = $_
      }
    }

    if ($finalValidated -and [IO.File]::Exists($backupPath)) {
      [IO.File]::Delete($backupPath)
    }
    if ([IO.File]::Exists($temporaryPath) -and [IO.File]::Exists($resolvedPath)) {
      [IO.File]::Delete($temporaryPath)
    }
  }

  if ($primaryError) {
    if ($restorationError) {
      throw (New-CombinedOperationException `
        -Message "Production secrets store replacement failed: $($primaryError.Exception.Message) Predecessor restoration also failed: $($restorationError.Exception.Message)" `
        -PrimaryError $primaryError `
        -SecondaryErrors @($restorationError))
    }
    throw $primaryError
  }
  if ($restorationError) {
    throw $restorationError
  }
}

function Resolve-DatabaseDeploymentReadiness {
  param(
    [Parameter(Mandatory)]
    [bool]$PostgresVmExists,

    [Parameter(Mandatory)]
    [bool]$InitializeDatabase,

    [Parameter(Mandatory)]
    [bool]$RotateDatabasePassword,

    [Parameter(Mandatory)]
    [bool]$HasRetainedCandidate,

    [Parameter(Mandatory)]
    [scriptblock]$GetExtensionState,

    [Parameter(Mandatory)]
    [scriptblock]$GetExistingAppHealth
  )

  if ($InitializeDatabase -and $RotateDatabasePassword) {
    throw '-InitializeDatabase and -RotateDatabasePassword are mutually exclusive.'
  }
  if ($RotateDatabasePassword -and -not $PostgresVmExists) {
    throw 'The PostgreSQL VM does not exist; use -InitializeDatabase for first provision.'
  }
  if ($HasRetainedCandidate) {
    if (-not $RotateDatabasePassword) {
      throw 'Retained password rotation state requires -RotateDatabasePassword to recover.'
    }
    return [pscustomobject]@{
      Mode = 'Recovery'
      DatabaseInitialized = $false
    }
  }
  if (-not $PostgresVmExists) {
    if (-not $InitializeDatabase) {
      throw 'The PostgreSQL VM does not exist. First provision requires the explicit -InitializeDatabase flag.'
    }
    return [pscustomobject]@{
      Mode = 'Initialize'
      DatabaseInitialized = $false
    }
  }

  $extension = & $GetExtensionState
  if (
    -not $extension -or
    -not $extension.PSObject.Properties['ExitCode'] -or
    -not $extension.PSObject.Properties['State']
  ) {
    throw 'PostgreSQL initialization discovery did not return an explicit extension query result.'
  }
  if ($extension.ExitCode -ne 0) {
    throw 'Could not inspect the PostgreSQL initialization extension.'
  }

  $databaseInitialized = $extension.State -eq 'Succeeded'
  if (-not $databaseInitialized) {
    $healthResult = @(& $GetExistingAppHealth)
    if ($healthResult.Count -ne 1 -or $healthResult[0] -isnot [bool]) {
      throw 'PostgreSQL initialization health discovery did not return one explicit boolean result.'
    }
    $databaseInitialized = $healthResult[0]
  }
  if ($InitializeDatabase -and $databaseInitialized) {
    return [pscustomobject]@{
      Mode = 'AlreadyInitialized'
      DatabaseInitialized = $true
    }
  }
  if (-not $databaseInitialized -and -not $InitializeDatabase) {
    throw 'PostgreSQL initialization is incomplete. Resume it with the explicit -InitializeDatabase flag.'
  }

  return [pscustomobject]@{
    Mode = if ($InitializeDatabase) { 'Initialize' } elseif ($RotateDatabasePassword) { 'FreshRotation' } else { 'Deploy' }
    DatabaseInitialized = $databaseInitialized
  }
}

function Resolve-RotationPreparation {
  param(
    [Parameter(Mandatory)]
    [bool]$HasRetainedCandidate,

    [Parameter(Mandatory)]
    [bool]$HasCompleteRecoveryMetadata,

    [Parameter(Mandatory)]
    [scriptblock]$LoadRetainedCandidate,

    [Parameter(Mandatory)]
    [scriptblock]$LoadCandidateOnlyRecovery,

    [Parameter(Mandatory)]
    [scriptblock]$GetFreshContext,

    [Parameter(Mandatory)]
    [scriptblock]$AssertFreshRevisionHealthy,

    [Parameter(Mandatory)]
    [scriptblock]$CreateFreshCandidate
  )

  if ($HasRetainedCandidate) {
    if ($HasCompleteRecoveryMetadata) {
      return & $LoadRetainedCandidate
    }
    return & $LoadCandidateOnlyRecovery
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
