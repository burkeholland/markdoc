using './main.bicep'

// Fill in before deploying (or pass with -p on the command line; secrets should come from the command line or a Key Vault).
param name = 'markdoc'
param minReplicas = 1
param cpu = '0.5'
param memory = '1Gi'
param postgresAdminLogin = 'markdoc'
param postgresAdminPassword = readEnvironmentVariable('MARKDOC_PG_PASSWORD', '')
param authSecret = readEnvironmentVariable('MARKDOC_AUTH_SECRET', '')
param githubClientId = readEnvironmentVariable('MARKDOC_GITHUB_CLIENT_ID', '')
param githubClientSecret = readEnvironmentVariable('MARKDOC_GITHUB_CLIENT_SECRET', '')
param image = readEnvironmentVariable('MARKDOC_IMAGE', '')
param publicUrl = readEnvironmentVariable('MARKDOC_PUBLIC_URL', '')
