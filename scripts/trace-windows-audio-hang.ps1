#requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(ParameterSetName = 'Capture', Mandatory)][switch]$Capture,
    [Parameter(ParameterSetName = 'Capture')][ValidateRange(5, 120)][int]$Seconds = 45,
    [Parameter(ParameterSetName = 'Snapshot', Mandatory)][switch]$Snapshot
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$profile = "$PSScriptRoot/windows-audio-hang.wprp!RajcordAudioHang.Light"
$wctSource = "$PSScriptRoot/windows-audio-wait-chain.cs"

function Get-AudioService {
    Get-CimInstance Win32_Service -Filter "Name='Audiosrv'" -OperationTimeoutSec 3 |
        Select-Object State, ProcessId
}

function Get-SessionEvidence {
    [ordered]@{
        timeUtc = [DateTimeOffset]::UtcNow.ToString('o')
        service = Get-AudioService
        processes = @(Get-Process audiodg,rajcord-obs -ErrorAction SilentlyContinue |
            Select-Object -First 16 ProcessName, Id)
    }
}

if ($Snapshot) {
    Add-Type -Path $wctSource
    $state = Get-SessionEvidence
    # Resolve the live host in this worker to avoid sampling an obsolete PID.
    $pids = @($state.service.ProcessId) + @($state.processes |
        Where-Object ProcessName -eq audiodg | Select-Object -First 4 -ExpandProperty Id)
    $state | ConvertTo-Json -Depth 4 -Compress
    foreach ($processId in $pids | Where-Object { $_ -gt 0 }) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (!$process) { continue }
        foreach ($thread in $process.Threads | Select-Object -First 128) {
            [ordered]@{
                processId = $processId
                chain = [RajcordAudioWaitChain]::Read($thread.Id)
            } | ConvertTo-Json -Depth 8 -Compress
        }
    }
    exit
}

# Validate the profile and native marshalling without starting ETW.
$wpr = (Get-Command wpr.exe).Source
& $wpr -profiledetails $profile
if ($LASTEXITCODE) { throw 'Could not validate the Rajcord Audio WPR profile.' }
if (!$Capture) {
    Add-Type -Path $wctSource
    $thread = [RajcordAudioWaitChain]::GetCurrentThreadId()
    $chain = [RajcordAudioWaitChain]::Read($thread)
    if ($chain.Error -or $chain.Nodes[0].ProcessId -ne $PID -or $chain.Nodes[0].ThreadId -ne $thread) {
        throw 'Wait-chain self-check failed.'
    }
    "Wait-chain self-check passed for PID $PID, thread $thread."
    return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Capture requires an explicitly authorized administrator PowerShell session.'
}

$instance = "RajcordAudio-$([guid]::NewGuid().ToString('N'))"
$output = New-Item -ItemType Directory -Force "$PSScriptRoot/../.local/windows-audio-traces/$instance"
$trace = Join-Path $output audio.etl
$before = Get-SessionEvidence
$before | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $output start.json)
$recording = $false

function Invoke-Wpr([int]$TimeoutMs, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($wpr)
    $info.UseShellExecute = $false
    foreach ($arg in $Arguments + @('-instancename', $instance)) {
        $info.ArgumentList.Add($arg)
    }
    $process = [Diagnostics.Process]::Start($info)
    try {
        if (!$process.WaitForExit($TimeoutMs)) {
            $process.Kill()
            $process.WaitForExit()
            throw "WPR $($Arguments[0]) timed out."
        }
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

try {
    $recording = $true
    if ((Invoke-Wpr 15000 @('-start', $profile)) -ne 0) { throw 'WPR could not start the named session.' }
    Write-Host "Recording $instance for up to $Seconds seconds. Press Enter at the first symptom."
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $trigger = 'deadline'
    while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
        if (![Console]::IsInputRedirected -and [Console]::KeyAvailable) {
            if ([Console]::ReadKey($true).Key -eq [ConsoleKey]::Enter) {
                $trigger = 'operator'
                break
            }
        }
        $live = Get-AudioService
        if ($live.State -ne 'Running' -or $live.ProcessId -ne $before.service.ProcessId) {
            $trigger = 'service-state-or-pid-changed'
            break
        }
        Start-Sleep -Milliseconds 500
    }
    [ordered]@{ reason = $trigger; timeUtc = [DateTimeOffset]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content (Join-Path $output trigger.json)

    # A native WCT request can block while a process is hung.
    $snapshot = @{
        FilePath = Join-Path $PSHOME pwsh.exe
        ArgumentList = @('-NoProfile', '-NonInteractive', '-File', ('"{0}"' -f $PSCommandPath), '-Snapshot')
        RedirectStandardOutput = Join-Path $output wait-chains.jsonl
        RedirectStandardError = Join-Path $output wait-chain-error.txt
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    $worker = Start-Process @snapshot
    if (!$worker.WaitForExit(7000)) {
        $worker.Kill()
        $worker.WaitForExit()
        'Wait-chain worker exceeded its seven-second budget.' | Add-Content (Join-Path $output wait-chain-error.txt)
    }
    $worker.Dispose()

    if ((Invoke-Wpr 60000 @('-stop', $trace, 'Rajcord Audio service', '-skipPdbGen', '-compress')) -ne 0) {
        throw 'WPR could not save the named session.'
    }
    $recording = $false
    if ((Get-Item -LiteralPath $trace).Length -gt 128MB) {
        Remove-Item -LiteralPath $trace
        throw 'The merged ETL exceeded the 128 MiB retention limit.'
    }
} finally {
    try {
        if ($recording -and (Invoke-Wpr 15000 @('-cancel')) -ne 0) {
            Write-Warning "Check the named session using wpr -status -instancename $instance."
        }
    } finally {
        $displayName = (Get-Service Audiosrv).DisplayName
        $events = @(Get-WinEvent -FilterHashtable @{
            LogName = 'System'
            ProviderName = 'Service Control Manager'
            Id = 7031, 7034, 7036
            StartTime = ([DateTimeOffset]$before.timeUtc).LocalDateTime
        } -ErrorAction SilentlyContinue | Where-Object {
            $_.Properties[0].Value -eq $displayName
        } | Select-Object -First 20 TimeCreated, Id, RecordId)
        ConvertTo-Json -InputObject $events | Set-Content (Join-Path $output service-events.json)
    }
}
Write-Output $output.FullName
