import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, release, totalmem } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, type Browser } from '../voice/browser-harness.js';
import { fixtureHtml } from './feasibility-page.js';
import { options } from './feasibility-metrics.js';
import { runScenario } from './feasibility-runner.js';

const settings = options(process.argv.slice(2));
const fixture = fixtureHtml();
const server = createServer((req, res) => {
  if (!['/source', '/publisher', '/receiver'].includes(req.url ?? '')) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(fixture);
});
const temporary = await mkdtemp(path.join(tmpdir(), 'tricord-screen-'));
if (
  path.dirname(temporary) !== path.resolve(tmpdir()) ||
  !path.basename(temporary).startsWith('tricord-screen-')
)
  throw new Error('Refusing unexpected fixture path');
const artifacts = fileURLToPath(new URL('../../../../artifacts/screen/', import.meta.url));
const browsers: Browser[] = [];
const results: unknown[] = [];
let failure: Error | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
  const origin = 'http://127.0.0.1:' + address.port;
  if (settings.runtime !== 'electron') {
    const publisher = await launch({ fakeMicrophone: false });
    browsers.push(publisher);
    const receiver = await launch({ fakeMicrophone: false });
    browsers.push(receiver);
    for (const [browser, role] of [
      [publisher, 'publisher'],
      [receiver, 'receiver'],
    ] as const) {
      await browser.call('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.call('Page.navigate', { url: origin + '/' + role });
      await browser.wait('!!window.screenFixture');
    }
    results.push({
      runtime: 'edge-headless',
      version: await publisher.call('Browser.getVersion'),
      scenario: await runScenario(publisher, receiver, {
        mode: 'canvas',
        codec: settings.codec,
        content: settings.content,
        phaseMs: settings.phaseMs,
      }),
    });
    for (const browser of browsers.splice(0)) await browser.close();
  }
  if (settings.runtime !== 'edge') {
    const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
    const binary = require('electron') as string;
    const output = path.join(temporary, 'electron-result.json');
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TRICORD_SCREEN_ORIGIN: origin,
      TRICORD_SCREEN_PROFILE: path.join(temporary, 'electron-profile'),
      TRICORD_SCREEN_OUTPUT: output,
      TRICORD_SCREEN_RUNNER: new URL('./feasibility-runner.js', import.meta.url).href,
      TRICORD_SCREEN_OPTIONS: JSON.stringify(settings),
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const entry = fileURLToPath(
      new URL('../../src/screen/electron-feasibility.mjs', import.meta.url),
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [entry], {
        env: childEnv,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill();
        },
        settings.phaseMs * 4 + 90000,
      );
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve();
        else
          reject(
            new Error(
              timedOut
                ? 'Electron feasibility deadline exceeded'
                : 'Electron feasibility failed; inspect the ignored artifacts/screen report',
            ),
          );
      });
    }).catch(async (error) => {
      try {
        results.push(JSON.parse(await readFile(output, 'utf8')));
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      }
      throw error;
    });
    results.push(JSON.parse(await readFile(output, 'utf8')));
  }
} catch (error) {
  failure = error as Error;
  const evidence = (error as { screenEvidence?: unknown }).screenEvidence;
  if (evidence) results.push({ failedScenario: evidence });
} finally {
  for (const browser of browsers) await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(
      artifacts,
      'feasibility-' + settings.runtime + '-' + settings.codec + '-' + Date.now() + '.json',
    ),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        settings,
        environment: {
          platform: process.platform,
          osRelease: release(),
          node: process.versions.node,
          cpuModel: cpus()[0]?.model ?? null,
          logicalCpus: cpus().length,
          memoryBytes: totalmem(),
        },
        scope:
          'isolated synthetic loopback; no real user profiles, microphones, screens, accounts or LiveKit',
        gates: [
          'real picker consent',
          'system/tab sound routing and intelligibility',
          'audio/video sync',
          'reference hardware and approved performance budgets',
          'active voice and fan-out',
          'WAN/STUN',
        ],
        failure: failure?.message ?? null,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (failure) throw failure;
console.log(
  'Screen feasibility measurements saved to ignored artifacts/screen/. Performance qualification remains open.',
);
