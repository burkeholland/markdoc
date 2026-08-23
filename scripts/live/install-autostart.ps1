# Register (or remove) a per-user Scheduled Task that runs start-live.ps1 at logon.
# No admin needed: runs as the current user with limited rights. Re-running updates it.
# Modeled on board\autostart.ps1.
#   .\install-autostart.ps1              register / update
#   .\install-autostart.ps1 -Uninstall   remove
param(
  [switch]$Uninstall,
  # start-live.ps1 to run at logon. Defaults to the copy next to this script; after
  # promoting a commit that contains scripts\live, re-run this from markdoc-live so
  # the task points at the permanent location rather than a review worktree.
  [string]$ScriptPath = (Join-Path $PSScriptRoot 'start-live.ps1')
)
$ErrorActionPreference = 'Stop'
$name = 'Markdoc live server'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed scheduled task '$name'"
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
Write-Host "remove with: .\install-autostart.ps1 -Uninstall"
