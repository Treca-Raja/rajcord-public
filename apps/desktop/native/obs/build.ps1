[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ObsSource,
  [Parameter(Mandatory)][string]$ObsRuntime,
  [Parameter(Mandatory)][string]$TransportSdk,
  [Parameter(Mandatory)][string]$CodecHeaders,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
  [ValidateSet('33.0.1-g0c790bd')][string]$ObsVersion = '33.0.1-g0c790bd'
)

$ErrorActionPreference = 'Stop'
$ObsSource = (Resolve-Path -LiteralPath $ObsSource).Path
$ObsRuntime = (Resolve-Path -LiteralPath $ObsRuntime).Path
$TransportSdk = (Resolve-Path -LiteralPath $TransportSdk).Path
if (!(Get-Command cl.exe -ErrorAction Ignore)) {
  $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $vs = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (!$vs) { throw 'Install the Visual Studio x64 C++ build tools and Windows SDK.' }
  & (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}

$obsDll = Join-Path $ObsRuntime 'bin/64bit/obs.dll'
$expectedOutputHeader = 'E2A4658CE28038EE7EC5056ADA4DF478025D636CC92D5E90E41C08B3BEEB2E2D'
$outputHeader = [IO.File]::ReadAllText("$ObsSource/libobs/obs-output.h").Replace("`r`n", "`n")
$outputHeaderHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($outputHeader)))
if ((Get-Item -LiteralPath $obsDll).VersionInfo.ProductVersion -ne '33.0.1' -or
    $outputHeaderHash -ne $expectedOutputHeader) {
  throw "Use the matching OBS x64 runtime and headers for $ObsVersion."
}
$out = (New-Item -ItemType Directory -Force -Path $OutputDirectory).FullName
@('#pragma once', '#define OBS_DATA_PATH "data"', '#define OBS_INSTALL_PREFIX "."',
  '#define OBS_RELEASE_CANDIDATE 0', '#define OBS_BETA 0', "#define RAJCORD_OBS_VERSION `"$ObsVersion`"") |
  Set-Content -LiteralPath "$out/obsconfig.h"
function New-ImportLibrary([string]$Dll, [string]$ExpectedExport) {
  $name = Split-Path -LeafBase $Dll
  $exports = & dumpbin.exe /nologo /exports $Dll
  if ($LASTEXITCODE) { throw "Could not read the $name export table." }
  $symbols = foreach ($line in $exports) {
    if ($line -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+([a-zA-Z_][a-zA-Z0-9_]+)(?:\s+=\s+.*)?\s*$') { $Matches[1] }
  }
  if ($symbols -notcontains $ExpectedExport) { throw "Missing $ExpectedExport in $name." }
  @("LIBRARY $name.dll", 'EXPORTS') + $symbols | Set-Content -LiteralPath "$out/$name.def"
  & lib.exe /nologo /machine:x64 "/def:$out/$name.def" "/out:$out/$name.lib"
  if ($LASTEXITCODE) { throw "Could not generate the $name import library." }
}
New-ImportLibrary $obsDll 'obs_startup'
New-ImportLibrary "$ObsRuntime/bin/64bit/w32-pthreads.dll" 'pthread_mutex_init'
$transportHeaders = "/I$TransportSdk/include"
$transportLibraries = 'datachannel.lib', 'opus.lib'
$senderSource = 'native-sender.cpp'
$arguments = @(
  '/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/MD', '/utf-8',
  "/I$out", "/I$ObsSource/libobs", $transportHeaders,
  "/I$TransportSdk/include/glib-2.0", "/I$TransportSdk/lib/glib-2.0/include",
  "/Fo$out/sender.obj", "/Fe$out/rajcord-obs.exe", (Join-Path $PSScriptRoot $senderSource),
  '/link', "/LIBPATH:$TransportSdk/lib", "$out/obs.lib", 'dxgi.lib'
) + $transportLibraries + @(
  'glib-2.0.lib', 'user32.lib', 'ws2_32.lib', 'ole32.lib', 'mmdevapi.lib', 'advapi32.lib'
)
& cl.exe @arguments
if ($LASTEXITCODE) { throw "OBS helper build failed ($LASTEXITCODE)." }
$congestionTest = Join-Path $out 'test-congestion.exe'
& cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /MD "/Fo$out/test-congestion.obj" "/Fe$congestionTest" (Join-Path $PSScriptRoot 'test-congestion.cpp')
if ($LASTEXITCODE) { throw 'Could not build the native congestion regression.' }
& $congestionTest
if ($LASTEXITCODE) { throw 'The native congestion regression failed.' }
$opusTest = Join-Path $out 'test-native-opus.exe'
& cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /MD "/I$TransportSdk/include" "/Fo$out/test-native-opus.obj" "/Fe$opusTest" (Join-Path $PSScriptRoot 'test-native-opus.cpp') /link "/LIBPATH:$TransportSdk/lib" opus.lib
if ($LASTEXITCODE) { throw 'Could not build the native Opus regression.' }
$buildPath = $env:PATH
try {
  $env:PATH = "$TransportSdk/bin;$buildPath"
  & $opusTest
  if ($LASTEXITCODE) { throw 'The native Opus regression failed.' }
} finally {
  $env:PATH = $buildPath
}
& cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /MT "/Fo$out/test-playout.obj" "/Fe$out/rajcord-obs-playout.exe" (Join-Path $PSScriptRoot 'test-playout.cpp') /link ole32.lib mmdevapi.lib advapi32.lib
if ($LASTEXITCODE) { throw 'Could not build the supervised playback observer.' }
& (Join-Path $PSScriptRoot 'build-winrt.ps1') -ObsSource $ObsSource -OutputDirectory $out
& (Join-Path $PSScriptRoot 'build-nvenc.ps1') -ObsSource $ObsSource -CodecHeaders $CodecHeaders -OutputDirectory $out
