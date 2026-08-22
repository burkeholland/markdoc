<#
.SYNOPSIS
  Provisions Markdoc on Azure (Container Apps + PostgreSQL Flexible Server + ACR) and deploys the
  current commit. Builds the image in Azure Container Registry, so no local Docker is needed.

  Nothing in this repository runs this automatically. Run it yourself when you are ready to deploy.

.EXAMPLE
  $env:MARKDOC_PG_PASSWORD = '<strong password>'
  $env:MARKDOC_AUTH_SECRET = (openssl rand -base64 32)
  $env:MARKDOC_GITHUB_CLIENT_ID = '<oauth app id>'
  $env:MARKDOC_GITHUB_CLIENT_SECRET = '<oauth app secret>'
  .\deploy\azure.ps1                      # rg "markdoc-rg" in eastus2
  .\deploy\azure.ps1 -InfraOnly           # create/update resources, skip the image build
  .\deploy\azure.ps1 -Small               # 0.25 vCPU / 0.5 GiB (~$14/mo for the app)
  .\deploy\azure.ps1 -ScaleToZero         # sleep when nobody is connected
  .\deploy\azure.ps1 -Destroy             # delete the resource group

.NOTES
  GitHub OAuth callback URL for the app: https://<app fqdn>/api/auth/callback/github
  The first run prints the FQDN; add it to the OAuth App, then rerun (or set MARKDOC_PUBLIC_URL).
#>
param(
  [string]$Name = 'markdoc',
  [string]$ResourceGroup = 'markdoc-rg',
  [string]$Location = 'eastus2',
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

foreach ($v in 'MARKDOC_PG_PASSWORD', 'MARKDOC_AUTH_SECRET', 'MARKDOC_GITHUB_CLIENT_ID', 'MARKDOC_GITHUB_CLIENT_SECRET') {
  if (-not (Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { throw "Set `$env:$v first (see the script header)." }
}

Step 'Registering providers'
az provider register -n Microsoft.App --wait -o none
az provider register -n Microsoft.OperationalInsights --wait -o none
az provider register -n Microsoft.DBforPostgreSQL --wait -o none
az provider register -n Microsoft.ContainerRegistry --wait -o none

Step "Creating resource group $ResourceGroup in $Location"
az group create -n $ResourceGroup -l $Location -o none

$cpu = if ($Small) { '0.25' } else { '0.5' }
$memory = if ($Small) { '0.5Gi' } else { '1Gi' }
$minReplicas = if ($ScaleToZero) { 0 } else { 1 }

function Deploy-Infra([string]$image) {
  $args = @(
    'deployment', 'group', 'create', '-g', $ResourceGroup, '-f', 'infra/main.bicep', '-o', 'json',
    '-p', "name=$Name", "cpu=$cpu", "memory=$memory", "minReplicas=$minReplicas",
    "postgresAdminPassword=$env:MARKDOC_PG_PASSWORD", "authSecret=$env:MARKDOC_AUTH_SECRET",
    "githubClientId=$env:MARKDOC_GITHUB_CLIENT_ID", "githubClientSecret=$env:MARKDOC_GITHUB_CLIENT_SECRET"
  )
  if ($image) { $args += "image=$image" }
  if ($env:MARKDOC_PUBLIC_URL) { $args += "publicUrl=$env:MARKDOC_PUBLIC_URL" }
  $out = az @args | ConvertFrom-Json
  if ($LASTEXITCODE) { throw 'Bicep deployment failed (see output above)' }
  return $out.properties.outputs
}

Step 'Deploying infrastructure (Bicep). The first run takes ~10 minutes because of PostgreSQL.'
$outputs = Deploy-Infra ''
$registry = $outputs.registryName.value
$appUrl = $outputs.appUrl.value
Write-Host "App URL: $appUrl" -ForegroundColor Green
Write-Host "Registry: $($outputs.registryLoginServer.value)"

if ($InfraOnly) { return }

$tag = (git rev-parse --short HEAD)
$image = "$($outputs.registryLoginServer.value)/markdoc:$tag"
Step "Building image $image in Azure Container Registry"
az acr build -r $registry -t "markdoc:$tag" -t 'markdoc:latest' --file Dockerfile . 2>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE) { throw 'az acr build failed' }

Step 'Rolling the Container App to the new image'
$outputs = Deploy-Infra $image

Step "Markdoc is live: $appUrl"
try {
  $h = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 60
  Write-Host "health: ok=$($h.ok) db=$($h.db) version=$($h.version)" -ForegroundColor Green
} catch { Write-Host "health check not answering yet ($($_.Exception.Message)); give it a minute." -ForegroundColor Yellow }
Write-Host "GitHub OAuth callback: $appUrl/api/auth/callback/github"
Write-Host "Logs: az containerapp logs show -n $Name -g $ResourceGroup --follow"
