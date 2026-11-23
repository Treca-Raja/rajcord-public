[CmdletBinding()]
param([string]$Runtime = (Join-Path $PSScriptRoot 'dist/bundle'))

$ErrorActionPreference = 'Stop'
$Runtime = (Resolve-Path -LiteralPath $Runtime).Path
$helper = (Resolve-Path -LiteralPath (Join-Path $Runtime 'bin/rajcord-obs.exe')).Path
Add-Type -AssemblyName System.Windows.Forms
$form = [Windows.Forms.Form]::new()
$form.Text = 'Rajcord screen identity test'
$form.Size = [Drawing.Size]::new(640, 480)
$form.BackColor = [Drawing.Color]::Navy

function Start-Helper {
  $info = [Diagnostics.ProcessStartInfo]::new($helper)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.WorkingDirectory = (Join-Path $Runtime 'bin')
  $info.Environment['PATH'] = $info.WorkingDirectory + ';' + (Join-Path $env:SystemRoot 'System32')
  return [Diagnostics.Process]::Start($info)
}

function Read-Reply([Diagnostics.Process]$Child) {
  $line = $Child.StandardOutput.ReadLineAsync()
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (!$line.IsCompleted -and $timer.Elapsed.TotalSeconds -lt 10) {
    [Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 10
  }
  if (!$line.IsCompleted) { throw 'OBS identity test timed out.' }
  return $line.GetAwaiter().GetResult()
}

try {
  $form.Show()
  [Windows.Forms.Application]::DoEvents()
  $owner = [Diagnostics.Process]::GetCurrentProcess()
  $ticks = $owner.StartTime.ToUniversalTime().Ticks.ToString()
  $handle = $form.Handle.ToInt64().ToString()
  foreach ($scenario in @('missing-owner', 'wrong-pid', 'reused-pid', 'closed-window')) {
    $child = Start-Helper
    try {
      $fields = @('1', 'start', 'window', $handle)
      switch ($scenario) {
        'wrong-pid' { $fields += @('identity', '0', $ticks) }
        'reused-pid' { $fields += @('identity', [string]$owner.Id, '1') }
        'closed-window' { $fields += @('identity', [string]$owner.Id, $ticks) }
      }
      $child.StandardInput.WriteLine(($fields -join "`t"))
      $line = Read-Reply $child
      if ($scenario -eq 'closed-window') {
        if ($line -ne "OK`t1`tV0dD") { throw 'The approved test window produced no WGC frame.' }
        $form.Close()
        $line = Read-Reply $child
      }
      if (!$line -or !$line.StartsWith("FATAL`t") -or !$child.WaitForExit(3000) -or !$child.ExitCode) {
        throw "The native sender did not terminate for $scenario."
      }
      Write-Output "$scenario passed"
    } finally {
      if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }
      $child.Dispose()
    }
  }
} finally {
  $form.Dispose()
}
