// Markdoc on Azure: Container Apps (app + WebSocket), a private PostgreSQL VM,
// Container Registry, Log Analytics, and PostgreSQL-aware off-VM recovery.
// Deploy with deploy/azure.ps1 or:
//   az deployment group create -g <rg> -f infra/main.bicep -p @<parameters.json>
//
// Hocuspocus keeps open documents in memory, so the app runs as exactly one replica.
// Scaling out needs the Redis extension (not included to keep costs down).

targetScope = 'resourceGroup'

@description('Base name for all resources (lowercase letters and digits).')
@minLength(3)
@maxLength(20)
param name string = 'markdoc'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Container image to run, preferably an immutable markdocacr.azurecr.io/markdoc@sha256:<digest> reference. Leave empty on the first deployment to create infrastructure without the app.')
param image string = ''

@description('Immutable application source version reported by /api/health.')
param appVersion string = ''

@description('Minimum replicas. 1 keeps the collaboration server warm; 0 scales to zero when nobody is connected.')
@allowed([0, 1])
param minReplicas int = 1

@description('CPU cores for the app container.')
@allowed(['0.25', '0.5', '0.75', '1.0'])
param cpu string = '0.5'

@description('Memory for the app container (must match the CPU tier, e.g. 0.5Gi for 0.25 CPU, 1Gi for 0.5 CPU).')
param memory string = '1Gi'

@secure()
@description('PostgreSQL administrator password.')
param postgresAdminPassword string

@secure()
@description('Candidate PostgreSQL administrator password used only during explicit rotation.')
param postgresCandidatePassword string

@secure()
@description('Auth.js secret (random 32+ bytes). Also signs collaboration tokens.')
param authSecret string

@secure()
@description('GitHub OAuth App client ID.')
param githubClientId string

@secure()
@description('GitHub OAuth App client secret.')
param githubClientSecret string

@secure()
@description('Email receiver for production database recovery alerts.')
param alertEmailAddress string

@secure()
@description('An SSH public key whose private key is not retained. Azure Run Command remains available for maintenance.')
param vmAdminSshPublicKey string

@description('Administrator username for the PostgreSQL VM.')
param vmAdminUsername string = 'markdocops'

@description('Public URL of the app (for Auth.js callbacks). Leave empty to use the Container App FQDN.')
param publicUrl string = ''

@description('Attach a deny-inbound public IP temporarily for approved database or recovery package setup. The deploy script always removes it afterward.')
param bootstrapPublicIp bool = false

@description('Protect the PostgreSQL VM after the deploy script sets the vault to locally redundant storage.')
param enableVmBackup bool = false

@description('Create or rotate the PostgreSQL login. Ordinary application redeployments must leave this false.')
param configureDatabase bool = false

@description('Rotate the PostgreSQL login with the rollback-capable managed run command. Ordinary application redeployments must leave this false.')
param rotateDatabasePassword bool = false

@description('Promote a successfully rotated PostgreSQL password to the active Key Vault secret.')
param commitDatabasePassword bool = false

@description('Restore the pre-rotation PostgreSQL password to the active Key Vault secrets during compensation.')
param restoreDatabasePassword bool = false

@description('Disable and overwrite the temporary PostgreSQL rotation candidate after a terminal result.')
param clearPendingDatabasePassword bool = false

@description('Reconcile PostgreSQL back to the pre-rotation credential after a failed application rollout.')
param reconcileDatabasePassword bool = false

@description('Exercise the pre-change password rotation failure path without modifying PostgreSQL.')
param simulateDatabaseRotationFailure bool = false

@description('Install or update PostgreSQL recovery services. Ordinary application redeployments must leave this false.')
param configureRecovery bool = false

@description('Exercise recovery deployment cleanup after temporary package egress has been enabled.')
param simulateRecoveryConfigurationFailure bool = false

@description('Explicit token that makes the database bootstrap extension rerun during an approved password rotation.')
param databaseConfigurationToken string = 'initial'

@description('Changes the Container App revision for every explicit deployment, including secret-only OAuth updates.')
param deploymentConfigurationToken string = 'manual'

@description('Explicit version for an approved recovery configuration update.')
param recoveryConfigurationVersion string = 'v1'

