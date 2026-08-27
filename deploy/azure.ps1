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
  .\deploy\azure.ps1 -SecretsPath "$env:LOCALAPPDATA\markdoc\azure-production-secrets.clixml"

.EXAMPLE
  .\deploy\azure.ps1 -ImageTag 0123456789abcdef0123456789abcdef01234567
  .\deploy\azure.ps1 -InfraOnly
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
  [switch]$InfraOnly,
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
  'Microsoft.RecoveryServices'
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
$sourceSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -or $sourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve the current Git commit.' }
$shortTag = $sourceSha.Substring(0, 12)

function Deploy-Infra([string]$Image, [string]$AppVersion, [bool]$BootstrapPublicIp, [bool]$EnableVmBackup) {
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
  $attached = az network nic show `
    --resource-group $ResourceGroup `
    --name "$Name-pg-nic" `
    --query 'ipConfigurations[0].publicIPAddress.id' `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not verify the PostgreSQL VM network interface.' }
  if ($attached) { throw 'The PostgreSQL bootstrap public IP is still attached; refusing to delete it.' }

  $exists = az network public-ip show `
    --resource-group $ResourceGroup `
    --name $PublicIpName `
    --query id `
    --output tsv `
    --only-show-errors 2>$null
  if ($LASTEXITCODE -eq 0 -and $exists) {
    az network public-ip delete --resource-group $ResourceGroup --name $PublicIpName --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not delete the PostgreSQL bootstrap public IP.' }
  }
}

Step 'Deploying private infrastructure. Initial PostgreSQL setup can take several minutes.'
$outputs = Deploy-Infra '' '' $true $false
$registry = $outputs.registryName.value
$appUrl = $outputs.appUrl.value
$image = ''
$appVersion = ''

az backup vault backup-properties set `
  --resource-group $ResourceGroup `
  --name $outputs.backupVaultName.value `
  --backup-storage-redundancy LocallyRedundant `
  --output none `
  --only-show-errors
if ($LASTEXITCODE) { throw 'Could not set locally redundant backup storage before enabling protection.' }

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
    Step "Building immutable image for source $sourceSha in Azure Container Registry"
    az acr build `
      --registry $registry `
      --image "markdoc:$sourceSha" `
      --image "markdoc:$shortTag" `
      --build-arg "APP_VERSION=$sourceSha" `
      --file Dockerfile `
      . `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Azure Container Registry build failed.' }
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
$outputs = Deploy-Infra $image $appVersion $false $true
Remove-BootstrapPublicIp $outputs.bootstrapPublicIpName.value

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
  Write-Host "Logs: az containerapp logs show -n $Name -g $ResourceGroup --follow"
}
