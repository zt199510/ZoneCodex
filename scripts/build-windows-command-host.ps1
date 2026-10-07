$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The Windows command host must be built on Windows.'
}

$commandHostRoot = Split-Path -Parent $PSScriptRoot
$commandHostSource = Join-Path $commandHostRoot 'native\windows-command-host\main.cpp'
$commandHostOutput = Join-Path $commandHostRoot 'resources\windows-command-runtime'

if (-not ('ZoneCodexCommandHostFileIdentity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ZoneCodexCommandHostFileIdentity {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes;
    public uint CreationLow, CreationHigh;
    public uint AccessLow, AccessHigh;
    public uint WriteLow, WriteHigh;
    public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool MoveFileEx(string source, string destination, uint flags);

  public static string Identity(string path) {
    using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      FileInformation information;
      if (!GetFileInformationByHandle(file.SafeFileHandle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (information.Links != 1) throw new InvalidOperationException("Command-host target has multiple hard links: " + path);
      return String.Join(":", new uint[] { information.VolumeSerial, information.IndexHigh, information.IndexLow,
        information.SizeHigh, information.SizeLow, information.WriteHigh, information.WriteLow });
    }
  }
  public static void Replace(string source, string destination) {
    if (!MoveFileEx(source, destination, 1 | 8)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
}

function Assert-CommandHostDirectory([string]$directory) {
  $directory = [IO.Path]::GetFullPath($directory)
  while ($directory) {
    $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Command-host output is not an ordinary directory: $directory"
    }
    $parent = Split-Path -Parent $directory
    if (-not $parent -or $parent -eq $directory) { break }
    $directory = $parent
  }
}

function Get-CommandHostTargetIdentity([string]$target) {
  Assert-CommandHostDirectory (Split-Path -Parent $target)
  try { $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop } catch {
    if ($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
    throw
  }
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Command-host replacement target is not an ordinary file: $target"
  }
  return [ZoneCodexCommandHostFileIdentity]::Identity($target)
}

Assert-CommandHostDirectory (Split-Path -Parent $commandHostOutput)
if (-not (Test-Path -LiteralPath $commandHostOutput)) {
  New-Item -ItemType Directory -Path $commandHostOutput -ErrorAction Stop | Out-Null
}
Assert-CommandHostDirectory $commandHostOutput
$commandHostExecutable = Join-Path $commandHostOutput 'host.exe'
$commandHostObject = Join-Path $commandHostOutput 'host.obj'
$commandHostExecutableIdentity = Get-CommandHostTargetIdentity $commandHostExecutable
$commandHostObjectIdentity = Get-CommandHostTargetIdentity $commandHostObject
$commandHostVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $commandHostVsWhere -PathType Leaf)) {
  throw 'Visual Studio C++ tools were not found. Install the Desktop development with C++ workload to build the command host.'
}

$commandHostVs = & $commandHostVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $commandHostVs) {
  throw 'No Visual Studio installation with x64 C++ tools was found.'
}
$commandHostVc = Get-ChildItem -LiteralPath (Join-Path $commandHostVs 'VC\Tools\MSVC') -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\Hostx64\x64\cl.exe') -PathType Leaf } |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $commandHostVc) { throw 'The x64 MSVC compiler was not found.' }

$commandHostSdk = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue).KitsRoot10
if (-not $commandHostSdk) { $commandHostSdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10' }
$commandHostSdkVersion = Get-ChildItem -LiteralPath (Join-Path $commandHostSdk 'Lib') -Directory |
  Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'um\x64\kernel32.lib') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'ucrt\x64\ucrt.lib') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $commandHostSdk ('Include\' + $_.Name + '\um\windows.h')) -PathType Leaf)
  } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $commandHostSdkVersion) { throw 'A complete Windows 10 or 11 x64 SDK was not found.' }

$commandHostPreviousInclude = $env:INCLUDE
$commandHostPreviousLib = $env:LIB
$commandHostStaging = Join-Path $commandHostOutput ('.host-build-' + [Guid]::NewGuid().ToString('N'))
try {
  $commandHostSdkInclude = Join-Path $commandHostSdk ('Include\' + $commandHostSdkVersion.Name)
  $env:INCLUDE = (Join-Path $commandHostVc.FullName 'include') + ';' +
    (Join-Path $commandHostSdkInclude 'ucrt') + ';' +
    (Join-Path $commandHostSdkInclude 'shared') + ';' +
    (Join-Path $commandHostSdkInclude 'um')
  $env:LIB = (Join-Path $commandHostVc.FullName 'lib\x64') + ';' +
    (Join-Path $commandHostSdkVersion.FullName 'ucrt\x64') + ';' +
    (Join-Path $commandHostSdkVersion.FullName 'um\x64')
  Assert-CommandHostDirectory $commandHostOutput
  New-Item -ItemType Directory -Path $commandHostStaging -ErrorAction Stop | Out-Null
  Assert-CommandHostDirectory $commandHostStaging
  $commandHostCompiler = Join-Path $commandHostVc.FullName 'bin\Hostx64\x64\cl.exe'
  & $commandHostCompiler /nologo /std:c++17 /EHsc /W4 /WX /MT /O2 /utf-8 /DUNICODE /D_UNICODE `
    $commandHostSource "/Fo$commandHostStaging\host.obj" "/Fe$commandHostStaging\host.exe" `
    /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA kernel32.lib
  if ($LASTEXITCODE -ne 0) { throw "Windows command-host compilation failed: $LASTEXITCODE" }
  if ((Get-CommandHostTargetIdentity $commandHostExecutable) -cne $commandHostExecutableIdentity -or
      (Get-CommandHostTargetIdentity $commandHostObject) -cne $commandHostObjectIdentity) {
    throw 'Command-host replacement target changed during compilation.'
  }
  Get-CommandHostTargetIdentity (Join-Path $commandHostStaging 'host.exe') | Out-Null
  Get-CommandHostTargetIdentity (Join-Path $commandHostStaging 'host.obj') | Out-Null
  [ZoneCodexCommandHostFileIdentity]::Replace((Join-Path $commandHostStaging 'host.exe'), $commandHostExecutable)
  [ZoneCodexCommandHostFileIdentity]::Replace((Join-Path $commandHostStaging 'host.obj'), $commandHostObject)
} finally {
  $env:INCLUDE = $commandHostPreviousInclude
  $env:LIB = $commandHostPreviousLib
  if (Test-Path -LiteralPath $commandHostStaging) {
    $commandHostStagingFull = [IO.Path]::GetFullPath($commandHostStaging)
    $commandHostOutputPrefix = [IO.Path]::GetFullPath($commandHostOutput).TrimEnd('\') + '\'
    if (-not $commandHostStagingFull.StartsWith($commandHostOutputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Command-host cleanup path is outside the runtime directory.'
    }
    Assert-CommandHostDirectory $commandHostStagingFull
    Remove-Item -LiteralPath $commandHostStagingFull -Recurse -Force
  }
}