var registryName = replace('${name}acr${uniqueString(resourceGroup().id)}', '-', '')
var keyVaultName = take(replace('${name}kv${uniqueString(resourceGroup().id)}', '-', ''), 24)
var recoveryStorageName = 'mdr${uniqueString(resourceGroup().id, name)}'
var recoveryContainerName = 'postgres-backups'
var postgresVmName = '${name}-pg'
var postgresNicName = '${postgresVmName}-nic'
var postgresNsgName = '${postgresVmName}-nsg'
var postgresBootstrapIpName = '${postgresVmName}-bootstrap-ip'
var postgresPrivateIp = '10.42.2.4'
var postgresAdminLogin = 'markdoc'
var postgresDatabaseName = 'markdoc'
var postgresPasswordSecretName = 'postgres-admin-password'
var postgresPendingPasswordSecretName = 'postgres-admin-password-pending'
var postgresRollbackPasswordSecretName = 'postgres-admin-password-rollback'
var databaseUrlSecretName = 'database-url'
var vnetName = '${name}-vnet'
var environmentName = '${name}-prod-env'
var appSubnetName = 'container-apps'
var appSubnetPrefix = '10.42.0.0/23'
var postgresSubnetName = 'postgres'
var postgresSubnetPrefix = '10.42.2.0/24'
var backupVaultName = '${name}-backup'
var backupPolicyName = 'daily-7-days'
var backupFabric = 'Azure'
var backupProtectionContainer = 'iaasvmcontainer;iaasvmcontainerv2;${resourceGroup().name};${postgresVmName}'
var backupProtectedItem = 'vm;iaasvmcontainerv2;${resourceGroup().name};${postgresVmName}'
var backupTime = '2026-01-01T02:00:00Z'
#disable-next-line BCP329
var keyVaultDnsHost = substring(az.environment().suffixes.keyvaultDns, 1, length(az.environment().suffixes.keyvaultDns) - 1)
var keyVaultAudience = uriComponent('https://${keyVaultDnsHost}')
var keyVaultSecretUrl = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${postgresPasswordSecretName}?api-version=7.4'
var keyVaultPendingSecretUrl = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${postgresPendingPasswordSecretName}?api-version=7.4'
var keyVaultRollbackSecretUrl = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${postgresRollbackPasswordSecretName}?api-version=7.4'
var databaseUrlSecretUrl = 'https://${keyVaultName}${az.environment().suffixes.keyvaultDns}/secrets/${databaseUrlSecretName}'
var postgresBaseSecurityRules = [
  {
    name: 'AllowPostgresFromContainerApps'
    properties: {
      priority: 100
      access: 'Allow'
      direction: 'Inbound'
      protocol: 'Tcp'
      sourceAddressPrefix: appSubnetPrefix
      sourcePortRange: '*'
      destinationAddressPrefix: postgresPrivateIp
      destinationPortRange: '5432'
    }
  }
  {
    name: 'DenyAllInbound'
    properties: {
      priority: 110
      access: 'Deny'
      direction: 'Inbound'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '*'
    }
  }
  {
    name: 'AllowStorageEgress'
    properties: {
      priority: 200
      access: 'Allow'
      direction: 'Outbound'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'Storage'
      destinationPortRange: '443'
    }
  }
  {
    name: 'AllowAzureMonitorEgress'
    properties: {
      priority: 210
      access: 'Allow'
      direction: 'Outbound'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'AzureMonitor'
      destinationPortRange: '443'
    }
  }
  {
    name: 'AllowAzureResourceManagerEgress'
    properties: {
      priority: 220
      access: 'Allow'
      direction: 'Outbound'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'AzureResourceManager'
      destinationPortRange: '443'
    }
  }
  {
    name: 'AllowEntraEgress'
    properties: {
      priority: 230
      access: 'Allow'
      direction: 'Outbound'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'AzureActiveDirectory'
      destinationPortRange: '443'
    }
  }
  {
    name: 'AllowKeyVaultEgress'
    properties: {
      priority: 240
      access: 'Allow'
      direction: 'Outbound'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'AzureKeyVault'
      destinationPortRange: '443'
    }
  }
]
var postgresPackageSetupRules = (configureDatabase || configureRecovery) ? [
  {
    name: 'AllowApprovedPackageSetup'
    properties: {
      priority: 250
      access: 'Allow'
      direction: 'Outbound'
      protocol: 'Tcp'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'Internet'
      destinationPortRanges: [
        '80'
        '443'
      ]
    }
  }
] : []
var postgresDenyOutboundRules = [
  {
    name: 'DenyOtherInternetEgress'
    properties: {
      priority: 260
      access: 'Deny'
      direction: 'Outbound'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: 'Internet'
      destinationPortRange: '*'
    }
  }
]

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-identity'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'acrpull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource postgresNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: postgresNsgName
  location: location
  properties: {
    securityRules: concat(postgresBaseSecurityRules, postgresPackageSetupRules, postgresDenyOutboundRules)
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.42.0.0/16']
    }
  }
}

