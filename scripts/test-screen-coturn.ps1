[CmdletBinding()]
param(
  [ValidateSet('udp', 'tcp', 'tls')][string[]]$Transport = @('udp', 'tcp', 'tls'),
  [switch]$Extended,
  [switch]$NormalIce,
  [switch]$Long,
  [switch]$VideoOnly
)

$ErrorActionPreference = 'Stop'
if ($VideoOnly -and (!$IsWindows -or $Extended -or $NormalIce)) {
  throw 'VideoOnly uses the Windows video fixture with forced relay. Extended audio and normal ICE tests use the supervised audio fixture.'
}
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$compose = Join-Path $repo 'infrastructure/screen-turn/compose.fixture.yaml'
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (!$openssl -and $IsWindows) { $openssl = 'C:/Program Files/Git/usr/bin/openssl.exe' }
if (!$openssl -or !(Test-Path -LiteralPath $openssl)) { throw 'OpenSSL is required for the fixture certificate.' }
$base = (New-Item -ItemType Directory -Path (Join-Path $repo '.local') -Force).FullName
$runtime = (New-Item -ItemType Directory -Path (Join-Path $base ('screen-turn-' + [guid]::NewGuid().ToString('N')))).FullName
$env:SCREEN_TURN_RUNTIME = $runtime
$env:SCREEN_COTURN_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$env:NODE_EXTRA_CA_CERTS = Join-Path $runtime 'fullchain.pem'
$owned = $false
$failures = [Collections.Generic.List[string]]::new()
Push-Location -LiteralPath $repo
$audioRecord = $null

function Invoke-MediaCheck([string]$Label, [string[]]$Options) {
  if ($VideoOnly) {
    $mode = $Options | Where-Object { $_ -match '^--coturn=(udp|tcp|tls)$' }
    $duration = $Options | Where-Object { $_ -match '^--seconds=\d+$' }
    $env:RAJCORD_SCREEN_BENCH_COTURN = $mode.Substring(9)
    $env:RAJCORD_SCREEN_BENCH_VIEWERS = '1'
    $env:RAJCORD_SCREEN_BENCH_SECONDS = if ($duration) { $duration.Substring(10) } else { '8' }
    node scripts/test-obs-screen.mjs
    if ($LASTEXITCODE) { $failures.Add($Label) }
    return
  }
  node scripts/test-obs-av.mjs @Options
  $mediaExit = $LASTEXITCODE
  if ($IsWindows) {
    node --input-type=module -e "import { checkWindowsAudio } from './scripts/obs-audio-service.mjs'; await checkWindowsAudio(Number(process.argv[1]));" $audioRecord
    if ($LASTEXITCODE) { throw 'The Windows Audio environment changed during the coturn fixture.' }
  }
  if ($mediaExit) { throw "Coturn audio check stopped at $Label (exit $mediaExit)." }
}

