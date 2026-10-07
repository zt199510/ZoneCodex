$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The Windows command host must be built on Windows.'
}

$commandHostRoot = Split-Path -Parent $PSScriptRoot
$commandHostSource = Join-Path $commandHostRoot 'native\windows-command-host\main.cpp'
$commandHostOutput = Join-Path $commandHostRoot 'resources\windows-command-runtime'
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
try {
  $commandHostSdkInclude = Join-Path $commandHostSdk ('Include\' + $commandHostSdkVersion.Name)
  $env:INCLUDE = (Join-Path $commandHostVc.FullName 'include') + ';' +
    (Join-Path $commandHostSdkInclude 'ucrt') + ';' +
    (Join-Path $commandHostSdkInclude 'shared') + ';' +
    (Join-Path $commandHostSdkInclude 'um')
  $env:LIB = (Join-Path $commandHostVc.FullName 'lib\x64') + ';' +
    (Join-Path $commandHostSdkVersion.FullName 'ucrt\x64') + ';' +
    (Join-Path $commandHostSdkVersion.FullName 'um\x64')
  New-Item -ItemType Directory -Path $commandHostOutput -Force | Out-Null
  $commandHostCompiler = Join-Path $commandHostVc.FullName 'bin\Hostx64\x64\cl.exe'
  & $commandHostCompiler /nologo /std:c++17 /EHsc /W4 /WX /MT /O2 /utf-8 /DUNICODE /D_UNICODE `
    $commandHostSource "/Fo$commandHostOutput\host.obj" "/Fe$commandHostOutput\host.exe" `
    /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA ole32.lib oleaut32.lib advapi32.lib uuid.lib
  if ($LASTEXITCODE -ne 0) { throw "Windows command-host compilation failed: $LASTEXITCODE" }
} finally {
  $env:INCLUDE = $commandHostPreviousInclude
  $env:LIB = $commandHostPreviousLib
}