resource appSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: appSubnetName
  properties: {
    addressPrefix: appSubnetPrefix
    delegations: [
      {
        name: 'MicrosoftAppEnvironments'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: postgresSubnetName
  properties: {
    addressPrefix: postgresSubnetPrefix
    serviceEndpoints: [
      {
        service: 'Microsoft.Storage'
        locations: [
          location
        ]
      }
      {
        service: 'Microsoft.KeyVault'
      }
    ]
    networkSecurityGroup: {
      id: postgresNsg.id
    }
  }
}

resource postgresBootstrapIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (bootstrapPublicIp) {
  name: postgresBootstrapIpName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource postgresNic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: postgresNicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'primary'
        properties: union({
          privateIPAllocationMethod: 'Static'
          privateIPAddress: postgresPrivateIp
          subnet: {
            id: postgresSubnet.id
          }
        }, bootstrapPublicIp ? {
          publicIPAddress: {
            id: postgresBootstrapIp.id
          }
        } : {})
      }
    ]
  }
}

resource postgresVm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: postgresVmName
  location: location
  zones: ['1']
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1ms'
    }
    osProfile: {
      computerName: postgresVmName
      adminUsername: vmAdminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${vmAdminUsername}/.ssh/authorized_keys'
              keyData: vmAdminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server-gen1'
        version: 'latest'
      }
      osDisk: {
        name: '${postgresVmName}-os'
        createOption: 'FromImage'
        diskSizeGB: 32
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: postgresNic.id
          properties: {
            primary: true
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

resource secretsVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

var activePostgresPassword = commitDatabasePassword ? postgresCandidatePassword : postgresAdminPassword

resource postgresPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (configureDatabase || commitDatabasePassword || restoreDatabasePassword) {
  parent: secretsVault
  name: postgresPasswordSecretName
  properties: {
    value: activePostgresPassword
  }
}

resource appDatabaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (configureDatabase || commitDatabasePassword || restoreDatabasePassword) {
  parent: secretsVault
  name: databaseUrlSecretName
  properties: {
    value: 'postgres://${postgresAdminLogin}:${uriComponent(activePostgresPassword)}@${postgresPrivateIp}:5432/${postgresDatabaseName}?uselibpqcompat=true&sslmode=require'
  }
}

resource postgresPendingPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (rotateDatabasePassword || reconcileDatabasePassword || clearPendingDatabasePassword) {
  parent: secretsVault
  name: postgresPendingPasswordSecretName
  properties: {
    value: clearPendingDatabasePassword ? 'rotation-not-active' : postgresCandidatePassword
    attributes: {
      enabled: !clearPendingDatabasePassword
    }
  }
}

resource postgresRollbackPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (rotateDatabasePassword || reconcileDatabasePassword || clearPendingDatabasePassword) {
  parent: secretsVault
  name: postgresRollbackPasswordSecretName
  properties: {
    value: clearPendingDatabasePassword ? 'rotation-not-active' : postgresAdminPassword
    attributes: {
      enabled: !clearPendingDatabasePassword
    }
  }
}

resource postgresSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(secretsVault.id, postgresVm.id, 'key-vault-secrets-user')
  scope: secretsVault
  properties: {
    principalId: postgresVm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource appSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(secretsVault.id, identity.id, 'key-vault-secrets-user')
  scope: secretsVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

var postgresSetupScript = format('''
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl postgresql

TOKEN="$(curl -fsS -H Metadata:true 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource={0}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
for attempt in $(seq 1 30); do
  if ADMIN_PASSWORD="$(curl -fsS -H "Authorization: Bearer $TOKEN" '{1}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'Key Vault secret access did not become ready' >&2
    exit 1
  fi
  sleep 10
done

PG_CONFIG="$(sudo -u postgres psql -Atc 'show config_file')"
PG_HBA="$(sudo -u postgres psql -Atc 'show hba_file')"
if grep -Eq '^[# ]*listen_addresses[[:space:]]*=' "$PG_CONFIG"; then
  sed -ri "s|^[# ]*listen_addresses[[:space:]]*=.*|listen_addresses = '{2}'|" "$PG_CONFIG"
else
  echo "listen_addresses = '{2}'" >> "$PG_CONFIG"
fi
if grep -Eq '^[# ]*ssl[[:space:]]*=' "$PG_CONFIG"; then
  sed -ri 's|^[# ]*ssl[[:space:]]*=.*|ssl = on|' "$PG_CONFIG"
else
  echo 'ssl = on' >> "$PG_CONFIG"
fi
if ! grep -q 'markdoc-container-apps' "$PG_HBA"; then
  echo 'hostssl all all {3} scram-sha-256 # markdoc-container-apps' >> "$PG_HBA"
fi

sudo -u postgres psql \
  -v ON_ERROR_STOP=1 \
  --set=admin_password="$ADMIN_PASSWORD" <<'SQL'
select format(
  case
    when exists (select from pg_roles where rolname = '{4}')
      then 'alter role %I with login password %L'
    else 'create role %I with login password %L'
  end,
  '{4}',
  :'admin_password'
) \gexec
SQL
if ! sudo -u postgres psql -Atc "select 1 from pg_database where datname = '{5}'" | grep -qx 1; then
  sudo -u postgres createdb --owner={4} {5}
fi

unset ADMIN_PASSWORD TOKEN
systemctl restart postgresql
for attempt in $(seq 1 30); do
  pg_isready -h {2} -p 5432 -d {5} && exit 0
  sleep 2
done
echo 'PostgreSQL did not become ready' >&2
exit 1
''', keyVaultAudience, keyVaultSecretUrl, postgresPrivateIp, appSubnetPrefix, postgresAdminLogin, postgresDatabaseName)

resource postgresSetup 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = if (configureDatabase) {
  parent: postgresVm
  name: 'install-postgresql'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Extensions'
    type: 'CustomScript'
    typeHandlerVersion: '2.1'
    autoUpgradeMinorVersion: true
    forceUpdateTag: databaseConfigurationToken
    protectedSettings: {
      commandToExecute: 'bash -c "echo ${base64(postgresSetupScript)} | base64 -d | tr -d \'\\r\' | bash"'
    }
  }
  dependsOn: [
    postgresPasswordSecret
    postgresSecretReader
  ]
}

var postgresRotationScript = replace(format('''
#!/usr/bin/env bash
set -u -o pipefail
# Rotation configuration token: {0}

if ! TOKEN="$(curl -fsS -H Metadata:true 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource={1}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"; then
  echo 'database-password-rotation=failed stage=managed-identity'
  exit 0
fi
if ! ACTIVE_PASSWORD="$(curl -fsS --oauth2-bearer "$TOKEN" '{2}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"; then
  echo 'database-password-rotation=failed stage=active-secret'
  exit 0
fi
if ! CANDIDATE_PASSWORD="$(curl -fsS --oauth2-bearer "$TOKEN" '{3}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"; then
  echo 'database-password-rotation=failed stage=candidate-secret'
  exit 0
fi

PG_HBA="$(sudo -u postgres psql -Atc 'show hba_file')"
if ! grep -q 'markdoc-password-rotation' "$PG_HBA"; then
  sed -i '1ilocal all {4} scram-sha-256 # markdoc-password-rotation' "$PG_HBA"
  sudo -u postgres psql -Atc 'select pg_reload_conf()' >/dev/null
fi

if [ '{6}' = 'true' ]; then
  unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-rotation=failed stage=preflight-simulation'
  exit 0
fi

if PGPASSWORD="$CANDIDATE_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
  unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-rotation=already-committed'
  exit 0
fi

if ! PGPASSWORD="$ACTIVE_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
  unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-rotation=reconciliation-required stage=preflight'
  exit 0
fi

if ! sudo -u postgres psql \
  -v ON_ERROR_STOP=1 \
  --set=admin_password="$CANDIDATE_PASSWORD" <<'SQL'
select format('alter role %I with login password %L', '{4}', :'admin_password') \gexec
SQL
then
  unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-rotation=failed stage=alter'
  exit 0
fi

if PGPASSWORD="$CANDIDATE_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
  unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-rotation=committed'
  exit 0
fi

if sudo -u postgres psql \
  -v ON_ERROR_STOP=1 \
  --set=admin_password="$ACTIVE_PASSWORD" <<'SQL'
select format('alter role %I with login password %L', '{4}', :'admin_password') \gexec
SQL
then
  if PGPASSWORD="$ACTIVE_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
    unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
    echo 'database-password-rotation=rolled-back stage=candidate-verification'
    exit 0
  fi
fi

unset ACTIVE_PASSWORD CANDIDATE_PASSWORD TOKEN
echo 'database-password-rotation=reconciliation-required stage=rollback'
exit 0
''', databaseConfigurationToken, keyVaultAudience, keyVaultSecretUrl, keyVaultPendingSecretUrl, postgresAdminLogin, postgresDatabaseName, simulateDatabaseRotationFailure ? 'true' : 'false'), '\r', '')

resource postgresRotation 'Microsoft.Compute/virtualMachines/runCommands@2024-07-01' = if (rotateDatabasePassword) {
  parent: postgresVm
  name: 'rotate-postgresql-password'
  location: location
  properties: {
    asyncExecution: false
    timeoutInSeconds: 600
    source: {
      script: postgresRotationScript
    }
  }
  dependsOn: [
    postgresPendingPasswordSecret
    postgresRollbackPasswordSecret
    postgresSecretReader
  ]
}

var postgresReconciliationScript = replace(format('''
#!/usr/bin/env bash
set -u -o pipefail
# Reconciliation configuration token: {0}

if ! TOKEN="$(curl -fsS -H Metadata:true 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource={1}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"; then
  echo 'database-password-reconciliation=failed stage=managed-identity'
  exit 0
fi
if ! ROLLBACK_PASSWORD="$(curl -fsS --oauth2-bearer "$TOKEN" '{2}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"; then
  echo 'database-password-reconciliation=failed stage=rollback-secret'
  exit 0
fi
if ! CANDIDATE_PASSWORD="$(curl -fsS --oauth2-bearer "$TOKEN" '{3}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')"; then
  echo 'database-password-reconciliation=failed stage=candidate-secret'
  exit 0
fi
if [ -z "$ROLLBACK_PASSWORD" ] || [ "$ROLLBACK_PASSWORD" = 'rotation-not-active' ]; then
  unset ROLLBACK_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-reconciliation=failed stage=rollback-secret'
  exit 0
fi

PG_HBA="$(sudo -u postgres psql -Atc 'show hba_file')"
if ! grep -q 'markdoc-password-rotation' "$PG_HBA"; then
  sed -i '1ilocal all {4} scram-sha-256 # markdoc-password-rotation' "$PG_HBA"
  sudo -u postgres psql -Atc 'select pg_reload_conf()' >/dev/null
fi

if PGPASSWORD="$ROLLBACK_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
  unset ROLLBACK_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-reconciliation=already-active'
  exit 0
fi

if ! PGPASSWORD="$CANDIDATE_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
  unset ROLLBACK_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-reconciliation=failed stage=unknown-database-credential'
  exit 0
fi

if ! sudo -u postgres psql \
  -v ON_ERROR_STOP=1 \
  --set=admin_password="$ROLLBACK_PASSWORD" <<'SQL'
select format('alter role %I with login password %L', '{4}', :'admin_password') \gexec
SQL
then
  unset ROLLBACK_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-reconciliation=failed stage=alter'
  exit 0
fi

if PGPASSWORD="$ROLLBACK_PASSWORD" psql "host=/var/run/postgresql dbname={5} user={4}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then
  unset ROLLBACK_PASSWORD CANDIDATE_PASSWORD TOKEN
  echo 'database-password-reconciliation=rolled-back'
  exit 0
fi

unset ROLLBACK_PASSWORD CANDIDATE_PASSWORD TOKEN
echo 'database-password-reconciliation=failed stage=verification'
exit 0
''', databaseConfigurationToken, keyVaultAudience, keyVaultRollbackSecretUrl, keyVaultPendingSecretUrl, postgresAdminLogin, postgresDatabaseName), '\r', '')

resource postgresReconciliation 'Microsoft.Compute/virtualMachines/runCommands@2024-07-01' = if (reconcileDatabasePassword) {
  parent: postgresVm
  name: 'reconcile-postgresql-password'
  location: location
  properties: {
    asyncExecution: false
    timeoutInSeconds: 600
    source: {
      script: postgresReconciliationScript
    }
  }
  dependsOn: [
    postgresPendingPasswordSecret
    postgresRollbackPasswordSecret
    postgresSecretReader
  ]
}

resource recoveryStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: recoveryStorageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      virtualNetworkRules: [
        {
          action: 'Allow'
          id: postgresSubnet.id
        }
      ]
    }
  }
}

