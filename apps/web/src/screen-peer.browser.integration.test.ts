import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { AuthService } from '../../api/src/auth/service';
import { createApp } from '../../api/src/app';
import { testDatabase } from '../../api/src/db/test-database';
import { voiceConfig } from '../../api/src/voice/config';
import { launch, type Browser } from '../../api/src/voice/browser-harness';
import type { createScreenPeerFixture } from './screen-peer-browser-fixture';
import type { ScreenVideoApplied } from './screen-quality';

type ParameterSnapshot = ReturnType<
  ReturnType<typeof createScreenPeerFixture>['parameterSnapshot']
>;

const origin = 'http://127.0.0.1:3008',
  apiOrigin = 'http://127.0.0.1:3009';
let database: Awaited<ReturnType<typeof testDatabase>>, server: ReturnType<typeof createApp>;
let web: ViteDevServer, auth: AuthService, owner: string, channelId: string, prefix: string;
let config: NonNullable<ReturnType<typeof voiceConfig>>,
  apiClosed = true;
const f = 'window.screenPeerFixture';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let gate:
  | { entered: boolean; release: ReturnType<typeof deferred>; drained: ReturnType<typeof deferred> }
  | undefined;

beforeAll(async () => {
  database = await testDatabase();
  auth = new AuthService(database.database.pool);
  const password = randomUUID() + '-Peer';
  await auth.bootstrap('peer_fixture_owner', 'Owned peer fixture', password);
  owner = (
    await auth.login({ username: 'peer_fixture_owner', password, remember: false }, undefined)
  ).token;
  const configured = voiceConfig();
  if (!configured) throw new Error('Local voice fixture services are not configured.');
  config = configured;
  web = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: {
      host: '127.0.0.1',
      port: 3008,
      strictPort: true,
      proxy: { '/api': { target: apiOrigin }, '/socket.io': { target: apiOrigin, ws: true } },
    },
    plugins: [
      {
        name: 'owned-screen-peer-fixture',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/fixture') return next();
            response.setHeader('Content-Type', 'text/html');
            response.setHeader(
              'Content-Security-Policy',
              "default-src 'self'; connect-src 'self' ws://127.0.0.1:3008; media-src 'self' blob:",
            );
            response.setHeader(
              'Permissions-Policy',
              'microphone=(), camera=(), display-capture=(), speaker-selection=()',
            );
            response.end(
              '<!doctype html><title>Owned screen peer fixture</title><body><h1>Owned screen peer fixture</h1><script type="module" src="/src/screen-peer-browser-fixture.ts"></script>',
            );
          });
        },
      },
    ],
  });
  await web.listen();
}, 20_000);

beforeEach(async () => {
  // Each scenario owns its API budgets; do not reset or relax production admission.
  prefix = 'tricord-peer-browser-' + randomUUID() + '-';
  server = createApp({
    databaseUrl: database.url,
    allowedOrigins: [origin],
    voiceConfig: { ...config, prefix },
  });
  apiClosed = false;
  await server.app.listen({ host: '127.0.0.1', port: 3009 });
  channelId = (await server.voice!.channels(owner))[0]!.id;
});

async function closeApi() {
  if (apiClosed) return;
  const failures: unknown[] = [];
  try {
    await server.app.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (channelId) await server.voice!.media.deleteRoom(prefix + channelId);
  } catch (error) {
    if (!['not_found', 'NOT_FOUND'].includes(String((error as { code?: string }).code)))
      failures.push(error);
  }
  apiClosed = true;
  if (failures.length) throw new AggregateError(failures, 'Owned API scenario cleanup failed.');
}
afterEach(closeApi);

afterAll(async () => {
  gate?.release.resolve();
  if (gate?.entered) await gate.drained.promise;
  const failures: unknown[] = [];
  const clean = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  await clean(async () => web?.close());
  await clean(closeApi);
  await clean(async () => database?.cleanup());
  if (failures.length) throw new AggregateError(failures, 'Owned API fixture cleanup failed.');
});

