<#
.SYNOPSIS
  Monthly OS security patch for the private PostgreSQL VM (docs/postgres-patching.md). Opens the same temporary
  egress path deploy/azure.ps1 -ConfigureRecovery uses (bootstrap public IP + NSG rule 255), runs infra/patch-os.sh
  as the managed run command `patch-os`, closes egress through Invoke-OperationWithGuaranteedCleanup (on success,
  on failure and best-effort on Ctrl-C), reboots only when the guest reports reboot=required, then verifies
  /api/health, Syslog, Heartbeat and the steady-state network. Nothing runs this automatically; a scheduled
  workflow is a later step. Every mutation is printed with a [mutation] prefix; -DryRun prints them all and runs none.

.EXAMPLE
  .\deploy\patch-postgres-vm.ps1 -DryRun                       # every az call it would make; zero az calls run
  .\deploy\patch-postgres-vm.ps1                               # security-only (unattended-upgrade), reboot if required
  .\deploy\patch-postgres-vm.ps1 -Snapshot -Full               # incremental OS-disk snapshot first, then apt-get upgrade
  .\deploy\patch-postgres-vm.ps1 -NoReboot                     # patch now, take the reboot in a later window
  .\deploy\patch-postgres-vm.ps1 -Rollback postgresql-16=16.10-1.pgdg24.04+1   # reinstall one exact package version
