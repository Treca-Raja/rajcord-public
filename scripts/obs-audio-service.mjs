import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function checkWindowsAudioSnapshot(snapshot, previousRecord) {
  const { Audiosrv, AudioEndpointBuilder, terminationRecord } = snapshot;
  if (Audiosrv !== 'Running' || AudioEndpointBuilder !== 'Running') {
    throw new Error(
      `OBS audio fixture environment failed: Audiosrv=${Audiosrv}, AudioEndpointBuilder=${AudioEndpointBuilder}.`,
    );
  }
  if (previousRecord !== undefined && terminationRecord > previousRecord) {
    throw new Error(
      `OBS audio fixture environment failed: Windows Audio termination event ${terminationRecord}.`,
    );
  }
  return terminationRecord;
}

export async function checkWindowsAudio(previousRecord) {
  if (process.platform !== 'win32') return;
  let snapshot;
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
          $ErrorActionPreference = 'Stop'
          $audio = Get-Service -Name Audiosrv
          $endpoint = Get-Service -Name AudioEndpointBuilder
          $events = Get-WinEvent -FilterHashtable @{
            LogName = 'System'
            ProviderName = 'Service Control Manager'
            Id = 7031, 7034
            StartTime = (Get-Date).AddDays(-1)
          } -ErrorAction SilentlyContinue -ErrorVariable eventErrors
          $unexpected = $eventErrors | Where-Object FullyQualifiedErrorId -NotLike 'NoMatchingEventsFound,*'
          if ($unexpected) { throw $unexpected[0] }
          $record = $events | Where-Object {
            $_.Properties[0].Value -in @($audio.DisplayName, $endpoint.DisplayName)
          } | Select-Object -First 1 -ExpandProperty RecordId
          @{
            Audiosrv = $audio.Status.ToString()
            AudioEndpointBuilder = $endpoint.Status.ToString()
            terminationRecord = [long]$record
          } | ConvertTo-Json -Compress
        `,
      ],
      { timeout: 15000, windowsHide: true },
    );
    snapshot = JSON.parse(stdout);
  } catch (cause) {
    throw new Error('OBS audio fixture environment failed: could not query Windows Audio.', {
      cause,
    });
  }
  return checkWindowsAudioSnapshot(snapshot, previousRecord);
}
