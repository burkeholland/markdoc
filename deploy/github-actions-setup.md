# Release from GitHub Actions: one-time setup

The **Deploy to Azure (manual)** workflow (`.github/workflows/deploy.yml`) runs `deploy/release-vm.ps1 -Target Enterprise`
on a GitHub-hosted runner, so `npm audit` uses the public registry instead of the local policy-gated feed.
It logs in to Azure with OIDC (no stored secret). Run once, as an Owner of the subscription, in `pwsh`:

```powershell
$sub    = 'f40011a4-4708-4843-9b04-e1eac4ad0ebf'
$tenant = 'f1fde69f-c8d3-4b94-adeb-02d045b37f6a'
$repo   = 'burkeholland/markdoc'

az login --tenant $tenant
az account set --subscription $sub

# 1. App registration + service principal
$appId = az ad app create --display-name markdoc-github-deploy --query appId -o tsv
az ad sp create --id $appId

# 2. Federated credential: only the `production` environment of this repo can use it
@{
  name = 'github-production'
  issuer = 'https://token.actions.githubusercontent.com'
  subject = "repo:${repo}:environment:production"
  audiences = @('api://AzureADTokenExchange')
} | ConvertTo-Json | Set-Content fic.json
az ad app federated-credential create --id $appId --parameters fic.json
Remove-Item fic.json

# 3. Role: Contributor on the resource group only (ACR build + VM run-command)
az role assignment create --assignee $appId --role Contributor `
  --scope "/subscriptions/$sub/resourceGroups/markdoc-rg"

# 4. GitHub environment + variables (IDs are not secrets; no secrets are needed)
gh api -X PUT "repos/$repo/environments/production"
gh variable set AZURE_CLIENT_ID       --env production --repo $repo --body $appId
gh variable set AZURE_TENANT_ID       --env production --repo $repo --body $tenant
gh variable set AZURE_SUBSCRIPTION_ID --env production --repo $repo --body $sub
```

Optional: add yourself as a required reviewer on the `production` environment (Settings → Environments) for an approval gate.

## Running a release

Actions → **Deploy to Azure (manual)** → Run workflow on `main`. Leave `sha` blank for main HEAD, or paste a full 40-hex
commit that is on `main`. Only one release runs at a time. The job runs the dependency preflight, builds in ACR, rolls the VM,
then checks `https://markdoc.app/api/health` (no-cache) for the exact SHA with `ok`/`db`/`collab` all true.
