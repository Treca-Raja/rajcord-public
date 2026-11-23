[CmdletBinding()]
param([Parameter(Mandatory)][string]$VisualStudioPath)

$ErrorActionPreference = 'Stop'
$redist = Join-Path $VisualStudioPath 'VC/Redist/MSVC'
$latest = if (Test-Path -LiteralPath $redist -PathType Container) {
  Get-ChildItem -LiteralPath $redist -Directory |
    Where-Object Name -Match '^14\.\d+\.\d+$' |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
}
$required = @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')
if ($latest) {
  foreach ($folder in @('Microsoft.VC145.CRT', 'Microsoft.VC143.CRT')) {
    $paths = $required | ForEach-Object { Join-Path $latest.FullName "x64/$folder/$_" }
    $missing = $paths | Where-Object { !(Test-Path -LiteralPath $_ -PathType Leaf) }
    if (!$missing) { return $paths }
  }
}
throw 'Install the complete Visual Studio x64 v14 redistributable files.'
