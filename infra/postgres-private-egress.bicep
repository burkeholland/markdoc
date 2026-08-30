// Private egress for the PostgreSQL VM's Azure Monitor agent: an Azure Monitor
// Private Link Scope reached through one private endpoint in the postgres subnet.
// Together with the Microsoft.KeyVault service endpoint on that subnet (main.bicep)
// this replaces the NAT gateway markdoc-pg-egress, which only carried agent
// telemetry. Backups never used the NAT: pgBackRest already rides the
// Microsoft.Storage service endpoint. Retirement runbook: docs/postgres-egress.md.
//
// Additive only. The NAT gateway stays in main.bicep and in Azure until the
// private path is verified in production; a later change removes it.
//
// Deployable on its own (no secure parameters, every default matches markdoc-rg):
//   az deployment group what-if -g markdoc-rg --template-file infra/postgres-private-egress.bicep
//   az deployment group create  -g markdoc-rg --template-file infra/postgres-private-egress.bicep
// main.bicep also invokes it as module postgresPrivateEgress so a full deployment
// converges on the same resources.

targetScope = 'resourceGroup'

@description('Base name shared with main.bicep; fixes the resource names the runbook expects.')
@minLength(3)
@maxLength(20)
param name string = 'markdoc'

@description('Azure region for the data collection endpoint and the private endpoint.')
param location string = resourceGroup().location

@description('Existing virtual network that hosts the PostgreSQL subnet and receives the private DNS zone links.')
param vnetName string = '${name}-vnet'

@description('Existing subnet that receives the Azure Monitor private endpoint.')
param subnetName string = 'postgres'

@description('Existing Log Analytics workspace that the Azure Monitor agent and the Container Apps environment write to.')
param logAnalyticsWorkspaceName string = '${name}-logs'

@description('Existing PostgreSQL VM that runs the Azure Monitor agent.')
param postgresVmName string = '${name}-pg'

var dataCollectionEndpointName = '${name}-pg-dce'
var privateLinkScopeName = '${name}-ampls'
var privateEndpointName = '${name}-ampls-pe'
// Microsoft's documented Azure Monitor Private Link zone set.
var privateDnsZoneNames = [
  'privatelink.monitor.azure.com'
  'privatelink.oms.opinsights.azure.com'
  'privatelink.ods.opinsights.azure.com'
  'privatelink.agentsvc.azure-automation.net'
  // The blob zone only affects storage accounts that have a private endpoint somewhere
  // (Azure Monitor's own content accounts, registered by the zone group below). The recovery
  // account mdrrrkpb6rlcowxc has none, so it never gets a privatelink CNAME and keeps
  // resolving publicly, reached through the Microsoft.Storage service endpoint as today.
  'privatelink.blob.${environment().suffixes.storage}'
]

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: subnetName
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource postgresVm 'Microsoft.Compute/virtualMachines@2024-07-01' existing = {
  name: postgresVmName
}

// Public network access stays Enabled on the endpoint itself: the private endpoint and the
// private DNS zones decide the path, and the Container Apps environment keeps its public path.
resource dataCollectionEndpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: dataCollectionEndpointName
  location: location
  kind: 'Linux'
  properties: {
    description: 'Configuration access endpoint for the Azure Monitor agent on the PostgreSQL VM.'
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Open access modes: the Container Apps environment logs to the same workspace and its
// requests also arrive through this scope once the VNet resolves the private zones.
resource privateLinkScope 'Microsoft.Insights/privateLinkScopes@2021-09-01' = {
  name: privateLinkScopeName
  location: 'global'
  properties: {
    accessModeSettings: {
      ingestionAccessMode: 'Open'
      queryAccessMode: 'Open'
    }
  }
}

resource scopedWorkspace 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-09-01' = {
  parent: privateLinkScope
  name: logs.name
  properties: {
    linkedResourceId: logs.id
  }
}

resource scopedDataCollectionEndpoint 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-09-01' = {
  parent: privateLinkScope
  name: dataCollectionEndpoint.name
  properties: {
    linkedResourceId: dataCollectionEndpoint.id
  }
}

// Second association on the VM next to the rule association in main.bicep: this one carries
// the endpoint, not a rule. The Azure Monitor agent requires exactly this name.
resource configurationAccessEndpoint 'Microsoft.Insights/dataCollectionRuleAssociations@2023-03-11' = {
  name: 'configurationAccessEndpoint'
  scope: postgresVm
  properties: {
    description: 'Routes Azure Monitor agent configuration and ingestion through the private link scope.'
    dataCollectionEndpointId: dataCollectionEndpoint.id
  }
}

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateDnsZoneNames: {
  name: zone
  location: 'global'
}]

resource privateDnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, index) in privateDnsZoneNames: {
  parent: privateDnsZones[index]
  name: vnet.name
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}]

// The scoped resources must exist before the endpoint so its DNS zone group is populated for both.
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: privateEndpointName
  location: location
  properties: {
    subnet: {
      id: subnet.id
    }
    privateLinkServiceConnections: [
      {
        name: privateEndpointName
        properties: {
          privateLinkServiceId: privateLinkScope.id
          groupIds: [
            'azuremonitor'
          ]
        }
      }
    ]
  }
  dependsOn: [
    scopedWorkspace
    scopedDataCollectionEndpoint
  ]
}

resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [for (zone, index) in privateDnsZoneNames: {
      name: replace(zone, '.', '-')
      properties: {
        privateDnsZoneId: privateDnsZones[index].id
      }
    }]
  }
}

output privateEndpointId string = privateEndpoint.id
output dataCollectionEndpointId string = dataCollectionEndpoint.id
output privateLinkScopeId string = privateLinkScope.id
