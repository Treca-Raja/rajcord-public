[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ObsRuntime,
  [Parameter(Mandatory)][string]$ObsSource,
  [Parameter(Mandatory)][string]$TransportSdk,
  [string]$BuildDirectory = (Join-Path $PSScriptRoot 'dist'),
  [string]$ObsDependencyBin,
  [Parameter(Mandatory)][string]$ObsBuildManifest
)
$ErrorActionPreference = 'Stop'
$dist = (Resolve-Path -LiteralPath $BuildDirectory).Path
if ((Get-Item -LiteralPath $dist).LinkType) {
  throw 'OBS staging needs a local dist directory.'
}
$ready = Join-Path $dist 'bundle'
$bundle = Join-Path $dist ('bundle-staging-' + [guid]::NewGuid().ToString('N'))
$ObsRuntime = (Resolve-Path -LiteralPath $ObsRuntime).Path
$TransportSdk = (Resolve-Path -LiteralPath $TransportSdk).Path
$obsBin = Join-Path $ObsRuntime 'bin/64bit'
if ((Get-Item -LiteralPath "$obsBin/obs.dll").VersionInfo.ProductVersion -ne '33.0.1') {
  throw 'The OBS private bundle requires version 33.0.1.'
}
$locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$tools = Get-ChildItem -LiteralPath (Join-Path $vs 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$dumpbin = Join-Path $tools.FullName 'bin/Hostx64/x64/dumpbin.exe'
$redistributable = Get-ChildItem -LiteralPath (Join-Path $vs 'VC/Redist/MSVC') -Directory |
  Where-Object Name -Match '^14\.\d+\.\d+$' |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$redistributable) { throw 'Install the Visual Studio x64 VC143 redistributable files.' }
