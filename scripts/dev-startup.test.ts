import { it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// @ts-expect-error Plain Node entry point shared with the desktop startup command.
import { waitForDevelopment } from './wait-for-dev.mjs';
const servers: Server[] = [];
async function endpoint(body: string) {
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
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
  await expect(waitForDevelopment({ webUrl, apiUrl, timeoutMs: 5000 })).resolves.toBeUndefined();
});
it.each([
  { service: 'unavailable', status: 503, body: {} },
  {
    service: 'a different service',
    status: 200,
    body: { status: 'ok', service: 'something-else' },
  },
])('reports the API as missing when its endpoint returns $service', async ({ status, body }) => {
  const timeoutMs = 500;
  const webUrl = 'http://127.0.0.1:5173';
  const apiUrl = 'http://127.0.0.1:3001/health';
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  const probe = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === webUrl) return Response.json({});
    expect(url).toBe(apiUrl);
    // Model the final probe without spending the deadline waiting on loopback.
    clock.mockReturnValue(timeoutMs);
    return Response.json(body, { status });
  });
  try {
    await expect(waitForDevelopment({ webUrl, apiUrl, timeoutMs })).rejects.toThrow(
      'waiting for: API. Check the [api] and [web] output above. Run pnpm --filter @tricord/api dev',
    );
    expect(probe.mock.calls.map(([url]) => url)).toEqual([webUrl, apiUrl]);
  } finally {
    probe.mockRestore();
    clock.mockRestore();
  }
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
  async function healthyPort(after = 0) {
    let lastFailure: unknown;
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      if (launchError) throw launchError;
      const matches = [...output.matchAll(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/g)];
      if (child.exitCode !== null) throw new Error('API development supervisor exited: ' + output);
      const listening = matches.length;
      const port = matches.at(-1)?.[1];
      if (listening > after && port) {
        try {
          const response = await fetch('http://127.0.0.1:' + port + '/health', {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) {
            const body: unknown = await response.json();
            return { listening, body };
          }
          lastFailure = new Error('Health endpoint returned ' + response.status);
        } catch (error) {
          lastFailure = error;
        }
      }
      await delay(100);
    }
    throw new Error('API development startup/reload timed out: ' + output, { cause: lastFailure });
  }
  try {
    const initial = await healthyPort();
    expect(initial.body).toMatchObject({
      service: 'tricord-api',
      status: 'ok',
    });
    await utimes(watched, original.atime, new Date());
    const restarted = await healthyPort(initial.listening);
    expect(restarted.body).toMatchObject({ service: 'tricord-api', status: 'ok' });
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