resource recoveryBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: recoveryStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource recoveryContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: recoveryBlobService
  name: recoveryContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource recoveryLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: recoveryStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-logical-backups'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${recoveryContainerName}/logical/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 30
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource postgresRecoveryContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(recoveryStorage.id, postgresVm.id, 'storage-blob-data-contributor')
  scope: recoveryStorage
  properties: {
    principalId: postgresVm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

var postgresRecoveryScriptBody = replace(
  replace(
    replace(loadTextContent('./postgres-recovery.sh'), '\r', ''),
    '__STORAGE_ACCOUNT__',
    recoveryStorage.name
  ),
  '__STORAGE_CONTAINER__',
  recoveryContainer.name
)
var postgresRecoveryFailureInjection = simulateRecoveryConfigurationFailure ? 'echo \'recovery-configuration=simulated-failure\'\nexit 42\n' : ''
var postgresRecoveryScript = '# Recovery configuration version: ${recoveryConfigurationVersion}\n${postgresRecoveryFailureInjection}${postgresRecoveryScriptBody}'

resource postgresRecovery 'Microsoft.Compute/virtualMachines/runCommands@2024-07-01' = if (configureRecovery) {
  parent: postgresVm
  name: 'configure-postgresql-recovery'
  location: location
  properties: {
    asyncExecution: false
    treatFailureAsDeploymentFailure: true
    timeoutInSeconds: 7200
    source: {
      script: postgresRecoveryScript
    }
  }
  dependsOn: [
    postgresRecoveryContributor
    postgresSetup
  ]
}

resource postgresMonitorRule 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: '${name}-postgres-backup'
  location: location
  kind: 'Linux'
  properties: {
    dataSources: {
      syslog: [
        {
          name: 'markdocBackupSyslog'
          facilityNames: [
            'local0'
          ]
          logLevels: [
            'Info'
            'Notice'
            'Warning'
            'Error'
            'Critical'
            'Alert'
            'Emergency'
          ]
          streams: [
            'Microsoft-Syslog'
          ]
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'markdocWorkspace'
          workspaceResourceId: logs.id
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-Syslog'
        ]
        destinations: [
          'markdocWorkspace'
        ]
      }
    ]
  }
}

