import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const smokeEnv = { ...process.env };
delete smokeEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require('electron'),
  [fileURLToPath(new URL('../apps/desktop/dist/external-links-smoke.js', import.meta.url))],
  { env: smokeEnv, stdio: 'inherit', windowsHide: true },
);
child.once('error', (error) => {
  console.error('Electron link smoke could not start:', error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
