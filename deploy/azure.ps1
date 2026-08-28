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
  .\deploy\azure.ps1 -ConfigureRecovery -VerifyRecovery
  .\deploy\azure.ps1 -Small
  .\deploy\azure.ps1 -ScaleToZero
  .\deploy\azure.ps1 -Destroy

.NOTES
  GitHub OAuth callback URL for the app: https://<app fqdn>/api/auth/callback/github
  The first run prints the FQDN; add it to the OAuth App, then rerun (or set MARKDOC_PUBLIC_URL).
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
  [switch]$ConfigureRecovery,
  [switch]$VerifyRecovery,
  [switch]$Small,
  [switch]$ScaleToZero,
  [switch]$Destroy
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'

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

$secretDefinitions = @(
  @{ Property = 'PostgresAdminPassword'; Environment = 'MARKDOC_PG_PASSWORD' },
  @{ Property = 'AuthSecret'; Environment = 'MARKDOC_AUTH_SECRET' },
  @{ Property = 'GitHubClientId'; Environment = 'MARKDOC_GITHUB_CLIENT_ID' },
  @{ Property = 'GitHubClientSecret'; Environment = 'MARKDOC_GITHUB_CLIENT_SECRET' },
  @{ Property = 'VmAdminSshPublicKey'; Environment = 'MARKDOC_VM_SSH_PUBLIC_KEY' }
)

$secureValues = @{}
if ($SecretsPath) {
  $resolvedSecretsPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SecretsPath)
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
    $secureValues[$definition.Property] = ConvertTo-SecureString $value -AsPlainText -Force
  }
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
  $allowedDeploymentPaths = @('Dockerfile', 'README.md', 'deploy/', 'infra/')
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

function Deploy-Infra(
  [string]$Image,
  [string]$AppVersion,
  [bool]$BootstrapPublicIp,
  [bool]$EnableVmBackup,
  [bool]$ConfigureDatabase,
  [bool]$ConfigurePostgresRecovery,
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
        authSecret = @{ value = $plainValues.AuthSecret }
        githubClientId = @{ value = $plainValues.GitHubClientId }
        githubClientSecret = @{ value = $plainValues.GitHubClientSecret }
        vmAdminSshPublicKey = @{ value = $plainValues.VmAdminSshPublicKey }
        image = @{ value = $Image }
        appVersion = @{ value = $AppVersion }
        publicUrl = @{ value = if ($env:MARKDOC_PUBLIC_URL) { $env:MARKDOC_PUBLIC_URL } else { '' } }
        bootstrapPublicIp = @{ value = $BootstrapPublicIp }
        enableVmBackup = @{ value = $EnableVmBackup }
        configureDatabase = @{ value = $ConfigureDatabase }
        configureRecovery = @{ value = $ConfigurePostgresRecovery }
        databaseConfigurationToken = @{ value = $DatabaseConfigurationToken }
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

function Remove-BootstrapPublicIp([string]$PublicIpName) {
  $nicId = az network nic list `
    --resource-group $ResourceGroup `
    --query "[?name=='$Name-pg-nic'] | [0].id" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the PostgreSQL VM network interface during cleanup.' }

  if (-not [string]::IsNullOrWhiteSpace($nicId)) {
    $attached = az network nic show `
      --resource-group $ResourceGroup `
      --name "$Name-pg-nic" `
      --query 'ipConfigurations[0].publicIPAddress.id' `
      --output tsv `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not verify the PostgreSQL VM network interface.' }
    if ($attached) {
      az network nic ip-config update `
        --resource-group $ResourceGroup `
        --nic-name "$Name-pg-nic" `
        --name 'primary' `
        --remove publicIPAddress `
        --output none `
        --only-show-errors
      if ($LASTEXITCODE) { throw 'Could not detach the PostgreSQL bootstrap public IP.' }
    }

    $attached = az network nic show `
      --resource-group $ResourceGroup `
      --name "$Name-pg-nic" `
      --query 'ipConfigurations[0].publicIPAddress.id' `
      --output tsv `
      --only-show-errors
    if ($LASTEXITCODE -or $attached) { throw 'The PostgreSQL bootstrap public IP is still attached.' }
  }

  $publicIpId = az network public-ip list `
    --resource-group $ResourceGroup `
    --query "[?name=='$PublicIpName'] | [0].id" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the PostgreSQL bootstrap public IP during cleanup.' }
  if (-not [string]::IsNullOrWhiteSpace($publicIpId)) {
    az network public-ip delete --resource-group $ResourceGroup --name $PublicIpName --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not delete the PostgreSQL bootstrap public IP.' }
  }
}

$postgresVmId = az vm show `
  --resource-group $ResourceGroup `
  --name "$Name-pg" `
  --query id `
  --output tsv `
  --only-show-errors 2>$null
$postgresVmExists = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($postgresVmId)

if ($InitializeDatabase -and $postgresVmExists) {
  throw 'The PostgreSQL VM already exists; -InitializeDatabase is only valid for first provision.'
}
if ($RotateDatabasePassword -and -not $postgresVmExists) {
  throw 'The PostgreSQL VM does not exist; use -InitializeDatabase for first provision.'
}
if ($InitializeDatabase -and $RotateDatabasePassword) {
  throw '-InitializeDatabase and -RotateDatabasePassword are mutually exclusive.'
}
if (-not $postgresVmExists -and -not $InitializeDatabase) {
  throw 'The PostgreSQL VM does not exist. First provision requires the explicit -InitializeDatabase flag.'
}

$configureDatabase = [bool]($InitializeDatabase -or $RotateDatabasePassword)
$databaseConfigurationToken = if ($configureDatabase) { [guid]::NewGuid().ToString('N') } else { 'unchanged' }
$recoveryConfigurationVersion = if ($ConfigureRecovery) { [guid]::NewGuid().ToString('N') } else { 'unchanged' }
$preDeployImage = ''
$preDeployAppVersion = ''

if ($RotateDatabasePassword) {
  $preDeployImage = az containerapp show `
    --resource-group $ResourceGroup `
    --name $Name `
    --query 'properties.template.containers[0].image' `
    --output tsv `
    --only-show-errors
  $preDeployAppVersion = az containerapp show `
    --resource-group $ResourceGroup `
    --name $Name `
    --query "properties.template.containers[0].env[?name=='APP_VERSION'] | [0].value" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE -or [string]::IsNullOrWhiteSpace($preDeployImage) -or [string]::IsNullOrWhiteSpace($preDeployAppVersion)) {
    throw 'Password rotation requires a healthy existing Container App image and APP_VERSION.'
  }
}

Step 'Deploying private infrastructure without changing the existing PostgreSQL database.'
if ($InitializeDatabase) {
  Step 'Explicit first provision: temporarily enabling bootstrap networking and creating the database login.'
} elseif ($RotateDatabasePassword) {
  Step 'Explicit password rotation: updating the PostgreSQL login without enabling public networking.'
}
if ($ConfigureRecovery) {
  Step 'Explicit recovery update: configuring off-VM WAL archiving and backup verification.'
}
$temporaryPublicIp = [bool]($InitializeDatabase -or $ConfigureRecovery)
try {
  $outputs = Deploy-Infra `
    $preDeployImage `
    $preDeployAppVersion `
    $temporaryPublicIp `
    $false `
    $configureDatabase `
    ([bool]$ConfigureRecovery) `
    $databaseConfigurationToken `
    $recoveryConfigurationVersion
} finally {
  if ($temporaryPublicIp) {
    Remove-BootstrapPublicIp "$Name-pg-bootstrap-ip"
  }
}

$registry = $outputs.registryName.value
$appUrl = $outputs.appUrl.value
$image = ''
$appVersion = ''

if ($InitializeDatabase) {
  az backup vault backup-properties set `
    --resource-group $ResourceGroup `
    --name $outputs.backupVaultName.value `
    --backup-storage-redundancy LocallyRedundant `
    --output none `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not set locally redundant backup storage before enabling protection.' }
}

