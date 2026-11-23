[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RtcSource,
  [Parameter(Mandatory)][string]$DependencySdk,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [Parameter(Mandatory)][string]$DependencyVersions
)

$ErrorActionPreference = 'Stop'
$pin = '4e4f4892dccb2a57fe3a490d0c9d958de4244e74'
$source = (Resolve-Path -LiteralPath $RtcSource).Path
$dependencies = (Resolve-Path -LiteralPath $DependencySdk).Path
$output = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
if ((git -C $source rev-parse HEAD) -ne $pin -or $LASTEXITCODE) {
  throw "Use the libdatachannel checkout at $pin."
}
$submodules = @(git -C $source submodule status --recursive)
if ($LASTEXITCODE -or !$submodules.Count -or ($submodules -match '^[+\-U]')) {
  throw 'Initialize the pinned libdatachannel submodules.'
}
$patch = Join-Path $PSScriptRoot 'libdatachannel-ice-binding.patch'
git -C $source apply --reverse --check $patch 2>$null
if ($LASTEXITCODE) {
  git -C $source apply $patch
  if ($LASTEXITCODE) { throw 'Could not apply the libnice bind-address patch.' }
}

$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Install Visual Studio x64 C++ build tools.' }
$cmake = Join-Path $vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
$installationVersion = [version](& $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion)
$generator = if ($installationVersion.Major -ge 18) { 'Visual Studio 18 2026' } else { 'Visual Studio 17 2022' }
$chosenCmake = (Get-Command cmake.exe -ErrorAction Ignore).Source
if ($chosenCmake) { $cmake = $chosenCmake }
if (!(Test-Path -LiteralPath $cmake)) { throw 'Install CMake with support for the installed Visual Studio generator.' }
$build = Join-Path $output 'build'
$options = @(
  '-DUSE_NICE=ON', '-DUSE_MBEDTLS=OFF', '-DUSE_GNUTLS=OFF', '-DNO_WEBSOCKET=ON', '-DNO_EXAMPLES=ON', '-DNO_TESTS=ON',
  "-DCMAKE_PREFIX_PATH=$dependencies", "-DOPENSSL_ROOT_DIR=$dependencies"
)
& $cmake -S $source -B $build -G $generator -A x64 @options
if ($LASTEXITCODE) { throw 'Could not configure libdatachannel with libnice and OpenSSL.' }
& $cmake --build $build --config Release --parallel 6 --target datachannel
if ($LASTEXITCODE) { throw 'Could not build the native libdatachannel library.' }

$sdk = Join-Path $output 'sdk'
foreach ($dir in @('bin', 'lib', 'include', 'share/licenses')) {
  New-Item -ItemType Directory -Path "$sdk/$dir" -Force | Out-Null
}
foreach ($file in Get-ChildItem -LiteralPath "$dependencies/bin" -File -Filter '*.dll') {
  Copy-Item -LiteralPath $file.FullName -Destination "$sdk/bin" -Force
}
foreach ($file in @('opus.lib', 'glib-2.0.lib')) {
  Copy-Item -LiteralPath "$dependencies/lib/$file" -Destination "$sdk/lib" -Force
}
foreach ($include in @('opus', 'glib-2.0')) {
  Copy-Item -LiteralPath "$dependencies/include/$include" -Destination "$sdk/include" -Recurse -Force
}
Copy-Item -LiteralPath "$dependencies/lib/glib-2.0" -Destination "$sdk/lib" -Recurse -Force
Copy-Item -LiteralPath "$source/include/rtc" -Destination "$sdk/include" -Recurse -Force
Copy-Item -LiteralPath "$build/Release/datachannel.dll" -Destination "$sdk/bin" -Force
Copy-Item -LiteralPath "$build/Release/datachannel.lib" -Destination "$sdk/lib" -Force
foreach ($package in Get-ChildItem -LiteralPath "$dependencies/share" -Directory) {
  if (Test-Path -LiteralPath "$($package.FullName)/copyright" -PathType Leaf) {
    Copy-Item -LiteralPath "$($package.FullName)/copyright" -Destination "$sdk/share/licenses/$($package.Name).txt" -Force
  }
}
Copy-Item -LiteralPath "$source/LICENSE" -Destination "$sdk/share/licenses/libdatachannel.txt" -Force
Copy-Item -LiteralPath "$source/deps/usrsctp/LICENSE.md" -Destination "$sdk/share/licenses/usrsctp.txt" -Force
Copy-Item -LiteralPath "$source/deps/libsrtp/LICENSE" -Destination "$sdk/share/licenses/libsrtp.txt" -Force
@("libdatachannel 0.24.2 ($pin) with libnice and OpenSSL") +
  (Get-Content -LiteralPath $DependencyVersions) |
  Set-Content -LiteralPath "$sdk/share/versions.txt"
Write-Output $sdk
