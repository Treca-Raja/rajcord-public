$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REF_NAME -ne 'feature/desktop-update-acceptance-v0.1.1') {
  throw 'Run this fixture only on its disposable GitHub Windows runner.'
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$profile = Join-Path $env:APPDATA 'Rajcord'
$install = Join-Path $env:RUNNER_TEMP 'rajcord-update-install'
$location = Join-Path $env:RUNNER_TEMP 'rajcord-update-evidence'
$existing = @(Get-ChildItem HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -eq 'Rajcord')
if ($existing.Count -or (Test-Path -LiteralPath $profile) -or (Test-Path -LiteralPath $install)) {
  throw 'The runner must start without a Rajcord installation or profile.'
}
New-Item -ItemType Directory -Path $location | Out-Null
$env:RAJCORD_FIXTURE_DIR = $location
$keys = node -e "const {generateKeyPairSync}=require('node:crypto'); const keys=generateKeyPairSync('ed25519'); console.log(JSON.stringify({public:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),private:keys.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')}))" | ConvertFrom-Json
$env:RAJCORD_UPDATE_PUBLIC_KEY = $keys.public
$source = 'apps/desktop/src/update-manifest.ts'
$contents = Get-Content -LiteralPath $source -Raw
$origin = 'https://github.com/Treca-Raja/rajcord-public/releases'
if (-not $contents.Contains($origin)) { throw 'The fixture expected the production release origin.' }
Set-Content -LiteralPath $source -Value $contents.Replace($origin, 'http://127.0.0.1:39475/releases') -NoNewline
@'
const config = require('./electron-builder.cjs');
module.exports = {
  ...config,
  files: [...config.files, 'dist/update-acceptance.cjs'],
  extraMetadata: { ...config.extraMetadata, main: 'dist/update-acceptance.cjs' },
};
'@ | Set-Content -LiteralPath apps/desktop/electron-builder.acceptance.cjs

function Build-Installer {
  pnpm --filter @tricord/desktop build
  Copy-Item -LiteralPath scripts/desktop-update-acceptance.cjs -Destination apps/desktop/dist/update-acceptance.cjs
  pnpm --filter @tricord/desktop exec electron-builder --config electron-builder.acceptance.cjs --win nsis --x64 --publish never
}

Build-Installer
$old = (Resolve-Path -LiteralPath artifacts/desktop/Rajcord-Setup-0.1.1-x64.exe).Path
node -e "const fs=require('node:fs');const file='apps/desktop/package.json';const pkg=JSON.parse(fs.readFileSync(file));if(pkg.version!=='0.1.1')throw Error('Unexpected baseline');pkg.version='0.1.2';fs.writeFileSync(file,JSON.stringify(pkg,null,2)+'\n')"
Build-Installer
$env:RAJCORD_UPDATE_PRIVATE_KEY = $keys.private
node scripts/desktop-update-manifest.mjs
Remove-Item Env:RAJCORD_UPDATE_PRIVATE_KEY
pnpm desktop:audit
Copy-Item -LiteralPath artifacts/desktop/rajcord-windows-update.json,artifacts/desktop/Rajcord-Setup-0.1.2-x64.exe -Destination $location

function Invoke-FixtureApp([string]$Role) {
  $env:RAJCORD_FIXTURE_ROLE = $Role
  $child = Start-Process -FilePath (Join-Path $install 'Rajcord.exe') -WindowStyle Hidden -PassThru
  if (-not $child.WaitForExit(60000)) { $child.Kill(); throw "Rajcord fixture timed out in $Role mode." }
  if ($child.ExitCode -ne 0) {
    $errorFile = Join-Path $location 'error.txt'
    if (Test-Path -LiteralPath $errorFile) { throw (Get-Content -LiteralPath $errorFile -Raw) }
    throw "Rajcord fixture failed in $Role mode."
  }
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:RAJCORD_FIXTURE_ROLE = 'feed'
$node = (Get-Command node).Source
$server = Start-Process -FilePath $node -ArgumentList 'scripts/desktop-update-acceptance.cjs' -WindowStyle Hidden -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    try { $ready = (Invoke-RestMethod -Uri 'http://127.0.0.1:39475/ready' -TimeoutSec 2) -eq 'ready' } catch {}
    if ($ready) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'The disposable update feed did not start.' }
  $env:RAJCORD_FIXTURE_ROLE = 'idle'
  $setup = Start-Process -FilePath $old -ArgumentList @('/S', "/D=$install") -WindowStyle Hidden -Wait -PassThru
  if ($setup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $install 'Rajcord.exe'))) { throw 'Initial fixture installation failed.' }
  Invoke-FixtureApp 'decline'
  $requests = @(Get-Content -LiteralPath (Join-Path $location 'requests.txt'))
  if ($requests.Count -ne 1 -or $requests[0] -ne 'rajcord-windows-update.json') { throw 'Declining the offer triggered an installer download.' }
  Invoke-FixtureApp 'install'
  $handoff = Get-Content -LiteralPath (Join-Path $location 'installer.json') -Raw | ConvertFrom-Json
  $expectedHash = (Get-FileHash -LiteralPath (Join-Path $location 'Rajcord-Setup-0.1.2-x64.exe') -Algorithm SHA512).Hash
  if (-not $handoff.internetZone -or (Get-FileHash -LiteralPath $handoff.file -Algorithm SHA512).Hash -ne $expectedHash) { throw 'Update handoff returned the wrong installer.' }
  $env:RAJCORD_FIXTURE_ROLE = 'idle'
  $upgrade = Start-Process -FilePath $handoff.file -ArgumentList @('/S', "/D=$install") -WindowStyle Hidden -Wait -PassThru
  if ($upgrade.ExitCode -ne 0) { throw 'The verified NSIS upgrade failed.' }
  Invoke-FixtureApp 'probe'
  $result = Get-Content -LiteralPath (Join-Path $location 'upgraded.json') -Raw | ConvertFrom-Json
  if ($result.version -ne '0.1.2' -or -not $result.profilePreserved) { throw 'The updated app reported the wrong version or profile.' }
  Write-Output 'PASS Installed v0.1.1, declined once, downloaded and verified v0.1.2, checked the Windows Internet zone marker, ran the downloaded NSIS upgrade, and preserved the installed profile.'
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
