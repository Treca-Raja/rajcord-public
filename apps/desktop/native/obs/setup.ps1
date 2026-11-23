[CmdletBinding()]
param(
  [string]$SourceArchive,
  [string]$X64Dependencies,
  [string]$X86Dependencies,
  [string]$CodecHeaders,
  [string]$DownloadDirectory,
  [string]$BuildDirectory,
  [string]$VcpkgSource,
  [string]$RtcSource
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'OBS desktop screen sharing builds on Windows x64.'
}
$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $locator)) { throw 'Install Visual Studio x64 C++ Build Tools and Windows SDK 26100.' }
$vs = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs -or !(Get-ChildItem -LiteralPath "$vs/VC/Tools/MSVC" -Directory -Filter '14.44.*')) {
  throw 'Install the MSVC v143 14.44 toolset and the x64 v14 redistributable.'
}
& (Join-Path $PSScriptRoot 'vc-runtime.ps1') -VisualStudioPath $vs | Out-Null
if (!(Test-Path -LiteralPath "${env:ProgramFiles(x86)}/Windows Kits/10/Include/10.0.26100.0/um/audioclientactivationparams.h")) {
  throw 'Install Windows SDK 10.0.26100.0 with the Windows desktop headers.'
}
if (!(Get-Command git.exe -ErrorAction Ignore)) { throw 'Install Git and make git.exe available on PATH.' }
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
if (!$DownloadDirectory) { $DownloadDirectory = Join-Path $repo '.local/obs-sdk/native' }
if (!$BuildDirectory) { $BuildDirectory = Join-Path $repo '.local/obs-native-build' }
$cache = (New-Item -ItemType Directory -Path $DownloadDirectory -Force).FullName
$build = (New-Item -ItemType Directory -Path $BuildDirectory -Force).FullName

function Get-VerifiedInput([string]$Name, [string]$Url, [string]$Sha256) {
  $file = Join-Path $cache $Name
  if (!(Test-Path -LiteralPath $file)) {
    $download = "$file.$([guid]::NewGuid().ToString('N')).download"
    try {
      Invoke-WebRequest -Uri $Url -OutFile $download -TimeoutSec 900
      if ((Get-FileHash -LiteralPath $download).Hash -ne $Sha256) { throw "Incorrect SHA-256 for $Name." }
      Move-Item -LiteralPath $download -Destination $file
    } finally {
      if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download }
    }
  }
  if ((Get-FileHash -LiteralPath $file).Hash -ne $Sha256) { throw "Incorrect SHA-256 for $Name." }
  return $file
}

$commit = '0c790bd0151fb9f574867e025ecf57e6eedc58e2'
$depsRelease = '2026-10-23'
if (!$SourceArchive) {
  $SourceArchive = Get-VerifiedInput "obs-studio-$commit.tar.gz" "https://codeload.github.com/obsproject/obs-studio/tar.gz/$commit" 'EA30CB17B1752121AEE459ADFF124A0CAA3B5EC357635A673BD7CF910A3E6EF7'
}
if (!$X64Dependencies) {
  $name = "windows-deps-$depsRelease-x64.zip"
  $X64Dependencies = Get-VerifiedInput $name "https://github.com/obsproject/obs-deps/releases/download/$depsRelease/$name" '7508972A867A0EF68C26CD8BDBA61FD999EDD0A92FA9EB9585774DE9BF51BFBE'
}
if (!$X86Dependencies) {
  $name = "windows-deps-$depsRelease-x86.zip"
  $X86Dependencies = Get-VerifiedInput $name "https://github.com/obsproject/obs-deps/releases/download/$depsRelease/$name" 'BCA7F4D6603028A7AC9CFA6A88AA3FF0E9402627593633E26CC0B3A5E5312A9B'
}
$headersPin = 'e844e5b26f46bb77479f063029595293aa8f812d'
$headersHash = '42d72fbcca46e05a1c05a79f1cda1fedd68ba686b21adf917e05d908153645d9'
if (!$CodecHeaders) {
  $CodecHeaders = Get-VerifiedInput "nv-codec-headers-$headersPin.tar.gz" "https://codeload.github.com/FFmpeg/nv-codec-headers/tar.gz/$headersPin" $headersHash
}
if ((Get-FileHash -LiteralPath $CodecHeaders).Hash -ne $headersHash) { throw 'Incorrect NVENC headers SHA-256.' }

$transport = @{
  OutputDirectory = Join-Path $build 'rtc'
  DownloadDirectory = $cache
  VcpkgSource = $VcpkgSource
  RtcSource = $RtcSource
}
& (Join-Path $PSScriptRoot 'bootstrap-webrtc.ps1') @transport
$engine = @{
  SourceArchive = $SourceArchive
  X64Dependencies = $X64Dependencies
  X86Dependencies = $X86Dependencies
  TransportSdk = Join-Path $transport.OutputDirectory 'webrtc/sdk'
  CodecHeaders = $CodecHeaders
  BuildDirectory = Join-Path $build 'engine'
  HelperDirectory = Join-Path $PSScriptRoot 'dist'
}
& (Join-Path $PSScriptRoot 'build-engine.ps1') @engine
