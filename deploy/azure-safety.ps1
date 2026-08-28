function New-CombinedOperationException {
  param(
    [Parameter(Mandatory)]
    [string]$Message,

    [Parameter(Mandatory)]
    [Management.Automation.ErrorRecord]$PrimaryError,

    [Parameter(Mandatory)]
    [Management.Automation.ErrorRecord[]]$SecondaryErrors
  )

  $exceptions = [Collections.Generic.List[Exception]]::new()
  $exceptions.Add($PrimaryError.Exception)
  foreach ($errorRecord in $SecondaryErrors) {
    $exceptions.Add($errorRecord.Exception)
  }
  return [AggregateException]::new($Message, $exceptions.ToArray())
}

function Invoke-OperationWithGuaranteedCleanup {
  param(
    [Parameter(Mandatory)]
    [string]$Context,

    [Parameter(Mandatory)]
    [scriptblock]$Operation,

    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [hashtable[]]$CleanupActions
  )

  $result = $null
  $primaryError = $null
  try {
    $result = & $Operation
  } catch {
    $primaryError = $_
  }

  $cleanupErrors = [Collections.Generic.List[Management.Automation.ErrorRecord]]::new()
  foreach ($cleanup in $CleanupActions) {
    try {
      [void](& $cleanup.Action)
    } catch {
      $cleanupErrors.Add($_)
    }
  }

  if ($primaryError) {
    if ($cleanupErrors.Count -gt 0) {
      $details = $cleanupErrors | ForEach-Object { $_.Exception.Message }
      throw (New-CombinedOperationException `
        -Message "$Context failed: $($primaryError.Exception.Message) Cleanup also failed: $($details -join '; ')" `
        -PrimaryError $primaryError `
        -SecondaryErrors $cleanupErrors.ToArray())
    }
    throw $primaryError
  }

  if ($cleanupErrors.Count -gt 0) {
    if ($cleanupErrors.Count -eq 1) {
      throw $cleanupErrors[0]
    }
    $first = $cleanupErrors[0]
    $remaining = $cleanupErrors.ToArray()[1..($cleanupErrors.Count - 1)]
    throw (New-CombinedOperationException `
      -Message "$Context cleanup failed: $(($cleanupErrors | ForEach-Object { $_.Exception.Message }) -join '; ')" `
      -PrimaryError $first `
      -SecondaryErrors $remaining)
  }

  return $result
}

function Get-WindowsFileAccessControl {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $file = [IO.FileInfo]::new($Path)
  $sections = [Security.AccessControl.AccessControlSections]::Access
  if ('System.IO.FileSystemAclExtensions' -as [type]) {
    return [IO.FileSystemAclExtensions]::GetAccessControl($file, $sections)
  }
  return $file.GetAccessControl($sections)
}

function Set-WindowsFileAccessControl {
  param(
    [Parameter(Mandatory)]
    [string]$Path,

    [Parameter(Mandatory)]
    [Security.AccessControl.FileSecurity]$Security
  )

  $file = [IO.FileInfo]::new($Path)
  if ('System.IO.FileSystemAclExtensions' -as [type]) {
    [IO.FileSystemAclExtensions]::SetAccessControl($file, $Security)
    return
  }
  $file.SetAccessControl($Security)
}

function Assert-ProtectedCurrentUserFileAcl {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $acl = Get-WindowsFileAccessControl $Path
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = @(
    $acl.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    )
  )
  if ($rules.Count -eq 0) {
    throw 'The production secrets store ACL has no readable access rules.'
  }
  $foreignAllow = @(
    $rules | Where-Object {
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.IdentityReference -ne $currentSid
    }
  )
  if (-not $acl.AreAccessRulesProtected -or $foreignAllow.Count -gt 0) {
    throw 'The production secrets store ACL is not restricted to the current Windows user.'
  }
}

function Set-ProtectedCurrentUserFileAcl {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $protectedAcl = [Security.AccessControl.FileSecurity]::new()
  $protectedAcl.SetAccessRuleProtection($true, $false)
  $currentUserRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$protectedAcl.AddAccessRule($currentUserRule)
  Set-WindowsFileAccessControl -Path $Path -Security $protectedAcl
  Assert-ProtectedCurrentUserFileAcl $Path
}

