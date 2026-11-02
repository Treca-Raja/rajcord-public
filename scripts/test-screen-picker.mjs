import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const ownedRoot = fileURLToPath(new URL('../.local/', import.meta.url));
await mkdir(ownedRoot, { recursive: true });
const profile = await mkdtemp(path.join(ownedRoot, 'screen-picker-smoke-'));
if (
  path.dirname(path.resolve(profile)) !== path.resolve(ownedRoot) ||
  !path.basename(profile).startsWith('screen-picker-smoke-')
)
  throw new Error('Unexpected picker fixture path.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(
    require('electron'),
    [
      fileURLToPath(
        new URL(
          process.argv.includes('--native')
            ? '../apps/desktop/dist/native-capture-smoke.js'
            : '../apps/desktop/dist/screen-picker-smoke.js',
          import.meta.url,
        ),
      ),
      '--picker-profile=' + profile,
    ],
    { env, stdio: 'inherit', windowsHide: true },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
