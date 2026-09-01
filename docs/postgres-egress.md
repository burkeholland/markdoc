# PostgreSQL egress: retiring the NAT gateway

How to move the PostgreSQL VM `markdoc-pg` off the NAT gateway `markdoc-pg-egress` (+ `markdoc-pg-egress-ip`, ≈ $36.53/month) onto two explicit, cheaper paths without touching backups or the database: a free `Microsoft.KeyVault` service endpoint on the `postgres` subnet, and an Azure Monitor Private Link Scope reached through one private endpoint (≈ $9.83/month). The NAT only ever carried Azure Monitor agent telemetry (~1 MB/h); pgBackRest, the backup health uploads and the weekly restore check already bypass it through the `Microsoft.Storage` service endpoint, and Key Vault is read only during operator-driven password rotation.

Nothing in the repo runs this automatically. Run the phases in order, in a maintenance window, one phase per sitting if you like: every phase is additive or reversible on its own, and the NAT stays attached until Phase 3. Every **verify** command below is read-only and none prints a secret. The best window starts ≥ 2 h before 02:30 UTC so the soak includes the pgBackRest full (02:30Z) and logical (03:30Z) backup jobs.

The code side landed in two parts:

- **Part 1 (merged with this document, task #1078):** `infra/main.bicep` declares the Key Vault service endpoint on the subnet and invokes the standalone module `infra/postgres-private-egress.bicep` (DCE, AMPLS, private endpoint, private DNS zones, `configurationAccessEndpoint` association). Until Part 2 the NAT gateway was still declared, so a full `deploy/azure.ps1` run converged on *both* paths. `deploy/azure.ps1 -ConfigureRecovery` now attaches the temporary bootstrap public IP (as `-InitializeDatabase` always did) so package installs keep an explicit egress path once the NAT is gone; it is removed afterwards whether setup succeeds or fails.
- **Part 2 (merged 2026-09-01, task #1321, after the Phase 4 check passed):** `postgresNatIp`, `postgresNatGateway`, the subnet `natGateway` reference and the `postgresNatGatewayName` output were removed from `infra/main.bicep`; `deploy/azure-safety.tests.ps1` pins their absence. The template no longer declares the NAT, so `deploy/azure.ps1` is safe again (an incremental ARM deployment never deletes, so the still-existing gateway and IP are simply ignored until Phase 5 deletes them by hand).

## 1. Before you start

**Facts (read-only, `markdoc-rg`, East US 2; confirmed 2026-08-30)**

| Fact | Value | Read with |
| --- | --- | --- |
| VNet / subnet / prefix | `markdoc-vnet` / `postgres` / `10.42.2.0/24` | `az network vnet subnet show -g markdoc-rg --vnet-name markdoc-vnet -n postgres --query "{prefix:addressPrefix, endpoints:serviceEndpoints[].service, nat:natGateway.id, pePolicies:privateEndpointNetworkPolicies}"` |
| Subnet today | service endpoints `Microsoft.Storage` only; `natGateway` attached; `privateEndpointNetworkPolicies: Disabled` (the NSG does not apply to private endpoint NICs) | same command |
| VM / NIC / private IP | `markdoc-pg` / `markdoc-pg-nic` / `10.42.2.4`, no public IP | `az network nic show -g markdoc-rg -n markdoc-pg-nic --query "ipConfigurations[0].{ip:privateIPAddress, publicIp:publicIPAddress.id}"` |
| NAT gateway / IP | `markdoc-pg-egress` / `markdoc-pg-egress-ip` | `az network nat gateway show -g markdoc-rg -n markdoc-pg-egress --query "{id:id, ips:publicIpAddresses[].id}"` |
| Log Analytics workspace | `markdoc-logs`; its `customerId` is the `<workspace-id>` used in KQL commands and agent hostnames | `az monitor log-analytics workspace show -g markdoc-rg -n markdoc-logs --query customerId -o tsv` |
| Existing agent wiring (stays untouched) | DCR `markdoc-postgres-backup` + rule association `markdoc-postgres-backup` on the VM; the new `configurationAccessEndpoint` association is a *second* association (endpoint, not rule) | `az monitor data-collection rule association list --resource $(az vm show -g markdoc-rg -n markdoc-pg --query id -o tsv) --query "[].{name:name, rule:dataCollectionRuleId!=null, endpoint:dataCollectionEndpointId!=null}" -o table` |
| Key Vault (name only) | `markdockvmnd542unepl56`, public network access enabled, no firewall. Do **not** add a vault firewall in this change: `deploy/azure.ps1` writes secrets from the operator's machine. | `az keyvault show -g markdoc-rg -n markdockvmnd542unepl56 --query "properties.{public:publicNetworkAccess, acls:networkAcls.defaultAction}"` |
| Recovery storage account | `mdrrrkpb6rlcowxc`, `defaultAction: Deny`, one VNet rule for the `postgres` subnet — proof that backups already use the Storage service endpoint, not the NAT | `az storage account show -g markdoc-rg -n mdrrrkpb6rlcowxc --query "networkRuleSet.{default:defaultAction, vnetRules:length(virtualNetworkRules), ipRules:length(ipRules)}"` |
| Alert rules (the tripwire) | `markdoc-postgres-backup-heartbeat` (no `backup-health=ok` for 15 min) and `markdoc-postgres-backup-failure`, both `enabled` | `az monitor scheduled-query show -g markdoc-rg -n markdoc-postgres-backup-heartbeat --query enabled -o tsv` |
| Health endpoint | `https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/api/health` → `ok=true`, `db=true` | `curl -s <url>` |

**What the module creates (17 resources, all new names; `what-if` in Phase 1b must show exactly these as `Create` and nothing as `Modify`/`Delete`)**

| Resource type | Name | Notes |
| --- | --- | --- |
| `Microsoft.Insights/dataCollectionEndpoints` | `markdoc-pg-dce` | `publicNetworkAccess: Enabled`; the private endpoint and DNS decide the path |
| `Microsoft.Insights/privateLinkScopes` | `markdoc-ampls` | ingestion `Open`, query `Open`, so the Container Apps environment (same workspace) keeps working through the same scope |
| `…/privateLinkScopes/scopedResources` ×2 | `markdoc-logs`, `markdoc-pg-dce` | workspace + DCE |
| `Microsoft.Insights/dataCollectionRuleAssociations` | `configurationAccessEndpoint` on `markdoc-pg` | exact name required by the Azure Monitor agent |
| `Microsoft.Network/privateEndpoints` | `markdoc-ampls-pe` | subnet `postgres`, `groupIds: [azuremonitor]`, connection `markdoc-ampls-pe`; gets a `10.42.2.x` address |
| `Microsoft.Network/privateDnsZones` ×5 + `virtualNetworkLinks` ×5 (`markdoc-vnet`, registration off) | `privatelink.monitor.azure.com`, `privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com`, `privatelink.agentsvc.azure-automation.net`, `privatelink.blob.core.windows.net` | Microsoft's documented AMPLS set. The blob zone only affects storage accounts that have a private endpoint somewhere; `mdrrrkpb6rlcowxc` has none and keeps resolving publicly through the Storage service endpoint |
| `…/privateEndpoints/privateDnsZoneGroups` | `default` | one config per zone; Azure writes the A records |

Why no NSG change: the private endpoint address is inside the VNet, so the VM's outbound traffic to it matches the default `AllowVnetOutBound` rule; the custom deny rule (`DenyOtherInternetEgress`) only covers `Internet`. The existing `AllowAzureMonitorEgress` / `AllowKeyVaultEgress` rules stay and become dormant.

**Egress safety net and trap.** The subnet is a non-private subnet (created with API 2024-05-01, `defaultOutboundAccess` unset), so detaching the NAT does *not* cut the VM off: it silently falls back to Azure "default outbound access" through a Microsoft-owned IP that can change without notice. That is a safety net during the migration and a trap for verification — a broken private path is masked. The Phase 2 gate (NAT bytes = 0 *while the NAT is still attached*) and the private-endpoint byte counters are therefore the real proof, not "the heartbeat still arrives". Phase 6 closes the fallback.

## 2. Phase 1a: Key Vault service endpoint

Adds the free `Microsoft.KeyVault` service endpoint next to `Microsoft.Storage`; `--service-endpoints` replaces the list, so always name both. Traffic to the vault moves to the Azure backbone with the VM's private source address; no vault firewall change is needed or wanted. `infra/main.bicep` declares the same two endpoints, so a later full deployment converges rather than reverting this.

```bash
az network vnet subnet update -g markdoc-rg --vnet-name markdoc-vnet -n postgres --service-endpoints Microsoft.Storage Microsoft.KeyVault
```

Verify:

```bash
az network vnet subnet show -g markdoc-rg --vnet-name markdoc-vnet -n postgres --query "serviceEndpoints[].service" -o tsv
```

→ both `Microsoft.Storage` and `Microsoft.KeyVault`.

```bash
az network nic show-effective-route-table -g markdoc-rg -n markdoc-pg-nic --query "length(value[?nextHopType=='VirtualNetworkServiceEndpoint'])"
```

→ rises from 2 to ≥ 3 (allow a minute).

Path test from the VM (no secret is read; any HTTP status proves reachability, a timeout does not):

```bash
az vm run-command invoke -g markdoc-rg -n markdoc-pg --command-id RunShellScript --scripts "curl -sS -o /dev/null -w '%{http_code}\n' https://markdockvmnd542unepl56.vault.azure.net/healthstatus" --query "value[0].message" -o tsv
```

→ contains `200`.

Rollback (seconds, no data path involved):

```bash
az network vnet subnet update -g markdoc-rg --vnet-name markdoc-vnet -n postgres --service-endpoints Microsoft.Storage
```

## 3. Phase 1b: deploy the private Azure Monitor path (module)

Run from a checkout of `main` at or after the commit that added `infra/postgres-private-egress.bicep`. The module has no secure parameters; every value below is a name, and the defaults already equal them (they are spelled out so the command and the template visibly agree).

Preview first — read-only:

```bash
az deployment group what-if -g markdoc-rg --template-file infra/postgres-private-egress.bicep --parameters name=markdoc location=eastus2 vnetName=markdoc-vnet subnetName=postgres logAnalyticsWorkspaceName=markdoc-logs postgresVmName=markdoc-pg
```

Expected: **17 to create** (the table in section 1), **0 to modify, 0 to delete**; existing resources in the group are listed as "ignore"/"no change" only. If any *existing* resource shows as Modify or Delete, stop and fix the template. (Re-running the what-if later as an idempotency check on an *applied* deployment reports Modify entries that are `Delete`s of server-populated properties absent from the template — `immutableId`, `scopeId`, `resolutionPolicy`, `isIPv6EnabledPrivateEndpoint`, zone-group child etags; Create 0 / Delete 0 is the real test.) Then create:

```bash
az deployment group create -g markdoc-rg -n markdoc-postgres-private-egress --template-file infra/postgres-private-egress.bicep --parameters name=markdoc location=eastus2 vnetName=markdoc-vnet subnetName=postgres logAnalyticsWorkspaceName=markdoc-logs postgresVmName=markdoc-pg
```

Takes a few minutes (the private endpoint is the slow part). From this moment every resolver in `markdoc-vnet` — the VM *and* the Container Apps environment — resolves the Azure Monitor hostnames to the private endpoint; the NAT is still attached and still carries anything that is not yet re-resolved.

Verify, **≥ 15 min after** the deployment (agent re-resolves and re-authenticates in the background; `<workspace-id>` is the workspace `customerId` from section 1):

```bash
az deployment group show -g markdoc-rg -n markdoc-postgres-private-egress --query "properties.{state:provisioningState, outputs:outputs}"
```

→ `Succeeded`, three output ids (`privateEndpointId`, `dataCollectionEndpointId`, `privateLinkScopeId`).

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "Heartbeat | where Computer == 'markdoc-pg' and TimeGenerated > ago(15m) | count" -o table
```

→ ≥ 10.

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "Syslog | where Facility == 'local0' and SyslogMessage contains 'backup-health=ok' and TimeGenerated > ago(15m) | count" -o table
```

→ ≥ 5.

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "ContainerAppSystemLogs_CL | where TimeGenerated > ago(30m) | count" -o table
```

→ > 0 (Container Apps logs still arrive, now through the private endpoint).

```bash
az vm run-command invoke -g markdoc-rg -n markdoc-pg --command-id RunShellScript --scripts "getent hosts <workspace-id>.ods.opinsights.azure.com; getent hosts global.handler.control.monitor.azure.com" --query "value[0].message" -o tsv
```

→ both resolve to `10.42.2.x` (the private endpoint), not to public addresses.

```bash
az monitor metrics list --resource $(az network private-endpoint show -g markdoc-rg -n markdoc-ampls-pe --query id -o tsv) --metrics PEBytesIn PEBytesOut --aggregation Total --interval PT5M --offset 1h --query "value[].{metric:name.value, buckets:timeseries[0].data[].total}" -o json
```

→ non-zero buckets on both.

```bash
az vm get-instance-view -g markdoc-rg -n markdoc-pg --query "instanceView.extensions[?name=='AzureMonitorLinuxAgent'].statuses[0].displayStatus" -o tsv
```

→ `Provisioning succeeded`.

```bash
az monitor data-collection rule association list --resource $(az vm show -g markdoc-rg -n markdoc-pg --query id -o tsv) --query "[].{name:name, rule:dataCollectionRuleId!=null, endpoint:dataCollectionEndpointId!=null}" -o table
```

→ two rows: `markdoc-postgres-backup` (rule) and `configurationAccessEndpoint` (endpoint).

Rollback Phase 1b — **links first**: an empty private zone that is still linked answers NXDOMAIN for the agent hostnames, which is worse than the public answer. Once the links are gone DNS returns to public within TTL and the agent resumes over the NAT. The AMPLS and DCE may stay (inert and free) or go with the rest of the deployment's resources:

```bash
az network private-dns link vnet delete -g markdoc-rg -z privatelink.monitor.azure.com -n markdoc-vnet -y
az network private-dns link vnet delete -g markdoc-rg -z privatelink.oms.opinsights.azure.com -n markdoc-vnet -y
az network private-dns link vnet delete -g markdoc-rg -z privatelink.ods.opinsights.azure.com -n markdoc-vnet -y
az network private-dns link vnet delete -g markdoc-rg -z privatelink.agentsvc.azure-automation.net -n markdoc-vnet -y
az network private-dns link vnet delete -g markdoc-rg -z privatelink.blob.core.windows.net -n markdoc-vnet -y
az network private-endpoint delete -g markdoc-rg -n markdoc-ampls-pe
az monitor data-collection rule association delete --association-name configurationAccessEndpoint --resource-uri $(az vm show -g markdoc-rg -n markdoc-pg --query id -o tsv) -y
```

After a rollback the template is ahead of Azure: the next full `deploy/azure.ps1` run recreates these resources. Either fix the cause before the next deployment or revert the module reference in `infra/main.bicep`.

## 4. Phase 2: soak ≥ 1 h with the NAT still attached (the gate)

Nothing may use the NAT any more. Gate:

```bash
az monitor metrics list --resource $(az network nat gateway show -g markdoc-rg -n markdoc-pg-egress --query id -o tsv) --metrics ByteCount --aggregation Total --interval PT15M --offset 1h --query "value[0].timeseries[0].data[].{t:timeStamp, bytes:total}" -o table
```

→ `bytes` null or 0 for **every** bucket of the last hour (`PacketCount` also null; `SNATConnectionCount` sits at a platform floor ≈ 277/15 min while the gateway is attached even with zero packets — not a consumer — and reads exactly 0 once it is detached, so a non-zero value after Phase 3 means something re-attached it). If bytes persist, find the consumer before continuing; the only candidates are the agent still on public DNS (re-run the `getent` check) or the Key Vault service endpoint not applied (Phase 1a verify).

Health, same hour:

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "Heartbeat | where Computer == 'markdoc-pg' and TimeGenerated > ago(1h) | count" -o table
```

→ ≥ 55.

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "Syslog | where Facility == 'local0' and SyslogMessage contains 'backup-health=ok' and TimeGenerated > ago(1h) | count" -o table
```

→ ≥ 25.

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "Syslog | where Facility == 'local0' and (SyslogMessage contains 'backup-health=failed' or SyslogMessage contains 'logical-backup=failed' or SyslogMessage contains 'restore-check=failed') and TimeGenerated > ago(1h) | count" -o table
```

→ 0.

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "ContainerAppSystemLogs_CL | where TimeGenerated > ago(1h) | count" -o table
```

→ > 0 (Container Apps logs still arriving).

```bash
az monitor scheduled-query show -g markdoc-rg -n markdoc-postgres-backup-heartbeat --query enabled -o tsv
az monitor scheduled-query show -g markdoc-rg -n markdoc-postgres-backup-failure --query enabled -o tsv
```

→ `true`, `true`, and no fired alert:

```bash
az rest --method get --url "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/resourceGroups/markdoc-rg/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview&timeRange=1d" --query "value[].properties.essentials.{rule:alertRule, state:alertState, since:startDateTime}" -o table
```

→ empty (or only alerts that predate Phase 1). On Windows pass the query string with `--url-parameters api-version=2019-05-05-preview timeRange=1d` instead of writing it into `--url`; `az.cmd` splits a URL at `&`.

## 5. Phase 3: detach the NAT

Existing flows reset; new flows use the private endpoint and the service endpoints.

```bash
az network vnet subnet update -g markdoc-rg --vnet-name markdoc-vnet -n postgres --remove natGateway
```

Verify for **≥ 1 h** (include the 02:30Z / 03:30Z jobs if the window allows). Repeat the Phase 2 Log Analytics assertions (Heartbeat ≥ 55/h, `backup-health=ok` ≥ 25/h, zero `*=failed`, Container Apps logs arriving, alert rules enabled, nothing fired), re-run the `PEBytesIn PEBytesOut` command from Phase 1b (non-zero in the latest buckets proves the traffic is on the private path, not on the implicit default outbound IP), re-run the Key Vault path test from Phase 1a (still an HTTP status), and:

```bash
az network vnet subnet show -g markdoc-rg --vnet-name markdoc-vnet -n postgres --query natGateway
```

→ `null`.

```bash
curl -s https://markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io/api/health
```

→ HTTP 200 with `ok=true`, `db=true`.

```bash
az vm run-command invoke -g markdoc-rg -n markdoc-pg --command-id RunShellScript --scripts "sudo -u postgres psql -Atc 'select last_archived_time, extract(epoch from now()-last_archived_time)::int, failed_count from pg_stat_archiver'; sudo find \$(sudo -u postgres psql -Atc 'show data_directory')/pg_wal/archive_status -name '*.ready' | wc -l" --query "value[0].message" -o tsv
```

→ `last_archived_time` newer than the last forced switch (the 02:30Z pgBackRest backup) **or** 0 pending `.ready` segments with `failed_count` unchanged between two runs. Do not read the age alone: an idle database fails a literal "age ≤ 300 s" check by definition (#1108 measured age 15 996 s with 0 `.ready`, 0 failed — healthy).

```bash
az vm run-command invoke -g markdoc-rg -n markdoc-pg --command-id RunShellScript --scripts "sudo -u postgres pgbackrest --stanza=markdoc info" --query "value[0].message" -o tsv
```

→ last full backup within 26 h, `status: ok`.

Two `az vm run-command invoke` habits: it returns only the last ≈ 4 KB of stdout, so put `pgbackrest info` last in a combined script or `head` it; and `--scripts @file.sh` sends a local file, which avoids every `az.cmd` quoting hazard on Windows (nested quotes, `$`, `|`). Keep read-only scripts read-only — no `pgbackrest check` (section 6, correction iii).

```bash
az backup job list -g markdoc-rg -v markdoc-backup --status Completed --operation Backup --start-date <today, DD-MM-YYYY> -o table
```

→ the next daily VM backup job `Completed`.

Rollback (~1 min):

```bash
az network vnet subnet update -g markdoc-rg --vnet-name markdoc-vnet -n postgres --nat-gateway markdoc-pg-egress
```

## 6. Phase 4: verify again (24 h recommended, ≥ 1 h minimum)

Same assertions as Phase 3 over a full day; additionally confirm the weekly Sunday 05:00Z `markdoc-restore-check` if the window allows:

```bash
az monitor log-analytics query -w <workspace-id> --analytics-query "Syslog | where Facility == 'local0' and SyslogMessage contains 'restore-check=ok' and TimeGenerated > ago(7d) | summarize count(), max(TimeGenerated)" -o table
```

**Result (task #1298):** T0 = 2026-08-30T22:32:31Z (the Phase 3 detach, task #1108); the check run 2026-08-31T23:46Z → 2026-09-01T00:09Z (= T0 + 25 h) passed — Heartbeat 60 in all 24 full hours, `backup-health=ok` ≥ 29/h, `*=failed` 0, alerts fired 0, pgBackRest full `20260831-023757F` + logical backup + Azure Backup job all `Completed` after T0, archiver `failed_count` 0 / `.ready` 0, NAT `ByteCount`/`PacketCount` no data points, `SNATConnectionCount` 0 from 22:45Z, PE bytes non-zero every hour, exactly one subnet write in the activity log (the detach itself); the Sunday restore drill was not due inside the window (last 2026-08-30T05:17Z), so it is a Phase 5 precondition below. Three corrections learned there: (i) `az monitor activity-log list -g markdoc-rg --start-time <T0>` **without** `--end-time <now> --max-events 1000` returned a stale subset (8 rows, nothing after 04:19Z; the explicit form returned all 47) — always write `az monitor activity-log list -g markdoc-rg --start-time <T0> --end-time <now> --max-events 1000`; (ii) the alerts `az rest … timeRange=1d` run a day later misses T0 → T0 + 78 min — use `timeRange=7d` and filter `startDateTime ≥ T0` in PowerShell; (iii) pgBackRest logs to its own journal, not `local0`, so the Syslog table has no 02:30Z marker — the proof is `pgbackrest info` (`status: ok`, newest full label after T0) plus `journalctl -u markdoc-pgbackrest-full` via a read-only run-command, and `pgbackrest check` must stay out of any read-only script (it forces a WAL switch = a repository write).

Once this passes, file the Part 2 template change (remove the NAT resources from `infra/main.bicep`) — done for this environment: Part 2 is merged (2026-09-01, task #1321), so `deploy/azure.ps1` no longer re-attaches the NAT; before the merge a run would have converged on the template and undone Phase 3.

## 7. Phase 5: delete the NAT gateway and its IP (Part 2 is merged; wait for the restore drill)

Precondition: the Sunday `restore-check=ok` line (the section 6 query) has been logged at least once **after** T0 = 2026-08-30T22:32:31Z — first chance 2026-09-06T05:08Z — so the restore path has run once without the NAT before anything is deleted.

```bash
az network nat gateway delete -g markdoc-rg -n markdoc-pg-egress
az network public-ip delete -g markdoc-rg -n markdoc-pg-egress-ip
```

Verify: `az network nat gateway list -g markdoc-rg -o table` and `az network public-ip list -g markdoc-rg -o table` no longer list them; the Phase 3 assertions still hold an hour later. Drop the "deleted by hand per `docs/postgres-egress.md` §7" clause from the README cost table row in the same change.

Rollback after deletion (a *new* public address; nothing whitelists it, so nothing else needs updating; ~3 min end to end):

```bash
az network public-ip create -g markdoc-rg -n markdoc-pg-egress-ip -l eastus2 --sku Standard --allocation-method Static
az network nat gateway create -g markdoc-rg -n markdoc-pg-egress -l eastus2 --public-ip-addresses markdoc-pg-egress-ip --idle-timeout 4
az network vnet subnet update -g markdoc-rg --vnet-name markdoc-vnet -n postgres --nat-gateway markdoc-pg-egress
```

## 8. Phase 6 (optional hardening, separate window): make the subnet private

Only after this does egress become strictly limited to the service-endpoint and private-endpoint paths (no default outbound access). It needs a VM stop/deallocate to bind to the NIC, which is **3–5 min of database downtime**: `/api/health` reports `db=false` and the app's liveness probe does not depend on the database, so the app stays up and recovers when PostgreSQL returns. Bundle it with a planned OS patch reboot rather than with the phases above, and set `defaultOutboundAccess: false` on the `postgres` subnet in `infra/main.bicep` in the same change so the template agrees.

```bash
az network vnet subnet update -g markdoc-rg --vnet-name markdoc-vnet -n postgres --default-outbound false
az vm deallocate -g markdoc-rg -n markdoc-pg
az vm start -g markdoc-rg -n markdoc-pg
```

Verify: the Phase 3 assertions, `/api/health` back to `db=true`, and the Key Vault path test still answers (it uses the service endpoint). Rollback: `--default-outbound true` plus another deallocate/start.

## 9. Triggers

**Failure triggers that mean "re-attach the NAT now" (Phases 3–5):** `Heartbeat` rows for `markdoc-pg` = 0 in any 10-minute window; `backup-health=ok` rows = 0 for 10 min or any `*=failed` row; either alert rule fires; AMA extension status ≠ `Provisioning succeeded` or VM agent ≠ `Ready`; Key Vault `/healthstatus` times out; `pg_stat_archiver` `failed_count` increasing, or `last_archived_time` older than the last forced switch (the 02:30Z pgBackRest backup) **while** pending `.ready` segments are > 0 (an idle database with none fails a literal "age ≤ 300 s" check by definition — that alone is not a trigger); the first daily pgBackRest/logical/Azure Backup job after the change not `Completed`.

**Trigger that means "roll back Phase 1b (DNS), not the NAT":** `ContainerAppSystemLogs_CL`/`ContainerAppConsoleLogs_CL` stop for 30 min while VM heartbeats continue.

Re-attach = the Phase 3 rollback command (Phase 5 rollback once the NAT is deleted). Roll back DNS = the Phase 1b rollback commands.

## 10. Maintenance after retirement

- **Package installs on the VM** (`deploy/azure.ps1 -ConfigureRecovery`, and `-InitializeDatabase` for a new environment) attach the temporary `markdoc-pg-bootstrap-ip` and the temporary `AllowApprovedPackageSetup` NSG rule for the duration of the run and remove both afterwards, so they do not depend on the subnet's egress path (before Part 1, `-ConfigureRecovery` on its own relied on the NAT for apt). Run `-ConfigureRecovery` on its own (the documented form): `deploy/azure.ps1` refuses it combined with `-RotateDatabasePassword`, because the rotation paths deploy without the bootstrap IP and would otherwise ride default outbound access for apt.
- **Password rotation** (`-RotateDatabasePassword`) reads Key Vault over the service endpoint and needs nothing else.
- **Re-introduce a NAT gateway only** if a recurring internet-only dependency appears (a destination outside `Storage`, `AzureMonitor`, `AzureKeyVault` needed more often than the monthly maintenance path) or if NAT-worthy volume appears (> 100 GB/month).
- Observed, not changed here: the VM has no automatic security patching in steady state (apt is denied by design). Define a patch cadence via `-ConfigureRecovery` or a scheduled temporary-egress runbook separately.