#>
param(
  [string]$Name = 'markdoc',
  [string]$ResourceGroup = 'markdoc-rg',
  [string]$WorkspaceId = '38faa130-4081-42a2-b43b-6ee128652871',
  [switch]$Full,
  [switch]$NoReboot,
  [switch]$Snapshot,
  [string]$Rollback = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
. (Join-Path $PSScriptRoot 'azure-safety.ps1')
. (Join-Path $PSScriptRoot 'azure-postgres-network.ps1')
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'

if ($Rollback -and $Full) {
  throw 'Refusing -Rollback combined with -Full: a rollback window reinstalls one exact package version and nothing else.'
}
if ($Rollback -and $Rollback -notmatch '^[a-z0-9][a-z0-9.+-]*=[A-Za-z0-9][A-Za-z0-9.:~+-]*$') {
  throw '-Rollback must be <package>=<version> using Debian package and version characters only, for example postgresql-16=16.10-1.pgdg24.04+1.'
}
if ($WorkspaceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
  throw '-WorkspaceId must be the Log Analytics workspace GUID (customerId), not its name or resource id.'
}

$vmName = "$Name-pg"
$publicIpName = "$Name-pg-bootstrap-ip"
$mode = if ($Rollback) { 'rollback' } elseif ($Full) { 'full' } else { 'security' }
$mutations = 0
$invariant = [Globalization.CultureInfo]::InvariantCulture

function Invoke-Az {
  param([string[]]$Arguments, [string]$Failure, [switch]$Mutation, [switch]$Json)
  foreach ($argument in $Arguments) {
    # az is az.cmd on Windows: PowerShell quotes only arguments containing whitespace, so a bare operator would reach cmd.exe.
    if ($argument -match '[|&<>^%]' -and $argument -notmatch '\s') { throw "Refusing to pass an unquoted cmd.exe operator to az: $argument" }
  }
  $kind = if ($Mutation) { '[mutation]' } else { '[read-only]' }
  if ($DryRun) { Write-Host "$kind az $($Arguments -join ' ')"; return $null }
  if ($Mutation) { $script:mutations++ }
  $output = & az @Arguments --only-show-errors
  if ($LASTEXITCODE) { throw "$Failure (az $($Arguments[0..1] -join ' ') exited $LASTEXITCODE)." }
  if ($Json) { return (($output -join "`n") | ConvertFrom-Json) }
  return ([string]($output | Out-String)).Trim()
}

function Invoke-Kql([string]$Query) {
  $rows = Invoke-Az -Arguments @('monitor', 'log-analytics', 'query', '-w', $WorkspaceId, '--analytics-query', $Query, '-o', 'json') -Failure 'Could not query the Log Analytics workspace' -Json
  return @($rows)
}

function ConvertTo-UtcTime([string]$Value) { return [datetimeoffset]::Parse($Value, $invariant).UtcDateTime }
function Format-Kql([datetime]$Value) { return "datetime($($Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', $invariant)))" }

function Get-PowerState {
  return Invoke-Az -Arguments @('vm', 'get-instance-view', '-g', $ResourceGroup, '-n', $vmName, '--query', "instanceView.statuses[?starts_with(code, 'PowerState')].displayStatus | [0]", '-o', 'tsv') -Failure 'Could not read the PostgreSQL VM power state'
}

function Assert-SteadyStateNetwork([string]$When) {
  $rules = @(Invoke-Az -Arguments @('network', 'nsg', 'rule', 'list', '-g', $ResourceGroup, '--nsg-name', "$Name-pg-nsg", '--query', '[?priority >= `255`].{name: name, priority: priority, access: access, direction: direction, destination: destinationAddressPrefix}', '-o', 'json') -Failure 'Could not list the PostgreSQL network security rules' -Json)
  $attached = Invoke-Az -Arguments @('network', 'nic', 'show', '-g', $ResourceGroup, '-n', "$Name-pg-nic", '--query', 'ipConfigurations[0].publicIPAddress.id', '-o', 'tsv') -Failure 'Could not inspect the PostgreSQL VM network interface'
  $webPublicIpName = "$Name-web-ip"
  $bootstrap = Invoke-Az -Arguments @('network', 'public-ip', 'list', '-g', $ResourceGroup, '--query', "[?name == '$publicIpName'] | [0].id", '-o', 'tsv') -Failure 'Could not inspect the PostgreSQL bootstrap public IP'
  if ($DryRun) { Write-Host "$When steady state would be asserted from the three read-only calls above."; return }
  $temporary = @($rules | Where-Object { $_.name -eq 'AllowApprovedPackageSetup' })
  $deny = @($rules | Where-Object { $_.name -eq 'DenyOtherInternetEgress' })
  if ($temporary.Count -ne 0) { throw "$When the temporary egress rule 255 exists; close it with Restore-PostgresSteadyStateEgress (deploy/azure-postgres-network.ps1) first." }
  if ($deny.Count -ne 1 -or $deny[0].priority -ne 260 -or $deny[0].access -ne 'Deny' -or $deny[0].direction -ne 'Outbound' -or $deny[0].destination -ne 'Internet') {
    throw "$When rule 260 DenyOtherInternetEgress is missing or has unexpected semantics."
  }
  if ($attached -notmatch "/publicIPAddresses/$([regex]::Escape($webPublicIpName))$") { throw "$When the Markdoc web public IP $webPublicIpName is not attached to the PostgreSQL NIC ($attached)." }
  if ($bootstrap) { throw "$When the bootstrap public IP $publicIpName still exists; delete it with Remove-BootstrapPublicIp first." }
  Write-Host "$When postgres-egress=restricted rule-250=absent rule-260=Deny/Outbound/Internet nic-public-ip=$webPublicIpName bootstrap-ip=absent"
}

function Assert-BackupFreshness {
  $endTimes = Invoke-Az -Arguments @('backup', 'job', 'list', '-g', $ResourceGroup, '-v', "$Name-backup", '--operation', 'Backup', '--status', 'Completed', '--query', '[].properties.endTime', '-o', 'tsv') -Failure 'Could not list the Azure Backup jobs'
  $rows = Invoke-Kql "Syslog | where TimeGenerated > ago(26h) and Computer == '$vmName' | summarize monitor = countif(SyslogMessage has 'backup-health=ok' and TimeGenerated > ago(15m)), logical = countif(SyslogMessage has 'logical-backup=ok')"
  if ($DryRun) { Write-Host 'Backup freshness would be asserted: an Azure Backup job Completed within 26 h, backup-health=ok within 15 min, logical-backup=ok within 26 h.'; return }
  $completed = @(([string]$endTimes) -split '\r?\n' | Where-Object { $_.Trim() } | ForEach-Object { ConvertTo-UtcTime $_.Trim() } | Sort-Object)
  if ($completed.Count -eq 0 -or $completed[-1] -lt [datetime]::UtcNow.AddHours(-26)) { throw 'No Azure Backup job completed within the last 26 hours; patch only with a fresh VM restore point.' }
  $monitor = [int]$rows[0].monitor
  $logical = [int]$rows[0].logical
  if ($monitor -lt 1) { throw 'No backup-health=ok in Syslog within 15 minutes: the backup monitor or the agent is not healthy, fix that before patching.' }
  if ($logical -lt 1) { throw 'No logical-backup=ok in Syslog within 26 hours: patch only with a fresh logical dump as rollback.' }
  Write-Host "azure-backup=completed $([int]([datetime]::UtcNow - $completed[-1]).TotalMinutes)min-ago backup-health=ok x$monitor logical-backup=ok x$logical"
}

function Test-Health([string]$Fqdn) {
  try {
    $health = Invoke-RestMethod -Uri "https://$Fqdn/api/health" -TimeoutSec 5
    return [bool]($health.ok -and $health.db)
  } catch { return $false }
}

function Wait-DatabaseHealth([string]$Fqdn, [int]$TimeoutSeconds) {
  $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([datetime]::UtcNow -lt $deadline) {
    if (Test-Health $Fqdn) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI not found: https://aka.ms/installazurecli' }
if (-not $DryRun) {
  az account show -o none 2>$null
  if ($LASTEXITCODE) { throw 'Sign in first (az login); this script never signs in on its own.' }
}

Step "Step 1: pre-checks for $vmName in $ResourceGroup (mode=$mode, read-only, abort on any mismatch)"
$powerState = Get-PowerState
if (-not $DryRun -and $powerState -ne 'VM running') { throw "The PostgreSQL VM is '$powerState', not 'VM running'; patch a running VM only." }
Assert-SteadyStateNetwork 'Before the window,'
Assert-BackupFreshness
$fqdn = Invoke-Az -Arguments @('network', 'public-ip', 'show', '-g', $ResourceGroup, '-n', "$Name-web-ip", '--query', 'dnsSettings.fqdn', '-o', 'tsv') -Failure 'Could not read the VM-hosted Markdoc FQDN'
if ($DryRun) { $fqdn = '<fqdn>'; Write-Host "[read-only] GET https://$fqdn/api/health must report ok=true db=true" }
elseif (-not (Test-Health $fqdn)) { throw "https://$fqdn/api/health does not report ok=true and db=true; patch a healthy deployment only." }
else { Write-Host "health=ok db=ok fqdn=$fqdn" }

Step 'Steps 2-4: open egress, patch, close egress (guaranteed cleanup wraps every mutation)'
Write-Host 'cleanup=registered Restore-PostgresSteadyStateEgress,Remove-BootstrapPublicIp,Restore-MarkdocWebPublicIp (Invoke-OperationWithGuaranteedCleanup: runs after success, failure and best-effort on Ctrl-C)'
$windowCleanup = @(
  @{ Action = {
    if ($DryRun) { Write-Host "[cleanup] Restore-PostgresSteadyStateEgress: az network nsg rule delete -g $ResourceGroup --nsg-name $Name-pg-nsg -n AllowApprovedPackageSetup, verify absent, assert 260 DenyOtherInternetEgress Deny/Outbound/Internet" }
    else { Restore-PostgresSteadyStateEgress }
  } },
  @{ Action = {
    if ($DryRun) { Write-Host "[cleanup] Remove-BootstrapPublicIp ${publicIpName}: az network nic ip-config update -g $ResourceGroup --nic-name $Name-pg-nic -n primary --remove publicIPAddress, verify detached, az network public-ip delete -g $ResourceGroup -n $publicIpName" }
    else { Remove-BootstrapPublicIp $publicIpName }
  } },
  @{ Action = {
    if ($DryRun) { Write-Host "[cleanup] Restore-MarkdocWebPublicIp ${Name}-web-ip: az network nic ip-config update -g $ResourceGroup --nic-name $Name-pg-nic -n primary --public-ip-address $Name-web-ip" }
    else { Restore-MarkdocWebPublicIp "$Name-web-ip" }
  } }
)
$patchScriptPath = [IO.Path]::Combine($PSScriptRoot, '..', 'infra', 'patch-os.sh')
$tempScript = Join-Path ([IO.Path]::GetTempPath()) "markdoc-patch-os-$PID.sh"
$parameters = @("MARKDOC_PATCH_MODE=$mode")
if ($Rollback) {
  $rollbackPackage, $rollbackVersion = $Rollback -split '=', 2
  $parameters += @("MARKDOC_ROLLBACK_PACKAGE=$rollbackPackage", "MARKDOC_ROLLBACK_VERSION=$rollbackVersion")
}
$windowSettled = $false
$window = $null
try {
  $window = Invoke-OperationWithGuaranteedCleanup `
    -Context 'PostgreSQL OS patch window' `
    -CleanupActions $windowCleanup `
    -Operation {
      if ($Snapshot) {
        $snapshotName = "$vmName-os-prepatch-$([datetime]::UtcNow.ToString('yyyyMMdd', $invariant))"
        $null = Invoke-Az -Mutation -Arguments @('snapshot', 'create', '-g', $ResourceGroup, '-n', $snapshotName, '--source', "$vmName-os", '--incremental', 'true', '--sku', 'Standard_LRS', '-o', 'none') -Failure 'Could not create the pre-patch OS disk snapshot'
        Write-Host "snapshot=$snapshotName (whole-VM rollback point: the database lives on the OS disk)"
      }
      # Same specification as infra/main.bicep postgresBootstrapIp and rule 255, so the shared cleanup helpers apply unchanged.
      $null = Invoke-Az -Mutation -Arguments @('network', 'public-ip', 'create', '-g', $ResourceGroup, '-n', $publicIpName, '--sku', 'Standard', '--allocation-method', 'Static', '--version', 'IPv4', '-o', 'none') -Failure 'Could not create the bootstrap public IP'
      $null = Invoke-Az -Mutation -Arguments @('network', 'nic', 'ip-config', 'update', '-g', $ResourceGroup, '--nic-name', "$Name-pg-nic", '-n', 'primary', '--public-ip-address', $publicIpName, '-o', 'none') -Failure 'Could not attach the bootstrap public IP'
      $null = Invoke-Az -Mutation -Arguments @('network', 'nsg', 'rule', 'create', '-g', $ResourceGroup, '--nsg-name', "$Name-pg-nsg", '-n', 'AllowApprovedPackageSetup', '--priority', '255', '--direction', 'Outbound', '--access', 'Allow', '--protocol', 'Tcp', '--source-address-prefixes', '*', '--destination-address-prefixes', 'Internet', '--destination-port-ranges', '80', '-o', 'none') -Failure 'Could not create the temporary egress rule'
      $openedAt = [datetime]::UtcNow
      Write-Host "egress=open at=$($openedAt.ToString('HH:mm:ss', $invariant))Z"

      $scriptText = ([IO.File]::ReadAllText($patchScriptPath) -replace "`r`n", "`n")
      if ($DryRun) {
        Write-Host "--- infra/patch-os.sh ($(($scriptText -split "`n").Count - 1) lines) would be sent verbatim as run command patch-os with parameters $($parameters -join ' ')"
        $scriptArgument = '@infra/patch-os.sh'
      } else {
        [IO.File]::WriteAllText($tempScript, $scriptText, [Text.UTF8Encoding]::new($false))
        $scriptArgument = "@$tempScript"
      }
      $null = Invoke-Az -Mutation -Arguments (@('vm', 'run-command', 'create', '-g', $ResourceGroup, '--vm-name', $vmName, '--run-command-name', 'patch-os', '--script', $scriptArgument, '--async-execution', 'false', '--timeout-in-seconds', '3600', '--parameters') + $parameters + @('-o', 'none')) -Failure 'The patch-os run command did not complete'
      if ($DryRun) {
        Write-Host '[read-only] Get-ManagedRunCommandResult patch-os (az vm run-command show --instance-view) must report Succeeded, exit 0 and an os-patch=ok line'
        $execution = @{ executionState = 'Succeeded'; exitCode = 0; output = 'os-patch=ok upgraded=<n> reboot=required running=<kernel> installed=<kernel> (dry run assumes a kernel update)' }
      } else {
        $execution = Get-ManagedRunCommandResult 'patch-os'
      }
      $output = ([string]$execution.output).TrimEnd()
      Write-Host $output
      if ($execution.executionState -ne 'Succeeded' -or $execution.exitCode -ne 0 -or $output -notmatch '(?m)^os-patch=ok ') {
        throw "infra/patch-os.sh did not report os-patch=ok (state $($execution.executionState), exit $($execution.exitCode)); egress is being closed. Details: /var/log/markdoc-os-patch.log on the VM."
      }
      return @{ Output = $output; OpenedAt = $openedAt }
    }
  $windowSettled = $true
} catch {
  $windowSettled = $true
  throw
} finally {
  if (-not $windowSettled) {
    Write-Host 'Interrupted before the window settled: closing egress now (rerun both helpers if this is cut short).'
    foreach ($cleanup in $windowCleanup) { try { [void](& $cleanup.Action) } catch { Write-Warning $_.Exception.Message } }
  }
  if (Test-Path -LiteralPath $tempScript) { Remove-Item -LiteralPath $tempScript -Force }
}
$closedAt = [datetime]::UtcNow
Write-Host "egress=closed at=$($closedAt.ToString('HH:mm:ss', $invariant))Z open-for=$([int]($closedAt - $window.OpenedAt).TotalSeconds)s"

$summary = [regex]::Match($window.Output, '(?m)^os-patch=ok .*$').Value
$upgraded = if ($summary -match '\bupgraded=(\S+)') { $Matches[1] } else { '?' }
$kernelBefore = if ($summary -match '\brunning=(\S+)') { $Matches[1] } else { '?' }
$kernelAfter = if ($summary -match '\binstalled=(\S+)') { $Matches[1] } else { $kernelBefore }
$rebootRequired = $summary -match '\breboot=required\b'
$rebooted = $false
$dbUnavailableSeconds = 0
$since = $closedAt
if ($rebootRequired -and $NoReboot) {
  Write-Host 'reboot=required but -NoReboot was given: the new kernel/libc waits for the next window (the old kernel keeps running).'
} elseif ($rebootRequired) {
  Step "Step 5: graceful restart of $vmName (egress is already closed; never a host move) while timing /api/health"
  $restartAt = [datetime]::UtcNow
  $null = Invoke-Az -Mutation -Arguments @('vm', 'restart', '-g', $ResourceGroup, '-n', $vmName, '--no-wait', '-o', 'none') -Failure 'az vm restart was not accepted'
  $since = $restartAt
  if (-not $DryRun) {
    $downAt = $null
    $upAt = $null
    while ([datetime]::UtcNow -lt $restartAt.AddMinutes(10)) {
      $healthy = Test-Health $fqdn
      if (-not $healthy -and -not $downAt) { $downAt = [datetime]::UtcNow }
      if ($healthy -and $downAt) { $upAt = [datetime]::UtcNow; break }
      if ($healthy -and -not $downAt -and [datetime]::UtcNow -gt $restartAt.AddMinutes(4)) { Write-Warning 'No /api/health outage was observed within 4 minutes; treating the restart as already complete.'; $upAt = [datetime]::UtcNow; break }
      Start-Sleep -Seconds 3
    }
    if (-not $upAt) { throw "https://$fqdn/api/health did not report ok=true db=true within 10 minutes of the restart; inspect the VM (serial console via boot diagnostics) before anything else." }
    if ($downAt) { $dbUnavailableSeconds = [int]($upAt - $downAt).TotalSeconds }
    $since = $upAt
  }
  $rebooted = $true
} else {
  Write-Host 'reboot=none: no kernel, libc or systemd update landed, the VM keeps running.'
}

Step 'Step 6: verify power state, /api/health, Syslog, Heartbeat and the steady-state network'
$powerState = Get-PowerState
if (-not $DryRun -and $powerState -ne 'VM running') { throw "The PostgreSQL VM is '$powerState' after the window, not 'VM running'." }
if (-not $DryRun -and -not (Wait-DatabaseHealth $fqdn 180)) { throw "https://$fqdn/api/health did not report ok=true db=true within 180 s after the window." }
$syslogQuery = "Syslog | where TimeGenerated > $(Format-Kql $window.OpenedAt) and Computer == '$vmName' | summarize patched = countif(SyslogMessage has 'os-patch=ok'), monitor = countif(SyslogMessage has 'backup-health=ok' and TimeGenerated > $(Format-Kql $since))"
$heartbeatQuery = "Heartbeat | where Computer == '$vmName' | summarize latest = max(TimeGenerated)"
$telemetryOk = $false
$deadline = [datetime]::UtcNow.AddMinutes(10)
do {
  $syslog = Invoke-Kql $syslogQuery
  $heartbeat = Invoke-Kql $heartbeatQuery
  if ($DryRun) { Write-Host 'Telemetry would be polled every 30 s for up to 10 min: os-patch=ok and backup-health=ok in Syslog, Heartbeat newer than the restart (or the window close).'; break }
  $patched = [int]$syslog[0].patched
  $monitor = [int]$syslog[0].monitor
  $latestHeartbeat = if ($heartbeat.Count -gt 0 -and $heartbeat[0].latest) { ConvertTo-UtcTime ([string]$heartbeat[0].latest) } else { [datetime]::MinValue }
  $telemetryOk = $patched -ge 1 -and $monitor -ge 1 -and $latestHeartbeat -gt $since
  Write-Host "syslog: os-patch=ok x$patched backup-health=ok x$monitor heartbeat-age=$([int]([datetime]::UtcNow - $latestHeartbeat).TotalSeconds)s $(if ($telemetryOk) { 'ok' } else { '(waiting for ingestion)' })"
  if (-not $telemetryOk) { Start-Sleep -Seconds 30 }
} while (-not $telemetryOk -and [datetime]::UtcNow -lt $deadline)
if (-not $DryRun -and -not $telemetryOk) {
  throw 'Telemetry did not confirm the window within 10 minutes (os-patch=ok, backup-health=ok after it, a fresh Heartbeat); check the workspace and the VM before recording the run.'
}
Assert-SteadyStateNetwork 'After the window,'
if ($rebooted) {
  # Best effort: the serial log names the kernel that actually booted; fall back to the newest installed one.
  try {
    $bootLog = Invoke-Az -Arguments @('vm', 'boot-diagnostics', 'get-boot-log', '-g', $ResourceGroup, '-n', $vmName) -Failure 'Could not read the serial boot log'
    $bootedKernels = [regex]::Matches([string]$bootLog, 'Linux version (\S+)')
    if ($bootedKernels.Count -gt 0) { $kernelAfter = $bootedKernels[$bootedKernels.Count - 1].Groups[1].Value }
  } catch { Write-Warning "$($_.Exception.Message) Reporting the newest installed kernel instead." }
}

$rebootLabel = if ($rebooted) { 'yes' } elseif ($rebootRequired) { 'deferred' } else { 'no' }
$egressMinutes = if ($DryRun) { '<n>' } else { [math]::Round(($closedAt - $window.OpenedAt).TotalMinutes, 1).ToString($invariant) }
$unavailable = if ($DryRun) { '<n>' } else { $dbUnavailableSeconds }
Write-Host "`nos-patch-window=ok mode=$mode upgraded=$upgraded kernel=$kernelBefore->$kernelAfter reboot=$rebootLabel db-unavailable=${unavailable}s egress-open=${egressMinutes}min az-mutations=$mutations"