if (-not ('MarkdocSecretStoreFileIdentity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class MarkdocSecretStoreFileIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(
        string longPath,
        StringBuilder shortPath,
        uint shortPathLength);

    public string DosPath { get; private set; }
    public string IdentityPath { get; private set; }
    public uint LinkCount { get; private set; }
    public uint VolumeSerialNumber { get; private set; }
    public uint FileIndexHigh { get; private set; }
    public uint FileIndexLow { get; private set; }

    private MarkdocSecretStoreFileIdentity(
        string dosPath,
        string identityPath,
        uint linkCount,
        uint volumeSerialNumber,
        uint fileIndexHigh,
        uint fileIndexLow)
    {
        DosPath = dosPath;
        IdentityPath = identityPath;
        LinkCount = linkCount;
        VolumeSerialNumber = volumeSerialNumber;
        FileIndexHigh = fileIndexHigh;
        FileIndexLow = fileIndexLow;
    }

    private static string ReadFinalPath(SafeFileHandle file, uint flags)
    {
        var path = new StringBuilder(512);
        var length = GetFinalPathNameByHandle(file, path, (uint)path.Capacity, flags);
        if (length == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (length >= path.Capacity)
        {
            path = new StringBuilder((int)length + 1);
            length = GetFinalPathNameByHandle(file, path, (uint)path.Capacity, flags);
            if (length == 0 || length >= path.Capacity)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        return path.ToString();
    }

    public static MarkdocSecretStoreFileIdentity Resolve(SafeFileHandle file)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(file, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        const uint VolumeNameDos = 0;
        const uint VolumeNameGuid = 1;
        var dosPath = ReadFinalPath(file, VolumeNameDos);
        var identityPath = dosPath.StartsWith(
            @"\\?\UNC\",
            StringComparison.OrdinalIgnoreCase)
            ? null
            : ReadFinalPath(file, VolumeNameGuid);
        return new MarkdocSecretStoreFileIdentity(
            dosPath,
            identityPath,
            information.NumberOfLinks,
            information.VolumeSerialNumber,
            information.FileIndexHigh,
            information.FileIndexLow);
    }

    public static string ReadShortPath(string longPath)
    {
        var path = new StringBuilder(512);
        var length = GetShortPathName(longPath, path, (uint)path.Capacity);
        if (length == 0)
        {
            return null;
        }
        if (length >= path.Capacity)
        {
            path = new StringBuilder((int)length + 1);
            length = GetShortPathName(longPath, path, (uint)path.Capacity);
            if (length == 0 || length >= path.Capacity)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        return path.ToString();
    }
}
'@
}

function ConvertFrom-WindowsExtendedPath {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    return "\\$($Path.Substring(8))"
  }
  if ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    return $Path.Substring(4)
  }
  return $Path
}

function Resolve-ProtectedSecretStoreOperationPath {
  param(
    [Parameter(Mandatory)]
    [string]$Path,

    [switch]$KeepIdentityHandle
  )

  $providerPath = $Path
  if (-not $Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
  }
  $fullPath = [IO.Path]::GetFullPath($providerPath)
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $file = $null
  try {
    $file = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
  } catch [IO.FileNotFoundException] {
    throw [IO.FileNotFoundException]::new(
      "Production secrets store not found: $fullPath",
      $_.Exception
    )
  } catch [IO.DirectoryNotFoundException] {
    throw [IO.DirectoryNotFoundException]::new(
      "Production secrets store directory not found: $fullPath",
      $_.Exception
    )
  }
  try {
    $identity = [MarkdocSecretStoreFileIdentity]::Resolve($file.SafeFileHandle)

    $canonicalPath = ConvertFrom-WindowsExtendedPath $identity.DosPath
    if ($canonicalPath.StartsWith('\\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The production secrets store must be on a local Windows volume.'
    }
    if ($identity.LinkCount -ne 1) {
      throw 'The production secrets store must not have hard-link aliases.'
    }
    Assert-ProtectedCurrentUserFileAcl $canonicalPath

    $result = [pscustomobject]@{
      RequestedPath = $fullPath
      Path = $identity.DosPath
      Identity = $identity.IdentityPath
      PhysicalIdentity = (
        '{0:X8}:{1:X8}{2:X8}' -f
          $identity.VolumeSerialNumber,
          $identity.FileIndexHigh,
          $identity.FileIndexLow
      )
      IdentityHandle = $null
    }
    if ($KeepIdentityHandle) {
      $result.IdentityHandle = $file
      $file = $null
    }
    return $result
  } finally {
    if ($file) {
      $file.Dispose()
    }
  }
}

function Get-ProtectedSecretStoreOperationMutexNameFromIdentity {
  param(
    [Parameter(Mandatory)]
    [string]$Identity
  )

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $pathBytes = [Text.Encoding]::UTF8.GetBytes("$currentSid|$Identity")
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $pathHash = $hasher.ComputeHash($pathBytes)
    $hashText = [BitConverter]::ToString($pathHash).Replace('-', '')
    return "Global\Markdoc.AzureProduction.$hashText"
  } finally {
    $hasher.Dispose()
    [Array]::Clear($pathBytes, 0, $pathBytes.Length)
    if ($pathHash) {
      [Array]::Clear($pathHash, 0, $pathHash.Length)
    }
  }
}

