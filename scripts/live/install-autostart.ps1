# Register (or remove) the per-user Scheduled Tasks for the live server. No admin needed: they run as
# the current user with limited rights. Re-running updates them (-Force). Modeled on board\autostart.ps1.
#   "Markdoc live server"  at logon        -> start-live.ps1
#   "Markdoc snapshot"     every 15 min    -> snapshot-data.ps1 -Latest  (..\markdoc-data\snapshots\latest)
#   .\install-autostart.ps1              register / update both
#   .\install-autostart.ps1 -Uninstall   remove both
param(
  [switch]$Uninstall,
  # start-live.ps1 to run at logon. Defaults to the copy next to this script; after
  # promoting a commit that contains scripts\live, re-run this from markdoc-live so
  # the tasks point at the permanent location rather than a review worktree.
  [string]$ScriptPath = (Join-Path $PSScriptRoot 'start-live.ps1'),
  [string]$SnapshotScriptPath = (Join-Path $PSScriptRoot 'snapshot-data.ps1'),
  [int]$SnapshotIntervalMinutes = 15
)
$ErrorActionPreference = 'Stop'
$name = 'Markdoc live server'
$snapshotName = 'Markdoc snapshot'

if ($Uninstall) {
  foreach ($n in @($name, $snapshotName)) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "removed scheduled task '$n'"
  }
  exit 0
}

$ScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path
$workDir = Split-Path -Parent $ScriptPath
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`"" `
  -WorkingDirectory $workDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
Write-Host "registered scheduled task '$name': runs $ScriptPath at logon for $env:USERNAME"

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
Write-Host "remove both with: .\install-autostart.ps1 -Uninstall"
