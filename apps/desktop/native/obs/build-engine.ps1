[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceArchive,
  [Parameter(Mandatory)][string]$X64Dependencies,
  [Parameter(Mandatory)][string]$X86Dependencies,
  [Parameter(Mandatory)][string]$TransportSdk,
  [Parameter(Mandatory)][string]$CodecHeaders,
  [string]$BuildDirectory,
  [string]$HelperDirectory

)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../../..')).Path
$commit = '0c790bd0151fb9f574867e025ecf57e6eedc58e2'
$build = (New-Item -ItemType Directory -Force -Path $(if ($BuildDirectory) { $BuildDirectory } else {
  Join-Path $repo ".local/obs-engine-$($commit.Substring(0, 7))"
})).FullName
$source = Join-Path $build 'src'
$dependencyDir = Join-Path $source '.deps'
$obsVersion = "33.0.1-g$($commit.Substring(0, 7))"

function Resolve-VerifiedInput([string]$Path, [string]$Hash) {
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if ((Get-FileHash -LiteralPath $resolved).Hash -ne $Hash) {
    throw "Unexpected SHA-256 for $(Split-Path -Leaf $resolved)."
  }
  $resolved
}

$sourceHash = 'EA30CB17B1752121AEE459ADFF124A0CAA3B5EC357635A673BD7CF910A3E6EF7'
$x64Hash = '7508972A867A0EF68C26CD8BDBA61FD999EDD0A92FA9EB9585774DE9BF51BFBE'
$x86Hash = 'BCA7F4D6603028A7AC9CFA6A88AA3FF0E9402627593633E26CC0B3A5E5312A9B'
$SourceArchive = Resolve-VerifiedInput $SourceArchive $sourceHash
$X64Dependencies = Resolve-VerifiedInput $X64Dependencies $x64Hash
$X86Dependencies = Resolve-VerifiedInput $X86Dependencies $x86Hash
New-Item -ItemType Directory -Path $build -Force | Out-Null
$prepared = Join-Path $build 'source-ready'
if (!(Test-Path -LiteralPath $prepared)) {
  New-Item -ItemType Directory -Path $source -Force | Out-Null
  & tar.exe -xf $SourceArchive -C $source --strip-components 1 '--exclude=*/.github/scripts/*' '--exclude=*/build-aux/run-*'
  if ($LASTEXITCODE) { throw 'Could not extract the pinned OBS source.' }
  $plugins = @(
    'obs-ffmpeg', 'obs-nvenc', 'obs-x264', 'win-capture'
  ) | ForEach-Object { "add_core_module($_)" }
  @(
    'set_property(GLOBAL PROPERTY ENABLE_PLUGINS ON)',
    'set_property(GLOBAL APPEND PROPERTY OBS_FEATURES_ENABLED "Core Modules")'
  ) + $plugins + 'set_obs_core_modules()' |
    Set-Content -LiteralPath "$source/plugins/CMakeLists.txt"

  New-Item -ItemType File -Path $prepared | Out-Null
}
# The headless engine needs the prebuilt libraries without the frontend's Qt SDK.
$buildspec = Join-Path $source 'cmake/windows/buildspec.cmake'
$text = [IO.File]::ReadAllText($buildspec).
  Replace('set(dependencies_list prebuilt qt6 cef)', 'set(dependencies_list prebuilt)').
  Replace('if(NOT CMAKE_VS_PLATFORM_NAME STREQUAL Win32)', 'if(NOT CMAKE_VS_PLATFORM_NAME STREQUAL Win32 AND ENABLE_FRONTEND)')
[IO.File]::WriteAllText($buildspec, $text)
New-Item -ItemType Directory -Path $dependencyDir -Force | Out-Null
Copy-Item -LiteralPath $X64Dependencies -Destination "$dependencyDir/windows-deps-2026-10-23-x64.zip" -Force
Copy-Item -LiteralPath $X86Dependencies -Destination "$dependencyDir/windows-deps-2026-10-23-x86.zip" -Force