$crt = Join-Path $redistributable.FullName 'x64/Microsoft.VC143.CRT'
$imports = [Collections.Generic.Queue[string]]::new()
function Copy-TransportFile([string]$Source, [string]$Relative) {
  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Missing OBS transport component: $Relative" }
  $destination = Join-Path $bundle $Relative
  if (Test-Path -LiteralPath $destination) { return }
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $destination
  $imports.Enqueue($Source)
}
Copy-TransportFile "$dist/rajcord-obs.exe" 'bin/rajcord-obs.exe'
foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
  Copy-TransportFile "$crt/$dll" "bin/$dll"
}
while ($imports.Count) {
  $binary = $imports.Dequeue()
  $lines = & $dumpbin /nologo /dependents $binary
  if ($LASTEXITCODE) { throw "Could not inspect imports of $binary" }
  foreach ($line in $lines) {
    if ($line -match '^\s+([\w.-]+\.dll)\s*$' -and (Test-Path -LiteralPath "$TransportSdk/bin/$($Matches[1])")) {
      Copy-TransportFile "$TransportSdk/bin/$($Matches[1])" "bin/$($Matches[1])"
    }
  }
}
Copy-Item -LiteralPath "$TransportSdk/share/versions.txt" -Destination "$bundle/versions.txt"
Copy-Item -LiteralPath "$TransportSdk/share/licenses" -Destination "$bundle/licenses" -Recurse
New-Item -ItemType Directory -Path "$bundle/obs/data","$bundle/obs/core" | Out-Null
Copy-Item -LiteralPath "$ObsSource/COPYING" -Destination "$bundle/obs/OBS-COPYING.txt"
Copy-Item -LiteralPath "$dist/nvenc/nv-codec-headers-license.txt" -Destination "$bundle/obs/"
Copy-Item -LiteralPath "$PSScriptRoot/licenses/ffmpeg" -Destination "$bundle/obs/ffmpeg-licenses" -Recurse
Copy-Item -LiteralPath "$ObsRuntime/data/libobs" -Destination "$bundle/obs/data" -Recurse
Copy-Item -LiteralPath "$PSScriptRoot/runtime-notices.md" -Destination $bundle
Copy-Item -LiteralPath "$PSScriptRoot/corresponding-source.md" -Destination $bundle
$manifest = Get-Content -LiteralPath $ObsBuildManifest -Raw | ConvertFrom-Json -AsHashtable
$manifest.transport = 'libdatachannel'
$manifest | ConvertTo-Json | Set-Content -LiteralPath "$bundle/obs/source-build.json" -Encoding utf8
foreach ($module in @('obs-nvenc', 'obs-ffmpeg', 'obs-x264')) {
  $origin = "$ObsRuntime/core/$module"
  $destination = "$bundle/obs/core/$module"
  New-Item -ItemType Directory -Path $destination | Out-Null
  $binary = if ($module -eq 'obs-nvenc') { "$dist/nvenc/$module.dll" } else { "$origin/$module.dll" }
  Copy-Item -LiteralPath $binary -Destination $destination
  Copy-Item -LiteralPath "$origin/data" -Destination $destination -Recurse
  $imports.Enqueue($binary)
}
$origin = "$ObsRuntime/core/win-capture"
$destination = "$bundle/obs/core/win-capture"
New-Item -ItemType Directory -Path "$destination/data" | Out-Null
Copy-Item -LiteralPath "$origin/win-capture.dll" -Destination $destination
Copy-Item -LiteralPath "$origin/data/locale" -Destination "$destination/data" -Recurse
Copy-Item -LiteralPath "$origin/data/compatibility.json" -Destination "$destination/data"
foreach ($bits in @('32', '64')) {
  foreach ($file in @("graphics-hook$bits.dll", "inject-helper$bits.exe", "get-graphics-offsets$bits.exe")) {
    Copy-Item -LiteralPath "$origin/data/$file" -Destination "$destination/data"
  }
}
$imports.Enqueue("$origin/win-capture.dll")
function Get-ObsBinary([string]$Name) {
  if (Test-Path -LiteralPath "$obsBin/$Name" -PathType Leaf) { return "$obsBin/$Name" }
  if ($ObsDependencyBin -and (Test-Path -LiteralPath "$ObsDependencyBin/$Name" -PathType Leaf)) {
    return "$ObsDependencyBin/$Name"
  }
}
function Copy-ObsBinary([string]$Name) {
  $origin = if ($Name -eq 'libobs-winrt.dll') {
    "$dist/winrt/$Name"
  } else {
    Get-ObsBinary $Name
  }
  if (!$origin) { throw "Missing private OBS runtime component: $Name" }
  if (Test-Path -LiteralPath "$bundle/bin/$Name") {
    if ((Get-FileHash -LiteralPath "$bundle/bin/$Name").Hash -ne (Get-FileHash -LiteralPath $origin).Hash) {
      throw "Conflicting private runtime DLL: $Name"
    }
    return
  }
  Copy-Item -LiteralPath $origin -Destination "$bundle/bin"
  $imports.Enqueue($origin)
}
foreach ($name in @('obs.dll', 'libobs-d3d11.dll', 'libobs-winrt.dll', 'obs-amf-test.exe', 'obs-nvenc-test.exe')) {
  Copy-ObsBinary $name
}
while ($imports.Count) {
  $binary = $imports.Dequeue()
  $lines = & $dumpbin /nologo /dependents $binary
  if ($LASTEXITCODE) { throw "Could not inspect imports of $binary" }
  foreach ($line in $lines) {
    if ($line -match '^\s+([\w.-]+\.dll)\s*$' -and (Get-ObsBinary $Matches[1])) {
      Copy-ObsBinary $Matches[1]
    }
  }
}
Get-ChildItem -LiteralPath $bundle -Recurse -File | Sort-Object FullName | ForEach-Object {
  [pscustomobject]@{
    path = [IO.Path]::GetRelativePath($bundle, $_.FullName).Replace('\','/')
    sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  }
} | ConvertTo-Json | Set-Content -LiteralPath "$bundle/inventory.json" -Encoding utf8
if (Test-Path -LiteralPath $ready) {
  if ((Resolve-Path -LiteralPath $ready).Path -ne $ready -or (Get-Item -LiteralPath $ready).LinkType) {
    throw 'Existing OBS bundle is outside the local staging directory.'
  }
  Move-Item -LiteralPath $ready -Destination (Join-Path $dist ('bundle-prior-' + [guid]::NewGuid().ToString('N')))
}
Move-Item -LiteralPath $bundle -Destination $ready
