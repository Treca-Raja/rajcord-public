import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHistogram } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { SCREEN_VIDEO_BITRATES } from '@tricord/shared';
import { createApp } from '../app.js';
import { AuthService } from '../auth/service.js';
import { testDatabase } from '../db/test-database.js';
import { launch, setup, type Browser } from '../voice/browser-harness.js';
import { checkVoiceTestServices } from '../voice/test-services.js';
import { installScreenLoadSource } from './load-page.js';
import { tracePublisherPacing } from './load-pacing.js';
import {
  screenLoadInterval,
  screenLoadWorkload,
  screenMicrophoneFailures,
  screenPublisherInterval,
  screenRecoveryResults,
  screenSharedUplinkResults,
  sharedUplinkIntervals,
  type ScreenLoadSample,
  type ScreenLoadMicrophone,
  type ScreenPublisherCounters,
} from './load-metrics.js';

const { count, audience, rounds } = screenLoadWorkload(process.env);
const requestedFrameRate = Number(process.env.TRICORD_SCREEN_LOAD_FPS ?? 60);
if (requestedFrameRate !== 30 && requestedFrameRate !== 60)
  throw new Error('TRICORD_SCREEN_LOAD_FPS must be 30 or 60.');
const frameRate = requestedFrameRate;
const profile = '1080p' + frameRate;
const videoBudget = Number(
  process.env.TRICORD_SCREEN_LOAD_BITRATE ?? (audience ? 12000000 : 20000000),
);
if (!SCREEN_VIDEO_BITRATES.some((value) => value === videoBudget))
  throw new Error('Choose a supported screen video bitrate in bits per second.');
const routes = rounds.flat();
const publishers = new Set(routes.map((route) => route.publisher));
const watchers = new Set(routes.map((route) => route.viewer));
const impairedViewer =
  process.env.TRICORD_SCREEN_LOAD_IMPAIR_VIEWER === undefined
    ? null
    : Number(process.env.TRICORD_SCREEN_LOAD_IMPAIR_VIEWER);
if (
  impairedViewer !== null &&
  (audience?.publishers !== 1 || watchers.size < 2 || !watchers.has(impairedViewer))
)
  throw new Error(
    'Choose one publisher, at least two viewers and a subscribed viewer index for impairment.',
  );
const impairment = {
  latency: 25,
  downloadThroughput: 500000,
  uploadThroughput: -1,
  packetLoss: 2,
  packetQueueLength: 50,
};
const uplinkMode = process.env.TRICORD_SCREEN_LOAD_SHARED_UPLINK ?? '0';
if (!['0', '1', 'control'].includes(uplinkMode))
  throw new Error('Use 1 or control for the staged uplink experiment.');
const sharedUplink = uplinkMode !== '0';
const activeMicrophones = sharedUplink ? 1 : audience ? 2 : count;
const tracePacing = process.env.TRICORD_SCREEN_LOAD_TRACE_PACING === '1';
if (tracePacing && (audience?.publishers !== 1 || sharedUplink || impairedViewer !== null))
  throw new Error(
    'Publisher pacing traces require one publisher in an unconstrained audience run.',
  );
if (
  sharedUplink &&
  (impairedViewer !== null || audience?.publishers !== 1 || audience.viewers !== 2)
)
  throw new Error(
    'The shared uplink experiment requires one publisher, two viewers and no viewer impairment.',
  );
const uplinkBitsPerSecond = 18000000;
const setPublisherUplink = (browser: Browser, limited: boolean) =>
  browser.call('Network.emulateNetworkConditionsByRule', {
    offline: false,
    matchedNetworkConditions: [
      {
        urlPattern: '',
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: limited ? uplinkBitsPerSecond / 8 : -1,
      },
    ],
  });
const setViewerConditions = (browser: Browser, impaired: boolean) =>
  browser.call('Network.emulateNetworkConditionsByRule', {
    offline: false,
    matchedNetworkConditions: [
      {
        urlPattern: '',
        ...(impaired
          ? impairment
          : {
              latency: 0,
              downloadThroughput: -1,
              uploadThroughput: -1,
              packetLoss: 0,
              packetQueueLength: 0,
            }),
      },
    ],
  });
