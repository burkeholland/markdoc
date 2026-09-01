param(
  [switch]$RequireCaseSensitiveOwnership
)

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
$sharedSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'azure-postgres-network.ps1') -Raw
Assert-True ($deploymentSource -match '\$temporaryPackageEgress = \[bool\]\(\$InitializeDatabase -or \$ConfigureRecovery\)') 'Initialization and recovery must both register temporary-egress cleanup.'
$temporaryPublicIpAssignment = [regex]::Match(
  $deploymentSource,
  '(?m)^\s*\$temporaryPublicIp = (?<expression>.+?)\s*$'
)
Assert-True $temporaryPublicIpAssignment.Success 'The temporary bootstrap public IP decision must remain structurally identifiable.'
Assert-Equal '[bool]($InitializeDatabase -or $ConfigureRecovery)' $temporaryPublicIpAssignment.Groups['expression'].Value 'Recovery configuration must attach the temporary bootstrap public IP so package installs keep an explicit egress path without the NAT gateway.'
$temporaryPublicIpDecision = [scriptblock]::Create(
  "param([switch]`$InitializeDatabase, [switch]`$ConfigureRecovery) $($temporaryPublicIpAssignment.Groups['expression'].Value)"
)
Assert-Equal $true (& $temporaryPublicIpDecision -ConfigureRecovery) 'Recovery configuration alone must attach the temporary bootstrap public IP.'
Assert-Equal $true (& $temporaryPublicIpDecision -InitializeDatabase) 'Database initialization must attach the temporary bootstrap public IP.'
Assert-Equal $true (& $temporaryPublicIpDecision -InitializeDatabase -ConfigureRecovery) 'Combined initialization and recovery must attach the temporary bootstrap public IP.'
Assert-Equal $false (& $temporaryPublicIpDecision) 'Ordinary redeployments must not attach a public IP to the database VM.'
Assert-True ($deploymentSource -match '(?ms)if \(\$temporaryPublicIp\) \{\s*\$initialCleanup \+= @\{ Action = \{ Remove-BootstrapPublicIp "\$Name-pg-bootstrap-ip" \} \}\s*\}') 'Attaching the temporary bootstrap public IP must register its guaranteed cleanup.'
Assert-True ($deploymentSource -match '-BootstrapPublicIp \$temporaryPublicIp `') 'The initial deployment must attach the bootstrap public IP from the shared decision.'
Assert-True ($deploymentSource -match '(?m)^Remove-BootstrapPublicIp \$outputs\.bootstrapPublicIpName\.value\s*$') 'Every deployment path must detach and delete the bootstrap public IP after the final rollout.'
$parameterGuards = [regex]::Matches(
  $deploymentSource,
  '(?m)^if \((?<condition>[^\r\n]+)\) \{\r?\n\s*throw ''(?<message>[^'']+)''\r?\n\}'
)
$rotationRecoveryGuard = @($parameterGuards | Where-Object {
  $_.Groups['condition'].Value -match '\$RotateDatabasePassword' -and $_.Groups['condition'].Value -match '\$ConfigureRecovery'
})
Assert-Equal 1 $rotationRecoveryGuard.Count 'Parameter validation must refuse -RotateDatabasePassword combined with -ConfigureRecovery: the rotation paths deploy without the bootstrap public IP.'
$rotationRecoveryRefusal = [scriptblock]::Create(
  "param([switch]`$RotateDatabasePassword, [switch]`$ConfigureRecovery) $($rotationRecoveryGuard[0].Groups['condition'].Value)"
)
Assert-Equal $true (& $rotationRecoveryRefusal -RotateDatabasePassword -ConfigureRecovery) 'Password rotation combined with recovery configuration must be refused.'
Assert-Equal $false (& $rotationRecoveryRefusal -RotateDatabasePassword) 'Password rotation on its own must not trip the recovery guard.'
Assert-Equal $false (& $rotationRecoveryRefusal -ConfigureRecovery) 'Recovery configuration on its own must not trip the rotation guard.'
Assert-Equal $false (& $rotationRecoveryRefusal) 'Ordinary redeployments must not trip the rotation/recovery guard.'
Assert-True (
  $rotationRecoveryGuard[0].Groups['message'].Value -match '-RotateDatabasePassword' -and
  $rotationRecoveryGuard[0].Groups['message'].Value -match '-ConfigureRecovery'
) 'The rotation/recovery refusal must name both switches so the operator knows to run them separately.'
Assert-True ($rotationRecoveryGuard[0].Index -lt $deploymentSource.IndexOf('$databaseReadiness = Resolve-DatabaseDeploymentReadiness')) 'The rotation/recovery refusal must run during parameter validation, before any deployment decision.'
$infrastructureDeployments = @([regex]::Matches(
  $deploymentSource,
  '(?s)Deploy-Infra `\s*(?<arguments>.+?)-RecoveryConfigurationVersion [^\r\n]+'
))
Assert-Equal 7 $infrastructureDeployments.Count 'All seven Deploy-Infra invocations must remain structurally identifiable (update this count when adding one and keep the egress invariants below).'
$switchDrivenRecoveryDeployments = @($infrastructureDeployments | Where-Object {
  $_.Groups['arguments'].Value -match '-ConfigurePostgresRecovery \(\[bool\]\$ConfigureRecovery\)'
})
Assert-Equal 1 $switchDrivenRecoveryDeployments.Count 'Exactly one deployment (the initial one, which attaches the bootstrap public IP) may configure PostgreSQL recovery from the -ConfigureRecovery switch.'
Assert-True ($switchDrivenRecoveryDeployments[0].Groups['arguments'].Value -match '-BootstrapPublicIp \$temporaryPublicIp `') 'The switch-driven recovery deployment must attach the temporary bootstrap public IP.'
$publicIpFreeRecoveryDeployments = @($infrastructureDeployments | Where-Object {
  $_.Groups['arguments'].Value -match '-BootstrapPublicIp \$false `' -and
  $_.Groups['arguments'].Value -notmatch '-ConfigurePostgresRecovery \$false `\s+-SimulatePostgresRecoveryFailure \$false `'
})
Assert-Equal 0 $publicIpFreeRecoveryDeployments.Count 'A deployment without the bootstrap public IP must never configure PostgreSQL recovery: its apt installs would ride default outbound access once the NAT gateway is gone.'
Assert-True ($deploymentSource -match 'Restore-PostgresSteadyStateEgress') 'The deployment path must invoke restrictive-egress restoration.'
Assert-True ($sharedSource -match "nsg rule delete[\s\S]+?AllowApprovedPackageSetup") 'Egress cleanup must modify only the temporary package rule.'
Assert-True ($sharedSource -match "DenyOtherInternetEgress[\s\S]+?destinationAddressPrefix -ne 'Internet'") 'Egress cleanup must verify the steady-state Internet deny rule.'
Assert-True ($deploymentSource -match 'Invoke-RotationFinalization') 'The deployment path must use compensated rotation finalization.'
Assert-True ($deploymentSource -match 'PostgresRotationPreviousRevision') 'Rotation state must retain the exact previous revision.'
Assert-True ($deploymentSource -match 'Resolve-RotationPreparation') 'Rotation must distinguish retained recovery state from a fresh candidate.'
Assert-True ($deploymentSource -match 'Invoke-AlreadyInitializedDatabaseRefusal') 'Already-initialized retries must run targeted cleanup before refusing.'
Assert-True ($deploymentSource -match 'Assert-ProtectedCurrentUserFileAcl') 'The production secret store must use the executable ACL helper.'
Assert-True ($deploymentSource -match 'Save-ProtectedSecureStringStore') 'The production secret store must use atomic protected replacement.'
Assert-True ($deploymentSource -match 'Enter-ProtectedSecretStoreOperation') 'The production workflow must acquire cross-process ownership.'
Assert-True ($deploymentSource -match '\$resolvedSecretsPath = \$secretStoreOperation\.Path') 'Secret access must use the stable final path protected by ownership.'
Assert-True ($deploymentSource -match 'Restore-CandidateOnlyDatabaseCredential') 'Legacy candidate-only state must use explicit credential reconciliation.'
Assert-True ($deploymentSource -match 'Resolve-DatabaseDeploymentReadiness') 'Rotation recovery must be selected before initialization health discovery.'
$operationAcquire = $deploymentSource.IndexOf('$secretStoreOperation = Enter-ProtectedSecretStoreOperation')
$secretImport = $deploymentSource.IndexOf('$store = Import-Clixml')
$firstAzureInvocation = $deploymentSource.IndexOf('az account show')
$operationRelease = $deploymentSource.LastIndexOf('Exit-ProtectedSecretStoreOperation')
Assert-True (
  $operationAcquire -ge 0 -and
  $operationAcquire -lt $secretImport -and
  $operationAcquire -lt $firstAzureInvocation
) 'Workflow ownership must be acquired before secret import and every Azure invocation.'
$releaseFromFinally = [regex]::Match(
  $deploymentSource,
  '(?ms)\}\s*finally\s*\{\s*Exit-ProtectedSecretStoreOperation \$secretStoreOperation\s*\}\s*$'
)
Assert-True ($operationRelease -gt $secretImport -and $releaseFromFinally.Success) 'Workflow ownership must be released from the top-level finally block.'
$candidateOnlyRecovery = [regex]::Match(
  $deploymentSource,
  '(?m)function Restore-CandidateOnlyDatabaseCredential\(\$CurrentApplication\) \{(?<body>[\s\S]+?)^}'
)
Assert-True $candidateOnlyRecovery.Success 'The candidate-only reconciliation function must remain structurally identifiable.'
$candidateOnlyBody = $candidateOnlyRecovery.Groups['body'].Value
Assert-True ($candidateOnlyBody -match '-RestorePostgresPassword \$true') 'Candidate-only recovery must restore the retained current credential to Key Vault.'
Assert-True ($candidateOnlyBody -match '-ReconcilePostgresPassword \$true') 'Candidate-only recovery must reconcile PostgreSQL to the retained current credential.'
Assert-True ($candidateOnlyBody -match '-CommitPostgresPassword \$false') 'Candidate-only recovery must not promote the candidate credential.'
Assert-True ($candidateOnlyBody -match '-ConfigurePostgresRecovery \$false `') 'Candidate-only recovery must not configure PostgreSQL recovery: it deploys without the bootstrap public IP, and -ConfigureRecovery is refused alongside -RotateDatabasePassword.'
Assert-True ($candidateOnlyBody -notmatch 'Restore-ContainerAppRevision') 'Candidate-only recovery must not guess or restore a prior revision.'
$candidateOnlyHealth = $candidateOnlyBody.IndexOf('Wait-AppHealth')
$candidateOnlyClearInfra = $candidateOnlyBody.IndexOf('Clear-RotationCandidateInfrastructure')
$candidateOnlyClearStore = $candidateOnlyBody.IndexOf('Complete-RotationSecretStore')
Assert-True (
  $candidateOnlyHealth -ge 0 -and
  $candidateOnlyClearInfra -gt $candidateOnlyHealth -and
  $candidateOnlyClearStore -gt $candidateOnlyClearInfra
) 'Candidate-only recovery must verify public database health before clearing infrastructure or local recovery state.'
Assert-True ($candidateOnlyBody -notmatch '\$ConfigureRecovery') 'Candidate-only recovery is unreachable with -ConfigureRecovery (refused with -RotateDatabasePassword) and must not carry recovery-only code.'
Assert-True ($candidateOnlyBody -notmatch 'configure-postgresql-recovery') 'Candidate-only recovery is unreachable with -ConfigureRecovery (refused with -RotateDatabasePassword) and must not read the recovery configuration run command.'
$rotationCommit = [regex]::Match(
  $deploymentSource,
  'Invoke-RotationFinalization\s+`\s+-Commit \{(?<body>[\s\S]+?)\}\s+`\s+-Verify'
)
Assert-True $rotationCommit.Success 'The rotation finalization commit block must remain structurally identifiable.'
Assert-True ($rotationCommit.Groups['body'].Value -match '-RotatePostgresPassword \$true') 'The database-changing rotation deployment must be inside compensated finalization.'
Assert-True ($rotationCommit.Groups['body'].Value -match '-CommitPostgresPassword \$true') 'The active secret and app rollout must share the same compensated finalization.'
$rotationCommitRecoveryArguments = @(
  [regex]::Matches($rotationCommit.Groups['body'].Value, '-ConfigurePostgresRecovery (?<value>[^`\r\n]+) `') |
    ForEach-Object { $_.Groups['value'].Value }
)
Assert-Equal 2 $rotationCommitRecoveryArguments.Count 'Both rotation deployments must remain structurally identifiable.'
Assert-Equal 0 @($rotationCommitRecoveryArguments | Where-Object { $_ -ne '$false' }).Count 'Rotation deployments must not configure PostgreSQL recovery: they run without the bootstrap public IP, and -ConfigureRecovery is refused alongside -RotateDatabasePassword.'
$rotationBranches = [regex]::Match(
  $deploymentSource,
  '(?s)if \(\$candidateOnlyRotationRecovery\) \{(?<body>.+?)\} else \{\s*Step ''Deploying private infrastructure'
)
Assert-True $rotationBranches.Success 'The rotation branches (candidate-only recovery and explicit rotation) must remain structurally identifiable ahead of the initial deployment path.'
Assert-True ($rotationBranches.Groups['body'].Value -notmatch '\$ConfigureRecovery') 'The rotation branches deploy without the bootstrap public IP; only the initial deployment may reference recovery configuration.'
Assert-True ($rotationBranches.Groups['body'].Value -notmatch 'configure-postgresql-recovery') 'The rotation branches deploy without the bootstrap public IP; only the initial deployment may read the recovery configuration run command.'

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
  Set-WindowsFileAccessControl -Path $aclPath -Security $protectedAcl
  Assert-ProtectedCurrentUserFileAcl $aclPath

  $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $foreignRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $administratorsSid,
    [Security.AccessControl.FileSystemRights]::Read,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$protectedAcl.AddAccessRule($foreignRule)
  Set-WindowsFileAccessControl -Path $aclPath -Security $protectedAcl
  try {
    Assert-ProtectedCurrentUserFileAcl $aclPath
    throw 'Expected foreign ACL rejection.'
  } catch {
    Assert-True ($_.Exception.Message -match 'not restricted') 'The ACL helper must reject a foreign allow rule.'
  }
} finally {
  Remove-Item -LiteralPath $aclPath -Force
}

