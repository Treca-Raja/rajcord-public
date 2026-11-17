import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'win32')
  throw new Error('Application audio qualification requires Windows 11.');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
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
try {
  const child = spawn(
    require('electron'),
    [
      fileURLToPath(new URL('./application-audio-smoke.mjs', import.meta.url)),
      '--audio-profile=' + profile,
    ],
    { env, windowsHide: true, stdio: 'inherit' },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