const subscriptions = routes.length;
const fileSource = process.env.TRICORD_SCREEN_LOAD_Y4M
  ? await realpath(process.env.TRICORD_SCREEN_LOAD_Y4M)
  : undefined;
let sourceSha256: string | undefined;
if (fileSource) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(fileSource)) hash.update(chunk);
  sourceSha256 = hash.digest('hex');
}
const host = cpus();
const webRoot = process.env.TRICORD_SCREEN_LOAD_WEB_BUILD
  ? await realpath(process.env.TRICORD_SCREEN_LOAD_WEB_BUILD)
  : fileURLToPath(new URL('../../../web/dist', import.meta.url));
const webIndexSha256 = createHash('sha256')
  .update(await readFile(join(webRoot, 'index.html')))
  .digest('hex');
const config = await checkVoiceTestServices();
const database = await testDatabase();
const origin = 'http://127.0.0.1:3013';
const prefix = 'screen-mesh-' + randomUUID() + '-';
let server: ReturnType<typeof createApp>;
try {
  server = createApp({
    databaseUrl: database.url,
    allowedOrigins: [origin],
    rateLimits: true,
    // This loopback fixture stands in for the trusted proxy and models clients
    // on separate networks without disabling any endpoint or account budget.
    trustProxyHops: 1,
    trustedProxyAddress: '127.0.0.1',
    voiceConfig: { ...config, prefix },
    staticRoot: webRoot,
  });
} catch (cause) {
  try {
    await database.cleanup();
  } catch (cleanupError) {
    throw new AggregateError([cause, cleanupError], 'Stress setup and database cleanup failed.', {
      cause: cleanupError,
    });
  }
  throw cause;
}
const browsers: Browser[] = [],
  accounts: string[] = [];
const queueWait = createHistogram(),
  commitTime = createHistogram();
const voice = server.voice!;
const exclusive = voice.exclusive.bind(voice);
voice.exclusive = <T>(work: () => Promise<T>) => {
  const queuedAt = performance.now();
  return exclusive(async () => {
    const startedAt = performance.now();
    queueWait.record(Math.max(1, Math.round((startedAt - queuedAt) * 1000)));
    try {
      return await work();
    } finally {
      commitTime.record(Math.max(1, Math.round((performance.now() - startedAt) * 1000)));
    }
  });
};
const timings = (histogram: typeof queueWait) => ({
  calls: histogram.count,
  p95Ms: histogram.percentile(95) / 1000,
  maxMs: histogram.max / 1000,
});
const owners: Record<string, number> = {};
const commands = {
  count: 0,
  unacknowledged: 0,
  maxReplyMs: 0,
  failureCounts: {} as Record<string, number>,
  failures: [] as { event: string; code: string; ms: number }[],
};
server.io.on('connection', (socket) =>
  socket.use((packet, next) => {
    const event = String(packet[0]),
      ack = packet.at(-1) as unknown;
    if (event.startsWith('screen:') && typeof ack === 'function') {
      const started = Date.now();
      commands.count++;
      commands.unacknowledged++;
      packet[packet.length - 1] = (response: { code?: string }) => {
        const ms = Date.now() - started;
        commands.unacknowledged--;
        commands.maxReplyMs = Math.max(commands.maxReplyMs, ms);
        if (response.code) {
          const key = event + '/' + response.code;
          commands.failureCounts[key] = (commands.failureCounts[key] ?? 0) + 1;
          if (commands.failures.length < 128)
            commands.failures.push({ event, code: response.code, ms });
        }
        ack(response);
      };
    }
    next();
  }),
);
server.io.on('connection', (socket) =>
  socket.onAnyOutgoing((event, value) => {
    const shares =
      event === 'screen:directory'
        ? value.shares
        : event === 'screen:snapshot'
          ? value.directory.shares
          : event === 'screen:directoryChanges'
            ? value.added
            : [];
    for (const share of shares) {
      const index = accounts.indexOf(share.publisherId);
      if (index >= 0) owners[share.id] = index;
    }
  }),
);
type Client = {
  sampledAt: number;
  streams: ScreenLoadSample[];
  outgoing: ScreenPublisherCounters[];
  voice: ScreenLoadMicrophone[];
  draws: number;
  liveSources: number;
};
const collectExpression = () =>
  'window.screenLoad.collect(' + JSON.stringify(owners) + ',' + JSON.stringify(accounts) + ')';