$missingStorePath = Join-Path ([IO.Path]::GetTempPath()) "markdoc-missing-$([guid]::NewGuid().ToString('N')).clixml"
try {
  [void](Resolve-ProtectedSecretStoreOperationPath $missingStorePath)
  throw 'Expected missing production store rejection.'
} catch {
  Assert-True ($_.Exception.Message -match 'Production secrets store not found') 'A missing store must return an operator-facing error before ownership.'
}

function New-TestSecureString([int]$Length) {
  $value = New-Object Security.SecureString
  foreach ($index in 1..$Length) {
    $value.AppendChar([char](64 + (($index % 26) + 1)))
  }
  $value.MakeReadOnly()
  return $value
}

function New-TestSecretStore([int]$Offset) {
  return [pscustomobject]@{
    PostgresAdminPassword = New-TestSecureString (20 + $Offset)
    AuthSecret = New-TestSecureString (21 + $Offset)
    GitHubClientId = New-TestSecureString (22 + $Offset)
    GitHubClientSecret = New-TestSecureString (23 + $Offset)
    AlertEmailAddress = New-TestSecureString (24 + $Offset)
    VmAdminSshPublicKey = New-TestSecureString (25 + $Offset)
    PostgresCandidatePassword = New-TestSecureString (26 + $Offset)
    PostgresRotationPreviousImage = New-TestSecureString (27 + $Offset)
    PostgresRotationPreviousAppVersion = New-TestSecureString (28 + $Offset)
    PostgresRotationPreviousRevision = New-TestSecureString (29 + $Offset)
    PostgresRotationAppUrl = New-TestSecureString (30 + $Offset)
  }
}

function New-ProtectedTestStore([string]$Path, [object]$TestStore) {
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $file.Dispose()
  Set-ProtectedCurrentUserFileAcl $Path
  $TestStore | Export-Clixml -LiteralPath $Path -Force
  Assert-ProtectedCurrentUserFileAcl $Path
}

function Assert-OriginalTestStore([string]$Path) {
  Assert-ProtectedCurrentUserFileAcl $Path
  $original = Import-Clixml -LiteralPath $Path
  Assert-SecureStringStore -Store $original -ExpectedProperties @(
    'PostgresAdminPassword',
    'PostgresCandidatePassword',
    'PostgresRotationPreviousImage',
    'PostgresRotationPreviousAppVersion',
    'PostgresRotationPreviousRevision',
    'PostgresRotationAppUrl'
  )
  Assert-Equal 20 $original.PostgresAdminPassword.Length 'A failed replacement must retain the original active credential.'
  Assert-Equal 26 $original.PostgresCandidatePassword.Length 'A failed replacement must retain the original candidate.'
}

function Assert-NoSecretStoreArtifacts([string]$Directory, [string]$StoreName) {
  $artifacts = @(
    Get-ChildItem -LiteralPath $Directory -Force |
      Where-Object { $_.Name -ne $StoreName }
  )
  Assert-Equal 0 $artifacts.Count 'Atomic store replacement must remove generated sibling artifacts.'
}

function Start-PowerShellTestProcess([string]$ScriptPath, [string[]]$Arguments) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Process -Id $PID).Path
  $processArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $ScriptPath
  ) + $Arguments
  foreach ($argument in $processArguments) {
    if ($argument.Contains('"')) {
      throw 'Ownership test process arguments must not contain quotation marks.'
    }
  }
  $startInfo.Arguments = ($processArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw 'Could not start the cross-process ownership test worker.'
  }
  return $process
}

function Wait-TestPath([string]$Path, [Diagnostics.Process]$Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not [IO.File]::Exists($Path)) {
    if ($Process.HasExited) {
      $workerError = $Process.StandardError.ReadToEnd()
      throw "The ownership test worker exited before becoming ready: $workerError"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw 'Timed out waiting for the cross-process ownership test worker.'
    }
    Start-Sleep -Milliseconds 50
  }
}

function Wait-TestProcess([Diagnostics.Process]$Process) {
  if (-not $Process.WaitForExit(15000)) {
    $Process.Kill()
    $Process.WaitForExit()
    throw 'Timed out waiting for the cross-process ownership test worker to exit.'
  }
  return [pscustomobject]@{
    ExitCode = $Process.ExitCode
    StandardOutput = $Process.StandardOutput.ReadToEnd()
    StandardError = $Process.StandardError.ReadToEnd()
  }
}

