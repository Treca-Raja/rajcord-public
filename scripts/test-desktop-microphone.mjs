import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'rajcord-microphone-smoke-'));
const servers = [];
async function origin() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<!doctype html><title>Microphone permission fixture</title><body>Microphone permission fixture</body>',
    );
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
async function run(stage, target) {
  const env = {
    ...process.env,
    TRICORD_MICROPHONE_SMOKE_PROFILE: profile,
    TRICORD_MICROPHONE_SMOKE_ORIGIN: target,
    TRICORD_MICROPHONE_SMOKE_STAGE: stage,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require('electron'),
    [
      fileURLToPath(
        new URL('../apps/desktop/dist/microphone-permission-smoke.js', import.meta.url),
      ),
    ],
    { env, stdio: 'inherit', windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Electron microphone permission stage timed out: ' + stage));
    }, 30000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Electron microphone permission stage failed: ' + stage));
    });
  });
}
try {
  const first = await origin();
  const second = await origin();
  for (const [stage, target] of [
    ['grant', first],
    ['remembered', first],
    ['other-origin', second],
    ['reset', first],
    ['after-reset', first],
  ])
    await run(stage, target);
  console.log(
    'PASS: saved approval across Electron restarts, origin isolation, reset, camera/frame/window denial (synthetic devices).',
  );
} finally {
  await cleanup();
}

async function cleanup() {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  const resolved = await realpath(profile);
  if (
    path.dirname(resolved) !== (await realpath(tmpdir())) ||
    !path.basename(resolved).startsWith('rajcord-microphone-smoke-')
  )
    throw new Error('Refusing unexpected microphone test profile cleanup.');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