const collect = () =>
  Promise.all(browsers.map(async (browser) => (await browser.js(collectExpression())) as Client));
function checkMicrophones(before: readonly Client[], after: readonly Client[]) {
  const failures = after.flatMap((client, listener) =>
    screenMicrophoneFailures(activeMicrophones, listener, before[listener]!.voice, client.voice),
  );
  assert.deepEqual(
    failures,
    [],
    'Every expected remote microphone must advance: ' + failures.join(' '),
  );
}
const samples: {
  networkPhase?:
    | 'baseline'
    | 'impaired'
    | 'restored'
    | 'single-viewer'
    | 'joining'
    | 'two-viewers'
    | 'follow-up';
  elapsedMs: number;
  clients: Client[];
  healthMs: number;
  result: ReturnType<typeof screenLoadInterval>;
  sourceFps: number[];
  publisherTiming: { publisher: number; links: ReturnType<typeof screenPublisherInterval> }[];
  hostBusyPercent: number | null;
}[] = [];
function cpuTimes() {
  return cpus().reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + Object.values(times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}
let failed: string | undefined,
  diagnostics: unknown,
  cancelled = false;
let setupStreams: number | null = null;
let screenStopPassed: boolean | null = null;
let sustainedFpsPassed: boolean | null = null;
let cadenceWindows: { minimumFps: number; passed: number; total: number } | null = null;
let recoveryResults: ReturnType<typeof screenRecoveryResults> = null;
let sharedUplinkResults: ReturnType<typeof screenSharedUplinkResults> = null;
let publisherPacing: Awaited<ReturnType<typeof tracePublisherPacing>> | null = null;
let impairmentObserved: boolean | null = null;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
const choose = (browser: Browser, label: string, value: string) =>
  browser.js(
    `(()=>{const input=document.querySelector('select[aria-label="${label}"]');if(!input)throw Error('Missing stress quality control');input.value='${value}';input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
async function run() {
  await server.app.listen({ host: '127.0.0.1', port: 3013 });
  const auth = new AuthService(database.database.pool),
    password = randomUUID() + '-Mesh';
  await auth.bootstrap('mesh_0', 'Mesh 0', password);
  const owner = await auth.login({ username: 'mesh_0', password, remember: false }, undefined);
  for (let index = 0; index < count; index++) {
    if (cancelled) throw new Error('Stress run cancelled.');
    if (index) {
      const account = await auth.register({
        username: 'mesh_' + index,
        displayName: 'Mesh ' + index,
        password,
      });
      await auth.changeStatus(owner.token, account.id, 'approve');
    }
    const account = index
      ? await auth.login({ username: 'mesh_' + index, password, remember: false }, undefined)
      : owner;
    accounts.push(account.auth.user.id);
    if (cancelled) throw new Error('Stress run cancelled.');
    const fakeVideoFile = publishers.has(index) ? fileSource : undefined;
    const browser = await launch({ fakeVideoFile });
    if (cancelled) {
      await browser.close();
      throw new Error('Stress run cancelled.');
    }
    browsers.push(browser);
    await browser.call('Network.setExtraHTTPHeaders', {
      headers: { 'X-Forwarded-For': '192.0.2.' + (index + 1) },
    });
    await browser.call('Page.addScriptToEvaluateOnNewDocument', {
      source:
        '(' +
        installScreenLoadSource.toString() +
        ')(' +
        index +
        ',' +
        Boolean(fakeVideoFile) +
        ')',
    });
    if (index === impairedViewer) await setViewerConditions(browser, false);
    if (sharedUplink && index === 0) await setPublisherUplink(browser, uplinkMode === '1');
    await setup(browser, account.token, origin);
    await browser.js('window.screenLoad.markVoicePeers()');
    // A single identifiable voice source lets every remote receiver measure the publisher's audio.
    if (index < activeMicrophones)
      await browser.js(
        'document.querySelector(\'button[aria-label="Unmute microphone"]\').click()',
      );
    if (!publishers.has(index) && !watchers.has(index)) continue;
    if (fakeVideoFile)
      await browser.call('Browser.grantPermissions', {
        origin,
        permissions: ['audioCapture', 'videoCapture'],
      });
    await browser.js('document.querySelector(".screen-launcher > button").click()');
    await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='ready'");
    if (publishers.has(index)) {
      await choose(browser, 'Screen resolution', '1080');
      await choose(browser, 'Screen frame rate', String(frameRate));
      await choose(browser, 'Screen video bitrate', String(videoBudget));
      await choose(browser, 'Screen source sound', 'none');
      await browser.click('Prepare source');
      await browser.wait("document.querySelector('#screen-panel')?.dataset.prepared==='true'");
      await browser.click('Choose source');
      await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='preview'");
      await browser.click('Start sharing');
      await browser.wait("document.querySelector('#screen-panel')?.dataset.phase==='sharing'");
      console.log('Publishing owned ' + profile + ' source ' + (index + 1) + '/' + publishers.size);
    }
    if (!watchers.has(index)) continue;
    await browser.js(
      "(()=>{const input=document.querySelector('.screen-watch input[type=checkbox]');if(!input.checked)input.click()})()",
    );
  }
  for (const viewer of watchers)
    await browsers[viewer]!.wait(
      "document.querySelectorAll('.screen-share-item').length===" + publishers.size,
    );
  const subscribeRound = async (round: typeof routes) => {
    for (const { publisher, viewer } of round) {
      if (cancelled) throw new Error('Stress run cancelled.');
      const browser = browsers[viewer]!;
      const selector = 'button[aria-label="Watch Mesh ' + publisher + ' with multiple streams"]';
      await browser.wait(
        '(()=>{const button=document.querySelector(' +
          JSON.stringify(selector) +
          ');if(!button||button.disabled)return false;button.click();return true})()',
      );
      // Spread authenticated controls across accounts without bypassing production budgets.
      await delay(120);
    }
  };
  const initialRounds = sharedUplink ? rounds.slice(0, 1) : rounds;
  const initialRoutes = initialRounds.flat();
  for (const [roundIndex, round] of initialRounds.entries()) {
    await subscribeRound(round);
    console.log(
      'Completed subscription requests for round ' + (roundIndex + 1) + '/' + rounds.length,
    );
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const clients = await collect();
    diagnostics = clients;
    setupStreams = clients.reduce((total, client) => total + client.streams.length, 0);
    if (
      clients.length === count &&
      setupStreams === initialRoutes.length &&
      initialRoutes.every(({ publisher, viewer }) =>
        clients[viewer]!.streams.some(
          (stream) => stream.publisher === publisher && stream.viewer === viewer,
        ),
      )
    ) {
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(ready, 'Every requested direct P2P subscription must be present.');
  const startAt = Date.now() + 5000;
  for (const browser of browsers) await browser.js('window.screenLoad.start(' + startAt + ')');
  await delay(Math.max(0, startAt - Date.now()) + 10000);
  if (tracePacing)
    publisherPacing = await tracePublisherPacing(
      browsers[0]!,
      [...watchers].map((viewer) => browsers[viewer]!),
    );
  let before = await collect();
  let cpuBefore = cpuTimes();
  const measuredAt = performance.now();
  let restoredAtMs = 0;
  const intervals = sharedUplink ? sharedUplinkIntervals : 13;
  for (let interval = 0; interval < intervals; interval++) {
    if (cancelled) throw new Error('Stress run cancelled.');
    if (impairedViewer !== null && (interval === 3 || interval === 5)) {
      await setViewerConditions(browsers[impairedViewer]!, interval === 3);
      if (interval === 5) restoredAtMs = performance.now() - measuredAt;
    }
    if (sharedUplink && interval === 3) await subscribeRound(rounds[1]!);
    if (sharedUplink && interval === 9) {
      await setPublisherUplink(browsers[0]!, false);
      restoredAtMs = performance.now() - measuredAt;
    }
    await delay(5000);
    const clients = await collect(),
      at = performance.now(),
      health = await fetch(origin + '/health');
    assert.equal(health.status, 200);
    await health.arrayBuffer();
    const scoringFirstViewerOnly = sharedUplink && interval <= 3;
    const result = screenLoadInterval(
      count,
      before.flatMap((client) => client.streams),
      clients
        .flatMap((client) => client.streams)
        .filter((stream) => !scoringFirstViewerOnly || stream.viewer === initialRoutes[0]!.viewer),
      frameRate,
      scoringFirstViewerOnly ? initialRoutes : routes,
    );
    const cpu = cpuTimes();
    const elapsed = cpu.total - cpuBefore.total;
    samples.push({
      elapsedMs: at - measuredAt,
      ...(sharedUplink
        ? ({
            networkPhase:
              interval < 3
                ? 'single-viewer'
                : interval === 3
                  ? 'joining'
                  : interval < 9
                    ? 'two-viewers'
                    : 'follow-up',
          } as const)
        : {}),
      ...(impairedViewer === null
        ? {}
        : { networkPhase: interval < 3 ? 'baseline' : interval < 5 ? 'impaired' : 'restored' }),
      clients,
      healthMs: performance.now() - at,
      result,
      publisherTiming: [...publishers].map((publisher) => ({
        publisher,
        links: screenPublisherInterval(before[publisher]!.outgoing, clients[publisher]!.outgoing),
      })),
      sourceFps: fileSource
        ? []
        : [...publishers].map((index) => {
            const current = clients[index]!,
              previous = before[index]!;
            return (
              ((current.draws - previous.draws) * 1000) / (current.sampledAt - previous.sampledAt)
            );
          }),
      hostBusyPercent: elapsed > 0 ? 100 * (1 - (cpu.idle - cpuBefore.idle) / elapsed) : null,
    });
    cpuBefore = cpu;
    checkMicrophones(before, clients);
    assert.ok(
      clients.every((client, index) => client.liveSources === Number(publishers.has(index))),
      'Every original screen source must remain live.',
    );
    console.log(
      subscriptions +
        '-stream interval ' +
        (interval + 1) +
        '/' +
        intervals +
        ': ' +
        result.failures.length +
        ' failures',
    );
    before = clients;
  }
  cadenceWindows = {
    minimumFps: samples[0]!.result.minimumFps,
    passed: samples.filter((sample) => sample.result.cadencePassed).length,
    total: samples.length,
  };
  sustainedFpsPassed = cadenceWindows.passed === cadenceWindows.total;
  if (sharedUplink)
    sharedUplinkResults = screenSharedUplinkResults(
      samples,
      uplinkMode === '1' ? uplinkBitsPerSecond : null,
      restoredAtMs,
    );
  if (impairedViewer !== null) {
    const beforeLoss = samples[2]!.clients[impairedViewer]!.streams[0]?.packetsLost;
    const afterLoss = samples[4]!.clients[impairedViewer]!.streams[0]?.packetsLost;
    impairmentObserved =
      beforeLoss !== undefined && afterLoss !== undefined && afterLoss > beforeLoss;
    if (impairmentObserved)
      recoveryResults = screenRecoveryResults(samples, [...watchers], impairedViewer, restoredAtMs);
  }
  assert.equal(
    browsers.flatMap((browser) => browser.httpErrors).filter((error) => error.status === 429)
      .length,
    0,
  );
  screenStopPassed = false;
  for (const publisher of publishers)
    await browsers[publisher]!.js(
      'document.querySelector(\'[aria-label="Stop screen sharing"]\').click()',
    );
  for (const browser of browsers) {
    await browser.wait(
      "!document.querySelector('[data-screen-playback]') && window.screenLoad.stopped()",
    );
    assert.equal(
      await browser.js("document.querySelector('[data-voice-status]')?.dataset.voiceStatus"),
      'connected',
    );
  }
  const afterStop = await collect();
  await delay(1000);
  checkMicrophones(afterStop, await collect());
  screenStopPassed = true;
  console.log(
    'Media measurements',
    JSON.stringify({
      sustainedFpsPassed,
      cadenceWindows,
      impairmentObserved,
      recoveryResults,
      sharedUplinkResults,
    }),
  );
  if (uplinkMode === '1')
    assert.ok(
      sharedUplinkResults?.aggregateLimitObserved,
      'Aggregate upload restriction was not verified.',
    );
  if (tracePacing)
    assert.ok(
      publisherPacing &&
        !publisherPacing.dataLost &&
        publisherPacing.captureGap &&
        publisherPacing.firstEncodeCompletionGap &&
        publisherPacing.links.length === watchers.size &&
        publisherPacing.links.every((link) => link.firstPacketSendGap && link.firstPacketPacerWait),
      'Publisher timing trace was incomplete.',
    );
  if (impairedViewer !== null) {
    assert.ok(
      impairmentObserved,
      'The selected viewer must report packet loss during the impairment.',
    );
    assert.ok(
      recoveryResults?.healthy.every((link) => link.passed) && recoveryResults.recovered,
      'Viewer isolation or bitrate recovery missed its baseline threshold.',
    );
  }
  assert.ok(
    samples.every((sample) => sample.result.passed),
    'Every ' +
      profile +
      ' subscription must pass every interval: ' +
      JSON.stringify(samples.flatMap((sample) => sample.result.failures).slice(0, 8)),
  );
}
try {
  running = run();
  await Promise.race([
    running,
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        cancelled = true;
        reject(new Error('Screen stress exceeded its ten-minute bound.'));
      }, 600000);
    }),
  ]);
} catch (cause) {
  failed = cause instanceof Error ? cause.message : 'Unknown stress failure.';
  diagnostics = await Promise.allSettled(
    browsers.map((browser) => browser.js('window.screenLoad ? ' + collectExpression() + ' : null')),
  );
  process.exitCode = 1;
} finally {
  cancelled = true;
  clearTimeout(watchdog);
  const cleanup = await Promise.allSettled(browsers.map((browser) => browser.close()));
  if (running) await Promise.allSettled([running]);
  cleanup.push(...(await Promise.allSettled([server.app.close()])));
  cleanup.push(
    ...(await Promise.allSettled([
      (async () => {
        for (const room of await server.voice!.media.listRooms())
          if (room.name.startsWith(prefix)) await server.voice!.media.deleteRoom(room.name);
      })(),
    ])),
  );
  cleanup.push(...(await Promise.allSettled([database.cleanup()])));
  if (cleanup.some((item) => item.status === 'rejected')) {
    failed ??= 'Stress fixture cleanup failed.';
    process.exitCode = 1;
  }
  const directory = fileURLToPath(new URL('../../../../artifacts/screen/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(
    directory + '/mesh-' + Date.now() + '.json',
    JSON.stringify(
      {
        passed: !failed,
        failure: failed,
        scope:
          'owned browser profiles and services on one host, actual app, direct P2P, synthetic voice',
        host: {
          processor: host[0]?.model.trim(),
          logicalCpus: host.length,
          totalMemoryBytes: totalmem(),
        },
        participants: count,
        activeMicrophones,
        topology: audience ?? 'all-to-all',
        source: fileSource ? 'file-backed 1080p60 Y4M' : 'generated moving desktop pattern',
        sourceSha256,
        webIndexSha256,
        expectedSubscriptions: subscriptions,
        sustainedFpsPassed,
        cadenceWindows,
        ...(tracePacing ? { publisherPacing } : {}),
        ...(impairedViewer === null ? {} : { impairmentObserved, recoveryResults }),
        ...(sharedUplink
          ? {
              sharedUplink: {
                publisher: 0,
                bitsPerSecond: uplinkMode === '1' ? uplinkBitsPerSecond : null,
                activeMicrophone: 0,
              },
              sharedUplinkResults,
            }
          : {}),
        ...(impairedViewer === null
          ? {}
          : { impairment: { viewer: impairedViewer, ...impairment } }),
        subscriptionsAtLastSetupPoll: setupStreams,
        requested: {
          width: 1920,
          height: 1080,
          fps: frameRate,
          perViewerVideoBitrate: videoBudget,
        },
        samples,
        commands,
        voiceQueue: { wait: timings(queueWait), work: timings(commitTime) },
        diagnostics,
        screenStopPassed,
        cleanupPassed: cleanup.every((item) => item.status === 'fulfilled'),
      },
      null,
      2,
    ) + '\n',
  );
}
if (failed) console.error('FAIL: ' + failed);
else
  console.log(
    'PASS: ' +
      publishers.size +
      ' publishers and all ' +
      subscriptions +
      ' ' +
      profile +
      ' P2P subscriptions, voice and cleanup.',
  );
