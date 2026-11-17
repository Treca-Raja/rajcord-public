param([Parameter(Mandatory=$true)][string]$WindowIds, [Parameter(Mandatory=$true)][uint32]$ExcludedProcess)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RajcordWindowAudio {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
}
'@
$identities = @()
foreach ($windowId in $WindowIds.Split(',')) {
  if ($windowId -notmatch '^[1-9][0-9]*$') { throw 'Invalid window identity.' }
  $handle = [IntPtr]::new([long]::Parse($windowId))
  if (-not [RajcordWindowAudio]::IsWindow($handle)) { continue }
  [uint32]$sourceProcess = 0
  if ([RajcordWindowAudio]::GetWindowThreadProcessId($handle, [ref]$sourceProcess) -eq 0) { continue }
  if ($sourceProcess -eq 0 -or $sourceProcess -eq $ExcludedProcess) { continue }
  try {
    $source = [Diagnostics.Process]::GetProcessById($sourceProcess)
    $started = $source.StartTime.ToUniversalTime().Ticks.ToString()
  } catch [System.ArgumentException] { continue }
    catch [System.ComponentModel.Win32Exception] { continue }
    catch [System.InvalidOperationException] { continue }
  $identities += @{ windowId=$windowId; processId=$sourceProcess; started=$started }
}
ConvertTo-Json -InputObject @($identities) -Compress