resource postgresMonitorAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2023-03-11' = {
  name: '${name}-postgres-backup'
  scope: postgresVm
  properties: {
    dataCollectionRuleId: postgresMonitorRule.id
  }
}

resource postgresMonitorAgent 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = if (configureRecovery) {
  parent: postgresVm
  name: 'AzureMonitorLinuxAgent'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Monitor'
    type: 'AzureMonitorLinuxAgent'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
  }
  dependsOn: [
    postgresRecovery
    postgresMonitorAssociation
  ]
}

// Private Azure Monitor path for the VM agent (AMPLS + private endpoint + private DNS zones,
// and the configurationAccessEndpoint association next to the rule association above).
// Together with the subnet's Storage and Key Vault service endpoints this is the only egress the
// template declares: the retired egress gateway <name>-pg-egress and its public IP are gone from it
// (docs/postgres-egress.md §5-§7: detached 2026-08-30, 24 h check passed, Phase 5 deletes them by hand).
module postgresPrivateEgress './postgres-private-egress.bicep' = {
  name: '${name}-postgres-private-egress'
  params: {
    name: name
    location: location
    vnetName: vnet.name
    subnetName: postgresSubnet.name
    logAnalyticsWorkspaceName: logs.name
    postgresVmName: postgresVm.name
  }
}