function Get-ProtectedSecretStoreOperationMutexName {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $resolvedPath = Resolve-ProtectedSecretStoreOperationPath $Path
  return Get-ProtectedSecretStoreOperationMutexNameFromIdentity "LOCATION|$($resolvedPath.Identity)"
}

function Get-ProtectedSecretStoreOperationMutexNames {
  param(
    [Parameter(Mandatory)]
    [object]$ResolvedPath
  )

  [string[]]$names = @(
    Get-ProtectedSecretStoreOperationMutexNameFromIdentity "LOCATION|$($ResolvedPath.Identity)"
    Get-ProtectedSecretStoreOperationMutexNameFromIdentity "FILE|$($ResolvedPath.PhysicalIdentity)"
  )
  [Array]::Sort($names, [StringComparer]::Ordinal)
  return $names
}

function New-ProtectedSecretStoreOperationMutexSecurity {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = [Security.AccessControl.MutexSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($currentSid)
  $currentUserRule = [Security.AccessControl.MutexAccessRule]::new(
    $currentSid,
    [Security.AccessControl.MutexRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($currentUserRule)
  return $security
}

function New-NamedMutexWithSecurity {
  param(
    [Parameter(Mandatory)]
    [string]$Name,

    [Parameter(Mandatory)]
    [Security.AccessControl.MutexSecurity]$Security,

    [Parameter(Mandatory)]
    [ref]$CreatedNew
  )

  if ('System.Threading.MutexAcl' -as [type]) {
    return [System.Threading.MutexAcl]::Create($false, $Name, $CreatedNew, $Security)
  }
  return [Threading.Mutex]::new($false, $Name, $CreatedNew, $Security)
}

function Assert-ProtectedSecretStoreOperationMutexSecurity {
  param(
    [Parameter(Mandatory)]
    [string]$Name
  )

  $sections = (
    [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Access
  )
  $security = [Security.AccessControl.MutexSecurity]::new($Name, $sections)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $owner = $security.GetOwner([Security.Principal.SecurityIdentifier])
  $rules = @(
    $security.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    )
  )
  $currentUserFullControl = @(
    $rules | Where-Object {
      $_.IdentityReference -eq $currentSid -and
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      ($_.MutexRights -band [Security.AccessControl.MutexRights]::FullControl) -eq
        [Security.AccessControl.MutexRights]::FullControl
    }
  )
  $foreignOrDenyRules = @(
    $rules | Where-Object {
      $_.IdentityReference -ne $currentSid -or
      $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow
    }
  )
  if (
    $owner -ne $currentSid -or
    -not $security.AreAccessRulesProtected -or
    $currentUserFullControl.Count -ne 1 -or
    $foreignOrDenyRules.Count -gt 0
  ) {
    throw 'The production operation lock is not restricted to the current Windows user.'
  }
}

function Assert-ProtectedSecretStoreOperationIdentity {
  param(
    [Parameter(Mandatory)]
    [object]$ResolvedPath
  )

  $reopenedFiles = [Collections.Generic.List[IO.FileStream]]::new()
  try {
    $identities = [Collections.Generic.List[object]]::new()
    $identities.Add(
      [MarkdocSecretStoreFileIdentity]::Resolve($ResolvedPath.IdentityHandle.SafeFileHandle)
    )

    [string[]]$pathsToReopen = @($ResolvedPath.RequestedPath, $ResolvedPath.Path)
    $previousPath = $null
    foreach ($pathToReopen in $pathsToReopen) {
      if ($previousPath -and [string]::Equals($previousPath, $pathToReopen, [StringComparison]::Ordinal)) {
        continue
      }
      $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
      try {
        $reopenedFile = [IO.File]::Open(
          $pathToReopen,
          [IO.FileMode]::Open,
          [IO.FileAccess]::Read,
          $share
        )
      } catch [IO.FileNotFoundException] {
        throw [InvalidOperationException]::new(
          'The production secrets store identity changed while ownership was being acquired.',
          $_.Exception
        )
      } catch [IO.DirectoryNotFoundException] {
        throw [InvalidOperationException]::new(
          'The production secrets store identity changed while ownership was being acquired.',
          $_.Exception
        )
      } catch [UnauthorizedAccessException] {
        throw [InvalidOperationException]::new(
          'The production secrets store identity changed while ownership was being acquired.',
          $_.Exception
        )
      } catch [IO.IOException] {
        throw [InvalidOperationException]::new(
          'The production secrets store identity changed while ownership was being acquired.',
          $_.Exception
        )
      }
      $reopenedFiles.Add($reopenedFile)
      $identities.Add(
        [MarkdocSecretStoreFileIdentity]::Resolve($reopenedFile.SafeFileHandle)
      )
      $previousPath = $pathToReopen
    }

    foreach ($identity in $identities) {
      $physicalIdentity = (
        '{0:X8}:{1:X8}{2:X8}' -f
          $identity.VolumeSerialNumber,
          $identity.FileIndexHigh,
          $identity.FileIndexLow
      )
      if (
        -not [string]::Equals(
          $identity.IdentityPath,
          $ResolvedPath.Identity,
          [StringComparison]::Ordinal
        ) -or
        -not [string]::Equals(
          $physicalIdentity,
          $ResolvedPath.PhysicalIdentity,
          [StringComparison]::Ordinal
        ) -or
        $identity.LinkCount -ne 1
      ) {
        throw [InvalidOperationException]::new(
          'The production secrets store identity changed while ownership was being acquired.'
        )
      }
    }

    Assert-ProtectedCurrentUserFileAcl (
      ConvertFrom-WindowsExtendedPath $ResolvedPath.Path
    )
  } finally {
    foreach ($reopenedFile in $reopenedFiles) {
      $reopenedFile.Dispose()
    }
  }
}

function Close-ProtectedSecretStoreOperationLocks {
  param(
    [Parameter(Mandatory)]
    [AllowEmptyCollection()]
    [object[]]$Locks
  )

  $releaseErrors = [Collections.Generic.List[Management.Automation.ErrorRecord]]::new()
  for ($index = $Locks.Count - 1; $index -ge 0; $index--) {
    $lock = $Locks[$index]
    try {
      if ($lock.Acquired) {
        $lock.Mutex.ReleaseMutex()
        $lock.Acquired = $false
      }
    } catch {
      $releaseErrors.Add($_)
    } finally {
      try {
        $lock.Mutex.Dispose()
      } catch {
        $releaseErrors.Add($_)
      }
    }
  }

  if ($releaseErrors.Count -eq 1) {
    throw $releaseErrors[0]
  }
  if ($releaseErrors.Count -gt 1) {
    $first = $releaseErrors[0]
    $remaining = $releaseErrors.ToArray()[1..($releaseErrors.Count - 1)]
    throw (New-CombinedOperationException `
      -Message "Production operation lock cleanup failed: $((
        $releaseErrors | ForEach-Object { $_.Exception.Message }
      ) -join '; ')" `
      -PrimaryError $first `
      -SecondaryErrors $remaining)
  }
}

function Enter-ProtectedSecretStoreOperation {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $resolvedPath = Resolve-ProtectedSecretStoreOperationPath $Path -KeepIdentityHandle
  $locks = [Collections.Generic.List[object]]::new()
  $recoveredAbandonedOwner = $false
  try {
    $mutexSecurity = New-ProtectedSecretStoreOperationMutexSecurity
    foreach ($mutexName in (Get-ProtectedSecretStoreOperationMutexNames $resolvedPath)) {
      $createdNew = $false
      $mutex = New-NamedMutexWithSecurity `
        -Name $mutexName `
        -Security $mutexSecurity `
        -CreatedNew ([ref]$createdNew)
      $lock = [pscustomobject]@{
        Name = $mutexName
        Mutex = $mutex
        Acquired = $false
      }
      $locks.Add($lock)
      Assert-ProtectedSecretStoreOperationMutexSecurity $mutexName
      try {
        $lock.Acquired = $mutex.WaitOne(0)
      } catch [Threading.AbandonedMutexException] {
        $lock.Acquired = $true
        $recoveredAbandonedOwner = $true
      }
      if (-not $lock.Acquired) {
        throw [InvalidOperationException]::new(
          'Another Markdoc production operation owns this secrets store.'
        )
      }
    }

    Assert-ProtectedSecretStoreOperationIdentity $resolvedPath
    $resolvedPath.IdentityHandle.Dispose()
    $resolvedPath.IdentityHandle = $null

    return [pscustomobject]@{
      Locks = $locks.ToArray()
      RecoveredAbandonedOwner = $recoveredAbandonedOwner
      Path = $resolvedPath.Path
    }
  } catch {
    $primaryError = $_
    $cleanupErrors = [Collections.Generic.List[Management.Automation.ErrorRecord]]::new()
    try {
      Close-ProtectedSecretStoreOperationLocks $locks.ToArray()
    } catch {
      $cleanupErrors.Add($_)
    }
    try {
      if ($resolvedPath.IdentityHandle) {
        $resolvedPath.IdentityHandle.Dispose()
        $resolvedPath.IdentityHandle = $null
      }
    } catch {
      $cleanupErrors.Add($_)
    }
    if ($cleanupErrors.Count -gt 0) {
      throw (New-CombinedOperationException `
        -Message "Production operation ownership failed: $($primaryError.Exception.Message) Cleanup also failed: $((
          $cleanupErrors | ForEach-Object { $_.Exception.Message }
        ) -join '; ')" `
        -PrimaryError $primaryError `
        -SecondaryErrors $cleanupErrors.ToArray())
    }
    throw $primaryError
  }
}

function Exit-ProtectedSecretStoreOperation {
  param(
    [AllowNull()]
    [object]$Ownership
  )

  if (-not $Ownership) {
    return
  }

  Close-ProtectedSecretStoreOperationLocks $Ownership.Locks
}

function Assert-SecureStringStore {
  param(
    [Parameter(Mandatory)]
    [object]$Store,

    [Parameter(Mandatory)]
    [string[]]$ExpectedProperties
  )

  foreach ($propertyName in $ExpectedProperties) {
    $property = $Store.PSObject.Properties[$propertyName]
    if (-not $property -or $property.Value -isnot [Security.SecureString]) {
      throw "The production secrets store property $propertyName must be a DPAPI-encrypted SecureString."
    }
  }
}

function Save-ProtectedSecureStringStore {
  param(
    [Parameter(Mandatory)]
    [string]$Path,

    [Parameter(Mandatory)]
    [object]$Store,

    [scriptblock]$ExportStore = {
      param($InputObject, [string]$OutputPath)
      $InputObject | Export-Clixml -LiteralPath $OutputPath -Force
    },

    [scriptblock]$ImportStore = {
      param([string]$InputPath)
      Import-Clixml -LiteralPath $InputPath
    },

    [scriptblock]$ReplaceFile = {
      param([string]$SourcePath, [string]$DestinationPath, [string]$BackupPath)
      [IO.File]::Replace($SourcePath, $DestinationPath, $BackupPath, $true)
    }
  )

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not [IO.File]::Exists($resolvedPath)) {
    throw "Production secrets store not found: $resolvedPath"
  }

  Assert-ProtectedCurrentUserFileAcl $resolvedPath
  $expectedProperties = @($Store.PSObject.Properties.Name)
  Assert-SecureStringStore -Store $Store -ExpectedProperties $expectedProperties

  $directory = [IO.Path]::GetDirectoryName($resolvedPath)
  $fileName = [IO.Path]::GetFileName($resolvedPath)
  $nonce = [guid]::NewGuid().ToString('N')
  $temporaryPath = [IO.Path]::Combine($directory, ".$fileName.$nonce.tmp")
  $backupPath = [IO.Path]::Combine($directory, ".$fileName.$nonce.bak")
  $replacementAttempted = $false
  $finalValidated = $false
  $primaryError = $null
  $restorationError = $null

  try {
    $temporaryFile = [IO.File]::Open(
      $temporaryPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    $temporaryFile.Dispose()
    Set-ProtectedCurrentUserFileAcl $temporaryPath

    [void](& $ExportStore $Store $temporaryPath)
    Assert-ProtectedCurrentUserFileAcl $temporaryPath
    $saved = & $ImportStore $temporaryPath
    Assert-SecureStringStore -Store $saved -ExpectedProperties $expectedProperties

    $replacementAttempted = $true
    [void](& $ReplaceFile $temporaryPath $resolvedPath $backupPath)

    Assert-ProtectedCurrentUserFileAcl $resolvedPath
    $saved = & $ImportStore $resolvedPath
    Assert-SecureStringStore -Store $saved -ExpectedProperties $expectedProperties
    $finalValidated = $true
  } catch {
    $primaryError = $_
  } finally {
    if ($replacementAttempted -and -not $finalValidated -and [IO.File]::Exists($backupPath)) {
      try {
        if ([IO.File]::Exists($resolvedPath)) {
          $failedReplacementPath = "$temporaryPath.failed"
          [IO.File]::Replace($backupPath, $resolvedPath, $failedReplacementPath, $true)
          if ([IO.File]::Exists($failedReplacementPath)) {
            [IO.File]::Delete($failedReplacementPath)
          }
        } else {
          [IO.File]::Move($backupPath, $resolvedPath)
        }
        Assert-ProtectedCurrentUserFileAcl $resolvedPath
      } catch {
        $restorationError = $_
      }
    }

    if ($finalValidated -and [IO.File]::Exists($backupPath)) {
      [IO.File]::Delete($backupPath)
    }
    if ([IO.File]::Exists($temporaryPath) -and [IO.File]::Exists($resolvedPath)) {
      [IO.File]::Delete($temporaryPath)
    }
  }

  if ($primaryError) {
    if ($restorationError) {
      throw (New-CombinedOperationException `
        -Message "Production secrets store replacement failed: $($primaryError.Exception.Message) Predecessor restoration also failed: $($restorationError.Exception.Message)" `
        -PrimaryError $primaryError `
        -SecondaryErrors @($restorationError))
    }
    throw $primaryError
  }
  if ($restorationError) {
    throw $restorationError
  }
}

function Resolve-DatabaseDeploymentReadiness {
  param(
    [Parameter(Mandatory)]
    [bool]$PostgresVmExists,

    [Parameter(Mandatory)]
    [bool]$InitializeDatabase,

    [Parameter(Mandatory)]
    [bool]$RotateDatabasePassword,

    [Parameter(Mandatory)]
    [bool]$HasRetainedCandidate,

    [Parameter(Mandatory)]
    [scriptblock]$GetExtensionState,

    [Parameter(Mandatory)]
    [scriptblock]$GetExistingAppHealth
  )

  if ($InitializeDatabase -and $RotateDatabasePassword) {
    throw '-InitializeDatabase and -RotateDatabasePassword are mutually exclusive.'
  }
  if ($RotateDatabasePassword -and -not $PostgresVmExists) {
    throw 'The PostgreSQL VM does not exist; use -InitializeDatabase for first provision.'
  }
  if ($HasRetainedCandidate) {
    if (-not $RotateDatabasePassword) {
      throw 'Retained password rotation state requires -RotateDatabasePassword to recover.'
    }
    return [pscustomobject]@{
      Mode = 'Recovery'
      DatabaseInitialized = $false
    }
  }
  if (-not $PostgresVmExists) {
    if (-not $InitializeDatabase) {
      throw 'The PostgreSQL VM does not exist. First provision requires the explicit -InitializeDatabase flag.'
    }
    return [pscustomobject]@{
      Mode = 'Initialize'
      DatabaseInitialized = $false
    }
  }

  $extension = & $GetExtensionState
  if (
    -not $extension -or
    -not $extension.PSObject.Properties['ExitCode'] -or
    -not $extension.PSObject.Properties['State']
  ) {
    throw 'PostgreSQL initialization discovery did not return an explicit extension query result.'
  }
  if ($extension.ExitCode -ne 0) {
    throw 'Could not inspect the PostgreSQL initialization extension.'
  }

  $databaseInitialized = $extension.State -eq 'Succeeded'
  if (-not $databaseInitialized) {
    $healthResult = @(& $GetExistingAppHealth)
    if ($healthResult.Count -ne 1 -or $healthResult[0] -isnot [bool]) {
      throw 'PostgreSQL initialization health discovery did not return one explicit boolean result.'
    }
    $databaseInitialized = $healthResult[0]
  }
  if ($InitializeDatabase -and $databaseInitialized) {
    return [pscustomobject]@{
      Mode = 'AlreadyInitialized'
      DatabaseInitialized = $true
    }
  }
  if (-not $databaseInitialized -and -not $InitializeDatabase) {
    throw 'PostgreSQL initialization is incomplete. Resume it with the explicit -InitializeDatabase flag.'
  }

  return [pscustomobject]@{
    Mode = if ($InitializeDatabase) { 'Initialize' } elseif ($RotateDatabasePassword) { 'FreshRotation' } else { 'Deploy' }
    DatabaseInitialized = $databaseInitialized
  }
}

function Resolve-RotationPreparation {
  param(
    [Parameter(Mandatory)]
    [bool]$HasRetainedCandidate,

    [Parameter(Mandatory)]
    [bool]$HasCompleteRecoveryMetadata,

    [Parameter(Mandatory)]
    [scriptblock]$LoadRetainedCandidate,

    [Parameter(Mandatory)]
    [scriptblock]$LoadCandidateOnlyRecovery,

    [Parameter(Mandatory)]
    [scriptblock]$GetFreshContext,

    [Parameter(Mandatory)]
    [scriptblock]$AssertFreshRevisionHealthy,

    [Parameter(Mandatory)]
    [scriptblock]$CreateFreshCandidate
  )

  if ($HasRetainedCandidate) {
    if ($HasCompleteRecoveryMetadata) {
      return & $LoadRetainedCandidate
    }
    return & $LoadCandidateOnlyRecovery
  }

  $freshContext = & $GetFreshContext
  [void](& $AssertFreshRevisionHealthy $freshContext)
  return & $CreateFreshCandidate $freshContext
}

function Invoke-AlreadyInitializedDatabaseRefusal {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$CleanupTemporaryEgress,

    [Parameter(Mandatory)]
    [scriptblock]$RemoveBootstrapPublicIp
  )

  $refusal = [InvalidOperationException]::new(
    'PostgreSQL initialization already succeeded; use ordinary deployment or explicit password rotation.'
  )
  [void](Invoke-OperationWithGuaranteedCleanup `
    -Context 'Already-initialized PostgreSQL cleanup' `
    -Operation { throw $refusal } `
    -CleanupActions @(
      @{ Action = $CleanupTemporaryEgress },
      @{ Action = $RemoveBootstrapPublicIp }
    ))
}

function Invoke-RotationFinalization {
  param(
    [Parameter(Mandatory)]
    [scriptblock]$Commit,

    [Parameter(Mandatory)]
    [scriptblock]$Verify,

    [Parameter(Mandatory)]
    [scriptblock]$Compensate,

    [Parameter(Mandatory)]
    [scriptblock]$TerminalCleanup,

    [switch]$SimulatePostChangeFailure
  )

  $result = $null
  try {
    $result = & $Commit
    if ($SimulatePostChangeFailure) {
      throw [InvalidOperationException]::new('Simulated failure during credential rollout after PostgreSQL and Key Vault accepted the candidate.')
    }
    [void](& $Verify $result)
  } catch {
    $primaryError = $_
    try {
      [void](& $Compensate $primaryError)
    } catch {
      throw (New-CombinedOperationException `
        -Message "Database credential rollout failed: $($primaryError.Exception.Message) Compensation also failed: $($_.Exception.Message)" `
        -PrimaryError $primaryError `
        -SecondaryErrors @($_))
    }
    throw $primaryError
  }

  [void](& $TerminalCleanup $result)
  return $result
}