if (-not $InfraOnly) {
  if ($ImageTag) {
    if ($ImageTag -notmatch '^[0-9a-f]{40}$') { throw '-ImageTag must be a full 40-character Git commit SHA.' }
    $available = az acr repository show-tags `
      --name $registry `
      --repository markdoc `
      --query "[?@=='$ImageTag'] | [0]" `
      --output tsv `
      --only-show-errors
    if ($LASTEXITCODE -or $available -ne $ImageTag) { throw "Image tag $ImageTag does not exist in registry $registry." }
    $appVersion = $ImageTag
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
    $appVersion = $sourceSha
  }

  $digest = az acr manifest list-metadata `
    --registry $registry `
    --name markdoc `
    --query "[?tags != null && contains(tags, '$appVersion')] | [0].digest" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE -or $digest -notmatch '^sha256:[0-9a-f]{64}$') { throw "Could not resolve the immutable image digest for $appVersion." }
  $image = "$($outputs.registryLoginServer.value)/markdoc@$digest"
}

Step 'Finalizing the private VM network and rolling the Container App'
$outputs = Deploy-Infra $image $appVersion $false $true $false $false 'unchanged' 'unchanged'
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
  try {
    $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 60
    Write-Host "health: ok=$($health.ok) db=$($health.db) version=$($health.version)" -ForegroundColor Green
  } catch {
    Write-Host "health check not answering yet ($($_.Exception.Message)); give it a minute." -ForegroundColor Yellow
  }
  Write-Host "GitHub OAuth callback: $appUrl/api/auth/callback/github"
  Write-Host "Recovery storage: $($outputs.recoveryStorageName.value)/$($outputs.recoveryContainerName.value)"
  Write-Host "Logs: az containerapp logs show -n $Name -g $ResourceGroup --follow"
}
