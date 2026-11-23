import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import path from 'node:path';
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
      hint: settings.hint,
      phaseMs: settings.phaseMs,
      bitrates: settings.bitrates,
    }),
  });
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
    path.join(artifacts, 'feasibility-browser-' + settings.codec + '-' + Date.now() + '.json'),
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
}
if (failure) throw failure;
console.log(
  'Screen feasibility measurements saved to ignored artifacts/screen/. Performance qualification remains open.',
);
