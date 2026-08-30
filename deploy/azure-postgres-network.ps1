# PostgreSQL VM network and run-command helpers shared by deploy/azure.ps1 (provisioning, -InitializeDatabase,
# -ConfigureRecovery) and deploy/patch-postgres-vm.ps1 (monthly OS security patch window). Dot-source it after
# azure-safety.ps1 from a script whose param() block declares $Name and $ResourceGroup: the helpers resolve both
# through PowerShell's dynamic scope exactly as they did inside azure.ps1, so the call sites there are unchanged
# and both scripts share one definition of "steady state" (rule 260 DenyOtherInternetEgress present, temporary
# rule 250 AllowApprovedPackageSetup absent, no public IP on the NIC, bootstrap public IP deleted).
# Every helper is idempotent and safe to rerun as a cleanup action; each throws instead of leaving egress open.

function Remove-BootstrapPublicIp([string]$PublicIpName) {
  $nicId = az network nic list `
    --resource-group $ResourceGroup `
    --query "[?name=='$Name-pg-nic'] | [0].id" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the PostgreSQL VM network interface during cleanup.' }

  if (-not [string]::IsNullOrWhiteSpace($nicId)) {
    $attached = az network nic show `
      --resource-group $ResourceGroup `
      --name "$Name-pg-nic" `
      --query 'ipConfigurations[0].publicIPAddress.id' `
      --output tsv `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not verify the PostgreSQL VM network interface.' }
    $attachedIsBootstrap = (
      -not [string]::IsNullOrWhiteSpace($attached) -and
      $attached -match "/publicIPAddresses/$([regex]::Escape($PublicIpName))$"
    )
    if ($attachedIsBootstrap) {
      az network nic ip-config update `
        --resource-group $ResourceGroup `
        --nic-name "$Name-pg-nic" `
        --name 'primary' `
        --remove publicIPAddress `
        --output none `
        --only-show-errors
      if ($LASTEXITCODE) { throw 'Could not detach the PostgreSQL bootstrap public IP.' }
    }

    $attached = az network nic show `
      --resource-group $ResourceGroup `
      --name "$Name-pg-nic" `
      --query 'ipConfigurations[0].publicIPAddress.id' `
      --output tsv `
      --only-show-errors
    if (
      $LASTEXITCODE -or (
        -not [string]::IsNullOrWhiteSpace($attached) -and
        $attached -match "/publicIPAddresses/$([regex]::Escape($PublicIpName))$"
      )
    ) {
      throw 'The PostgreSQL bootstrap public IP is still attached.'
    }
  }

  $publicIpId = az network public-ip list `
    --resource-group $ResourceGroup `
    --query "[?name=='$PublicIpName'] | [0].id" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the PostgreSQL bootstrap public IP during cleanup.' }
  if (-not [string]::IsNullOrWhiteSpace($publicIpId)) {
    az network public-ip delete --resource-group $ResourceGroup --name $PublicIpName --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not delete the PostgreSQL bootstrap public IP.' }
  }
}

function Get-PostgresNetworkRuleNames([string]$RuleName) {
  $names = az network nsg rule list `
    --resource-group $ResourceGroup `
    --nsg-name "$Name-pg-nsg" `
    --query "[?name=='$RuleName'].name" `
    --output tsv `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the PostgreSQL network security rules.' }
  return @($names | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Restore-PostgresSteadyStateEgress {
  if (@(Get-PostgresNetworkRuleNames 'AllowApprovedPackageSetup').Count -gt 0) {
    az network nsg rule delete `
      --resource-group $ResourceGroup `
      --nsg-name "$Name-pg-nsg" `
      --name 'AllowApprovedPackageSetup' `
      --only-show-errors
    if ($LASTEXITCODE) { throw 'Could not remove temporary PostgreSQL package-install egress.' }
  }

  if (@(Get-PostgresNetworkRuleNames 'AllowApprovedPackageSetup').Count -gt 0) {
    throw 'Temporary PostgreSQL package-install egress is still present.'
  }
  $denyJson = az network nsg rule show `
    --resource-group $ResourceGroup `
    --nsg-name "$Name-pg-nsg" `
    --name 'DenyOtherInternetEgress' `
    --query '{access:access,direction:direction,priority:priority,destinationAddressPrefix:destinationAddressPrefix}' `
    --output json `
    --only-show-errors
  if ($LASTEXITCODE) { throw 'Could not inspect the steady-state PostgreSQL Internet deny rule.' }
  $denyRule = $denyJson | ConvertFrom-Json
  if (
    $denyRule.access -ne 'Deny' -or
    $denyRule.direction -ne 'Outbound' -or
    $denyRule.priority -ne 260 -or
    $denyRule.destinationAddressPrefix -ne 'Internet'
  ) {
    throw 'The steady-state PostgreSQL Internet deny rule is missing or has unexpected semantics.'
  }
  Write-Host 'postgres-egress=restricted temporary-package-rule=absent'
}

function Get-ManagedRunCommandResult([string]$RunCommandName) {
  $executionJson = az vm run-command show `
    --resource-group $ResourceGroup `
    --vm-name "$Name-pg" `
    --run-command-name $RunCommandName `
    --instance-view `
    --query '{executionState:instanceView.executionState,exitCode:instanceView.exitCode,output:instanceView.output}' `
    --output json `
    --only-show-errors
  if ($LASTEXITCODE) { throw "Could not read managed run command $RunCommandName." }
  return $executionJson | ConvertFrom-Json
}
