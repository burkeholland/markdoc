// Markdoc on Azure: Container Apps (app + WebSocket), Azure Database for PostgreSQL Flexible Server,
// Container Registry, Log Analytics. Deploy with deploy/azure.ps1 or:
//   az deployment group create -g <rg> -f infra/main.bicep -p infra/main.bicepparam
//
// Cost notes (pay-as-you-go list prices, East US 2, August 2026, approximate):
//   Container App 0.5 vCPU / 1 GiB, 1 always-on replica ..... ~$34/month  (0.25/0.5 GiB: ~$14; scale to zero: ~$0 idle)
//   PostgreSQL Flexible Server B1ms, 32 GiB ................. ~$16/month  (stop it when not in use: storage only ~$4)
//   Container Registry Basic ................................ ~$5/month
//   Log Analytics (first 5 GiB/month free) ................... ~$0
// Total: roughly $40–55/month for a small team; ~$25 with the smaller app size.
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

@description('Container image to run, e.g. markdocacr.azurecr.io/markdoc:abc123. Leave empty on the first deployment to create the infrastructure with a placeholder image.')
param image string = ''

@description('Minimum replicas. 1 keeps the collaboration server warm; 0 scales to zero when nobody is connected (cold start on first open).')
@allowed([0, 1])
param minReplicas int = 1

@description('CPU cores for the app container.')
@allowed(['0.25', '0.5', '0.75', '1.0'])
param cpu string = '0.5'

@description('Memory for the app container (must match the CPU tier, e.g. 0.5Gi for 0.25 CPU, 1Gi for 0.5 CPU).')
param memory string = '1Gi'

@description('PostgreSQL administrator login.')
param postgresAdminLogin string = 'markdoc'

@secure()
@description('PostgreSQL administrator password.')
param postgresAdminPassword string

@secure()
@description('Auth.js secret (random 32+ bytes, e.g. `openssl rand -base64 32`). Also signs collaboration tokens.')
param authSecret string

@description('GitHub OAuth App client ID.')
param githubClientId string

@secure()
@description('GitHub OAuth App client secret.')
param githubClientSecret string

@description('Public URL of the app (for Auth.js callbacks). Leave empty to use the Container App FQDN.')
param publicUrl string = ''

var registryName = replace('${name}acr${uniqueString(resourceGroup().id)}', '-', '')
var postgresName = '${name}-pg-${uniqueString(resourceGroup().id)}'
var databaseName = 'markdoc'
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var appImage = empty(image) ? placeholderImage : image

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

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Disabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Container Apps egress uses Azure public IPs; allow Azure services (cheaper than VNet integration).
resource postgresAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-identity'
  location: location
}

// Let the app's identity pull from the registry (AcrPull).
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'acrpull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

var databaseUrl = 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'

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
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        // Collaborators must hit the same replica (there is only one) but this keeps sessions stable if max is ever raised.
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
        { name: 'database-url', value: databaseUrl }
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
  dependsOn: [acrPull, database, postgresAllowAzure]
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output identityId string = identity.id