$architecture = Join-Path $source 'cmake/windows/architecture.cmake'
$text = [IO.File]::ReadAllText($architecture)
[IO.File]::WriteAllText($architecture, $text.Replace('  add_subdirectory(plugins/win-dshow/virtualcam-module)', ''))
$relativeSource = [IO.Path]::GetRelativePath($repo, $source).Replace('\', '/')
foreach ($patchName in @('windows-game-capture.patch', 'windows-game-compatibility.patch')) {
  $gameCapturePatch = Join-Path $PSScriptRoot $patchName
  & git.exe -C $repo apply --check --reverse "--directory=$relativeSource" $gameCapturePatch 2>$null
  if ($LASTEXITCODE) {
    & git.exe -C $repo apply "--directory=$relativeSource" $gameCapturePatch
    if ($LASTEXITCODE) { throw "Could not apply the OBS Game Capture patch $patchName." }
  }
}

$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Install Visual Studio x64 C++ build tools and Windows SDK 26100.' }
$cmake = (Get-Command cmake.exe -ErrorAction Ignore).Source
if (!$cmake) {
  $cmake = Join-Path $vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
}
if (!(Test-Path -LiteralPath $cmake)) { throw 'Install CMake 3.28 or later.' }
$installationVersion = [version](& $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion)
$generator = if ($installationVersion.Major -ge 18) { 'Visual Studio 18 2026' } else { 'Visual Studio 17 2022' }
$configuration = Join-Path $build 'build-x64'
$options = @(
  '-DENABLE_FRONTEND=OFF', '-DENABLE_BROWSER=OFF', '-DENABLE_SCRIPTING=OFF',
  '-DENABLE_NEW_MPEGTS_OUTPUT=OFF', '-DENABLE_COMPAT_UPDATES=OFF', '-DCMAKE_PREFIX_PATH=',
  '-DVIRTUALCAM_GUID=A3FCE0F5-3493-419F-958A-ABA1250EC20B',
  "-DOBS_VERSION_OVERRIDE=$obsVersion"
)
& $cmake -S $source -B $configuration -G $generator -A 'x64,version=10.0.26100.0' -T 'v143,version=14.44' @options
if ($LASTEXITCODE) { throw 'Could not configure the headless OBS engine.' }
$targets = @(
  'libobs-d3d11', 'libobs-winrt', 'win-capture',
  'obs-ffmpeg', 'obs-amf-test', 'obs-x264', 'obs-nvenc', 'obs-nvenc-test'
)
& $cmake --build $configuration --config RelWithDebInfo --parallel 4 --target @targets
if ($LASTEXITCODE) { throw 'Could not build the headless OBS engine.' }
$runtime = Join-Path $configuration 'rundir/RelWithDebInfo'
$helper = if ($HelperDirectory) { $HelperDirectory } else { Join-Path $build 'rajcord' }
& (Join-Path $PSScriptRoot 'build.ps1') -ObsSource $source -ObsRuntime $runtime -ObsVersion $obsVersion `
  -TransportSdk $TransportSdk -CodecHeaders $CodecHeaders -OutputDirectory $helper
$provenance = Join-Path $helper 'source-build.json'
[ordered]@{
  obsCommit = $commit
  obsBuildVersion = $obsVersion
  sourceSha256 = $sourceHash
  dependenciesRelease = '2026-10-23'
  x64DependenciesSha256 = $x64Hash
  x86DependenciesSha256 = $x86Hash
} | ConvertTo-Json | Set-Content -LiteralPath $provenance -Encoding utf8
& (Join-Path $PSScriptRoot 'stage.ps1') -ObsSource $source -ObsRuntime $runtime -TransportSdk $TransportSdk `
  -BuildDirectory $helper -ObsDependencyBin "$dependencyDir/obs-deps-2026-10-23-x64/bin" `
  -ObsBuildManifest $provenance
Write-Output (Join-Path $helper 'bundle')
