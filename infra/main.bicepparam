using './main.bicep'

// Fill in before deploying. deploy/azure.ps1 writes secure values to a temporary parameter file
// and removes it after Azure CLI returns, so secrets never appear in the process command line.
param name = 'markdoc'
param minReplicas = 1
param cpu = '0.5'
param memory = '1Gi'
param postgresAdminPassword = readEnvironmentVariable('MARKDOC_PG_PASSWORD', '')
param authSecret = readEnvironmentVariable('MARKDOC_AUTH_SECRET', '')
param githubClientId = readEnvironmentVariable('MARKDOC_GITHUB_CLIENT_ID', '')
param githubClientSecret = readEnvironmentVariable('MARKDOC_GITHUB_CLIENT_SECRET', '')
param alertEmailAddress = readEnvironmentVariable('MARKDOC_ALERT_EMAIL', '')
param vmAdminSshPublicKey = readEnvironmentVariable('MARKDOC_VM_SSH_PUBLIC_KEY', '')
param image = readEnvironmentVariable('MARKDOC_IMAGE', '')
param appVersion = readEnvironmentVariable('APP_VERSION', '')
param publicUrl = readEnvironmentVariable('MARKDOC_PUBLIC_URL', '')
param bootstrapPublicIp = false
param enableVmBackup = false
param configureDatabase = false
param rotateDatabasePassword = false
param commitDatabasePassword = false
param clearPendingDatabasePassword = false
param simulateDatabaseRotationFailure = false
param configureRecovery = false
param databaseConfigurationToken = 'unchanged'
param deploymentConfigurationToken = 'manual'
param recoveryConfigurationVersion = 'v1'
