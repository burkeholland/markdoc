# Release from GitHub Actions: one-time setup

**What you need to do:** (1) run the block below once, as an Owner of the Azure subscription. That's it: the
**Deploy to Azure** workflow then releases once a day when `main` has changes, and can be started by hand on `main`.

> The one-time setup has already been run; these commands are kept for re-creating it.

The **Deploy to Azure** workflow (`.github/workflows/deploy.yml`) runs `deploy/release-vm.ps1 -Target Enterprise`
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

### Daily

The workflow runs once a day at 01:07 UTC (5:07 p.m. PST, 6:07 p.m. PDT). GitHub can start a scheduled run late. Its `check`
job holds no Azure or production access and runs `deploy/release-decision.ps1`, which reads `https://markdoc.app/api/health`
(no-cache) and compares the reported version with `main`:

| What it finds | Result |
| --- | --- |
| Nothing changed, or only docs changed | The run succeeds. The `deploy` job is skipped, so nothing touches production or Azure. |
| Changes beyond docs | The `deploy` job releases the exact commit that was compared. |
| Health is not `ok`/`db`/`collab` true, can't be read, or reports a version that isn't on `main` | The run fails and nothing is released. |

Docs means `docs/`, Markdown at the repository root and Markdown directly in `deploy/`. Anything else counts as a change,
including Markdown elsewhere, because some of it can ship with the app. Database migrations release the same way as any other
change, so one merged to `main` reaches production at the next daily run.

The schedule compares only with what production reports, so after a rollback by hand it releases `main` again at the next
daily run. To hold releases, run `gh workflow disable deploy.yml`, which also blocks starting the workflow by hand until
`gh workflow enable deploy.yml`. GitHub also turns off the schedule of a public repository after 60 days with no activity;
the same enable command turns it back on.

Only one run of this workflow goes at a time. GitHub keeps one more waiting and cancels any older waiting run, so a daily run
that starts during a release waits for it, then compares against the new version. A daily run can also replace a
manual run that is still waiting, so check that a manual `sha` release ran if you start one close to the daily time.

### By hand

Actions → **Deploy to Azure** → Run workflow on `main`. This always releases, without the daily check. Leave `sha` blank for main HEAD, or paste a full 40-hex
commit that is on `main`. Only one release runs at a time. The job runs the dependency preflight, builds in ACR, rolls the VM,
then checks `https://markdoc.app/api/health` (no-cache) for the exact SHA with `ok`/`db`/`collab` all true.
