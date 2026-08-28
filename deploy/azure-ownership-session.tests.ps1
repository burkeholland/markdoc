param(
  [switch]$RequireCrossSession
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'azure-safety.ps1')

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  if ($RequireCrossSession) {
    throw 'The cross-session ownership test requires the Windows ScheduledTasks module.'
  }
  Write-Host 'cross-session ownership test: skipped (Windows ScheduledTasks module unavailable)'
  return
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "markdoc-secret-session-tests-$([guid]::NewGuid().ToString('N'))"
[void](New-Item -ItemType Directory -Path $testRoot)
$storePath = Join-Path $testRoot 'production.clixml'
$workerPath = Join-Path $testRoot 'session-worker.ps1'
$resultPath = Join-Path $testRoot 'session-result.json'
$taskName = "Markdoc-Azure-Ownership-$([guid]::NewGuid().ToString('N'))"
$ownership = $null
$taskRegistered = $false

$workerSource = @'
param(
  [Parameter(Mandatory)]
  [string]$SafetyPath,
  [Parameter(Mandatory)]
  [string]$StorePath,
  [Parameter(Mandatory)]
  [string]$ResultPath
)
$ErrorActionPreference = 'Stop'
. $SafetyPath
$ownership = $null
$result = [ordered]@{
  Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  SessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  Contended = $false
  UnexpectedError = $false
}
try {
  try {
    $ownership = Enter-ProtectedSecretStoreOperation $StorePath
  } catch {
    if ($_.Exception.Message -match 'Another Markdoc production operation owns this secrets store') {
      $result.Contended = $true
    } else {
      $result.UnexpectedError = $true
    }
  }
} finally {
  Exit-ProtectedSecretStoreOperation $ownership
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
'@

try {
  $file = [IO.File]::Open($storePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $file.Dispose()
  Set-ProtectedCurrentUserFileAcl $storePath
  [IO.File]::WriteAllText($workerPath, $workerSource, [Text.UTF8Encoding]::new($false))

  $ownership = Enter-ProtectedSecretStoreOperation $storePath
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
  $workerArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $workerPath,
    '-SafetyPath',
    (Join-Path $PSScriptRoot 'azure-safety.ps1'),
    '-StorePath',
    $storePath,
    '-ResultPath',
    $resultPath
  )
  foreach ($argument in $workerArguments) {
    if ($argument.Contains('"')) {
      throw 'Cross-session test arguments must not contain quotation marks.'
    }
  }
  $actionArguments = ($workerArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $action = New-ScheduledTaskAction -Execute $powershellPath -Argument $actionArguments
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentIdentity.Name `
    -LogonType S4U `
    -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
  try {
    [void](Register-ScheduledTask `
      -TaskName $taskName `
      -Action $action `
      -Principal $principal `
      -Settings $settings `
      -Force)
  } catch {
    $accessDenied = (
      $_.Exception -is [UnauthorizedAccessException] -or
      $_.Exception.InnerException -is [UnauthorizedAccessException] -or
      $_.Exception.HResult -eq -2147024891 -or
      $_.FullyQualifiedErrorId -match '0x80070005' -or
      $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::PermissionDenied
    )
    if ($RequireCrossSession -or -not $accessDenied) {
      throw
    }
    Write-Host 'cross-session ownership test: skipped (scheduled S4U registration denied)'
    return
  }
  $taskRegistered = $true
  Start-ScheduledTask -TaskName $taskName

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not [IO.File]::Exists($resultPath)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
      throw "Timed out waiting for the scheduled ownership worker; last result $($taskInfo.LastTaskResult)."
    }
    Start-Sleep -Milliseconds 100
  }

  $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  Assert-True ($result.Sid -eq $currentIdentity.User.Value) 'The scheduled worker must run under the deployment SID.'
  Assert-True ($result.SessionId -ne $currentSessionId) 'The scheduled worker must run in a different Windows session.'
  Assert-True $result.Contended 'The different-session worker must contend on the same protected store.'
  Assert-True (-not $result.UnexpectedError) 'The different-session worker returned an unexpected ownership error.'
  Write-Host "cross-session ownership test: ok (sessions $currentSessionId and $($result.SessionId))"
} finally {
  Exit-ProtectedSecretStoreOperation $ownership
  if ($taskRegistered) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
