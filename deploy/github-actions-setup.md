# Release from GitHub Actions: one-time setup

**What you need to do:** (1) run the block below once, as an Owner of the Azure subscription; (2) run
Actions → **Deploy to Azure (manual)** on `main`. That's it.

> The one-time setup has already been run; these commands are kept for re-creating it.

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

# 2. Federated credential: only the `production` environment of this repo can use it.
#    This repo uses immutable OIDC subjects (repo and owner IDs), so the subject is not the plain repo name.
$repoId  = gh api "repos/$repo" --jq .id
$ownerId = gh api "repos/$repo" --jq .owner.id
$subject = "repo:$($repo.Split('/')[0])@$ownerId/$($repo.Split('/')[1])@$repoId`:environment:production"
@{
  name = 'github-production'
  issuer = 'https://token.actions.githubusercontent.com'
  subject = $subject
  audiences = @('api://AzureADTokenExchange')
} | ConvertTo-Json | Set-Content fic.json
az ad app federated-credential create --id $appId --parameters fic.json
Remove-Item fic.json

# 3. Role: Contributor on the resource group only (ACR build + VM run-command)
az role assignment create --assignee $appId --role Contributor `
  --scope "/subscriptions/$sub/resourceGroups/markdoc-rg"

# 4. GitHub `production` environment: limit it to main, keeping any settings it already has.
#    (PUT replaces the environment's settings, so read them first and send them back.)
$raw = gh api "repos/$repo/environments/production" 2>&1
$env0 = $null
if ($LASTEXITCODE -eq 0) { $env0 = $raw | ConvertFrom-Json }
elseif ("$raw" -notmatch 'HTTP 404') { throw "Could not read the production environment; aborting so its settings are not overwritten: $raw" }
$body = @{
  wait_timer = if ($env0) { [int](($env0.protection_rules | Where-Object type -eq 'wait_timer').wait_timer) } else { 0 }
  prevent_self_review = $false
  reviewers = @()
  deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true }
}
foreach ($rule in @($env0.protection_rules | Where-Object type -eq 'required_reviewers')) {
  $body.prevent_self_review = [bool]$rule.prevent_self_review
  $body.reviewers = @($rule.reviewers | ForEach-Object { @{ type = $_.type; id = $_.reviewer.id } })
}
$body | ConvertTo-Json -Depth 5 | gh api -X PUT "repos/$repo/environments/production" --input -
# Allow only the exact branch main: delete every other policy (branches and tags), then add main if missing
$policies = gh api "repos/$repo/environments/production/deployment-branch-policies" --jq '.branch_policies'
if ($LASTEXITCODE -ne 0) { throw 'Could not list deployment branch policies.' }
$policies = @($policies | ConvertFrom-Json)
foreach ($p in $policies) {
  if (-not ($p.name -ceq 'main' -and $p.type -eq 'branch')) {
    gh api -X DELETE "repos/$repo/environments/production/deployment-branch-policies/$($p.id)"
    if ($LASTEXITCODE -ne 0) { throw "Could not delete policy $($p.name)." }
  }
}
if (-not ($policies | Where-Object { $_.name -ceq 'main' -and $_.type -eq 'branch' })) {
  gh api -X POST "repos/$repo/environments/production/deployment-branch-policies" -f name=main -f type=branch
  if ($LASTEXITCODE -ne 0) { throw 'Could not add the main policy.' }
}

# 5. Variables (IDs are not secrets; no secrets are needed)
gh variable set AZURE_CLIENT_ID       --env production --repo $repo --body $appId
gh variable set AZURE_TENANT_ID       --env production --repo $repo --body $tenant
gh variable set AZURE_SUBSCRIPTION_ID --env production --repo $repo --body $sub
```

Optional: add yourself as a required reviewer on the `production` environment (Settings → Environments) for an approval gate.

## Running a release

Actions → **Deploy to Azure (manual)** → Run workflow on `main`. Leave `sha` blank for main HEAD, or paste a full 40-hex
commit that is on `main`. Only one release runs at a time. The job runs the dependency preflight, builds in ACR, rolls the VM,
then checks `https://markdoc.app/api/health` (no-cache) for the exact SHA with `ok`/`db`/`collab` all true.
