import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkWindowsAudio } from './obs-audio-service.mjs';
import { confirmAudioPermissions } from './windows-audio-preflight.mjs';

if (process.platform !== 'win32')
  throw new Error('Application audio qualification requires Windows 11.');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electron = await realpath(require('electron'));
await confirmAudioPermissions(
  `Stay at the desktop for the short application loopback fixture and handle any permission prompt for the listed executable.\nElectron source and capturer: ${electron}`,
  { warmup: true },
);
const audioServiceRecord = await checkWindowsAudio();
const ownedRoot = fileURLToPath(new URL('../.local/', import.meta.url));
await mkdir(ownedRoot, { recursive: true });
const profile = await mkdtemp(path.join(ownedRoot, 'application-audio-smoke-'));
if (
  path.dirname(path.resolve(profile)) !== path.resolve(ownedRoot) ||
  !path.basename(profile).startsWith('application-audio-smoke-')
)
  throw new Error('Unexpected application audio fixture path.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let exitCode;
try {
  const child = spawn(
    electron,
    [
      fileURLToPath(new URL('./application-audio-smoke.mjs', import.meta.url)),
      '--audio-profile=' + profile,
    ],
    { env, windowsHide: true, stdio: 'inherit' },
  );
  exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
await checkWindowsAudio(audioServiceRecord);
await confirmAudioPermissions(
  'The application loopback fixture has stopped. Confirm audio permissions stayed granted throughout the run.',
);
process.exitCode = exitCode;
