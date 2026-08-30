<#
.SYNOPSIS
  Provisions Markdoc on Azure (Container Apps + private PostgreSQL VM + ACR) and deploys the
  current commit. Builds the image in Azure Container Registry, so no local Docker is needed.

  Nothing in this repository runs this automatically. Run it yourself when you are ready to deploy.

.EXAMPLE
  $env:MARKDOC_PG_PASSWORD = '<strong password>'
  $env:MARKDOC_AUTH_SECRET = (openssl rand -base64 32)
  $env:MARKDOC_GITHUB_CLIENT_ID = '<oauth app id>'
  $env:MARKDOC_GITHUB_CLIENT_SECRET = '<oauth app secret>'
  $env:MARKDOC_ALERT_EMAIL = '<production alert receiver>'
  $env:MARKDOC_VM_SSH_PUBLIC_KEY = Get-Content "$HOME\.ssh\id_ed25519.pub" -Raw
  .\deploy\azure.ps1

.EXAMPLE
  # Every property in this CLIXML object must be a DPAPI-encrypted SecureString.
  .\deploy\azure.ps1 -SecretsPath "$env:LOCALAPPDATA\markdoc\azure-production-secrets.clixml" -InitializeDatabase -ConfigureRecovery

.EXAMPLE
  .\deploy\azure.ps1 -SourceCommit 0123456789abcdef0123456789abcdef01234567
  .\deploy\azure.ps1 -ImageTag 0123456789abcdef0123456789abcdef01234567
  .\deploy\azure.ps1 -InfraOnly
  .\deploy\azure.ps1 -RotateDatabasePassword
  .\deploy\azure.ps1 -RotateDatabasePassword -SimulateDatabaseRotationFailure
  .\deploy\azure.ps1 -RotateDatabasePassword -SimulatePostChangeDatabaseRotationFailure
  .\deploy\azure.ps1 -ConfigureRecovery -VerifyRecovery
  .\deploy\azure.ps1 -ConfigureRecovery -SimulateRecoveryConfigurationFailure
  .\deploy\azure.ps1 -Small
  .\deploy\azure.ps1 -ScaleToZero
  .\deploy\azure.ps1 -Destroy