function Get-RelayAllocations {
  $metrics = (Invoke-WebRequest http://127.0.0.1:19641/metrics -TimeoutSec 2).Content
  $allocations = [regex]::Matches($metrics, '(?m)^turn_total_allocations\{[^\r\n]*\}\s+([0-9]+)\s*$')
  return [int](($allocations | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Sum).Sum)
}

function Get-RelayTransmitBytes([string]$Container) {
  $value = docker exec $Container cat /sys/class/net/eth0/statistics/tx_bytes
  if ($LASTEXITCODE -or $value -notmatch '^\d+$') { throw 'Could not read the fixture relay transmit counter.' }
  return [long]$value
}

try {
  if ($IsWindows -and !$VideoOnly) {
    $audioRecord = node --input-type=module -e "import { checkWindowsAudio } from './scripts/obs-audio-service.mjs'; console.log(await checkWindowsAudio());"
    if ($LASTEXITCODE) { throw 'Windows Audio must be healthy before starting the coturn fixture.' }
  }
  $existing = docker compose -f $compose ps -a -q
  if ($LASTEXITCODE -or $existing) { throw 'Docker is unavailable or a screen relay fixture already exists.' }
  $certificateArgs = @('req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost','-keyout',"$runtime/privkey.pem",'-out',"$runtime/fullchain.pem")
  & $openssl @certificateArgs 2>$null
  if ($LASTEXITCODE) { throw 'Could not prepare the local TLS certificate.' }
  $common = Get-Content -LiteralPath (Join-Path $repo 'infrastructure/screen-turn/turnserver.common.conf')
  @($common) + @(
    'realm=localhost', 'listening-ip=0.0.0.0', 'relay-ip=172.31.247.2',
    'allowed-peer-ip=172.31.247.2', 'denied-peer-ip=0.0.0.0-255.255.255.255',
    'prometheus-address=0.0.0.0', "static-auth-secret=$env:SCREEN_COTURN_SECRET"
  ) | Set-Content -LiteralPath "$runtime/turnserver.conf"
  $owned = $true
  docker compose -f $compose up -d --build
  if ($LASTEXITCODE) { throw 'Could not start the isolated coturn instance.' }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30 -and !$ready; $attempt++) {
    try { $ready = (Invoke-WebRequest http://127.0.0.1:19641/metrics -TimeoutSec 1).StatusCode -eq 200 }
    catch { Start-Sleep -Milliseconds 250 }
  }
  if (!$ready) {
    docker compose -f $compose logs --tail=30 | ForEach-Object { $_.Replace($env:SCREEN_COTURN_SECRET, '<secret>') }
    throw 'The coturn metrics endpoint did not become ready.'
  }
  node scripts/test-coturn-control.mjs
  if ($LASTEXITCODE) { $failures.Add('authorization and destination policy') }
  node scripts/test-coturn-tls.mjs
  if ($LASTEXITCODE) { $failures.Add('certificate-verified TLS control') }
  node scripts/test-coturn-tls.mjs --wrong-host
  if ($LASTEXITCODE) { $failures.Add('TLS hostname rejection') }
  $fixtureCa = $env:NODE_EXTRA_CA_CERTS
  Remove-Item Env:NODE_EXTRA_CA_CERTS
  try {
    node scripts/test-coturn-tls.mjs --untrusted
    if ($LASTEXITCODE) { $failures.Add('TLS trust-chain rejection') }
  } finally { $env:NODE_EXTRA_CA_CERTS = $fixtureCa }
  foreach ($mode in $Transport) {
    Invoke-MediaCheck "$mode media" @("--coturn=$mode", '--rejoin')
  }
  $container = docker compose -f $compose ps -q coturn
  if ($Extended) {
    $env:RAJCORD_COTURN_TEST_CONTAINER = $container
    Invoke-MediaCheck 'ICE restart' @('--coturn=udp', '--relay-outage', '--rejoin')
    Invoke-MediaCheck 'three-viewer media' @('--coturn=udp', '--three-viewers')
  }
  if ($Extended -or $NormalIce) {
    Invoke-MediaCheck 'preference for direct media with TLS available' @('--coturn=tls', '--production-ice')
  }
  if ($Long) {
    $sentBefore = Get-RelayTransmitBytes $container
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Invoke-MediaCheck 'relay media through allocation refresh' @('--coturn=udp', '--seconds=135', '--rejoin')
    $sentAfter = Get-RelayTransmitBytes $container
    [ordered]@{
      relayTxBytes = $sentAfter - $sentBefore
      elapsedSeconds = $clock.Elapsed.TotalSeconds
      viewers = 1
    } | ConvertTo-Json -Compress
  }
  $active = Get-RelayAllocations
  $releaseTimeout = if ($Long) { 125 } else { 6 }
  for ($waited = 0; $active -and $waited -lt $releaseTimeout; $waited++) {
    Start-Sleep -Seconds 1
    $active = Get-RelayAllocations
  }
  Write-Output "Coturn active allocations after disconnect: $active (waited ${waited}s)"
  if ($active -and $Long) { $failures.Add('allocation cleanup by maximum lifetime') }
  docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}} {{.NetIO}}' $container
  if ($failures.Count) { throw ('Coturn qualification failures: ' + ($failures -join ', ')) }
} finally {
  if ($owned) { docker compose -f $compose down }
  Pop-Location
  if ((Resolve-Path -LiteralPath $runtime).Path -eq $runtime -and
      (Split-Path -Parent $runtime) -eq $base -and (Split-Path -Leaf $runtime) -match '^screen-turn-[0-9a-f]{32}$') {
    Remove-Item -LiteralPath $runtime -Recurse
  }
}