resource postgresAlertActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${name}-postgres-alerts'
  location: 'Global'
  properties: {
    groupShortName: 'mdpgalerts'
    enabled: true
    emailReceivers: [
      {
        name: 'production-owner'
        emailAddress: alertEmailAddress
        useCommonAlertSchema: true
      }
    ]
  }
}

resource backupFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${name}-postgres-backup-failure'
  location: location
  properties: {
    displayName: 'Markdoc PostgreSQL backup failure'
    description: 'Fires when the VM backup monitor reports an archive, repository, or freshness failure, or when the monthly OS patch (infra/patch-os.sh) reports os-patch=failed.'
    enabled: true
    severity: 1
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    scopes: [
      logs.id
    ]
    targetResourceTypes: [
      'Microsoft.OperationalInsights/workspaces'
    ]
    criteria: {
      allOf: [
        {
          query: 'Syslog | where Facility == "local0" and (SyslogMessage contains "backup-health=failed" or SyslogMessage contains "logical-backup=failed" or SyslogMessage contains "restore-check=failed" or SyslogMessage contains "os-patch=failed")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        postgresAlertActionGroup.id
      ]
    }
  }
}

// Free tripwire for an egress window opened outside deploy/azure.ps1 -ConfigureRecovery or deploy/patch-postgres-vm.ps1:
// both write the temporary rule 250 exactly once per window, so any other write to a rule of the PostgreSQL NSG
// (Activity Log, no ingestion cost) means somebody opened an egress path by hand and the steady state needs checking.
resource postgresNsgRuleWriteAlert 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: '${name}-postgres-nsg-rule-write'
  location: 'Global'
  properties: {
    description: 'Fires on every successful write to a security rule of the PostgreSQL NSG. Expected once per recovery or OS patch window; anything else means an egress path was opened by hand.'
    enabled: true
    scopes: [
      postgresNsg.id
    ]
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        { field: 'operationName', equals: 'Microsoft.Network/networkSecurityGroups/securityRules/write' }
        { field: 'status', equals: 'Succeeded' }
      ]
    }
    actions: {
      actionGroups: [
        { actionGroupId: postgresAlertActionGroup.id }
      ]
    }
  }
}

