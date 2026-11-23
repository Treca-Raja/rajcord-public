[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$DownloadDirectory,
  [string]$VcpkgSource,
  [string]$RtcSource
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'The OBS WebRTC SDK requires Windows x64.'
}
$output = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
$downloads = (New-Item -ItemType Directory -Path $DownloadDirectory -Force).FullName
$vcpkgPin = '9eec002df1cd109f8f104cd966a763daf9751489'
$rtcPin = '4e4f4892dccb2a57fe3a490d0c9d958de4244e74'

function Get-Checkout([string]$Name, [string]$Path, [string]$Remote, [string]$Pin) {
  if (!$Path) {
    $Path = Join-Path $output $Name
    if (!(Test-Path -LiteralPath "$Path/.git")) {
      & git.exe clone --no-checkout $Remote $Path | Out-Host
      if ($LASTEXITCODE) { throw "Could not clone $Name." }
      & git.exe -C $Path checkout --detach $Pin | Out-Host
      if ($LASTEXITCODE) { throw "Could not check out $Name at $Pin." }
    }
  }
  $Path = (Resolve-Path -LiteralPath $Path).Path
  $head = & git.exe -C $Path rev-parse HEAD
  if ($LASTEXITCODE -or $head -ne $Pin) { throw "$Name must be checked out at $Pin." }
  return $Path
}
$vcpkg = Get-Checkout 'vcpkg' $VcpkgSource 'https://github.com/microsoft/vcpkg.git' $vcpkgPin
$rtc = Get-Checkout 'libdatachannel' $RtcSource 'https://github.com/paullouisageneau/libdatachannel.git' $rtcPin
$changes = & git.exe -C $vcpkg status --porcelain --untracked-files=no
if ($LASTEXITCODE -or $changes) { throw 'The pinned vcpkg recipes have local changes.' }
$submodules = @(& git.exe -C $rtc submodule status --recursive)
if ($LASTEXITCODE) { throw 'Could not inspect libdatachannel submodules.' }
if (!$submodules.Count -or ($submodules -match '^-')) {
  if ($RtcSource) { throw 'Initialize the supplied libdatachannel checkout submodules recursively.' }
  & git.exe -C $rtc submodule update --init --recursive
  if ($LASTEXITCODE) { throw 'Could not fetch the pinned libdatachannel submodules.' }
}

$vcpkgTool = Join-Path $downloads 'vcpkg-2026-09-26-x64.exe'
$toolHash = '2A4AE1467B9E797964C60C919D057B9E5DC1EC03F4B9632C1150026DB25201F2'
if (!(Test-Path -LiteralPath $vcpkgTool)) {
  $candidate = "$vcpkgTool.$([guid]::NewGuid().ToString('N')).download"
  try {
    Invoke-WebRequest -Uri 'https://github.com/microsoft/vcpkg-tool/releases/download/2026-09-26/vcpkg.exe' -OutFile $candidate -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $candidate).Hash -ne $toolHash) { throw 'Unexpected vcpkg tool SHA-256.' }
    Move-Item -LiteralPath $candidate -Destination $vcpkgTool
  } finally {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
  }
}
if ((Get-FileHash -LiteralPath $vcpkgTool).Hash -ne $toolHash) { throw 'Unexpected cached vcpkg tool SHA-256.' }
$installed = Join-Path $output 'installed'
$flags = @(
  "--vcpkg-root=$vcpkg", "--downloads-root=$downloads", "--x-install-root=$installed",
  "--x-buildtrees-root=$output/buildtrees", "--x-packages-root=$output/packages",
  '--triplet=x64-windows', '--host-triplet=x64-windows', '--binarysource=clear'
)
& $vcpkgTool install --classic libnice openssl opus @flags
if ($LASTEXITCODE) { throw "The pinned Windows transport dependencies failed to build. See $output/buildtrees." }
$versions = Join-Path $output 'dependency-versions.txt'
$packages = & $vcpkgTool list "--vcpkg-root=$vcpkg" "--x-install-root=$installed"
if ($LASTEXITCODE -or !$packages) { throw 'Could not record the built vcpkg dependency versions.' }
@("vcpkg recipes $vcpkgPin") + $packages | Set-Content -LiteralPath $versions

$webrtc = @{
  RtcSource = $rtc
  DependencySdk = "$installed/x64-windows"
  OutputDirectory = Join-Path $output 'webrtc'
  DependencyVersions = $versions
}
& (Join-Path $PSScriptRoot 'build-webrtc.ps1') @webrtc
