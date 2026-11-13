$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo
$version = (Get-Content -LiteralPath apps/desktop/package.json -Raw | ConvertFrom-Json).version
$installer = Join-Path $repo "artifacts/desktop/Rajcord-Setup-$version-x64.exe"
$installRoot = [IO.Path]::GetFullPath((Join-Path $repo '.local/desktop-install'))
if (-not $installRoot.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay inside this checkout.' }
if (Test-Path -LiteralPath $installRoot) { throw 'Fixture install path already exists; inspect it before rerunning.' }
$profile = Join-Path $env:APPDATA 'Rajcord'
$marker = Join-Path $profile '.distribution-test-owner'
if ((Test-Path -LiteralPath $profile) -and (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $repo)) { throw 'This test requires a Windows account without an existing non-fixture Rajcord profile.' }
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rajcord.lnk'),
  (Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Rajcord.lnk')
)
foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'An existing Rajcord shortcut must be preserved.' } }
$existing = @(Get-ChildItem HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -eq 'Rajcord')
if ($existing.Count -gt 0) { throw 'An existing Rajcord installation must be preserved.' }
$exe = Join-Path $installRoot 'Rajcord.exe'
try {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -Wait -PassThru
  if ($install.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw 'NSIS installation failed.' }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in $shortcuts) {
    if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Installer did not create an expected shortcut.' }
    if ($shell.CreateShortcut($shortcut).TargetPath -ne $exe) { throw 'Shortcut points at another executable.' }
  }
  $metadata = (Get-Item -LiteralPath $exe).VersionInfo
  if ($metadata.ProductName -ne 'Rajcord' -or $metadata.ProductVersion -ne "$version.0") { throw 'Executable identity mismatch.' }
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Set-Content -LiteralPath $marker -Value $repo
  node scripts/desktop-installed-smoke.mjs $exe
  if ($LASTEXITCODE -ne 0) { throw 'Installed runtime smoke failed.' }
  Write-Output 'PASS NSIS per-user installation, executable metadata and Desktop/Start Menu shortcut targets.'
} finally {
  $uninstaller = Join-Path $installRoot 'Uninstall Rajcord.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $profileExisted = Test-Path -LiteralPath (Join-Path $env:APPDATA 'Rajcord')
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw 'NSIS uninstall failed.' }
    for ($attempt = 0; $attempt -lt 100 -and (Test-Path -LiteralPath $exe); $attempt++) { Start-Sleep -Milliseconds 200 }
    if (Test-Path -LiteralPath $exe) { throw 'Uninstall left the application executable.' }
    foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw 'Uninstall left a shortcut.' } }
    $remaining = @(Get-ChildItem HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -eq 'Rajcord')
    if ($remaining.Count -gt 0) { throw 'Uninstall left its per-user registration.' }
    if ($profileExisted -and -not (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Rajcord'))) { throw 'Uninstall unexpectedly removed user data.' }
    Write-Output 'PASS NSIS uninstallation and shortcut cleanup.'
    if ($profileExisted) { Write-Output 'PASS user profile preserved after uninstall.' }
  }
}
