// Markdoc on Azure: Container Apps (app + WebSocket), a private PostgreSQL VM,
// Container Registry, Log Analytics, and Recovery Services backup.
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

@description('Container image to run, e.g. markdocacr.azurecr.io/markdoc:<git-sha>. Leave empty on the first deployment to create the infrastructure with a placeholder image.')
param image string = ''

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
@description('Auth.js secret (random 32+ bytes). Also signs collaboration tokens.')
param authSecret string

@secure()
@description('GitHub OAuth App client ID.')
param githubClientId string

@secure()
@description('GitHub OAuth App client secret.')
param githubClientSecret string

@secure()
@description('An SSH public key whose private key is not retained. Azure Run Command remains available for maintenance.')
param vmAdminSshPublicKey string

@description('Administrator username for the PostgreSQL VM.')
param vmAdminUsername string = 'markdocops'

@description('Public URL of the app (for Auth.js callbacks). Leave empty to use the Container App FQDN.')
param publicUrl string = ''

@description('Attach a locked-down public IP temporarily so the VM can install PostgreSQL. The deploy script removes it after bootstrap.')
param bootstrapPublicIp bool = false

@description('Protect the PostgreSQL VM after the deploy script sets the vault to locally redundant storage.')
param enableVmBackup bool = false

var registryName = replace('${name}acr${uniqueString(resourceGroup().id)}', '-', '')
var keyVaultName = take(replace('${name}kv${uniqueString(resourceGroup().id)}', '-', ''), 24)
var postgresVmName = '${name}-pg'
var postgresNicName = '${postgresVmName}-nic'
var postgresNsgName = '${postgresVmName}-nsg'
var postgresBootstrapIpName = '${postgresVmName}-bootstrap-ip'
var postgresPrivateIp = '10.42.2.4'
var postgresAdminLogin = 'markdoc'
var postgresDatabaseName = 'markdoc'
var postgresPasswordSecretName = 'postgres-admin-password'
var vnetName = '${name}-vnet'
var environmentName = '${name}-prod-env'
var appSubnetName = 'container-apps'
var appSubnetPrefix = '10.42.0.0/23'
var postgresSubnetName = 'postgres'
var postgresSubnetPrefix = '10.42.2.0/24'
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var appImage = empty(image) ? placeholderImage : image
var backupVaultName = '${name}-backup'
var backupPolicyName = 'daily-7-days'
var backupFabric = 'Azure'
var backupProtectionContainer = 'iaasvmcontainer;iaasvmcontainerv2;${resourceGroup().name};${postgresVmName}'
var backupProtectedItem = 'vm;iaasvmcontainerv2;${resourceGroup().name};${postgresVmName}'
var backupTime = '2026-01-01T02:00:00Z'
var keyVaultAudience = uriComponent('https://${az.environment().suffixes.keyvaultDns}')
var keyVaultSecretUrl = 'https://${keyVaultName}.${az.environment().suffixes.keyvaultDns}/secrets/${postgresPasswordSecretName}?api-version=7.4'

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
    securityRules: [
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
    ]
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

resource postgresPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: secretsVault
  name: postgresPasswordSecretName
  properties: {
    value: postgresAdminPassword
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

if sudo -u postgres psql -Atc "select 1 from pg_roles where rolname = '{4}'" | grep -qx 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "alter role {4} with login password '$ADMIN_PASSWORD'"
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "create role {4} with login password '$ADMIN_PASSWORD'"
fi
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

resource postgresSetup 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = {
  parent: postgresVm
  name: 'install-postgresql'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Extensions'
    type: 'CustomScript'
    typeHandlerVersion: '2.1'
    autoUpgradeMinorVersion: true
    protectedSettings: {
      commandToExecute: 'bash -c "echo ${base64(postgresSetupScript)} | base64 -d | tr -d \'\\r\' | bash"'
    }
  }
  dependsOn: [
    postgresPasswordSecret
    postgresSecretReader
  ]
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

resource app 'Microsoft.App/containerApps@2024-03-01' = {
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
      registries: empty(image)
        ? []
        : [
            {
              server: registry.properties.loginServer
              identity: identity.id
            }
          ]
      secrets: [
        { name: 'auth-secret', value: authSecret }
        { name: 'github-client-secret', value: githubClientSecret }
        #disable-next-line use-secure-value-for-secure-inputs
        { name: 'database-url', value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgresPrivateIp}:5432/${postgresDatabaseName}?sslmode=require' }
      ]
    }
    template: {
      containers: [
        {
          name: 'markdoc'
          image: appImage
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
            { name: 'APP_VERSION', value: empty(image) ? 'placeholder' : last(split(image, ':')) }
          ]
          probes: empty(image)
            ? []
            : [
                {
                  type: 'Startup'
                  httpGet: { path: '/api/health', port: 3000 }
                  initialDelaySeconds: 5
                  periodSeconds: 5
                  failureThreshold: 12
                }
                {
                  type: 'Liveness'
                  httpGet: { path: '/api/health', port: 3000 }
                  periodSeconds: 30
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
    postgresSetup
  ]
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output postgresHost string = postgresPrivateIp
output postgresVmName string = postgresVm.name
output backupVaultName string = backupVault.name
output bootstrapPublicIpName string = postgresBootstrapIpName
output identityId string = identity.id
