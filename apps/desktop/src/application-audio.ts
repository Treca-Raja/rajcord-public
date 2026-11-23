import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile);
export type ApplicationAudioSource = {
  applicationAudioId: `applicationLoopback:${number}`;
  applicationIdentity: string;
};

// Electron's string pass-through is undocumented. Qualify every runtime upgrade
// with the two-process isolation probe before enabling this path on that version.
export function applicationAudioSupported(
  platform = process.platform,
  release = os.release(),
  electron = process.versions.electron,
) {
  const [major, , build] = release.split('.').map(Number);
  return platform === 'win32' && major === 10 && build! >= 22000 && electron === '45.1.0';
}

export async function applicationAudioSources(
  ids: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, ApplicationAudioSource>> {
  if (!applicationAudioSupported()) return new Map();
  return windowProcessSources(ids, signal);
}

export async function windowProcessSources(
  ids: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, ApplicationAudioSource>> {
  if (process.platform !== 'win32') return new Map();
  const windows = ids.filter((id) => /^window:[1-9]\d*:[01]$/.test(id));
  if (!windows.length) return new Map();
  const { stdout } = await execute(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      path
        .join(__dirname, 'window-audio-process.ps1')
        .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'),
      '-WindowIds',
      windows.map((id) => id.split(':')[1]).join(','),
      '-ExcludedProcess',
      String(process.pid),
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 256000, signal },
  );
  const result: unknown = JSON.parse(stdout);
  if (!Array.isArray(result)) throw new Error('Invalid application audio identities.');
  const byWindow = new Map<string, ApplicationAudioSource>();
  for (const item of result) {
    if (!item || typeof item !== 'object') throw new Error('Invalid application audio identity.');
    const { windowId, processId, started } = item as Record<string, unknown>;
    if (
      typeof windowId !== 'string' ||
      !/^[1-9]\d*$/.test(windowId) ||
      !Number.isSafeInteger(processId) ||
      (processId as number) <= 0 ||
      (processId as number) > 0xffffffff ||
      processId === process.pid ||
      typeof started !== 'string' ||
      !/^\d{1,20}$/.test(started)
    )
      throw new Error('Invalid application audio identity.');
    for (const id of windows.filter((id) => id.split(':')[1] === windowId))
      byWindow.set(id, {
        applicationAudioId: `applicationLoopback:${processId as number}`,
        applicationIdentity: `${processId}:${started}`,
      });
  }
  return byWindow;
}