.NOTES
  GitHub OAuth callback URL for the app: https://<app fqdn>/api/auth/callback/github
  The first run prints the FQDN; add it to the OAuth App, then rerun (or set MARKDOC_PUBLIC_URL).
  This script provisions or reconfigures the whole template. An application release to the
  existing production Container App is an image-only `az containerapp update` (README, "Deploy to
  Azure" > "Production runbook"); it does not go through this script.
#>
param(
  [string]$Name = 'markdoc',
  [string]$ResourceGroup = 'markdoc-rg',
  [string]$Location = 'eastus2',
  [string]$SecretsPath = '',
  [string]$ImageTag = '',
  [string]$SourceCommit = '',
  [switch]$InfraOnly,
  [switch]$InitializeDatabase,
  [switch]$RotateDatabasePassword,
  [switch]$SimulateDatabaseRotationFailure,
  [switch]$SimulatePostChangeDatabaseRotationFailure,
  [switch]$ConfigureRecovery,
  [switch]$SimulateRecoveryConfigurationFailure,
  [switch]$VerifyRecovery,
  [switch]$Small,
  [switch]$ScaleToZero,
  [switch]$Destroy
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
. (Join-Path $PSScriptRoot 'azure-safety.ps1')
. (Join-Path $PSScriptRoot 'azure-postgres-network.ps1')
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'
$secretStoreOperation = $null
$resolvedSecretsPath = ''
try {
  if ($SecretsPath) {
    $secretStoreOperation = Enter-ProtectedSecretStoreOperation $SecretsPath
    $resolvedSecretsPath = $secretStoreOperation.Path
  }

  if ($ImageTag -and $ImageTag -notmatch '^[0-9a-f]{40}$') {
    throw '-ImageTag must be a full 40-character Git commit SHA.'
  }

  if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI not found: https://aka.ms/installazurecli' }
  az account show -o none 2>$null
  if ($LASTEXITCODE) { Step 'Signing in to Azure'; az login -o none; if ($LASTEXITCODE) { throw 'az login failed' } }

  if ($Destroy) {
    Step "Deleting resource group $ResourceGroup and everything in it"
    az group delete -n $ResourceGroup --yes --no-wait
    return
  }

function ConvertTo-PlainText([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function ConvertFrom-PlainText([string]$Value) {
  $secureValue = New-Object Security.SecureString
  foreach ($character in $Value.ToCharArray()) {
    $secureValue.AppendChar($character)
  }
  $secureValue.MakeReadOnly()
  return $secureValue
}

$secretDefinitions = @(
  @{ Property = 'PostgresAdminPassword'; Environment = 'MARKDOC_PG_PASSWORD' },
  @{ Property = 'AuthSecret'; Environment = 'MARKDOC_AUTH_SECRET' },
  @{ Property = 'GitHubClientId'; Environment = 'MARKDOC_GITHUB_CLIENT_ID' },
  @{ Property = 'GitHubClientSecret'; Environment = 'MARKDOC_GITHUB_CLIENT_SECRET' },
  @{ Property = 'AlertEmailAddress'; Environment = 'MARKDOC_ALERT_EMAIL' },
  @{ Property = 'VmAdminSshPublicKey'; Environment = 'MARKDOC_VM_SSH_PUBLIC_KEY' }
)

  $secureValues = @{}
  $store = $null
  if ($resolvedSecretsPath) {
    if (-not (Test-Path -LiteralPath $resolvedSecretsPath)) { throw "Secrets file not found: $resolvedSecretsPath" }
    $store = Import-Clixml -LiteralPath $resolvedSecretsPath
    foreach ($definition in $secretDefinitions) {
      $property = $store.PSObject.Properties[$definition.Property]
      if (-not $property -or $property.Value -isnot [Security.SecureString]) {
        throw "Secrets file property $($definition.Property) must be a SecureString."
      }
      $secureValues[$definition.Property] = $property.Value
    }
  } else {
    foreach ($definition in $secretDefinitions) {
      $value = (Get-Item "env:$($definition.Environment)" -ErrorAction SilentlyContinue).Value
      if (-not $value) { throw "Set `$env:$($definition.Environment) first (see the script header), or pass -SecretsPath." }
      $secureValues[$definition.Property] = ConvertFrom-PlainText $value
    }
  }
$secureValues.PostgresCandidatePassword = $secureValues.PostgresAdminPassword
$rotationRecoveryProperties = @(
  'PostgresRotationPreviousImage',
  'PostgresRotationPreviousAppVersion',
  'PostgresRotationPreviousRevision',
  'PostgresRotationAppUrl'
)
$hasStoredRotationCandidate = [bool](
  $store -and $store.PSObject.Properties['PostgresCandidatePassword']
)
$storedRotationRecoveryPropertyCount = @(
  $rotationRecoveryProperties | Where-Object {
    $store -and $store.PSObject.Properties[$_]
  }
).Count
$hasCompleteRotationRecoveryMetadata = (
  $hasStoredRotationCandidate -and
  $storedRotationRecoveryPropertyCount -eq $rotationRecoveryProperties.Count
)
if ($hasStoredRotationCandidate) {
  $storedCandidate = $store.PSObject.Properties['PostgresCandidatePassword']
  if ($storedCandidate.Value -isnot [Security.SecureString]) {
    throw 'Secrets file property PostgresCandidatePassword must be a SecureString.'
  }
  $secureValues.PostgresCandidatePassword = $storedCandidate.Value
}

function Assert-ProductionSecretStoreAcl {
  if (-not $resolvedSecretsPath -or -not $store) {
    throw 'Password rotation state requires the DPAPI-encrypted production secrets store.'
  }
  Assert-ProtectedCurrentUserFileAcl $resolvedSecretsPath
}

function Save-ProductionSecretStore {
  Assert-ProductionSecretStoreAcl
  Save-ProtectedSecureStringStore -Path $resolvedSecretsPath -Store $store
  Assert-ProductionSecretStoreAcl
}

function New-RotationCandidatePassword {
  $bytes = [byte[]]::new(48)
  $plainText = $null
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    $plainText = [Convert]::ToBase64String($bytes)
    return ConvertFrom-PlainText $plainText
  } finally {
    $generator.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
    $plainText = $null
  }
}

function Get-RotationRecoveryState {
  Assert-ProductionSecretStoreAcl
  $candidate = $store.PSObject.Properties['PostgresCandidatePassword']
  if (-not $candidate -or $candidate.Value -isnot [Security.SecureString]) {
    throw 'Secrets file property PostgresCandidatePassword must be a SecureString.'
  }
  $values = @{}
  foreach ($propertyName in $rotationRecoveryProperties) {
    $property = $store.PSObject.Properties[$propertyName]
    if (-not $property -or $property.Value -isnot [Security.SecureString]) {
      throw "Retained password rotation state is missing SecureString property $propertyName."
    }
    $values[$propertyName] = ConvertTo-PlainText $property.Value
  }
  if (
    $values.PostgresRotationPreviousImage -notmatch '@sha256:[0-9a-f]{64}$' -or
    $values.PostgresRotationPreviousAppVersion -notmatch '^[0-9a-f]{40}$' -or
    [string]::IsNullOrWhiteSpace($values.PostgresRotationPreviousRevision) -or
    $values.PostgresRotationAppUrl -notmatch '^https://[^/]+$'
  ) {
    throw 'Retained password rotation recovery metadata is invalid.'
  }

  $secureValues.PostgresCandidatePassword = $candidate.Value
  return [pscustomobject]@{
    RecoveryKind = 'Complete'
    PreviousImage = $values.PostgresRotationPreviousImage
    PreviousAppVersion = $values.PostgresRotationPreviousAppVersion
    PreviousRevision = $values.PostgresRotationPreviousRevision
    AppUrl = $values.PostgresRotationAppUrl
  }
}

function Initialize-RotationCandidate(
  [string]$PreviousImage,
  [string]$PreviousAppVersion,
  [string]$PreviousRevision,
  [string]$AppUrl
) {
  Assert-ProductionSecretStoreAcl
  $candidate = $store.PSObject.Properties['PostgresCandidatePassword']
  $recoveryPropertyCount = @(
    $rotationRecoveryProperties | Where-Object { $store.PSObject.Properties[$_] }
  ).Count
  if ($candidate -and $recoveryPropertyCount -eq $rotationRecoveryProperties.Count) {
    return Get-RotationRecoveryState
  }
  if ($candidate) {
    throw 'A candidate-only password rotation must be reconciled before a fresh candidate can be initialized.'
  }
  if ($recoveryPropertyCount -ne 0) {
    throw 'The DPAPI-encrypted password rotation recovery metadata is incomplete.'
  }

  $recoveryValues = [ordered]@{
    PostgresRotationPreviousImage = $PreviousImage
    PostgresRotationPreviousAppVersion = $PreviousAppVersion
    PostgresRotationPreviousRevision = $PreviousRevision
    PostgresRotationAppUrl = $AppUrl
  }
  if (
    $PreviousImage -notmatch '@sha256:[0-9a-f]{64}$' -or
    $PreviousAppVersion -notmatch '^[0-9a-f]{40}$' -or
    [string]::IsNullOrWhiteSpace($PreviousRevision) -or
    $AppUrl -notmatch '^https://[^/]+$'
  ) {
    throw 'Password rotation recovery metadata is invalid.'
  }
  $store | Add-Member -NotePropertyName PostgresCandidatePassword -NotePropertyValue (New-RotationCandidatePassword)
  foreach ($entry in $recoveryValues.GetEnumerator()) {
    $store | Add-Member -NotePropertyName $entry.Key -NotePropertyValue (ConvertFrom-PlainText $entry.Value)
  }
  Save-ProductionSecretStore
  return Get-RotationRecoveryState
}

function Complete-RotationSecretStore([bool]$PromoteCandidate) {
  $candidate = $store.PSObject.Properties['PostgresCandidatePassword']
  if (-not $candidate -or $candidate.Value -isnot [Security.SecureString]) {
    throw 'The DPAPI-encrypted rotation candidate is unavailable.'
  }
  if ($PromoteCandidate) {
    $store.PostgresAdminPassword = $candidate.Value
    $secureValues.PostgresAdminPassword = $candidate.Value
  }
  $store.PSObject.Properties.Remove('PostgresCandidatePassword')
  foreach ($propertyName in $rotationRecoveryProperties) {
    $store.PSObject.Properties.Remove($propertyName)
  }
  Save-ProductionSecretStore
  $secureValues.PostgresCandidatePassword = $secureValues.PostgresAdminPassword
}

Step 'Registering providers'
foreach ($provider in @(
  'Microsoft.App',
  'Microsoft.Compute',
  'Microsoft.ContainerRegistry',
  'Microsoft.KeyVault',
  'Microsoft.ManagedIdentity',
  'Microsoft.Network',
  'Microsoft.OperationalInsights',
  'Microsoft.RecoveryServices',
  'Microsoft.Insights',
  'Microsoft.Storage'
)) {
  az provider register -n $provider --wait -o none
  if ($LASTEXITCODE) { throw "Provider registration failed: $provider" }
}

Step "Creating resource group $ResourceGroup in $Location"
az group create -n $ResourceGroup -l $Location -o none
if ($LASTEXITCODE) { throw 'Resource group creation failed' }

$cpu = if ($Small) { '0.25' } else { '0.5' }
$memory = if ($Small) { '0.5Gi' } else { '1Gi' }
$minReplicas = if ($ScaleToZero) { 0 } else { 1 }
$deploymentSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -or $deploymentSha -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve the current Git commit.' }
$worktreeChanges = @(git status --porcelain --untracked-files=all)
if ($LASTEXITCODE) { throw 'Could not inspect the deployment worktree.' }
if ($worktreeChanges.Count -gt 0) { throw 'Refusing to deploy from a dirty worktree. Commit or remove every change first.' }

$sourceSha = if ($SourceCommit) { $SourceCommit.ToLowerInvariant() } else { $deploymentSha }
if ($sourceSha -notmatch '^[0-9a-f]{40}$') { throw '-SourceCommit must be a full 40-character Git commit SHA.' }
git cat-file -e "$sourceSha^{commit}" 2>$null
if ($LASTEXITCODE) { throw "Source commit $sourceSha is not available in this checkout." }

if ($SourceCommit -and $sourceSha -ne $deploymentSha) {
  $allowedDeploymentPaths = @('Dockerfile', 'README.md', '.github/workflows/deploy.yml', 'deploy/', 'infra/')
  $productChanges = @(
    git diff --name-only $sourceSha $deploymentSha -- . |
      Where-Object {
        $path = $_.Replace('\', '/')
        -not ($allowedDeploymentPaths | Where-Object {
          $path -eq $_ -or $path.StartsWith($_, [StringComparison]::Ordinal)
        })
      }
  )
  if ($LASTEXITCODE) { throw "Could not compare source commit $sourceSha with deployment commit $deploymentSha." }
  if ($productChanges.Count -gt 0) {
    throw "-SourceCommit differs from this deployment commit in application files: $($productChanges -join ', ')"
  }
}
$shortTag = $sourceSha.Substring(0, 12)
$deploymentConfigurationToken = [guid]::NewGuid().ToString('N')

function Deploy-Infra(
  [string]$Image,
  [string]$AppVersion,
  [bool]$BootstrapPublicIp,
  [bool]$EnableVmBackup,
  [bool]$InitializePostgres,
  [bool]$RotatePostgresPassword,
  [bool]$CommitPostgresPassword,
  [bool]$RestorePostgresPassword,
  [bool]$ClearPendingPostgresPassword,
  [bool]$ReconcilePostgresPassword,
  [bool]$SimulatePostgresRotationFailure,
  [bool]$ConfigurePostgresRecovery,
  [bool]$SimulatePostgresRecoveryFailure,
  [string]$DatabaseConfigurationToken,
  [string]$RecoveryConfigurationVersion
) {
  $tempParameters = Join-Path ([IO.Path]::GetTempPath()) "markdoc-azure-$([guid]::NewGuid().ToString('N')).parameters.json"
  $plainValues = @{}
  $json = $null
  try {
    foreach ($definition in $secretDefinitions) {
      $plainValues[$definition.Property] = ConvertTo-PlainText $secureValues[$definition.Property]
    }
    $plainValues.PostgresCandidatePassword = ConvertTo-PlainText $secureValues.PostgresCandidatePassword
    $parameters = [ordered]@{
      '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
      contentVersion = '1.0.0.0'
      parameters = [ordered]@{
        name = @{ value = $Name }
        location = @{ value = $Location }
        cpu = @{ value = $cpu }
        memory = @{ value = $memory }
        minReplicas = @{ value = $minReplicas }
        postgresAdminPassword = @{ value = $plainValues.PostgresAdminPassword }
        postgresCandidatePassword = @{ value = $plainValues.PostgresCandidatePassword }
        authSecret = @{ value = $plainValues.AuthSecret }
        githubClientId = @{ value = $plainValues.GitHubClientId }
        githubClientSecret = @{ value = $plainValues.GitHubClientSecret }
        alertEmailAddress = @{ value = $plainValues.AlertEmailAddress }
        vmAdminSshPublicKey = @{ value = $plainValues.VmAdminSshPublicKey }
        image = @{ value = $Image }
        appVersion = @{ value = $AppVersion }
        publicUrl = @{ value = if ($env:MARKDOC_PUBLIC_URL) { $env:MARKDOC_PUBLIC_URL } else { '' } }
        bootstrapPublicIp = @{ value = $BootstrapPublicIp }
        enableVmBackup = @{ value = $EnableVmBackup }
        configureDatabase = @{ value = $InitializePostgres }
        rotateDatabasePassword = @{ value = $RotatePostgresPassword }
        commitDatabasePassword = @{ value = $CommitPostgresPassword }
        restoreDatabasePassword = @{ value = $RestorePostgresPassword }
        clearPendingDatabasePassword = @{ value = $ClearPendingPostgresPassword }
        reconcileDatabasePassword = @{ value = $ReconcilePostgresPassword }
        simulateDatabaseRotationFailure = @{ value = $SimulatePostgresRotationFailure }
        configureRecovery = @{ value = $ConfigurePostgresRecovery }
        simulateRecoveryConfigurationFailure = @{ value = $SimulatePostgresRecoveryFailure }
        databaseConfigurationToken = @{ value = $DatabaseConfigurationToken }
        deploymentConfigurationToken = @{ value = $deploymentConfigurationToken }
        recoveryConfigurationVersion = @{ value = $RecoveryConfigurationVersion }
      }
    }
    $json = $parameters | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($tempParameters, $json, [Text.UTF8Encoding]::new($false))

    $parameterArgument = "@$tempParameters"
    $outputJson = az deployment group create `
      --name "$Name-$shortTag-infra" `
      --resource-group $ResourceGroup `
      --template-file 'infra/main.bicep' `
      --parameters $parameterArgument `
      --query properties.outputs `
      --output json `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Bicep deployment failed; inspect the deployment operation without displaying its parameters.' }
    return $outputJson | ConvertFrom-Json
  } finally {
    if (Test-Path -LiteralPath $tempParameters) { Remove-Item -LiteralPath $tempParameters -Force }
    foreach ($key in @($plainValues.Keys)) { $plainValues[$key] = $null }
    $json = $null
  }
}

function Get-ActiveContainerAppRevisions {
  $active = az containerapp revision list `
    --resource-group $ResourceGroup `
    --name $Name `
    --query '[?properties.active].name' `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect active Container App revisions.' }
  return @($active | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Restore-ContainerAppRevision([string]$RevisionName) {
  $active = @(Get-ActiveContainerAppRevisions)
  $alreadySoleActive = $active.Count -eq 1 -and $active[0] -eq $RevisionName
  if (-not $alreadySoleActive) {
    az containerapp revision activate `
      --resource-group $ResourceGroup `
      --name $Name `
      --revision $RevisionName `
      --output none `
      --only-show-errors
    if ($LASTEXITCODE) { throw "Could not reactivate Container App revision $RevisionName." }
  }

  for ($attempt = 1; $attempt -le 24; $attempt++) {
    $active = @(Get-ActiveContainerAppRevisions)
    if ($active.Count -eq 1 -and $active[0] -eq $RevisionName) { break }
    Start-Sleep -Seconds 5
  }
  if ($active.Count -ne 1 -or $active[0] -ne $RevisionName) {
    throw "Container App revision $RevisionName was not restored as the only active revision."
  }
  if ($alreadySoleActive) { return }

  az containerapp revision restart `
    --resource-group $ResourceGroup `
    --name $Name `
    --revision $RevisionName `
    --output none `
    --only-show-errors
  if ($LASTEXITCODE) { throw "Could not restart restored Container App revision $RevisionName." }
}

function Wait-NewActiveContainerAppRevision([string]$PreviousRevisionName) {
  for ($attempt = 1; $attempt -le 24; $attempt++) {
    $active = @(Get-ActiveContainerAppRevisions)
    if ($active.Count -eq 1 -and $active[0] -ne $PreviousRevisionName) {
      return $active[0]
    }
    Start-Sleep -Seconds 5
  }
  throw 'Password rotation did not produce one new active Container App revision.'
}

function Wait-AppHealth([string]$AppUrl, [string]$ExpectedVersion) {
  for ($attempt = 1; $attempt -le 24; $attempt++) {
    try {
      $candidate = Invoke-RestMethod "$AppUrl/api/health" -TimeoutSec 10
      if ($candidate.ok -eq $true -and $candidate.db -eq $true -and $candidate.version -eq $ExpectedVersion) {
        return $candidate
      }
    } catch {
      # A new Container App revision can refuse traffic briefly while its startup probe runs.
    }
    Start-Sleep -Seconds 5
  }
  throw "The deployed revision did not become healthy on application version $ExpectedVersion."
}

function Assert-ContainerAppDatabaseSecretReference {
  $metadataJson = az containerapp show `
    --resource-group $ResourceGroup `
    --name $Name `
    --query "{databaseRef:properties.template.containers[0].env[?name=='DATABASE_URL'] | [0].secretRef,keyVaultUrl:properties.configuration.secrets[?name=='database-url'] | [0].keyVaultUrl}" `
    --output json `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the Container App database secret reference.' }
  $metadata = $metadataJson | ConvertFrom-Json
  if (
    $metadata.databaseRef -ne 'database-url' -or
    $metadata.keyVaultUrl -notmatch '/secrets/database-url$'
  ) {
    throw 'The Container App is not using the expected active Key Vault database secret reference.'
  }
}

function Assert-RotationCandidatesDisabled([string]$VaultId) {
  foreach ($secretName in @('postgres-admin-password-pending', 'postgres-admin-password-rollback')) {
    $enabled = az resource show `
      --ids "$VaultId/secrets/$secretName" `
      --api-version '2023-07-01' `
      --query 'properties.attributes.enabled' `
      --output tsv `
      --only-show-errors
    if ($LASTEXITCODE -or $enabled -ne 'false') {
      throw "Rotation secret $secretName was not disabled after terminal verification."
    }
  }
  Write-Host 'database-password-candidates=disabled'
}

$postgresVmId = az vm show `
  --resource-group $ResourceGroup `
  --name "$Name-pg" `
  --query id `
  --output tsv `
  --only-show-errors 2>$null
$postgresVmExists = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($postgresVmId)

if ($SimulateDatabaseRotationFailure -and -not $RotateDatabasePassword) {
  throw '-SimulateDatabaseRotationFailure requires -RotateDatabasePassword.'
}
if ($SimulatePostChangeDatabaseRotationFailure -and -not $RotateDatabasePassword) {
  throw '-SimulatePostChangeDatabaseRotationFailure requires -RotateDatabasePassword.'
}
if ($SimulateDatabaseRotationFailure -and $SimulatePostChangeDatabaseRotationFailure) {
  throw 'Pre-change and post-change database rotation failure simulations are mutually exclusive.'
}
if (
  $hasStoredRotationCandidate -and (
    $SimulateDatabaseRotationFailure -or
    $SimulatePostChangeDatabaseRotationFailure
  )
) {
  throw 'Database rotation failure simulations cannot run while retained recovery state is present.'
}
if ($SimulateRecoveryConfigurationFailure -and -not $ConfigureRecovery) {
  throw '-SimulateRecoveryConfigurationFailure requires -ConfigureRecovery.'
}
if ($RotateDatabasePassword -and $InfraOnly) {
  throw 'Password rotation must roll and verify the Container App; do not combine -RotateDatabasePassword with -InfraOnly.'
}
if ($RotateDatabasePassword -and $ConfigureRecovery) {
  throw 'Run -ConfigureRecovery on its own: recovery configuration installs packages and needs the temporary bootstrap public IP, which the -RotateDatabasePassword flow does not attach (docs/postgres-egress.md). Rotate first, then configure recovery.'
}
if ($RotateDatabasePassword -and -not $SecretsPath) {
  throw 'Password rotation requires -SecretsPath so current and candidate credentials remain DPAPI-encrypted and recoverable.'
}

$databaseReadiness = Resolve-DatabaseDeploymentReadiness `
  -PostgresVmExists $postgresVmExists `
  -InitializeDatabase ([bool]$InitializeDatabase) `
  -RotateDatabasePassword ([bool]$RotateDatabasePassword) `
  -HasRetainedCandidate $hasStoredRotationCandidate `
  -GetExtensionState {
    $state = az vm extension list `
      --resource-group $ResourceGroup `
      --vm-name "$Name-pg" `
      --query "[?name=='install-postgresql'] | [0].provisioningState" `
      --output tsv `
      --only-show-errors 2>$null
    return [pscustomobject]@{
      ExitCode = $LASTEXITCODE
      State = [string]$state
    }
  } `
  -GetExistingAppHealth {
    $existingFqdn = az containerapp list `
      --resource-group $ResourceGroup `
      --query "[?name=='$Name'] | [0].properties.configuration.ingress.fqdn" `
      --output tsv `
      --only-show-errors 2>$null
    if ($LASTEXITCODE) {
      throw 'Could not inspect the existing Container App during PostgreSQL initialization discovery.'
    }
    if ([string]::IsNullOrWhiteSpace($existingFqdn)) {
      return $false
    }
    try {
      $existingHealth = Invoke-RestMethod "https://$existingFqdn/api/health" -TimeoutSec 10
      return $existingHealth.ok -eq $true -and $existingHealth.db -eq $true
    } catch {
      return $false
    }
  }
if ($databaseReadiness.Mode -eq 'AlreadyInitialized') {
  Invoke-AlreadyInitializedDatabaseRefusal `
    -CleanupTemporaryEgress { Restore-PostgresSteadyStateEgress } `
    -RemoveBootstrapPublicIp { Remove-BootstrapPublicIp "$Name-pg-bootstrap-ip" }
}

$databaseConfigurationToken = if ($InitializeDatabase -or $RotateDatabasePassword) { [guid]::NewGuid().ToString('N') } else { 'unchanged' }
$recoveryConfigurationVersion = if ($ConfigureRecovery) { [guid]::NewGuid().ToString('N') } else { 'unchanged' }
$rotationImage = ''
$rotationAppVersion = ''
$rotationRevision = ''
$rotationAppUrl = ''

function Get-CurrentApplicationContext {
  $previousImage = az containerapp show `
    --resource-group $ResourceGroup `
    --name $Name `
    --query 'properties.template.containers[0].image' `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the existing Container App image before password rotation.' }

  $previousAppVersion = az containerapp show `
    --resource-group $ResourceGroup `
    --name $Name `
    --query "properties.template.containers[0].env[?name=='APP_VERSION'] | [0].value" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the existing Container App version before password rotation.' }

  $previousFqdn = az containerapp show `
    --resource-group $ResourceGroup `
    --name $Name `
    --query 'properties.configuration.ingress.fqdn' `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the existing Container App FQDN before password rotation.' }

  if (
    $previousImage -notmatch '@sha256:[0-9a-f]{64}$' -or
    $previousAppVersion -notmatch '^[0-9a-f]{40}$' -or
    [string]::IsNullOrWhiteSpace($previousFqdn)
  ) {
    throw 'Password recovery requires an existing Container App with an immutable image, APP_VERSION, and FQDN.'
  }

  return [pscustomobject]@{
    PreviousImage = $previousImage
    PreviousAppVersion = $previousAppVersion
    AppUrl = "https://$previousFqdn"
  }
}

function Get-CurrentRotationContext {
  $context = Get-CurrentApplicationContext
  $previousActiveRevisions = @(Get-ActiveContainerAppRevisions)
  if ($previousActiveRevisions.Count -ne 1) {
    throw 'Fresh password rotation requires exactly one existing active Container App revision.'
  }
  $context | Add-Member -NotePropertyName PreviousRevision -NotePropertyValue $previousActiveRevisions[0]
  return $context
}

$candidateOnlyRotationRecovery = $false
if ($RotateDatabasePassword) {
  $rotationPreparation = Resolve-RotationPreparation `
    -HasRetainedCandidate $hasStoredRotationCandidate `
    -HasCompleteRecoveryMetadata $hasCompleteRotationRecoveryMetadata `
    -LoadRetainedCandidate { Get-RotationRecoveryState } `
    -LoadCandidateOnlyRecovery {
      [pscustomobject]@{ RecoveryKind = 'CandidateOnly' }
    } `
    -GetFreshContext { Get-CurrentRotationContext } `
    -AssertFreshRevisionHealthy {
      param($context)
      [void](Wait-AppHealth $context.AppUrl $context.PreviousAppVersion)
    } `
    -CreateFreshCandidate {
      param($context)
      Initialize-RotationCandidate `
        -PreviousImage $context.PreviousImage `
        -PreviousAppVersion $context.PreviousAppVersion `
        -PreviousRevision $context.PreviousRevision `
        -AppUrl $context.AppUrl
    }
  if ($rotationPreparation.RecoveryKind -eq 'CandidateOnly') {
    $candidateOnlyRotationRecovery = $true
  } else {
    $rotationImage = $rotationPreparation.PreviousImage
    $rotationAppVersion = $rotationPreparation.PreviousAppVersion
    $rotationRevision = $rotationPreparation.PreviousRevision
    $rotationAppUrl = $rotationPreparation.AppUrl
  }
}

function Clear-RotationCandidateInfrastructure([bool]$EnableVmBackup) {
  $cleanupOutputs = Deploy-Infra `
    -Image '' `
    -AppVersion '' `
    -BootstrapPublicIp $false `
    -EnableVmBackup $EnableVmBackup `
    -InitializePostgres $false `
    -RotatePostgresPassword $false `
    -CommitPostgresPassword $false `
    -RestorePostgresPassword $false `
    -ClearPendingPostgresPassword $true `
    -ReconcilePostgresPassword $false `
    -SimulatePostgresRotationFailure $false `
    -ConfigurePostgresRecovery $false `
    -SimulatePostgresRecoveryFailure $false `
    -DatabaseConfigurationToken 'unchanged' `
    -RecoveryConfigurationVersion 'unchanged'
  Assert-RotationCandidatesDisabled $cleanupOutputs.secretsVaultId.value
}

function Restore-PreviousDatabaseCredential {
  $rollbackOutputs = Deploy-Infra `
    -Image $rotationImage `
    -AppVersion $rotationAppVersion `
    -BootstrapPublicIp $false `
    -EnableVmBackup $true `
    -InitializePostgres $false `
    -RotatePostgresPassword $false `
    -CommitPostgresPassword $false `
    -RestorePostgresPassword $true `
    -ClearPendingPostgresPassword $false `
    -ReconcilePostgresPassword $true `
    -SimulatePostgresRotationFailure $false `
    -ConfigurePostgresRecovery $false `
    -SimulatePostgresRecoveryFailure $false `
    -DatabaseConfigurationToken $databaseConfigurationToken `
    -RecoveryConfigurationVersion 'unchanged'

  $reconciliation = Get-ManagedRunCommandResult 'reconcile-postgresql-password'
  $reconciliationResult = [string]$reconciliation.output
  if (
    $reconciliation.executionState -ne 'Succeeded' -or
    $reconciliation.exitCode -ne 0 -or
    $reconciliationResult -notmatch 'database-password-reconciliation=(rolled-back|already-active)'
  ) {
    $state = if ($reconciliationResult -match 'database-password-reconciliation=[a-z-]+(?: stage=[a-z-]+)?') {
      $Matches[0]
    } else {
      'database-password-reconciliation=unknown'
    }
    throw "PostgreSQL compensation did not verify the original credential ($state)."
  }
  Write-Host ($reconciliationResult | Select-String -Pattern 'database-password-reconciliation=(rolled-back|already-active)' | Select-Object -First 1)
  Restore-ContainerAppRevision $rotationRevision
  [void](Wait-AppHealth $rotationAppUrl $rotationAppVersion)
  Assert-ContainerAppDatabaseSecretReference
  Clear-RotationCandidateInfrastructure $true
  Complete-RotationSecretStore $false
  Write-Host "database-password-compensation=verified revision=$rotationRevision"
}

function Clear-UnchangedRotationCandidate {
  [void](Wait-AppHealth $rotationAppUrl $rotationAppVersion)
  Clear-RotationCandidateInfrastructure $true
  Complete-RotationSecretStore $false
  Write-Host 'database-password-rotation=unchanged candidate=cleared'
}

function Restore-CandidateOnlyDatabaseCredential($CurrentApplication) {
  # Deploys without the bootstrap public IP, so it never configures recovery: validation refuses -RotateDatabasePassword with -ConfigureRecovery.
  $reconciliationOutputs = Deploy-Infra `
    -Image $CurrentApplication.PreviousImage `
    -AppVersion $CurrentApplication.PreviousAppVersion `
    -BootstrapPublicIp $false `
    -EnableVmBackup $true `
    -InitializePostgres $false `
    -RotatePostgresPassword $false `
    -CommitPostgresPassword $false `
    -RestorePostgresPassword $true `
    -ClearPendingPostgresPassword $false `
    -ReconcilePostgresPassword $true `
    -SimulatePostgresRotationFailure $false `
    -ConfigurePostgresRecovery $false `
    -SimulatePostgresRecoveryFailure $false `
    -DatabaseConfigurationToken $databaseConfigurationToken `
    -RecoveryConfigurationVersion $recoveryConfigurationVersion

  if ($ConfigureRecovery) {
    $recoveryExecution = Get-ManagedRunCommandResult 'configure-postgresql-recovery'
    if ($recoveryExecution.executionState -ne 'Succeeded' -or $recoveryExecution.exitCode -ne 0) {
      throw 'The PostgreSQL recovery configuration failed during candidate-only credential recovery.'
    }
  }

  $reconciliation = Get-ManagedRunCommandResult 'reconcile-postgresql-password'
  $reconciliationResult = [string]$reconciliation.output
  if (
    $reconciliation.executionState -ne 'Succeeded' -or
    $reconciliation.exitCode -ne 0 -or
    $reconciliationResult -notmatch 'database-password-reconciliation=(rolled-back|already-active)'
  ) {
    $state = if ($reconciliationResult -match 'database-password-reconciliation=[a-z-]+(?: stage=[a-z-]+)?') {
      $Matches[0]
    } else {
      'database-password-reconciliation=unknown'
    }
    throw "Candidate-only PostgreSQL recovery did not restore the retained current credential ($state)."
  }

  [void](Wait-AppHealth $CurrentApplication.AppUrl $CurrentApplication.PreviousAppVersion)
  Assert-ContainerAppDatabaseSecretReference
  Clear-RotationCandidateInfrastructure $true
  Complete-RotationSecretStore $false
  Write-Host 'database-password-reconciliation=verified candidate-only-state=cleared'
  return $reconciliationOutputs
}

function Resolve-ApplicationArtifact($StageOutputs) {
  if ($InfraOnly) {
    return [pscustomobject]@{ Image = ''; AppVersion = '' }
  }

  $registry = $StageOutputs.registryName.value
  $resolvedAppVersion = ''
  if ($ImageTag) {
    $available = az acr repository show-tags `
      --name $registry `
      --repository markdoc `
      --query "[?@=='$ImageTag'] | [0]" `
      --output tsv `
      --only-show-errors
    if ($LASTEXITCODE -or $available -ne $ImageTag) { throw "Image tag $ImageTag does not exist in registry $registry." }
    $resolvedAppVersion = $ImageTag
  } else {
    Step "Building immutable image for application source $sourceSha in Azure Container Registry"
    $buildContext = Join-Path ([IO.Path]::GetTempPath()) "markdoc-build-$([guid]::NewGuid().ToString('N'))"
    $buildArchive = "$buildContext.tar"
    try {
      [void](New-Item -ItemType Directory -Path $buildContext)
      git archive --format=tar --output=$buildArchive $deploymentSha
      if ($LASTEXITCODE) { throw "Could not create an exact build context from deployment commit $deploymentSha." }
      tar -xf $buildArchive -C $buildContext
      if ($LASTEXITCODE) { throw 'Could not extract the exact Git build context.' }
      Remove-Item -LiteralPath $buildArchive -Force

      $buildRunId = az acr build `
        --registry $registry `
        --image "markdoc:$sourceSha" `
        --image "markdoc:$shortTag" `
        --build-arg "APP_VERSION=$sourceSha" `
        --file (Join-Path $buildContext 'Dockerfile') `
        $buildContext `
        --no-logs `
        --query runId `
        --output tsv `
        --only-show-errors
      if ($LASTEXITCODE -or [string]::IsNullOrWhiteSpace($buildRunId)) {
        throw 'Azure Container Registry build could not be queued.'
      }

      $buildStatus = ''
      for ($attempt = 1; $attempt -le 120; $attempt++) {
        $buildStatus = az acr task show-run `
          --registry $registry `
          --run-id $buildRunId `
          --query status `
          --output tsv `
          --only-show-errors
        if ($LASTEXITCODE) { throw "Could not read ACR build $buildRunId status." }
        if ($buildStatus -eq 'Succeeded') { break }
        if ($buildStatus -in @('Canceled', 'Error', 'Failed', 'Timeout')) {
          throw "Azure Container Registry build $buildRunId finished with status $buildStatus."
        }
        Start-Sleep -Seconds 15
      }
      if ($buildStatus -ne 'Succeeded') { throw "Azure Container Registry build $buildRunId did not finish in 30 minutes." }
    } finally {
      if (Test-Path -LiteralPath $buildArchive) { Remove-Item -LiteralPath $buildArchive -Force }
      if (Test-Path -LiteralPath $buildContext) { Remove-Item -LiteralPath $buildContext -Recurse -Force }
    }
    $resolvedAppVersion = $sourceSha
  }

  $digest = az acr manifest list-metadata `
    --registry $registry `
    --name markdoc `
    --query "[?tags != null && contains(tags, '$resolvedAppVersion')] | [0].digest" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE -or $digest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw "Could not resolve the immutable image digest for $resolvedAppVersion."
  }
  return [pscustomobject]@{
    Image = "$($StageOutputs.registryLoginServer.value)/markdoc@$digest"
    AppVersion = $resolvedAppVersion
  }
}

$outputs = $null
$image = ''
$appVersion = ''
if ($candidateOnlyRotationRecovery) {
  Step 'Recovering an interrupted legacy password rotation to the retained current credential.'
  $currentApplication = Get-CurrentApplicationContext
  $image = $currentApplication.PreviousImage
  $appVersion = $currentApplication.PreviousAppVersion
  $candidateOnlyCleanup = @()
  if ($ConfigureRecovery) {
    $candidateOnlyCleanup += @{ Action = { Restore-PostgresSteadyStateEgress } }
  }
  $outputs = Invoke-OperationWithGuaranteedCleanup `
    -Context 'Candidate-only PostgreSQL recovery' `
    -Operation { Restore-CandidateOnlyDatabaseCredential $currentApplication } `
    -CleanupActions $candidateOnlyCleanup
} elseif ($RotateDatabasePassword) {
  Step 'Explicit password rotation: staging a candidate secret and using the rollback-capable private run command.'
  if ($ConfigureRecovery) {
    Step 'Explicit recovery update: configuring off-VM WAL archiving and backup verification.'
  }
  $image = $rotationImage
  $appVersion = $rotationAppVersion
  $rotationCleanup = @()
  if ($ConfigureRecovery) {
    $rotationCleanup += @{ Action = { Restore-PostgresSteadyStateEgress } }
  }
  $outputs = Invoke-OperationWithGuaranteedCleanup `
    -Context 'PostgreSQL password rotation' `
    -Operation {
      Invoke-RotationFinalization `
        -Commit {
          # Deploys without the bootstrap public IP, so it never configures recovery: validation refuses -RotateDatabasePassword with -ConfigureRecovery.
          $stageOutputs = Deploy-Infra `
            -Image '' `
            -AppVersion '' `
            -BootstrapPublicIp $false `
            -EnableVmBackup $false `
            -InitializePostgres $false `
            -RotatePostgresPassword $true `
            -CommitPostgresPassword $false `
            -RestorePostgresPassword $false `
            -ClearPendingPostgresPassword $false `
            -ReconcilePostgresPassword $false `
            -SimulatePostgresRotationFailure ([bool]$SimulateDatabaseRotationFailure) `
            -ConfigurePostgresRecovery $false `
            -SimulatePostgresRecoveryFailure $false `
            -DatabaseConfigurationToken $databaseConfigurationToken `
            -RecoveryConfigurationVersion $recoveryConfigurationVersion

          if ($ConfigureRecovery) {
            $recoveryExecution = Get-ManagedRunCommandResult 'configure-postgresql-recovery'
            if ($recoveryExecution.executionState -ne 'Succeeded' -or $recoveryExecution.exitCode -ne 0) {
              throw 'The PostgreSQL recovery configuration failed on the VM.'
            }
          }

          $rotationExecution = Get-ManagedRunCommandResult 'rotate-postgresql-password'
          $rotationResult = [string]$rotationExecution.output
          if (
            $rotationExecution.executionState -ne 'Succeeded' -or
            $rotationExecution.exitCode -ne 0 -or
            $rotationResult -notmatch 'database-password-rotation=(committed|already-committed)'
          ) {
            $rotationState = if ($rotationResult -match 'database-password-rotation=[a-z-]+(?: stage=[a-z-]+)?') {
              $Matches[0]
            } else {
              'database-password-rotation=unknown'
            }
            $rotationFailure = [InvalidOperationException]::new(
              "PostgreSQL password rotation did not commit ($rotationState)."
            )
            if (
              $rotationExecution.executionState -eq 'Succeeded' -and
              $rotationExecution.exitCode -eq 0 -and
              $rotationState -in @(
                'database-password-rotation=failed stage=managed-identity',
                'database-password-rotation=failed stage=active-secret',
                'database-password-rotation=failed stage=candidate-secret',
                'database-password-rotation=failed stage=preflight-simulation',
                'database-password-rotation=rolled-back stage=candidate-verification'
              )
            ) {
              $rotationFailure.Data['DatabaseState'] = 'unchanged'
            }
            throw $rotationFailure
          }
          Write-Host ($rotationResult | Select-String -Pattern 'database-password-rotation=(committed|already-committed)' | Select-Object -First 1)

          Step 'Finalizing the private VM network and rolling the Container App'
          return Deploy-Infra `
            -Image $image `
            -AppVersion $appVersion `
            -BootstrapPublicIp $false `
            -EnableVmBackup $true `
            -InitializePostgres $false `
            -RotatePostgresPassword $false `
            -CommitPostgresPassword $true `
            -RestorePostgresPassword $false `
            -ClearPendingPostgresPassword $false `
            -ReconcilePostgresPassword $false `
            -SimulatePostgresRotationFailure $false `
            -ConfigurePostgresRecovery $false `
            -SimulatePostgresRecoveryFailure $false `
            -DatabaseConfigurationToken $databaseConfigurationToken `
            -RecoveryConfigurationVersion 'unchanged'
        } `
        -Verify {
          param($committedOutputs)
          [void](Wait-NewActiveContainerAppRevision $rotationRevision)
          [void](Wait-AppHealth $committedOutputs.appUrl.value $appVersion)
          Assert-ContainerAppDatabaseSecretReference
        } `
        -Compensate {
          param($primaryError)
          if ($primaryError.Exception.Data['DatabaseState'] -eq 'unchanged') {
            Clear-UnchangedRotationCandidate
          } else {
            Restore-PreviousDatabaseCredential
          }
        } `
        -TerminalCleanup {
          Clear-RotationCandidateInfrastructure $true
          Complete-RotationSecretStore $true
        } `
        -SimulatePostChangeFailure:$SimulatePostChangeDatabaseRotationFailure
    } `
    -CleanupActions $rotationCleanup
} else {
  Step 'Deploying private infrastructure without changing the existing PostgreSQL database.'
  if ($InitializeDatabase) {
    Step 'Explicit first provision: temporarily enabling bootstrap networking and creating the database login.'
  }
  if ($ConfigureRecovery) {
    Step 'Explicit recovery update: temporarily enabling bootstrap networking and configuring off-VM WAL archiving and backup verification.'
  }
  # Recovery installs packages with apt, so it needs an explicit egress path that does not depend
  # on the NAT gateway being attached (docs/postgres-egress.md); the cleanup below always detaches the IP.
  $temporaryPublicIp = [bool]($InitializeDatabase -or $ConfigureRecovery)
  $temporaryPackageEgress = [bool]($InitializeDatabase -or $ConfigureRecovery)
  $initialCleanup = @()
  if ($temporaryPackageEgress) {
    $initialCleanup += @{ Action = { Restore-PostgresSteadyStateEgress } }
  }
  if ($temporaryPublicIp) {
    $initialCleanup += @{ Action = { Remove-BootstrapPublicIp "$Name-pg-bootstrap-ip" } }
  }
  $outputs = Invoke-OperationWithGuaranteedCleanup `
    -Context 'Initial private infrastructure deployment' `
    -Operation {
      $stageOutputs = Deploy-Infra `
        -Image '' `
        -AppVersion '' `
        -BootstrapPublicIp $temporaryPublicIp `
        -EnableVmBackup $false `
        -InitializePostgres ([bool]$InitializeDatabase) `
        -RotatePostgresPassword $false `
        -CommitPostgresPassword $false `
        -RestorePostgresPassword $false `
        -ClearPendingPostgresPassword $false `
        -ReconcilePostgresPassword $false `
        -SimulatePostgresRotationFailure $false `
        -ConfigurePostgresRecovery ([bool]$ConfigureRecovery) `
        -SimulatePostgresRecoveryFailure ([bool]$SimulateRecoveryConfigurationFailure) `
        -DatabaseConfigurationToken $databaseConfigurationToken `
        -RecoveryConfigurationVersion $recoveryConfigurationVersion
      if ($ConfigureRecovery) {
        $recoveryExecution = Get-ManagedRunCommandResult 'configure-postgresql-recovery'
        if ($recoveryExecution.executionState -ne 'Succeeded' -or $recoveryExecution.exitCode -ne 0) {
          throw 'The PostgreSQL recovery configuration failed on the VM.'
        }
      }
      return $stageOutputs
    } `
    -CleanupActions $initialCleanup

  if ($InitializeDatabase) {
    az backup vault backup-properties set `
      --resource-group $ResourceGroup `
      --name $outputs.backupVaultName.value `
      --backup-storage-redundancy LocallyRedundant `
      --output none `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not set locally redundant backup storage before enabling protection.' }
  }

  $artifact = Resolve-ApplicationArtifact $outputs
  $image = $artifact.Image
  $appVersion = $artifact.AppVersion
  Step 'Finalizing the private VM network and rolling the Container App'
  $outputs = Deploy-Infra `
    -Image $image `
    -AppVersion $appVersion `
    -BootstrapPublicIp $false `
    -EnableVmBackup $true `
    -InitializePostgres $false `
    -RotatePostgresPassword $false `
    -CommitPostgresPassword $false `
    -RestorePostgresPassword $false `
    -ClearPendingPostgresPassword $false `
    -ReconcilePostgresPassword $false `
    -SimulatePostgresRotationFailure $false `
    -ConfigurePostgresRecovery $false `
    -SimulatePostgresRecoveryFailure $false `
    -DatabaseConfigurationToken $databaseConfigurationToken `
    -RecoveryConfigurationVersion 'unchanged'
}
$appUrl = $outputs.appUrl.value
Remove-BootstrapPublicIp $outputs.bootstrapPublicIpName.value

if ($VerifyRecovery -or $ConfigureRecovery) {
  if (-not $ConfigureRecovery) {
    Step 'Running the existing automated scratch restore verification.'
  } else {
    Step 'Running the newly configured automated scratch restore verification.'
  }
  $restoreResult = ''
  if ($ConfigureRecovery) {
    $recoveryExecutionJson = az vm run-command show `
      --resource-group $ResourceGroup `
      --vm-name "$Name-pg" `
      --run-command-name 'configure-postgresql-recovery' `
      --instance-view `
      --query '{exitCode:instanceView.exitCode,output:instanceView.output}' `
      --output json `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not read the PostgreSQL recovery configuration result.' }
    $recoveryExecution = $recoveryExecutionJson | ConvertFrom-Json
    if ($recoveryExecution.exitCode -ne 0) { throw 'The PostgreSQL recovery configuration failed on the VM.' }
    $restoreResult = $recoveryExecution.output
  } else {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      $restoreResult = az vm run-command invoke `
        --resource-group $ResourceGroup `
        --name "$Name-pg" `
        --command-id RunShellScript `
        --scripts '/usr/local/sbin/markdoc-restore-check && sudo -u postgres /usr/local/sbin/markdoc-backup-monitor && echo recovery-verification=ok' `
        --query 'value[0].message' `
        --output tsv `
        --only-show-errors
      if ($LASTEXITCODE -eq 0 -and $restoreResult -match 'recovery-verification=ok') { break }
      if ($attempt -lt 5) { Start-Sleep -Seconds 30 }
    }
  }
  if ($restoreResult -notmatch 'recovery-verification=ok') {
    throw 'The PostgreSQL scratch restore verification failed.'
  }
  Write-Host $restoreResult
}

Write-Host "App URL: $appUrl" -ForegroundColor Green
Write-Host "Registry: $($outputs.registryLoginServer.value)"
if (-not $InfraOnly) {
  Step "Markdoc staged at $appUrl"
  $health = Wait-AppHealth $appUrl $appVersion
  Assert-ContainerAppDatabaseSecretReference
  Write-Host "health: ok=$($health.ok) db=$($health.db) version=$($health.version)" -ForegroundColor Green
  Write-Host "GitHub OAuth callback: $appUrl/api/auth/callback/github"
  Write-Host "Recovery storage: $($outputs.recoveryStorageName.value)/$($outputs.recoveryContainerName.value)"
  Write-Host "Logs: az containerapp logs show -n $Name -g $ResourceGroup --follow"
}
} finally {
  Exit-ProtectedSecretStoreOperation $secretStoreOperation
}
