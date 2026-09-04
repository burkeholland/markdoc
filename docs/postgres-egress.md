# PostgreSQL VM egress

The PostgreSQL VM no longer uses a NAT gateway or an Azure Monitor Private Link
Scope. Its steady-state network policy permits only the paths the database and
co-located Markdoc application require:

- `Microsoft.Storage:443` for pgBackRest, logical backups, and restore checks.
- `Microsoft.KeyVault:443` for managed-identity secret retrieval.
- `AzureMonitor:443`, `AzureResourceManager:443`, and
  `AzureActiveDirectory:443` for monitoring and managed identity.
- `Internet:443` for the Markdoc application, GitHub OAuth/API calls, ACR image
  pulls, and public Azure Monitor ingestion.
- A temporary `Internet:80` rule only while approved package installation is
  running. Deployment cleanup removes that rule even after failure.

All other Internet egress remains denied. PostgreSQL port 5432 remains reachable
only from the Container Apps subnet and from the VM's own `10.42.2.4/32`
address. Public web ingress stays closed until the Markdoc hostname and TLS
certificate are ready.

## Current production state

On September 4, 2026:

- `markdoc-pg-egress` and its public IP were deleted after a successful
  pgBackRest restore drill.
- The Azure Monitor private endpoint, AMPLS, data collection endpoint, and
  private DNS zones were retired after HTTPS egress was restricted to port 443.
- Azure Monitor heartbeat and backup-health telemetry were verified after the
  change.
- The recovery storage account still uses its `Microsoft.Storage` service
  endpoint and remains protected by a `CanNotDelete` lock.

## Verification

Confirm the effective NSG rules:

```powershell
az network nsg rule list -g markdoc-rg --nsg-name markdoc-pg-nsg `
  --query "[].{name:name,priority:priority,direction:direction,access:access,ports:destinationPortRange,prefix:destinationAddressPrefix}" `
  -o table
```

Confirm the latest VM heartbeat:

```powershell
$workspace = az monitor log-analytics workspace show -g markdoc-rg -n markdoc-logs --query customerId -o tsv
az monitor log-analytics query -w $workspace `
  --analytics-query "Heartbeat | where TimeGenerated > ago(30m) | where Computer =~ 'markdoc-pg' | summarize Latest=max(TimeGenerated), Count=count()" `
  -o table
```

Confirm backup health and repository state:

```powershell
az vm run-command invoke -g markdoc-rg -n markdoc-pg `
  --command-id RunShellScript `
  --scripts "sudo systemctl is-active markdoc-backup-monitor.timer; sudo -u postgres pgbackrest --stanza=markdoc info" `
  --query "value[0].message" -o tsv
```

Confirm the application can reach the database locally:

```powershell
az vm run-command invoke -g markdoc-rg -n markdoc-pg `
  --command-id RunShellScript `
  --scripts "curl -fsS http://127.0.0.1:3000/api/health" `
  --query "value[0].message" -o tsv
```

The health response must report `ok`, `db`, and `collab` as `true`. Do not open
ports 80 or 443 until DNS points the intended hostname to `markdoc-web-ip` and
TLS has been configured.