resource backupHeartbeatAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${name}-postgres-backup-heartbeat'
  location: location
  properties: {
    displayName: 'Markdoc PostgreSQL backup monitor heartbeat missing'
    description: 'Fires when no successful PostgreSQL recovery health check reaches Log Analytics for ten minutes.'
    enabled: true
    severity: 1
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      logs.id
    ]
    targetResourceTypes: [
      'Microsoft.OperationalInsights/workspaces'
    ]
    criteria: {
      allOf: [
        {
          query: 'Syslog | where Facility == "local0" and ProcessName == "markdoc-backup-monitor" and SyslogMessage contains "backup-health=ok"'
          timeAggregation: 'Count'
          operator: 'LessThan'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        postgresAlertActionGroup.id
      ]
    }
  }
}

resource backupVault 'Microsoft.RecoveryServices/vaults@2023-06-01' = {
  name: backupVaultName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicNetworkAccess: 'Enabled'
  }
}

resource backupPolicy 'Microsoft.RecoveryServices/vaults/backupPolicies@2023-02-01' = {
  parent: backupVault
  name: backupPolicyName
  properties: {
    backupManagementType: 'AzureIaasVM'
    schedulePolicy: {
      schedulePolicyType: 'SimpleSchedulePolicy'
      scheduleRunFrequency: 'Daily'
      scheduleRunTimes: [backupTime]
    }
    retentionPolicy: {
      retentionPolicyType: 'LongTermRetentionPolicy'
      dailySchedule: {
        retentionTimes: [backupTime]
        retentionDuration: {
          count: 7
          durationType: 'Days'
        }
      }
    }
    timeZone: 'UTC'
  }
}

