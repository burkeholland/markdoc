# Register (or remove) the per-user Scheduled Tasks for the live server. No admin needed: they run as
# the current user with limited rights. Re-running updates them (-Force). Modeled on board\autostart.ps1.
#   "Markdoc live server"  at logon        -> start-live.ps1
#   "Markdoc snapshot"     every 15 min    -> snapshot-data.ps1 -Latest  (..\markdoc-data\snapshots\latest)
#   "Markdoc watchdog"     every 1 min     -> watchdog.ps1 (restarts :3000 after two missed health checks)
#   .\install-autostart.ps1                  register / update all three
#   .\install-autostart.ps1 -Only watchdog   register / update only the named task(s): live, snapshot, watchdog
#   .\install-autostart.ps1 -Uninstall       remove all three
param(
  [switch]$Uninstall,
  # start-live.ps1 to run at logon. Defaults to the copy next to this script; after
  # promoting a commit that contains scripts\live, re-run this from markdoc-live so
  # the tasks point at the permanent location rather than a review worktree.
  [string]$ScriptPath = (Join-Path $PSScriptRoot 'start-live.ps1'),
  [string]$SnapshotScriptPath = (Join-Path $PSScriptRoot 'snapshot-data.ps1'),
  [int]$SnapshotIntervalMinutes = 15,
  [string]$WatchdogScriptPath = (Join-Path $PSScriptRoot 'watchdog.ps1'),
  [int]$WatchdogIntervalMinutes = 1,
  # Register only these tasks (the others are left as they are). Useful when this copy is newer than the
  # live worktree's, e.g. to roll out the watchdog before the live worktree carries watchdog.ps1.
  [ValidateSet('live', 'snapshot', 'watchdog')]
  [string[]]$Only = @('live', 'snapshot', 'watchdog')
)
$ErrorActionPreference = 'Stop'
$name = 'Markdoc live server'
$snapshotName = 'Markdoc snapshot'
$watchdogName = 'Markdoc watchdog'

if ($Uninstall) {
  foreach ($n in @($name, $snapshotName, $watchdogName)) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "removed scheduled task '$n'"
  }
  exit 0
}

if ($Only -contains 'live') {
  $ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path
  $workDir = Split-Path -Parent $ScriptPath
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`"" `
    -WorkingDirectory $workDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
  Write-Host "registered scheduled task '$name': runs $ScriptPath at logon for $env:USERNAME"
}

if ($Only -contains 'snapshot') {
  $SnapshotScriptPath = (Resolve-Path -LiteralPath $SnapshotScriptPath).Path
  $snapshotAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SnapshotScriptPath`" -Latest" `
    -WorkingDirectory (Split-Path -Parent $SnapshotScriptPath)
  # -Once + -RepetitionInterval with no duration repeats indefinitely from now on.
  $snapshotTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $SnapshotIntervalMinutes)
  # A snapshot takes ~35 s; 10 minutes is a generous cap so a hung download never overlaps the next run.
  $snapshotSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $snapshotName -Action $snapshotAction -Trigger $snapshotTrigger -Settings $snapshotSettings -RunLevel Limited -Force | Out-Null
  Write-Host "registered scheduled task '$snapshotName': runs $SnapshotScriptPath -Latest every $SnapshotIntervalMinutes min for $env:USERNAME"
}

if ($Only -contains 'watchdog') {
  $WatchdogScriptPath = (Resolve-Path -LiteralPath $WatchdogScriptPath).Path
  $watchdogAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatchdogScriptPath`"" `
    -WorkingDirectory (Split-Path -Parent $WatchdogScriptPath)
  $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $WatchdogIntervalMinutes)
  # A healthy tick takes < 1 s; a restart waits up to start-live's 180 s. IgnoreNew: a tick that is still
  # restarting is never joined by the next one.
  $watchdogSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $watchdogName -Action $watchdogAction -Trigger $watchdogTrigger -Settings $watchdogSettings -RunLevel Limited -Force | Out-Null
  Write-Host "registered scheduled task '$watchdogName': runs $WatchdogScriptPath every $WatchdogIntervalMinutes min for $env:USERNAME"
}
Write-Host "remove all three with: .\install-autostart.ps1 -Uninstall"
