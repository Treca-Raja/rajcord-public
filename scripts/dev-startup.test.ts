import { it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// @ts-expect-error Plain Node entry point shared with the desktop startup command.
import { waitForDevelopment } from './wait-for-dev.mjs';
const servers: Server[] = [];
async function endpoint(body: string, status = 200) {
  const server = createServer((_req, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('desktop waits for both HTTP services and identifies the Rajcord API', async () => {
  const webUrl = await endpoint('{}');
  const apiUrl = await endpoint('{"status":"ok","service":"tricord-api"}');
  await expect(waitForDevelopment({ webUrl, apiUrl, timeoutMs: 1000 })).resolves.toBeUndefined();
});
it('a missing API produces a bounded, actionable failure', async () => {
  const webUrl = await endpoint('{}');
  const apiUrl = await endpoint('{}', 503);
  await expect(
    waitForDevelopment({ webUrl, apiUrl, timeoutMs: 500, intervalMs: 25 }),
  ).rejects.toThrow('waiting for: API');
});
it('a different service on the API port does not launch Electron', async () => {
  const webUrl = await endpoint('{}');
  const apiUrl = await endpoint('{"status":"ok","service":"something-else"}');
  await expect(
    waitForDevelopment({ webUrl, apiUrl, timeoutMs: 500, intervalMs: 25 }),
  ).rejects.toThrow('pnpm --filter @tricord/api dev');
});
it('the real API development command boots and reloads under concurrently', async () => {
  const apiDirectory = path.resolve('apps/api');
  const manifest = JSON.parse(await readFile(path.join(apiDirectory, 'package.json'), 'utf8'));
  const watched = path.join(apiDirectory, 'src/app.ts');
  const original = await stat(watched);
  const child = spawn(
    process.execPath,
    [
      path.resolve('node_modules/concurrently/dist/bin/concurrently.js'),
      '-k',
      '-n',
      'api,helper',
      manifest.scripts.dev,
      'node -e "setInterval(()=>{},1000)"',
    ],
    {
      cwd: apiDirectory,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: '0',
        PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      },
    },
  );
  let output = '',
    launchError: Error | undefined;
  child.on('error', (error) => {
    launchError = error;
  });
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  async function listening(count: number) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (launchError) throw launchError;
      const matches = [...output.matchAll(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/g)];
      if (matches.length >= count) return matches.at(-1)![1]!;
      if (child.exitCode !== null) throw new Error('API development supervisor exited: ' + output);
      await delay(100);
    }
    throw new Error('API development startup/reload timed out: ' + output);
  }
  try {
    const port = await listening(1);
    expect(await (await fetch('http://127.0.0.1:' + port + '/health')).json()).toMatchObject({
      service: 'tricord-api',
      status: 'ok',
    });
    await utimes(watched, original.atime, new Date());
    const restartedPort = await listening(2);
    expect((await fetch('http://127.0.0.1:' + restartedPort + '/health')).status).toBe(200);
  } finally {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      else process.kill(-child.pid, 'SIGTERM');
    }
    await utimes(watched, original.atime, original.mtime);
  }
}, 40000);