resource postgresBackup 'Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems@2023-02-01' = if (enableVmBackup) {
  name: '${backupVault.name}/${backupFabric}/${backupProtectionContainer}/${backupProtectedItem}'
  properties: {
    protectedItemType: 'Microsoft.Compute/virtualMachines'
    policyId: backupPolicy.id
    sourceResourceId: postgresVm.id
  }
}

// Every deployment re-PUTs backupPolicy, and Azure Backup answers each PUT with its built-in
// Sev0 "Modify policy with shorter retention" alert even though retention never changes.
// This rule strips the action groups from exactly that alert on this vault; backup-job
// failures and every other vault alert keep their normal routing.
resource backupPolicyRedeployAlertSuppression 'Microsoft.AlertsManagement/actionRules@2021-08-08' = {
  name: '${backupVaultName}-policy-redeploy-suppression'
  location: 'Global'
  properties: {
    description: 'Suppress the built-in Azure Backup alert raised when a Bicep deployment re-PUTs the unchanged ${backupPolicyName} policy. Only the policy-modification alert is affected.'
    enabled: true
    scopes: [
      backupVault.id
    ]
    conditions: [
      {
        field: 'MonitorService'
        operator: 'Equals'
        values: [
          'Azure Backup'
        ]
      }
      {
        field: 'Severity'
        operator: 'Equals'
        values: [
          'Sev0'
        ]
      }
      {
        field: 'Description'
        operator: 'Equals'
        values: [
          'A Modify Policy operation for RSVault has been executed'
        ]
      }
    ]
    actions: [
      {
        actionType: 'RemoveAllActionGroups'
      }
    ]
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      internal: false
      infrastructureSubnetId: appSubnet.id
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = if (!empty(image)) {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        stickySessions: { affinity: 'sticky' }
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        { name: 'auth-secret', value: authSecret }
        { name: 'github-client-secret', value: githubClientSecret }
        {
          name: 'database-url'
          keyVaultUrl: databaseUrlSecretUrl
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'markdoc'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
            { name: 'AUTH_GITHUB_ID', value: githubClientId }
            { name: 'AUTH_GITHUB_SECRET', secretRef: 'github-client-secret' }
            { name: 'AUTH_TRUST_HOST', value: 'true' }
            { name: 'AUTH_URL', value: empty(publicUrl) ? 'https://${name}.${environment.properties.defaultDomain}' : publicUrl }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DATABASE_SSL', value: '1' }
            { name: 'APP_VERSION', value: empty(appVersion) ? last(split(image, ':')) : appVersion }
            { name: 'DEPLOYMENT_CONFIGURATION_VERSION', value: deploymentConfigurationToken }
          ]
          // Startup waits for the full check (database round trip); Liveness must not: a slow or
          // restarting PostgreSQL is not a reason to kill a healthy process (task #987). The default
          // probe timeout is 1 s; a cold connection to the B1ms VM alone takes ~45 ms plus TLS jitter.
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/api/health', port: 3000 }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 5
              failureThreshold: 12
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/health?probe=live', port: 3000 }
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    acrPull
    appSecretReader
    appDatabaseUrlSecret
    postgresSetup
    postgresReconciliation
  ]
}

output appUrl string = 'https://${name}.${environment.properties.defaultDomain}'
output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output postgresHost string = postgresPrivateIp
output postgresVmName string = postgresVm.name
output backupVaultName string = backupVault.name
output recoveryStorageName string = recoveryStorage.name
output recoveryContainerName string = recoveryContainer.name
output bootstrapPublicIpName string = postgresBootstrapIpName
output postgresAlertActionGroupName string = postgresAlertActionGroup.name
output identityId string = identity.id
output secretsVaultName string = secretsVault.name
output secretsVaultId string = secretsVault.id