async function credentials() {
  const username = 'peer_' + randomUUID().replaceAll('-', '').slice(0, 20),
    password = randomUUID() + '-Peer';
  const user = await auth.register({ username, displayName: 'Owned synthetic peer', password });
  await auth.changeStatus(owner, user.id, 'approve');
  return { username, password };
}

async function withPeers(
  work: (publisher: Browser, viewer: Browser) => Promise<void>,
  size = { width: 320, height: 180 },
  receiveMode: 'peer' | 'lane' = 'peer',
) {
  const browsers: Browser[] = [];
  const cleanupErrors: unknown[] = [];
  let failed: Error | undefined;
  try {
    for (const role of ['publisher', 'viewer'] as const) {
      const account = await credentials(),
        browser = await launch({ fakeMicrophone: false });
      browsers.push(browser);
      await browser.call('Page.navigate', { url: origin + '/fixture' });
      await browser.wait('window.screenPeerFixtureReady===true');
      await browser.js(
        `${f}=window.createScreenPeerFixture(${JSON.stringify(role)},${JSON.stringify(size)},${JSON.stringify(receiveMode)});true`,
      );
      await browser.js(`${f}.connect(${JSON.stringify(account)}).then(()=>true)`);
      const cookies = await browser.call('Network.getCookies', { urls: [origin] });
      expect(
        (cookies.cookies as { name: string; httpOnly: boolean; sameSite: string }[]).some(
          (cookie) =>
            cookie.name === 'tricord_session' && cookie.httpOnly && cookie.sameSite === 'Strict',
        ),
      ).toBe(true);
      expect(await browser.js("document.cookie.includes('tricord_session')")).toBe(false);
    }
    const [publisher, viewer] = browsers as [Browser, Browser];
    expect(await publisher.js(`${f}.rejectWrongCsrf()`)).toBe(true);
    const share = (await publisher.js(`${f}.publish()`)) as { id: string };
    const selected = (await viewer.js(`${f}.select(${JSON.stringify(share.id)})`)) as {
      linkId: string;
      remainingMs: number;
    };
    await publisher.wait(`!!${f}.linkNotice`);
    const renewal = (await publisher.js(`${f}.refreshPublisherGrant()`)) as {
      linkId: string;
      remainingMs: number;
    };
    expect(renewal.linkId).toBe(selected.linkId);
    expect(renewal.remainingMs).toBeGreaterThan(0);
    expect(renewal.remainingMs).toBeLessThanOrEqual(45000);
    for (const browser of browsers) {
      const prepared = (await browser.js(`${f}.prepare()`)) as {
        silent: boolean;
        remainingMs: number;
      };
      expect(prepared.silent).toBe(true);
      expect(prepared.remainingMs).toBeGreaterThan(0);
      expect(prepared.remainingMs).toBeLessThanOrEqual(45000);
    }
    await publisher.js(`${f}.offer()`);
    for (const browser of browsers)
      await browser.wait(
        `${f}.snapshot().phase==='stable' && ${f}.snapshot().connection==='connected'`,
      );
    await viewer.wait(`${f}.snapshot().frames>=3 && ${f}.snapshot().rms>0.001`);
    await work(publisher, viewer);
  } catch (error) {
    const diagnostics = [];
    for (const browser of browsers) {
      try {
        diagnostics.push(
          await browser.js(
            `(async()=>${f} ? {snapshot:${f}.snapshot(),route:await ${f}.route().catch(()=>null)} : null)()`,
          ),
        );
      } catch {
        diagnostics.push('Owned fixture diagnostics unavailable.');
      }
    }
    failed = new Error('Owned peer fixture failed: ' + JSON.stringify(diagnostics), {
      cause: error,
    });
  } finally {
    const current = gate;
    current?.release.resolve();
    if (current?.entered) await current.drained.promise;
    gate = undefined;
    vi.restoreAllMocks();
    for (const browser of browsers.reverse()) {
      try {
        await browser.js(`${f}?.releaseCleanup();true`);
        const cleanup = await browser.js(`${f} ? ${f}.dispose() : null`);
        if (cleanup)
          expect(cleanup).toEqual({
            peersClosed: true,
            tracksEnded: true,
            silent: true,
            pending: 0,
            listeners: 0,
          });
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        try {
          await browser.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
  }
  if (failed || cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [failed] : []), ...cleanupErrors],
      'Owned browser peer fixture failed.',
    );
}

it('round-trips native video ceilings without changing capture or source audio', async () => {
  await withPeers(
    async (publisher, viewer) => {
      const before = (await publisher.js(`${f}.parameterSnapshot()`)) as ParameterSnapshot;
      const request = (revision: number, publisherBitrate: number, viewerProfile: string) => ({
        revision,
        publisher: { profile: 'smooth', videoBitrate: publisherBitrate },
        viewer: { profile: viewerProfile, videoBitrate: 4_000_000 },
      });
      const low = (await publisher.js(
        `${f}.setVideoQuality(${JSON.stringify(request(1, 8_000_000, 'low'))})`,
      )) as ScreenVideoApplied;
      expect(low.encoding).toEqual({
        maxBitrate: 4_000_000,
        maxFramerate: 15,
        scaleResolutionDownBy: 1.5,
      });
      expect(low.plan.qualification).toBe('experimental-ceilings');
      const smooth = (await publisher.js(
        `${f}.setVideoQuality(${JSON.stringify(request(2, 2_000_000, 'smooth'))})`,
      )) as ScreenVideoApplied;
      expect(smooth.encoding).toEqual({
        maxBitrate: 2_000_000,
        maxFramerate: 20,
        scaleResolutionDownBy: 1,
      });
      const state = await publisher.js(`${f}.videoQuality()`);
      expect(state).toMatchObject({
        requested: { revision: 2 },
        applied: smooth,
        pending: 0,
        closed: false,
      });
      const after = (await publisher.js(`${f}.parameterSnapshot()`)) as ParameterSnapshot;
      expect(after.find((row: { kind: string }) => row.kind === 'audio')).toEqual(
        before.find((row: { kind: string }) => row.kind === 'audio'),
      );
      expect(after.find((row) => row.kind === 'video')!.source).toEqual(
        before.find((row) => row.kind === 'video')!.source,
      );
      expect(
        await viewer.js(
          `${f}.setVideoQuality(${JSON.stringify(request(1, 2_000_000, 'smooth'))}).then(()=>false,()=>true)`,
        ),
      ).toBe(true);
      for (const browser of [publisher, viewer]) {
        expect(await browser.js(`${f}.snapshot()`)).toMatchObject({
          phase: 'stable',
          physicalCalls: 0,
          errors: [],
          peerErrors: [],
          silent: true,
        });
      }
      expect(await viewer.js(`${f}.snapshot().rms>0.001`)).toBe(true);
    },
    { width: 1280, height: 720 },
  );
});

it('negotiates actual video and decoded source sound over authenticated direct screen signaling', async () => {
  await withPeers(async (publisher, viewer) => {
    const route = (await viewer.js(`${f}.route()`)) as {
      state: string;
      local: string;
      remote: string;
      video: number;
      audio: number;
      audioCodec: string;
    };
    expect(route.state).toBe('succeeded');
    expect(['host', 'srflx', 'prflx']).toContain(route.local);
    expect(['host', 'srflx', 'prflx']).toContain(route.remote);
    expect(route.video).toBeGreaterThan(0);
    expect(route.audio).toBeGreaterThan(0);
    expect(route.audioCodec.toLowerCase()).toBe('audio/opus');
    expect(await publisher.js(`${f}.route().then(route=>route.sourceAudioEnergy>0)`)).toBe(true);
    expect(await publisher.js(`${f}.signalTypes.filter(type=>type==='offer').length`)).toBe(1);
    expect(await viewer.js(`${f}.signalTypes.filter(type=>type==='offer').length`)).toBe(0);
    expect(await viewer.js(`${f}.signalTypes.filter(type=>type==='answer').length`)).toBe(1);
    expect(await publisher.js(`${f}.snapshot().senders`)).toEqual(['video', 'audio']);
    expect(await viewer.js(`${f}.snapshot().senders`)).toEqual([]);
    for (const browser of [publisher, viewer])
      expect(
        await browser.js(
          `${f}.snapshot().physicalCalls===0 && ${f}.snapshot().silent && ${f}.snapshot().errors.length===0`,
        ),
      ).toBe(true);
    await publisher.js(`${f}.stopPeer()`);
    expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
    await viewer.js(`${f}.stopPeer()`);
    expect(await viewer.js(`${f}.snapshot().incomingEnded`)).toBe(true);
  });
});

it('server exact-lease invalidation closes both native peers without stopping borrowed capture', async () => {
  await withPeers(async (publisher, viewer) => {
    await viewer.js(`${f}.leave()`);
    for (const browser of [publisher, viewer])
      await browser.wait(
        `${f}.snapshot().connection==='closed' && ${f}.snapshot().phase==='closed'`,
      );
    expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
    expect(await viewer.js(`${f}.snapshot().incomingEnded`)).toBe(true);
  });
});

it('fresh server authorization denies a held renegotiation after peer-session revocation and drains its late response', async () => {
  await withPeers(async (publisher, viewer) => {
    for (const browser of [publisher, viewer]) {
      await browser.wait(`${f}.snapshot().gathering==='complete'`);
      await browser.js(`${f}.drain()`);
    }
    const receivedBefore = await viewer.js(`${f}.signalCount`);
    const current: NonNullable<typeof gate> = {
      entered: false,
      release: deferred(),
      drained: deferred(),
    };
    gate = current;
    const relay = server.screen!.relay.bind(server.screen);
    vi.spyOn(server.screen!, 'relay').mockImplementationOnce(async (...args) => {
      current.entered = true;
      await current.release.promise;
      try {
        return await relay(...args);
      } finally {
        current.drained.resolve();
      }
    });
    await publisher.js(`${f}.startOffer();true`);
    await expect.poll(() => current.entered).toBe(true);
    await viewer.js(`${f}.logout()`);
    await publisher.wait(
      `${f}.operationResult==='rejected' && ${f}.snapshot().connection==='closed'`,
    );
    expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
    current.release.resolve();
    await current.drained.promise;
    await publisher.js(`${f}.drain()`);
    expect(await publisher.js(`${f}.lastAck?.ok`)).toBe(false);
    expect(await viewer.js(`${f}.signalCount`)).toBe(receivedBefore);
    for (const browser of [publisher, viewer]) expect(await browser.js(`${f}.errors`)).toEqual([]);
  });
});

it('verified grant deadlines close actual peers when close notifications are lost', async () => {
  await withPeers(async (publisher, viewer) => {
    for (const browser of [publisher, viewer]) await browser.js(`${f}.ignoreClosed=true;true`);
    await expect
      .poll(
        async () =>
          (await publisher.js(`${f}.snapshot().connection`)) === 'closed' &&
          (await viewer.js(`${f}.snapshot().connection`)) === 'closed',
        { timeout: 50_000, interval: 200 },
      )
      .toBe(true);
    for (const browser of [publisher, viewer])
      expect(
        await browser.js(`${f}.peerErrors.some(message=>message.includes('deadline expired'))`),
      ).toBe(true);
    expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
    expect(await viewer.js(`${f}.snapshot().incomingEnded`)).toBe(true);
  });
}, 75_000);

it.each(['stop', 'hide'] as const)(
  'receiving lane collects native picture/sound and closes locally before acknowledged %s cleanup',
  async (action) => {
    await withPeers(
      async (publisher, viewer) => {
        expect(await viewer.js(`${f}.snapshot().receiver`)).toMatchObject({
          phase: 'ready',
          hasVideo: true,
          hasAudio: true,
        });
        const route = (await viewer.js(`${f}.route()`)) as Awaited<
          ReturnType<ReturnType<typeof createScreenPeerFixture>['route']>
        >;
        expect(route).toMatchObject({ state: 'succeeded', audioCodec: 'audio/opus' });
        expect(['host', 'srflx', 'prflx']).toContain(route.local);
        expect(['host', 'srflx', 'prflx']).toContain(route.remote);
        expect(route.video).toBeGreaterThan(0);
        expect(route.audio).toBeGreaterThan(0);
        await viewer.js(`${f}.playReceiver()`);
        expect(await viewer.js(`${f}.snapshot().receiver.playback`)).toMatchObject({
          phase: 'playing',
          muted: true,
          volume: 0.25,
          output: 'owned-fake-output',
        });
        expect(await viewer.js(`${f}.snapshot().outputs[0].kinds`)).toEqual(['audio', 'video']);
        await viewer.js(action === 'hide' ? `${f}.hideReceiver()` : `${f}.stopPeer()`);
        expect(await viewer.js(`${f}.snapshot()`)).toMatchObject({
          connection: 'closed',
          incomingEnded: true,
          silent: true,
          receiver: { phase: action === 'hide' ? 'paused-hidden' : 'closed' },
        });
        await viewer.js(`${f}.drain()`);
        expect(await viewer.js(`${f}.cleanupLog`)).toEqual([
          expect.objectContaining({
            revision: 2,
            reason: action === 'hide' ? 'hidden' : 'stopped',
            localClosed: true,
            incomingEnded: true,
            outputDetached: true,
            reply: 'unselected',
          }),
        ]);
        expect(await viewer.js(`${f}.selectionStatus()`)).toEqual([]);
        expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
        expect(await viewer.js(`${f}.snapshot().physicalCalls`)).toBe(0);
        expect(await viewer.js(`${f}.errors`)).toEqual([]);
      },
      undefined,
      'lane',
    );
  },
);

it.each(['before-send', 'after-ack'] as const)(
  'retains one receiving lane through held %s cleanup and fences its late result from replacement',
  async (stage) => {
    await withPeers(
      async (publisher, viewer) => {
        await viewer.js(`${f}.playReceiver()`);
        await viewer.js(`${f}.holdCleanup(${JSON.stringify(stage)});${f}.hideReceiver();true`);
        await viewer.wait(`${f}.snapshot().receiver.cleanup.status==='timed-out'`);
        expect(await viewer.js(`${f}.snapshot()`)).toMatchObject({
          nativeCount: 1,
          connection: 'closed',
          incomingEnded: true,
          lane: { occupied: false, pending: { cleanup: true } },
        });
        expect(await viewer.js(`${f}.cleanupLog[0]`)).toMatchObject({
          localClosed: true,
          incomingEnded: true,
          outputDetached: true,
          aborted: true,
          ...(stage === 'after-ack' ? { reply: 'unselected' } : {}),
        });
        const next = (await viewer.js(`${f}.reselect()`)) as { linkId: string };
        expect(await viewer.js(`${f}.selectionStatus()`)).toEqual([next.linkId]);
        expect(await viewer.js(`${f}.prepare().then(()=>false,()=>true)`)).toBe(true);
        expect(await viewer.js(`${f}.snapshot().nativeCount`)).toBe(1);
        expect(await viewer.js(`${f}.snapshot().lane.pending.cleanup`)).toBe(true);
        await viewer.js(`${f}.releaseCleanup();true`);
        await viewer.js(`${f}.drain()`);
        await viewer.wait(`!${f}.snapshot().lane.pending.cleanup`);
        expect(await viewer.js(`${f}.snapshot().receiverHistory[0]`)).toMatchObject({
          phase: 'paused-hidden',
          cleanup: {
            status: 'timed-out',
            pending: false,
            late: stage === 'after-ack' ? 'succeeded' : 'failed',
          },
        });
        expect(await viewer.js(`${f}.cleanupLog[0].reply`)).toBe(
          stage === 'after-ack' ? 'unselected' : 'stale',
        );
        expect(await viewer.js(`${f}.selectionStatus()`)).toEqual([next.linkId]);
        await publisher.wait(
          `${f}.snapshot().connection==='closed' && ${f}.linkNotice?.grant.link.id===${JSON.stringify(next.linkId)}`,
        );
        await publisher.js(`${f}.refreshPublisherGrant()`);
        await publisher.js(`${f}.prepare()`);
        await viewer.js(`${f}.prepare()`);
        await publisher.js(`${f}.offer()`);
        await viewer.wait(
          `${f}.snapshot().connection==='connected' && ${f}.snapshot().receiver.phase==='ready' && ${f}.snapshot().frames>=3 && ${f}.snapshot().rms>0.001`,
        );
        expect(await viewer.js(`${f}.snapshot()`)).toMatchObject({
          nativeCount: 2,
          physicalCalls: 0,
          silent: true,
          errors: [],
          lane: { occupied: true, pending: { cleanup: false } },
        });
        expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
      },
      undefined,
      'lane',
    );
  },
);

it.each(['leave', 'logout'] as const)(
  'receiving lane closes actual peers and tracks on real %s authority loss',
  async (action) => {
    await withPeers(
      async (publisher, viewer) => {
        await viewer.js(`${f}.playReceiver()`);
        await viewer.js(`${f}.${action}()`);
        for (const browser of [publisher, viewer])
          await browser.wait(`${f}.snapshot().connection==='closed'`);
        await viewer.js(`${f}.drain()`);
        expect(await viewer.js(`${f}.snapshot()`)).toMatchObject({
          receiver: { phase: 'closed', reason: 'lifecycle-lost', cleanup: { pending: false } },
          incomingEnded: true,
          physicalCalls: 0,
          silent: true,
          errors: [],
        });
        expect(await viewer.js(`${f}.cleanupLog[0]`)).toMatchObject({
          localClosed: true,
          incomingEnded: true,
          outputDetached: true,
        });
        const cleanup = (await viewer.js(`${f}.cleanupLog[0]`)) as {
          reply?: string;
          transport?: string;
        };
        if (cleanup.reply) expect(['stale', 'not_authorized']).toContain(cleanup.reply);
        else {
          expect(action).toBe('logout');
          expect(cleanup.transport).toBe('disconnected');
        }
        expect(await publisher.js(`${f}.selectionStatus()`)).toEqual([]);
        expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
      },
      undefined,
      'lane',
    );
  },
);

it('receiving lane enforces the real server deadline when close notifications are suppressed', async () => {
  await withPeers(
    async (publisher, viewer) => {
      for (const browser of [publisher, viewer]) await browser.js(`${f}.ignoreClosed=true;true`);
      await expect
        .poll(async () => (await viewer.js(`${f}.snapshot().connection`)) === 'closed', {
          timeout: 50_000,
          interval: 200,
        })
        .toBe(true);
      await viewer.js(`${f}.drain()`);
      expect(await viewer.js(`${f}.snapshot()`)).toMatchObject({
        receiver: { phase: 'closed', reason: 'expired', cleanup: { pending: false } },
        incomingEnded: true,
        physicalCalls: 0,
        silent: true,
      });
      expect(await viewer.js(`Date.now()>=${f}.snapshot().deadline`)).toBe(true);
      await publisher.wait(`${f}.snapshot().connection==='closed'`);
      expect(await publisher.js(`${f}.snapshot().sourceLive`)).toBe(true);
    },
    undefined,
    'lane',
  );
}, 75_000);