function Enable-TestDirectoryCaseSensitivity([string]$Path) {
  $fsutil = Get-Command fsutil.exe -ErrorAction SilentlyContinue
  if (-not $fsutil) {
    return $false
  }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $fsutil.Source
  $startInfo.Arguments = "file setCaseSensitiveInfo `"$Path`" enable"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      return $false
    }
    $process.WaitForExit()
    return $process.ExitCode -eq 0
  } finally {
    $process.Dispose()
  }
}

$ownershipTestRoot = Join-Path ([IO.Path]::GetTempPath()) "markdoc-secret-ownership-tests-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $ownershipTestRoot)
$ownershipWorkerPath = Join-Path $ownershipTestRoot 'ownership-worker.ps1'
$ownershipWorkerSource = @'
param(
  [Parameter(Mandatory)]
  [string]$SafetyPath,
  [Parameter(Mandatory)]
  [string]$Mode,
  [Parameter(Mandatory)]
  [string]$StorePath,
  [string]$ReadyPath = '',
  [string]$ReleasePath = '',
  [string]$OperationPath = '',
  [string]$IdentityReadyPath = '',
  [string]$IdentityReleasePath = '',
  [string]$LocksReadyPath = '',
  [string]$LocksReleasePath = ''
)
$ErrorActionPreference = 'Stop'
. $SafetyPath
$originalGetMutexNames = ${function:Get-ProtectedSecretStoreOperationMutexNames}
$originalAssertIdentity = ${function:Assert-ProtectedSecretStoreOperationIdentity}
if ($IdentityReadyPath) {
  function Get-ProtectedSecretStoreOperationMutexNames {
    param([object]$ResolvedPath)
    [IO.File]::WriteAllText($IdentityReadyPath, 'ready')
    while (-not [IO.File]::Exists($IdentityReleasePath)) {
      Start-Sleep -Milliseconds 25
    }
    return & $originalGetMutexNames $ResolvedPath
  }
}
if ($LocksReadyPath) {
  function Assert-ProtectedSecretStoreOperationIdentity {
    param([object]$ResolvedPath)
    [IO.File]::WriteAllText($LocksReadyPath, 'ready')
    while (-not [IO.File]::Exists($LocksReleasePath)) {
      Start-Sleep -Milliseconds 25
    }
    & $originalAssertIdentity $ResolvedPath
  }
}
$ownership = $null
try {
  $ownership = Enter-ProtectedSecretStoreOperation $StorePath
  if ($ReadyPath) {
    [IO.File]::WriteAllText($ReadyPath, 'ready')
  }
  if ($Mode -eq 'Hold') {
    while (-not [IO.File]::Exists($ReleasePath)) {
      Start-Sleep -Milliseconds 50
    }
  } elseif ($Mode -eq 'Mutate') {
    [IO.File]::WriteAllText("$OperationPath.entered", 'entered')
    $store = Import-Clixml -LiteralPath $StorePath
    $store.PostgresCandidatePassword = $store.AuthSecret
    Save-ProtectedSecureStringStore -Path $StorePath -Store $store
    [IO.File]::WriteAllText("$OperationPath.azure", 'azure')
  } elseif ($Mode -eq 'Acquire') {
    $store = Import-Clixml -LiteralPath $ownership.Path
    if ($store.PostgresAdminPassword -isnot [Security.SecureString]) {
      throw 'The final protected I/O path could not import retained state.'
    }
    [IO.File]::WriteAllText($OperationPath, 'acquired')
  } elseif ($Mode -eq 'Recover') {
    $store = Import-Clixml -LiteralPath $StorePath
    if (
      -not $store.PSObject.Properties['PostgresCandidatePassword'] -or
      $store.PostgresCandidatePassword -isnot [Security.SecureString]
    ) {
      throw 'Retained recovery state was unavailable after abandoned ownership.'
    }
    [IO.File]::WriteAllText($OperationPath, [string]$ownership.RecoveredAbandonedOwner)
  } elseif ($Mode -eq 'Exception') {
    throw 'simulated owner exception'
  } else {
    throw "Unknown ownership test mode: $Mode"
  }
} finally {
  Exit-ProtectedSecretStoreOperation $ownership
}
'@
[IO.File]::WriteAllText($ownershipWorkerPath, $ownershipWorkerSource, [Text.UTF8Encoding]::new($false))

$ownershipProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$junctionAliasPath = ''
$symbolicLinkAliasPath = ''
$substDrive = ''
try {
  $sharedDirectory = Join-Path $ownershipTestRoot 'shared'
  [void](New-Item -ItemType Directory -Path $sharedDirectory)
  $sharedStorePath = Join-Path $sharedDirectory 'production.clixml'
  New-ProtectedTestStore -Path $sharedStorePath -TestStore (New-TestSecretStore 0)
  $holderReadyPath = Join-Path $sharedDirectory 'holder.ready'
  $holderReleasePath = Join-Path $sharedDirectory 'holder.release'
  $loserOperationPath = Join-Path $sharedDirectory 'loser'
  $holder = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Hold',
    '-StorePath', $sharedStorePath,
    '-ReadyPath', $holderReadyPath,
    '-ReleasePath', $holderReleasePath
  )
  $ownershipProcesses.Add($holder)
  Wait-TestPath $holderReadyPath $holder

  $globalMutexName = Get-ProtectedSecretStoreOperationMutexName $sharedStorePath
  Assert-True ($globalMutexName.StartsWith('Global\')) 'Ownership must use the cross-session Global namespace.'
  $globalHandle = [Threading.Mutex]::OpenExisting($globalMutexName)
  $globalHandle.Dispose()
  $localHandle = $null
  try {
    $localName = "Local\$($globalMutexName.Substring('Global\'.Length))"
    $localHandle = [Threading.Mutex]::OpenExisting($localName)
    throw 'Expected the session-local namespace to remain empty.'
  } catch {
    Assert-True (
      $_.Exception -is [Threading.WaitHandleCannotBeOpenedException] -or
      $_.Exception.InnerException -is [Threading.WaitHandleCannotBeOpenedException]
    ) 'The operation mutex must not resolve through the session-local namespace.'
  } finally {
    if ($localHandle) {
      $localHandle.Dispose()
    }
  }

  $resolvedSharedStore = Resolve-ProtectedSecretStoreOperationPath $sharedStorePath
  $currentSidText = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $expectedNameBytes = [Text.Encoding]::UTF8.GetBytes(
    "$currentSidText|LOCATION|$($resolvedSharedStore.Identity)"
  )
  $expectedNameHasher = [Security.Cryptography.SHA256]::Create()
  try {
    $expectedNameHash = $expectedNameHasher.ComputeHash($expectedNameBytes)
    $expectedName = "Global\Markdoc.AzureProduction.$([BitConverter]::ToString($expectedNameHash).Replace('-', ''))"
    Assert-Equal $expectedName $globalMutexName 'The operation identity must include the deployment SID and final filesystem path.'
  } finally {
    $expectedNameHasher.Dispose()
    [Array]::Clear($expectedNameBytes, 0, $expectedNameBytes.Length)
    if ($expectedNameHash) {
      [Array]::Clear($expectedNameHash, 0, $expectedNameHash.Length)
    }
  }
  $sharedMutexNames = @(Get-ProtectedSecretStoreOperationMutexNames $resolvedSharedStore)
  Assert-Equal 2 $sharedMutexNames.Count 'Protected-store ownership must include location and physical-file locks.'
  Assert-True ($sharedMutexNames[0] -ne $sharedMutexNames[1]) 'Location and physical-file ownership names must remain distinct.'
  Assert-True (
    [string]::CompareOrdinal($sharedMutexNames[0], $sharedMutexNames[1]) -lt 0
  ) 'Multiple ownership identities must be acquired in deterministic ordinal order.'

  $storeAliases = [Collections.Generic.List[object]]::new()
  $storeAliases.Add([pscustomobject]@{
    Name = 'normalized lexical'
    Path = [IO.Path]::Combine(
      [IO.Path]::GetDirectoryName($sharedStorePath),
      '.',
      [IO.Path]::GetFileName($sharedStorePath)
    ).ToUpperInvariant()
  })
  $storeAliases.Add([pscustomobject]@{
    Name = 'extended-length'
    Path = "\\?\$sharedStorePath"
  })

  $aliasDirectory = Join-Path $ownershipTestRoot 'aliases'
  [void](New-Item -ItemType Directory -Path $aliasDirectory)
  $junctionAliasPath = Join-Path $aliasDirectory 'shared-junction'
  [void](New-Item -ItemType Junction -Path $junctionAliasPath -Target $sharedDirectory)
  $storeAliases.Add([pscustomobject]@{
    Name = 'junction'
    Path = Join-Path $junctionAliasPath 'production.clixml'
  })

  $symbolicLinkAliasPath = Join-Path $aliasDirectory 'production-link.clixml'
  try {
    [void](New-Item -ItemType SymbolicLink -Path $symbolicLinkAliasPath -Target $sharedStorePath)
    $storeAliases.Add([pscustomobject]@{
      Name = 'symbolic-link'
      Path = $symbolicLinkAliasPath
    })
  } catch {
    $symbolicLinkAliasPath = ''
  }

  $shortPath = [MarkdocSecretStoreFileIdentity]::ReadShortPath($sharedStorePath)
  if ($shortPath -and $shortPath -ne $sharedStorePath) {
    $storeAliases.Add([pscustomobject]@{
      Name = 'short-name'
      Path = $shortPath
    })
  }

  foreach ($driveCode in 90..68) {
    $candidateDrive = [char]$driveCode
    if (-not (Test-Path -LiteralPath "${candidateDrive}:\")) {
      & subst.exe "${candidateDrive}:" $sharedDirectory
      if ($LASTEXITCODE -eq 0) {
        $substDrive = [string]$candidateDrive
        $storeAliases.Add([pscustomobject]@{
          Name = 'mapped-drive'
          Path = "${candidateDrive}:\production.clixml"
        })
        break
      }
    }
  }

  foreach ($alias in $storeAliases) {
    $aliasOperationPath = "$loserOperationPath-$($alias.Name)"
    $loser = Start-PowerShellTestProcess $ownershipWorkerPath @(
      '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
      '-Mode', 'Mutate',
      '-StorePath', $alias.Path,
      '-OperationPath', $aliasOperationPath
    )
    $ownershipProcesses.Add($loser)
    $loserResult = Wait-TestProcess $loser
    Assert-True ($loserResult.ExitCode -ne 0) "A $($alias.Name) alias must contend with the canonical store owner."
    Assert-True ($loserResult.StandardError -match 'Another Markdoc production operation owns this secrets store') 'Contention must return an explicit non-secret ownership error.'
    Assert-True (-not [IO.File]::Exists("$aliasOperationPath.entered")) 'The losing process must fail before importing or mutating secrets.'
    Assert-True (-not [IO.File]::Exists("$aliasOperationPath.azure")) 'The losing process must fail before invoking Azure operations.'
    Assert-OriginalTestStore $sharedStorePath
  }

  [IO.File]::WriteAllText($holderReleasePath, 'release')
  $holderResult = Wait-TestProcess $holder
  Assert-Equal 0 $holderResult.ExitCode 'The first owner must release normally.'

  $reacquiredPath = Join-Path $sharedDirectory 'reacquired'
  $reacquired = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Acquire',
    '-StorePath', $sharedStorePath,
    '-OperationPath', $reacquiredPath
  )
  $ownershipProcesses.Add($reacquired)
  $reacquiredResult = Wait-TestProcess $reacquired
  Assert-Equal 0 $reacquiredResult.ExitCode 'A later process must acquire after normal release.'
  Assert-True ([IO.File]::Exists($reacquiredPath)) 'Normal release must make the store available to the next process.'
  Assert-OriginalTestStore $sharedStorePath

  $abandonedDirectory = Join-Path $ownershipTestRoot 'abandoned'
  [void](New-Item -ItemType Directory -Path $abandonedDirectory)
  $abandonedStorePath = Join-Path $abandonedDirectory 'production.clixml'
  New-ProtectedTestStore -Path $abandonedStorePath -TestStore (New-TestSecretStore 0)
  $abandonedReadyPath = Join-Path $abandonedDirectory 'holder.ready'
  $abandonedReleasePath = Join-Path $abandonedDirectory 'holder.release'
  $abandonedHolder = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Hold',
    '-StorePath', $abandonedStorePath,
    '-ReadyPath', $abandonedReadyPath,
    '-ReleasePath', $abandonedReleasePath
  )
  $ownershipProcesses.Add($abandonedHolder)
  Wait-TestPath $abandonedReadyPath $abandonedHolder
  $guardian = [Threading.Mutex]::OpenExisting(
    (Get-ProtectedSecretStoreOperationMutexName $abandonedStorePath)
  )
  try {
    $abandonedHolder.Kill()
    $abandonedHolder.WaitForExit()
    $recoveryPath = Join-Path $abandonedDirectory 'recovered'
    $recovery = Start-PowerShellTestProcess $ownershipWorkerPath @(
      '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
      '-Mode', 'Recover',
      '-StorePath', $abandonedStorePath,
      '-OperationPath', $recoveryPath
    )
    $ownershipProcesses.Add($recovery)
    $recoveryResult = Wait-TestProcess $recovery
    Assert-Equal 0 $recoveryResult.ExitCode 'A later process must recover abandoned ownership.'
    Assert-Equal 'True' ([IO.File]::ReadAllText($recoveryPath)) 'Abandoned ownership must be recognized while retained state is recovered.'
    Assert-OriginalTestStore $abandonedStorePath
  } finally {
    $guardian.Dispose()
  }

  $exceptionDirectory = Join-Path $ownershipTestRoot 'exception'
  [void](New-Item -ItemType Directory -Path $exceptionDirectory)
  $exceptionStorePath = Join-Path $exceptionDirectory 'production.clixml'
  New-ProtectedTestStore -Path $exceptionStorePath -TestStore (New-TestSecretStore 0)
  $exceptionOwner = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Exception',
    '-StorePath', $exceptionStorePath
  )
  $ownershipProcesses.Add($exceptionOwner)
  $exceptionResult = Wait-TestProcess $exceptionOwner
  Assert-True ($exceptionResult.ExitCode -ne 0) 'An owner exception must remain explicit.'
  Assert-True ($exceptionResult.StandardError -match 'simulated owner exception') 'The owner exception must not be hidden by release.'
  $afterExceptionPath = Join-Path $exceptionDirectory 'reacquired'
  $afterException = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Acquire',
    '-StorePath', $exceptionStorePath,
    '-OperationPath', $afterExceptionPath
  )
  $ownershipProcesses.Add($afterException)
  $afterExceptionResult = Wait-TestProcess $afterException
  Assert-Equal 0 $afterExceptionResult.ExitCode 'The finally path must release ownership after an exception.'
  Assert-True ([IO.File]::Exists($afterExceptionPath)) 'Exception release must allow the next process to enter.'
  Assert-OriginalTestStore $exceptionStorePath

  $independentDirectory = Join-Path $ownershipTestRoot 'independent'
  [void](New-Item -ItemType Directory -Path $independentDirectory)
  $firstStorePath = Join-Path $independentDirectory 'first.clixml'
  $secondStorePath = Join-Path $independentDirectory 'second.clixml'
  New-ProtectedTestStore -Path $firstStorePath -TestStore (New-TestSecretStore 0)
  New-ProtectedTestStore -Path $secondStorePath -TestStore (New-TestSecretStore 0)
  $independentReadyPath = Join-Path $independentDirectory 'holder.ready'
  $independentReleasePath = Join-Path $independentDirectory 'holder.release'
  $firstHolder = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Hold',
    '-StorePath', $firstStorePath,
    '-ReadyPath', $independentReadyPath,
    '-ReleasePath', $independentReleasePath
  )
  $ownershipProcesses.Add($firstHolder)
  Wait-TestPath $independentReadyPath $firstHolder
  $independentAcquirePath = Join-Path $independentDirectory 'second-acquired'
  $independentAcquire = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Acquire',
    '-StorePath', $secondStorePath,
    '-OperationPath', $independentAcquirePath
  )
  $ownershipProcesses.Add($independentAcquire)
  $independentResult = Wait-TestProcess $independentAcquire
  Assert-Equal 0 $independentResult.ExitCode 'Distinct protected stores must not share workflow ownership.'
  Assert-True ([IO.File]::Exists($independentAcquirePath)) 'A distinct store must be independently available.'
  [IO.File]::WriteAllText($independentReleasePath, 'release')
  $firstHolderResult = Wait-TestProcess $firstHolder
  Assert-Equal 0 $firstHolderResult.ExitCode 'The distinct-store holder must release normally.'
  Assert-OriginalTestStore $firstStorePath
  Assert-OriginalTestStore $secondStorePath

  $hardLinkDirectory = Join-Path $ownershipTestRoot 'hard-link'
  [void](New-Item -ItemType Directory -Path $hardLinkDirectory)
  $hardLinkStorePath = Join-Path $hardLinkDirectory 'production.clixml'
  $hardLinkAliasPath = Join-Path $hardLinkDirectory 'production-alias.clixml'
  New-ProtectedTestStore -Path $hardLinkStorePath -TestStore (New-TestSecretStore 0)
  [void](New-Item -ItemType HardLink -Path $hardLinkAliasPath -Target $hardLinkStorePath)
  try {
    [void](Enter-ProtectedSecretStoreOperation $hardLinkAliasPath)
    throw 'Expected hard-link alias rejection.'
  } catch {
    Assert-True ($_.Exception.Message -match 'must not have hard-link aliases') 'Hard-link aliases must be rejected before ownership or secret access.'
  }
  Assert-OriginalTestStore $hardLinkStorePath

  $raceDirectory = Join-Path $ownershipTestRoot 'rename-hard-link-race'
  [void](New-Item -ItemType Directory -Path $raceDirectory)
  $raceOriginalPath = Join-Path $raceDirectory 'original.clixml'
  $raceRenamedPath = Join-Path $raceDirectory 'renamed.clixml'
  New-ProtectedTestStore -Path $raceOriginalPath -TestStore (New-TestSecretStore 0)
  $raceOriginalIdentity = Resolve-ProtectedSecretStoreOperationPath $raceOriginalPath
  $raceOriginalLocationMutex = Get-ProtectedSecretStoreOperationMutexName $raceOriginalPath
  $raceOriginalPhysicalMutex = @(
    Get-ProtectedSecretStoreOperationMutexNames $raceOriginalIdentity |
      Where-Object { $_ -ne $raceOriginalLocationMutex }
  )[0]
  $firstIdentityReady = Join-Path $raceDirectory 'first.identity-ready'
  $firstIdentityRelease = Join-Path $raceDirectory 'first.identity-release'
  $firstLocksReady = Join-Path $raceDirectory 'first.locks-ready'
  $firstLocksRelease = Join-Path $raceDirectory 'first.locks-release'
  $firstRaceOperation = Join-Path $raceDirectory 'first-operation'
  $firstRacer = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Mutate',
    '-StorePath', $raceOriginalPath,
    '-OperationPath', $firstRaceOperation,
    '-IdentityReadyPath', $firstIdentityReady,
    '-IdentityReleasePath', $firstIdentityRelease,
    '-LocksReadyPath', $firstLocksReady,
    '-LocksReleasePath', $firstLocksRelease
  )
  $ownershipProcesses.Add($firstRacer)
  Wait-TestPath $firstIdentityReady $firstRacer
  Move-Item -LiteralPath $raceOriginalPath -Destination $raceRenamedPath
  $raceRenamedIdentity = Resolve-ProtectedSecretStoreOperationPath $raceRenamedPath
  $raceRenamedLocationMutex = Get-ProtectedSecretStoreOperationMutexName $raceRenamedPath
  $raceRenamedPhysicalMutex = @(
    Get-ProtectedSecretStoreOperationMutexNames $raceRenamedIdentity |
      Where-Object { $_ -ne $raceRenamedLocationMutex }
  )[0]
  Assert-True ($raceOriginalLocationMutex -ne $raceRenamedLocationMutex) 'The rename race must resolve distinct location ownership names.'
  Assert-Equal $raceOriginalPhysicalMutex $raceRenamedPhysicalMutex 'The rename race must resolve one common physical-file ownership name.'

  $secondIdentityReady = Join-Path $raceDirectory 'second.identity-ready'
  $secondIdentityRelease = Join-Path $raceDirectory 'second.identity-release'
  $secondRaceOperation = Join-Path $raceDirectory 'second-operation'
  $secondRacer = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Mutate',
    '-StorePath', $raceRenamedPath,
    '-OperationPath', $secondRaceOperation,
    '-IdentityReadyPath', $secondIdentityReady,
    '-IdentityReleasePath', $secondIdentityRelease
  )
  $ownershipProcesses.Add($secondRacer)
  Wait-TestPath $secondIdentityReady $secondRacer
  [void](New-Item -ItemType HardLink -Path $raceOriginalPath -Target $raceRenamedPath)

  [IO.File]::WriteAllText($firstIdentityRelease, 'release')
  Wait-TestPath $firstLocksReady $firstRacer
  [IO.File]::WriteAllText($secondIdentityRelease, 'release')
  $secondRaceResult = Wait-TestProcess $secondRacer
  Assert-True ($secondRaceResult.ExitCode -ne 0) 'A renamed alias must contend on the common physical-file ownership.'
  Assert-True ($secondRaceResult.StandardError -match 'Another Markdoc production operation owns this secrets store') 'The physical-file race loser must return the ownership refusal.'
  Assert-True (-not [IO.File]::Exists("$secondRaceOperation.entered")) 'The physical-file race loser must not enter or mutate.'

  [IO.File]::WriteAllText($firstLocksRelease, 'release')
  $firstRaceResult = Wait-TestProcess $firstRacer
  Assert-True ($firstRaceResult.ExitCode -ne 0) 'The race winner must reject the changed location and link count during revalidation.'
  Assert-True ($firstRaceResult.StandardError -match 'identity changed while ownership was being acquired') 'The race winner must return an explicit identity-change refusal.'
  Assert-True (-not [IO.File]::Exists("$firstRaceOperation.entered")) 'The revalidation failure must occur before secret import or mutation.'
  Assert-OriginalTestStore $raceRenamedPath

  $renameDirectory = Join-Path $ownershipTestRoot 'revalidate-rename'
  [void](New-Item -ItemType Directory -Path $renameDirectory)
  $renameStorePath = Join-Path $renameDirectory 'production.clixml'
  $renamedStorePath = Join-Path $renameDirectory 'moved.clixml'
  New-ProtectedTestStore -Path $renameStorePath -TestStore (New-TestSecretStore 0)
  $renameIdentityReady = Join-Path $renameDirectory 'identity-ready'
  $renameIdentityRelease = Join-Path $renameDirectory 'identity-release'
  $renameOperationPath = Join-Path $renameDirectory 'operation'
  $renameWorker = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Mutate',
    '-StorePath', $renameStorePath,
    '-OperationPath', $renameOperationPath,
    '-IdentityReadyPath', $renameIdentityReady,
    '-IdentityReleasePath', $renameIdentityRelease
  )
  $ownershipProcesses.Add($renameWorker)
  Wait-TestPath $renameIdentityReady $renameWorker
  Move-Item -LiteralPath $renameStorePath -Destination $renamedStorePath
  [IO.File]::WriteAllText($renameIdentityRelease, 'release')
  $renameResult = Wait-TestProcess $renameWorker
  Assert-True ($renameResult.ExitCode -ne 0) 'A rename after resolution must fail revalidation.'
  Assert-True ($renameResult.StandardError -match 'identity changed while ownership was being acquired') 'A rename after resolution must return the explicit identity-change refusal.'
  Assert-True (-not [IO.File]::Exists("$renameOperationPath.entered")) 'Rename revalidation must fail before secret import or mutation.'
  Assert-OriginalTestStore $renamedStorePath

  $replacementDirectory = Join-Path $ownershipTestRoot 'revalidate-replacement'
  [void](New-Item -ItemType Directory -Path $replacementDirectory)
  $replacementStorePath = Join-Path $replacementDirectory 'production.clixml'
  $replacementCandidatePath = Join-Path $replacementDirectory 'candidate.clixml'
  $replacementBackupPath = Join-Path $replacementDirectory 'backup.clixml'
  New-ProtectedTestStore -Path $replacementStorePath -TestStore (New-TestSecretStore 0)
  New-ProtectedTestStore -Path $replacementCandidatePath -TestStore (New-TestSecretStore 10)
  $replacementIdentityReady = Join-Path $replacementDirectory 'identity-ready'
  $replacementIdentityRelease = Join-Path $replacementDirectory 'identity-release'
  $replacementOperationPath = Join-Path $replacementDirectory 'operation'
  $replacementWorker = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Mutate',
    '-StorePath', $replacementStorePath,
    '-OperationPath', $replacementOperationPath,
    '-IdentityReadyPath', $replacementIdentityReady,
    '-IdentityReleasePath', $replacementIdentityRelease
  )
  $ownershipProcesses.Add($replacementWorker)
  Wait-TestPath $replacementIdentityReady $replacementWorker
  [IO.File]::Replace(
    $replacementCandidatePath,
    $replacementStorePath,
    $replacementBackupPath,
    $true
  )
  [IO.File]::WriteAllText($replacementIdentityRelease, 'release')
  $replacementResult = Wait-TestProcess $replacementWorker
  Assert-True ($replacementResult.ExitCode -ne 0) 'A replacement after resolution must fail revalidation.'
  Assert-True ($replacementResult.StandardError -match 'identity changed while ownership was being acquired') 'A replacement after resolution must return the explicit identity-change refusal.'
  Assert-True (-not [IO.File]::Exists("$replacementOperationPath.entered")) 'Replacement revalidation must fail before secret import or mutation.'
  Assert-ProtectedCurrentUserFileAcl $replacementStorePath
  $replacementStore = Import-Clixml -LiteralPath $replacementStorePath
  Assert-Equal 30 $replacementStore.PostgresAdminPassword.Length 'The replacement test must leave the distinct replacement file at the canonical path.'

  $newLinkDirectory = Join-Path $ownershipTestRoot 'revalidate-new-link'
  [void](New-Item -ItemType Directory -Path $newLinkDirectory)
  $newLinkStorePath = Join-Path $newLinkDirectory 'production.clixml'
  $newLinkAliasPath = Join-Path $newLinkDirectory 'alias.clixml'
  New-ProtectedTestStore -Path $newLinkStorePath -TestStore (New-TestSecretStore 0)
  $newLinkIdentityReady = Join-Path $newLinkDirectory 'identity-ready'
  $newLinkIdentityRelease = Join-Path $newLinkDirectory 'identity-release'
  $newLinkOperationPath = Join-Path $newLinkDirectory 'operation'
  $newLinkWorker = Start-PowerShellTestProcess $ownershipWorkerPath @(
    '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-Mode', 'Mutate',
    '-StorePath', $newLinkStorePath,
    '-OperationPath', $newLinkOperationPath,
    '-IdentityReadyPath', $newLinkIdentityReady,
    '-IdentityReleasePath', $newLinkIdentityRelease
  )
  $ownershipProcesses.Add($newLinkWorker)
  Wait-TestPath $newLinkIdentityReady $newLinkWorker
  [void](New-Item -ItemType HardLink -Path $newLinkAliasPath -Target $newLinkStorePath)
  [IO.File]::WriteAllText($newLinkIdentityRelease, 'release')
  $newLinkResult = Wait-TestProcess $newLinkWorker
  Assert-True ($newLinkResult.ExitCode -ne 0) 'A hard link added after resolution must fail revalidation.'
  Assert-True ($newLinkResult.StandardError -match 'identity changed while ownership was being acquired') 'A new hard link must return the explicit identity-change refusal.'
  Assert-True (-not [IO.File]::Exists("$newLinkOperationPath.entered")) 'Hard-link revalidation must fail before secret import or mutation.'
  Assert-OriginalTestStore $newLinkStorePath

  $caseSensitiveDirectory = Join-Path $ownershipTestRoot 'case-sensitive'
  [void](New-Item -ItemType Directory -Path $caseSensitiveDirectory)
  if (Enable-TestDirectoryCaseSensitivity $caseSensitiveDirectory) {
    $lowerCaseStorePath = Join-Path $caseSensitiveDirectory 'store.clixml'
    $upperCaseStorePath = Join-Path $caseSensitiveDirectory 'STORE.clixml'
    New-ProtectedTestStore -Path $lowerCaseStorePath -TestStore (New-TestSecretStore 0)
    New-ProtectedTestStore -Path $upperCaseStorePath -TestStore (New-TestSecretStore 10)
    $lowerCaseMutexName = Get-ProtectedSecretStoreOperationMutexName $lowerCaseStorePath
    $upperCaseMutexName = Get-ProtectedSecretStoreOperationMutexName $upperCaseStorePath
    Assert-True ($lowerCaseMutexName -ne $upperCaseMutexName) 'Case-distinct files in a case-sensitive directory must have distinct location ownership.'

    $caseHolderReady = Join-Path $caseSensitiveDirectory 'holder.ready'
    $caseHolderRelease = Join-Path $caseSensitiveDirectory 'holder.release'
    $caseHolder = Start-PowerShellTestProcess $ownershipWorkerPath @(
      '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
      '-Mode', 'Hold',
      '-StorePath', $lowerCaseStorePath,
      '-ReadyPath', $caseHolderReady,
      '-ReleasePath', $caseHolderRelease
    )
    $ownershipProcesses.Add($caseHolder)
    Wait-TestPath $caseHolderReady $caseHolder
    $caseAcquirePath = Join-Path $caseSensitiveDirectory 'upper-acquired'
    $caseAcquire = Start-PowerShellTestProcess $ownershipWorkerPath @(
      '-SafetyPath', (Join-Path $PSScriptRoot 'azure-safety.ps1'),
      '-Mode', 'Acquire',
      '-StorePath', $upperCaseStorePath,
      '-OperationPath', $caseAcquirePath
    )
    $ownershipProcesses.Add($caseAcquire)
    $caseAcquireResult = Wait-TestProcess $caseAcquire
    Assert-Equal 0 $caseAcquireResult.ExitCode 'Case-distinct protected stores must operate independently.'
    Assert-True ([IO.File]::Exists($caseAcquirePath)) 'The second case-distinct store must acquire while the first is owned.'
    [IO.File]::WriteAllText($caseHolderRelease, 'release')
    $caseHolderResult = Wait-TestProcess $caseHolder
    Assert-Equal 0 $caseHolderResult.ExitCode 'The case-sensitive store holder must release normally.'
    Assert-OriginalTestStore $lowerCaseStorePath
    Assert-ProtectedCurrentUserFileAcl $upperCaseStorePath
    $upperCaseStore = Import-Clixml -LiteralPath $upperCaseStorePath
    Assert-Equal 30 $upperCaseStore.PostgresAdminPassword.Length 'The case-distinct store must retain independent data.'
  } elseif ($RequireCaseSensitiveOwnership) {
    throw 'Case-sensitive protected-store ownership is required but unavailable on this host.'
  } else {
    Write-Host 'case-sensitive ownership test: skipped (directory case sensitivity unavailable)'
  }

  $precreatedDirectory = Join-Path $ownershipTestRoot 'precreated'
  [void](New-Item -ItemType Directory -Path $precreatedDirectory)
  $precreatedStorePath = Join-Path $precreatedDirectory 'production.clixml'
  New-ProtectedTestStore -Path $precreatedStorePath -TestStore (New-TestSecretStore 0)
  $precreatedName = Get-ProtectedSecretStoreOperationMutexName $precreatedStorePath
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $hostileSecurity = [Security.AccessControl.MutexSecurity]::new()
  $hostileSecurity.SetAccessRuleProtection($true, $false)
  $hostileSecurity.SetOwner($currentSid)
  [void]$hostileSecurity.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
    $currentSid,
    [Security.AccessControl.MutexRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  ))
  [void]$hostileSecurity.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
    $usersSid,
    [Security.AccessControl.MutexRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  ))
  $hostileCreated = $false
  $hostileMutex = New-NamedMutexWithSecurity `
    -Name $precreatedName `
    -Security $hostileSecurity `
    -CreatedNew ([ref]$hostileCreated)
  try {
    Assert-True $hostileCreated 'The hostile-precreation test must own a new deterministic name.'
    try {
      [void](Enter-ProtectedSecretStoreOperation $precreatedStorePath)
      throw 'Expected hostile pre-created ownership rejection.'
    } catch {
      Assert-True ($_.Exception.Message -match 'not restricted to the current Windows user') 'A foreign-accessible pre-created lock must fail closed.'
    }
  } finally {
    $hostileMutex.Dispose()
  }

  $localServiceSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
  $denyingSecurity = [Security.AccessControl.MutexSecurity]::new()
  $denyingSecurity.SetAccessRuleProtection($true, $false)
  $denyingSecurity.SetOwner($currentSid)
  [void]$denyingSecurity.AddAccessRule([Security.AccessControl.MutexAccessRule]::new(
    $localServiceSid,
    [Security.AccessControl.MutexRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  ))
  $denyingCreated = $false
  $denyingMutex = New-NamedMutexWithSecurity `
    -Name $precreatedName `
    -Security $denyingSecurity `
    -CreatedNew ([ref]$denyingCreated)
  try {
    Assert-True $denyingCreated 'The denial-precreation test must own a new deterministic name.'
    try {
      [void](Enter-ProtectedSecretStoreOperation $precreatedStorePath)
      throw 'Expected inaccessible pre-created ownership rejection.'
    } catch {
      Assert-True (
        $_.Exception -is [UnauthorizedAccessException] -or
        $_.Exception.InnerException -is [UnauthorizedAccessException] -or
        $_.Exception.Message -match 'access.*denied'
      ) 'An inaccessible pre-created lock must fail closed.'
    }
  } finally {
    $denyingMutex.Dispose()
  }

  $postHostileOwnership = Enter-ProtectedSecretStoreOperation $precreatedStorePath
  Exit-ProtectedSecretStoreOperation $postHostileOwnership
  Assert-OriginalTestStore $precreatedStorePath
} finally {
  foreach ($process in $ownershipProcesses) {
    if (-not $process.HasExited) {
      $process.Kill()
      $process.WaitForExit()
    }
    $process.Dispose()
  }
  if ($substDrive) {
    & subst.exe "${substDrive}:" /D
  }
  if ($symbolicLinkAliasPath -and (Test-Path -LiteralPath $symbolicLinkAliasPath)) {
    [IO.File]::Delete($symbolicLinkAliasPath)
  }
  if ($junctionAliasPath -and (Test-Path -LiteralPath $junctionAliasPath)) {
    [IO.Directory]::Delete($junctionAliasPath)
  }
  Remove-Item -LiteralPath $ownershipTestRoot -Recurse -Force
}

$storeTestRoot = Join-Path ([IO.Path]::GetTempPath()) "markdoc-secret-store-tests-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $storeTestRoot)
try {
  foreach ($case in @(
    'success',
    'export-failure',
    'validation-failure',
    'post-replacement-validation-failure',
    'replacement-failure',
    'replacement-post-swap-failure'
  )) {
    $caseDirectory = Join-Path $storeTestRoot $case
    [void](New-Item -ItemType Directory -Path $caseDirectory)
    $casePath = Join-Path $caseDirectory 'production.clixml'
    New-ProtectedTestStore -Path $casePath -TestStore (New-TestSecretStore 0)
    $replacement = New-TestSecretStore 10

    if ($case -eq 'success') {
      Save-ProtectedSecureStringStore -Path $casePath -Store $replacement
      Assert-ProtectedCurrentUserFileAcl $casePath
      $saved = Import-Clixml -LiteralPath $casePath
      Assert-Equal 30 $saved.PostgresAdminPassword.Length 'Successful replacement must persist the complete new store.'
      Assert-Equal 36 $saved.PostgresCandidatePassword.Length 'Successful replacement must persist new recovery state.'
    } else {
      try {
        if ($case -eq 'export-failure') {
          Save-ProtectedSecureStringStore -Path $casePath -Store $replacement -ExportStore {
            throw 'simulated export failure'
          }
        } elseif ($case -eq 'validation-failure') {
          Save-ProtectedSecureStringStore -Path $casePath -Store $replacement -ImportStore {
            [pscustomobject]@{ PostgresAdminPassword = 'not-secure' }
          }
        } elseif ($case -eq 'post-replacement-validation-failure') {
          $importCalls = [Collections.Generic.List[int]]::new()
          Save-ProtectedSecureStringStore -Path $casePath -Store $replacement -ImportStore {
            param([string]$InputPath)
            [void]$importCalls.Add(1)
            if ($importCalls.Count -eq 1) {
              return Import-Clixml -LiteralPath $InputPath
            }
            return [pscustomobject]@{ PostgresAdminPassword = 'not-secure' }
          }
        } elseif ($case -eq 'replacement-failure') {
          Save-ProtectedSecureStringStore -Path $casePath -Store $replacement -ReplaceFile {
            throw 'simulated replacement failure'
          }
        } else {
          Save-ProtectedSecureStringStore -Path $casePath -Store $replacement -ReplaceFile {
            param([string]$SourcePath, [string]$DestinationPath, [string]$BackupPath)
            [IO.File]::Replace($SourcePath, $DestinationPath, $BackupPath, $true)
            throw 'simulated failure after replacement'
          }
        }
        throw "MISSING-REFUSAL:$case"
      } catch {
        Assert-True ($_.Exception.Message -notmatch 'MISSING-REFUSAL') "$case must not succeed."
        Assert-True ($_.Exception.Message -match 'failure|SecureString') "$case must surface an explicit failure."
      }
      Assert-OriginalTestStore $casePath
    }
    Assert-NoSecretStoreArtifacts -Directory $caseDirectory -StoreName 'production.clixml'
  }
} finally {
  Remove-Item -LiteralPath $storeTestRoot -Recurse -Force
}

$events = [Collections.Generic.List[string]]::new()
$retained = Resolve-RotationPreparation `
  -HasRetainedCandidate $true `
  -HasCompleteRecoveryMetadata $true `
  -LoadRetainedCandidate { $events.Add('load-retained'); 'retained-state' } `
  -LoadCandidateOnlyRecovery { $events.Add('load-candidate-only'); throw 'Complete state must not use legacy reconciliation.' } `
  -GetFreshContext { $events.Add('get-fresh'); throw 'Fresh context must not be read.' } `
  -AssertFreshRevisionHealthy { $events.Add('health'); throw 'Old app health must not gate retained state.' } `
  -CreateFreshCandidate { $events.Add('create'); throw 'A retained candidate must not be replaced.' }
Assert-Equal 'retained-state' $retained 'A retained candidate must be returned for reconciliation.'
Assert-Equal 'load-retained' ($events -join ',') 'Retained candidate recovery must run before app health.'

$events.Clear()
$legacy = Resolve-RotationPreparation `
  -HasRetainedCandidate $true `
  -HasCompleteRecoveryMetadata $false `
  -LoadRetainedCandidate { $events.Add('load-retained'); throw 'Candidate-only state has no exact prior revision.' } `
  -LoadCandidateOnlyRecovery { $events.Add('reconcile-candidate-only'); 'candidate-only-state' } `
  -GetFreshContext { $events.Add('get-fresh'); throw 'Fresh context must not be read.' } `
  -AssertFreshRevisionHealthy { $events.Add('health'); throw 'Old app health must not gate candidate-only recovery.' } `
  -CreateFreshCandidate { $events.Add('create'); throw 'A legacy candidate must never be overwritten.' }
Assert-Equal 'candidate-only-state' $legacy 'Legacy current-plus-candidate state must select reconciliation.'
Assert-Equal 'reconcile-candidate-only' ($events -join ',') 'Legacy state must bypass fresh creation and old-app health.'

$events.Clear()
try {
  Resolve-RotationPreparation `
    -HasRetainedCandidate $false `
    -HasCompleteRecoveryMetadata $false `
    -LoadRetainedCandidate { $events.Add('load-retained') } `
    -LoadCandidateOnlyRecovery { $events.Add('load-candidate-only') } `
    -GetFreshContext { $events.Add('get-fresh'); 'fresh-context' } `
    -AssertFreshRevisionHealthy { param($context) $events.Add("health-$context"); throw 'old app unhealthy' } `
    -CreateFreshCandidate { $events.Add('create') }
  throw 'Expected unhealthy fresh preflight.'
} catch {
  Assert-Equal 'old app unhealthy' $_.Exception.Message 'Fresh rotation must preserve the health preflight failure.'
}
Assert-Equal 'get-fresh,health-fresh-context' ($events -join ',') 'Fresh unhealthy preflight must refuse before candidate creation.'

$events.Clear()
foreach ($retainedCase in @('missing-extension', 'updating-extension', 'extension-query-failure', 'unhealthy-old-app')) {
  $events.Clear()
  $readiness = Resolve-DatabaseDeploymentReadiness `
    -PostgresVmExists $true `
    -InitializeDatabase $false `
    -RotateDatabasePassword $true `
    -HasRetainedCandidate $true `
    -GetExtensionState {
      $events.Add("extension-$retainedCase")
      throw 'Retained recovery must not query initialization state.'
    } `
    -GetExistingAppHealth {
      $events.Add("health-$retainedCase")
      throw 'Retained recovery must not query old-app health.'
    }
  Assert-Equal 'Recovery' $readiness.Mode "$retainedCase retained state must enter recovery."
  Assert-Equal '' ($events -join ',') "$retainedCase retained state must bypass initialization and health gates."
}

foreach ($freshCase in @(
  @{ Name = 'missing-extension'; ExitCode = 0; State = '' },
  @{ Name = 'updating-extension'; ExitCode = 0; State = 'Updating' },
  @{ Name = 'extension-query-failure'; ExitCode = 1; State = '' },
  @{ Name = 'unhealthy-old-app'; ExitCode = 0; State = 'Failed' }
)) {
  $events.Clear()
  try {
    Resolve-DatabaseDeploymentReadiness `
      -PostgresVmExists $true `
      -InitializeDatabase $false `
      -RotateDatabasePassword $true `
      -HasRetainedCandidate $false `
      -GetExtensionState {
        $events.Add("extension-$($freshCase.Name)")
        [pscustomobject]@{
          ExitCode = $freshCase.ExitCode
          State = $freshCase.State
        }
      } `
      -GetExistingAppHealth {
        $events.Add("health-$($freshCase.Name)")
        return $false
      }
    $events.Add('create-candidate')
    throw "Expected $($freshCase.Name) refusal."
  } catch {
    Assert-True ($_.Exception.Message -match 'initialization|extension') "$($freshCase.Name) must fail closed."
  }
  Assert-True (-not $events.Contains('create-candidate')) "$($freshCase.Name) must refuse before creating rotation state."
  if ($freshCase.ExitCode -ne 0) {
    Assert-True (-not $events.Contains("health-$($freshCase.Name)")) 'An extension query error must not be converted into a health inference.'
  }
}

$events.Clear()
try {
  Resolve-DatabaseDeploymentReadiness `
    -PostgresVmExists $true `
    -InitializeDatabase $false `
    -RotateDatabasePassword $true `
    -HasRetainedCandidate $false `
    -GetExtensionState {
      [pscustomobject]@{ ExitCode = 0; State = 'Updating' }
    } `
    -GetExistingAppHealth {
      $false
      $true
    }
  throw 'MISSING-REFUSAL:ambiguous-health'
} catch {
  Assert-True ($_.Exception.Message -match 'one explicit boolean') 'Initialization health inference must fail closed on ambiguous output.'
}

$readiness = Resolve-DatabaseDeploymentReadiness `
  -PostgresVmExists $true `
  -InitializeDatabase $true `
  -RotateDatabasePassword $false `
  -HasRetainedCandidate $false `
  -GetExtensionState {
    [pscustomobject]@{ ExitCode = 0; State = '' }
  } `
  -GetExistingAppHealth { return $false }
Assert-Equal 'Initialize' $readiness.Mode 'An interrupted first provision with no extension or app must remain resumable explicitly.'

$events.Clear()
try {
  Resolve-DatabaseDeploymentReadiness `
    -PostgresVmExists $true `
    -InitializeDatabase $false `
    -RotateDatabasePassword $false `
    -HasRetainedCandidate $true `
    -GetExtensionState { $events.Add('extension') } `
    -GetExistingAppHealth { $events.Add('health') }
  throw 'MISSING-REFUSAL:retained-without-rotation'
} catch {
  Assert-True ($_.Exception.Message -match 'requires -RotateDatabasePassword') 'Retained recovery state must refuse an ordinary deployment.'
}
Assert-Equal '' ($events -join ',') 'Retained state must refuse an ordinary deployment before initialization discovery.'

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

# Monthly OS security patch window: deploy/patch-postgres-vm.ps1 + infra/patch-os.sh (docs/postgres-patching.md).
$patchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'patch-postgres-vm.ps1') -Raw
$guestSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'patch-os.sh')) -Raw
$templateSource = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'main.bicep')) -Raw
foreach ($helper in 'Remove-BootstrapPublicIp', 'Get-PostgresNetworkRuleNames', 'Restore-PostgresSteadyStateEgress', 'Get-ManagedRunCommandResult') {
  $definitions = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | Where-Object {
    (Get-Content -LiteralPath $_.FullName -Raw) -match "(?m)^function $([regex]::Escape($helper))\b"
  })
  Assert-Equal 'azure-postgres-network.ps1' (@($definitions | ForEach-Object { $_.Name }) -join ',') "The helper $helper must be defined exactly once across deploy/*.ps1, in the shared azure-postgres-network.ps1, so deployment and patch windows share one definition of the steady state."
}
foreach ($consumer in @(@{ Name = 'azure.ps1'; Source = $deploymentSource }, @{ Name = 'patch-postgres-vm.ps1'; Source = $patchSource })) {
  $safetyImport = $consumer.Source.IndexOf(". (Join-Path `$PSScriptRoot 'azure-safety.ps1')")
  $helperImport = $consumer.Source.IndexOf(". (Join-Path `$PSScriptRoot 'azure-postgres-network.ps1')")
  Assert-True ($safetyImport -ge 0 -and $helperImport -gt $safetyImport) "$($consumer.Name) must dot-source azure-postgres-network.ps1 right after azure-safety.ps1 so the shared helpers resolve `$Name and `$ResourceGroup from its param block."
}
$patchGuards = [regex]::Matches(
  $patchSource,
  '(?m)^if \((?<condition>[^\r\n]+)\) \{\r?\n\s*throw ''(?<message>[^'']+)''\r?\n\}'
)
$rollbackFullGuard = @($patchGuards | Where-Object {
  $_.Groups['condition'].Value -match '\$Rollback' -and $_.Groups['condition'].Value -match '\$Full'
})
Assert-Equal 1 $rollbackFullGuard.Count 'The patch script must refuse -Rollback combined with -Full: a rollback window reinstalls one package version and nothing else.'
$rollbackFullRefusal = [scriptblock]::Create(
  "param([string]`$Rollback, [switch]`$Full) $($rollbackFullGuard[0].Groups['condition'].Value)"
)
Assert-Equal $true (& $rollbackFullRefusal -Rollback 'postgresql-16=16.10-1.pgdg24.04+1' -Full) 'A rollback combined with a full upgrade must be refused.'
Assert-Equal $false (& $rollbackFullRefusal -Rollback 'postgresql-16=16.10-1.pgdg24.04+1') 'A rollback on its own must not trip the rollback/full guard.'
Assert-Equal $false (& $rollbackFullRefusal -Full) 'A full upgrade on its own must not trip the rollback/full guard.'
$rollbackFormatGuard = @($patchGuards | Where-Object { $_.Groups['condition'].Value -match '\$Rollback -notmatch' })
Assert-Equal 1 $rollbackFormatGuard.Count 'The patch script must validate the -Rollback package=version shape before it reaches the guest.'
$rollbackFormatRefusal = [scriptblock]::Create(
  "param([string]`$Rollback) $($rollbackFormatGuard[0].Groups['condition'].Value)"
)
Assert-Equal $false (& $rollbackFormatRefusal -Rollback 'postgresql-16=16.10-1.pgdg24.04+1') 'A Debian package=version rollback target must pass validation.'
Assert-Equal $false (& $rollbackFormatRefusal -Rollback 'vim=2:9.1.0016-1ubuntu7.7') 'A rollback version with an epoch must pass validation.'
Assert-Equal $true (& $rollbackFormatRefusal -Rollback 'postgresql-16') 'A rollback target without a version must be refused.'
Assert-Equal $true (& $rollbackFormatRefusal -Rollback 'postgresql-16=16.10; rm -rf /') 'A rollback target carrying shell metacharacters must be refused.'
Assert-Equal $false (& $rollbackFormatRefusal) 'No -Rollback must not trip the rollback format guard.'
Assert-True ($rollbackFullGuard[0].Index -lt $patchSource.IndexOf('$windowCleanup = @(')) 'Patch parameter validation must run before the egress window is even described.'
$cleanupRegistration = $patchSource.IndexOf('$windowCleanup = @(')
$operationStart = $patchSource.IndexOf('-Operation {')
$operationEnd = $patchSource.IndexOf('$windowSettled = $true')
$vmRestart = $patchSource.IndexOf("'vm', 'restart'")
Assert-True ($cleanupRegistration -ge 0 -and $operationStart -gt $cleanupRegistration -and $operationEnd -gt $operationStart) 'The patch window must register its cleanup actions before the guarded operation opens.'
foreach ($mutation in "'public-ip', 'create'", "'ip-config', 'update'", "'rule', 'create'", "'run-command', 'create'", "'snapshot', 'create'") {
  $index = $patchSource.IndexOf($mutation)
  Assert-True ($index -gt $operationStart -and $index -lt $operationEnd) "The patch window mutation $mutation must sit inside the guarded operation so the registered cleanup always closes egress."
}
$windowCleanupBlock = [regex]::Match($patchSource, '(?s)\$windowCleanup = @\((?<actions>.+?)\r?\n\)\r?\n')
Assert-True ($windowCleanupBlock.Success -and $windowCleanupBlock.Groups['actions'].Value -match 'Restore-PostgresSteadyStateEgress' -and $windowCleanupBlock.Groups['actions'].Value -match 'Remove-BootstrapPublicIp \$publicIpName') 'The patch window cleanup must run both shared helpers: restore restrictive egress and remove the bootstrap public IP.'
Assert-True ($patchSource -match '-CleanupActions \$windowCleanup') 'The patch window must hand its cleanup actions to Invoke-OperationWithGuaranteedCleanup.'
Assert-True ($vmRestart -gt $operationEnd) 'The VM restart must happen after the guarded window closed egress, so the VM never boots with Internet reachable.'
Assert-True ($patchSource -match '(?s)elseif \(\$rebootRequired\) \{.+?''vm'', ''restart''') 'The VM restart must be conditional on the guest reporting reboot=required.'
Assert-True ($patchSource -notmatch '\bredeploy\b') 'The patch window must restart in place, never move the VM to another host.'
$distributionUpgradeVerbs = @('dist', 'full') | ForEach-Object { "$_-upgrade" }
foreach ($verb in $distributionUpgradeVerbs) {
  Assert-True ($guestSource -notmatch [regex]::Escape($verb) -and $patchSource -notmatch [regex]::Escape($verb)) "Neither patch half may run apt-get ${verb}: only that verb could pull a new PostgreSQL major."
}
Assert-True ($guestSource -match '(?m)^set -euo pipefail' -and $guestSource -match 'trap fail ERR') 'infra/patch-os.sh must stop at the first failing stage and report it through the ERR trap.'
Assert-True ($guestSource -match 'unattended-upgrade' -and $guestSource -match 'apt-get -y -q upgrade') 'infra/patch-os.sh must patch security-only by default and use plain apt-get upgrade for -Full.'
Assert-True ($guestSource -notmatch '(?m)^\s*(sudo )?(reboot|shutdown|systemctl (reboot|poweroff|kexec))(\s|$)') 'infra/patch-os.sh must never reboot on its own: the orchestrator restarts only after egress is closed.'
Assert-True ($guestSource -match 'logger -p local0\.err -t markdoc-os-patch "os-patch=failed' -and $templateSource -match 'SyslogMessage contains "os-patch=failed"') 'A failed guest patch must reach the existing backup-failure alert through Syslog facility local0.'
Assert-True ($patchSource -match '\[IO\.File\]::ReadAllText\(\$patchScriptPath\)' -and $patchSource -match "'infra', 'patch-os\.sh'") 'The orchestrator must send infra/patch-os.sh itself, never an inline copy that could drift.'
foreach ($parameter in @([regex]::Matches($patchSource, 'MARKDOC_[A-Z_]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)) {
  Assert-True ($guestSource -match "\`$\{$parameter") "The run command parameter $parameter passed by the orchestrator must be read by infra/patch-os.sh."
}
Assert-True ($templateSource -match '(?s)activityLogAlerts@[0-9-]+'' = \{.+?scopes: \[\s*postgresNsg\.id\s*\].+?Microsoft\.Network/networkSecurityGroups/securityRules/write') 'The Activity Log tripwire must watch security-rule writes on the PostgreSQL NSG only.'

# Retired database NAT gateway (docs/postgres-egress.md, Part 2): the template declares only the subnet service
# endpoints and the private Azure Monitor path, so an incremental deployment can never re-attach the NAT.
Assert-Equal 0 ([regex]::Matches($templateSource, 'Microsoft\.Network/natGateways').Count) 'infra/main.bicep must not declare a NAT gateway: an incremental deployment converges on the template and would re-attach the retired gateway to the postgres subnet.'
Assert-Equal 0 ([regex]::Matches($templateSource, 'natGateway:').Count) 'No subnet in infra/main.bicep may reference a NAT gateway.'
Assert-Equal 1 ([regex]::Matches($templateSource, "(?m)^module postgresPrivateEgress './postgres-private-egress\.bicep'").Count) 'The private Azure Monitor egress module must stay declared exactly once: it is the agent path that replaced the NAT gateway.'
Assert-Equal 1 ([regex]::Matches($templateSource, "service: 'Microsoft\.Storage'").Count) 'The postgres subnet must keep exactly one Microsoft.Storage service endpoint: pgBackRest, the backup health uploads and the restore check reach the recovery storage account through it.'
Assert-Equal 1 ([regex]::Matches($templateSource, "service: 'Microsoft\.KeyVault'").Count) 'The postgres subnet must keep exactly one Microsoft.KeyVault service endpoint: password rotation reads the vault through it.'
Assert-True ($deploymentSource -notmatch 'postgresNatGatewayName') 'deploy/azure.ps1 must not read the removed postgresNatGatewayName deployment output.'

Write-Host "azure safety tests: ok (PowerShell $($PSVersionTable.PSVersion))"
