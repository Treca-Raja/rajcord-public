import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from '../auth/service.js';
import { createApp } from '../app.js';
import { checkVoiceTestServices } from './test-services.js';
import { launch, setup, type Browser } from './browser-harness.js';

const origin = 'http://127.0.0.1:3005',
  config = await checkVoiceTestServices().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
const fixture = await testDatabase(),
  auth = new AuthService(fixture.database.pool);
const options = {
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  rateLimits: true,
  voiceConfig: { ...config, prefix: 'tricord-load-' + randomUUID() + '-' },
  staticRoot: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
};
let server = createApp(options);
const browsers: Browser[] = [],
  users: { id: string; token: string; csrf: string }[] = [];
const artifacts = fileURLToPath(new URL('../../../../artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const statsExpression = `Promise.all(window.__peers.filter(p=>p.connectionState==='connected').map(p=>p.getStats())).then(reports=>{
 const stats=reports.flatMap(r=>[...r.values()]);
 const incoming=stats.filter(s=>s.type==='inbound-rtp'&&s.kind==='audio');
 const sum=key=>incoming.reduce((total,s)=>total+(s[key]||0),0);
 return {streams:incoming.filter(s=>s.bytesReceived>0).length,bytes:sum('bytesReceived'),packets:sum('packetsReceived'),lost:sum('packetsLost'),energy:sum('totalAudioEnergy'),maxJitterMs:Math.max(0,...incoming.map(s=>(s.jitter||0)*1000)),connections:window.__peers.filter(p=>p.connectionState==='connected').length,captures:window.__captureCount,microphones:window.__captures.filter(t=>t.readyState==='live').length,status:document.querySelector('[data-voice-status]')?.dataset.voiceStatus};
})`;
type Stats = {
  streams: number;
  bytes: number;
  packets: number;
  lost: number;
  energy: number;
  maxJitterMs: number;
  connections: number;
  captures: number;
  microphones: number;
  status: string;
};
const samples: {
  elapsedSeconds: number;
  healthMs: number;
  loopP95Ms: number;
  rssMiB: number;
  clients: Stats[];
}[] = [];
const checks: string[] = [];
let passed = false,
  failure: string | undefined;
let diagnostics: unknown;
async function collect() {
  return Promise.all(browsers.map(async (browser) => (await browser.js(statsExpression)) as Stats));
}
async function waitForAll() {
  for (const browser of browsers) {
    await browser.wait(
      "document.querySelector('[data-voice-status]')?.dataset.voiceStatus==='connected' && document.querySelectorAll('.voice-members li').length===10",
    );
    await browser.wait(
      '(' +
        statsExpression +
        ').then(s=>s.streams===9&&s.energy>0&&s.connections===2&&s.microphones===1)',
    );
  }
}
const api = (user: { token: string; csrf: string }, path: string, body: Record<string, unknown>) =>
  server.app.inject({
    url: '/api/voice' + path,
    method: 'POST',
    headers: { origin, cookie: 'tricord_session=' + user.token, 'x-csrf-token': user.csrf },
    payload: body,
  });
try {
  await server.app.listen({ host: '127.0.0.1', port: 3005 });
  const password = randomUUID() + '-Capacity';
  const owner = await auth.bootstrap('load_owner', 'Load owner', password);
  const ownerLogin = await auth.login(
    { username: owner.username, password, remember: true },
    undefined,
  );
  users.push({ id: owner.id, token: ownerLogin.token, csrf: ownerLogin.auth.csrfToken });
  for (let i = 1; i <= 10; i++) {
    const user = await auth.register({
      username: 'load_' + i,
      displayName: 'Load member ' + i,
      password,
    });
    await auth.changeStatus(ownerLogin.token, user.id, 'approve');
    const login = await auth.login(
      { username: user.username, password, remember: true },
      undefined,
    );
    users.push({ id: user.id, token: login.token, csrf: login.auth.csrfToken });
  }
  const channelId = (await server.voice!.channels(ownerLogin.token))[0].id;
  for (let i = 0; i < 10; i++) {
    const browser = await launch();
    browsers.push(browser);
    await setup(browser, users[i]!.token, origin);
    await browser.js('document.querySelector(\'button[aria-label="Unmute microphone"]\').click()');
    console.log('Connected synthetic voice client ' + (i + 1) + '/10');
  }
  await waitForAll();
  const room = server.voice!.leases.get(owner.id)!.room;
  const participants = await server.voice!.media.listParticipants(room);
  assert.equal(participants.length, 10);
  assert.ok(participants.every((p) => p.tracks.some((t) => t.source === 2 && !t.muted)));
  checks.push(
    'ten approved isolated browser clients publish microphone audio',
    'each client receives nine decoded audio streams',
  );
  assert.equal((await api(users[10]!, '/join', { channelId })).statusCode, 409);
  checks.push('eleventh account rejected without disrupting ten participants');
  const start = Date.now();
  let before = await collect();
  for (let sample = 0; sample < 13; sample++) {
    await delay(5000);
    const at = performance.now();
    const health = await fetch(origin + '/health');
    assert.equal(health.status, 200);
    await health.json();
    const healthMs = performance.now() - at,
      clients = await collect();
    samples.push({
      elapsedSeconds: (Date.now() - start) / 1000,
      healthMs,
      loopP95Ms: loop.percentile(95) / 1e6,
      rssMiB: process.memoryUsage().rss / 1048576,
      clients,
    });
    loop.reset();
    assert.ok(
      clients.every(
        (s) =>
          s.status === 'connected' && s.streams === 9 && s.connections === 2 && s.microphones === 1,
      ),
      'Every client must remain connected to nine incoming streams',
    );
    assert.ok(
      clients.every((s, i) => s.bytes > before[i]!.bytes),
      'Audio must continue advancing',
    );
    before = clients;
    assert.equal(server.voice!.leases.size, 10);
    console.log(
      'Ten-client soak: ' +
        Math.round((Date.now() - start) / 1000) +
        's; API ' +
        Math.round(healthMs) +
        'ms',
    );
  }
  assert.equal(
    browsers.flatMap((b) => b.httpErrors).filter((e) => e.status === 429).length,
    0,
    'Normal ten-person use must not exhaust rate limits',
  );
  checks.push(
    '65 seconds of continuous ten-way audio with production rate limits',
    'no HTTP throttling during normal room use',
  );
  const opens = await Promise.all(browsers.map((b) => b.js('window.__voiceOpens')));
  for (const lease of server.voice!.leases.values()) lease.close?.();
  for (let i = 0; i < browsers.length; i++)
    await browsers[i]!.wait('window.__voiceOpens>' + opens[i]);
  await waitForAll();
  checks.push('all ten clients recover after simultaneous signaling loss');
  const previousIds = [...server.voice!.leases.values()].map((l) => l.id);
  await server.app.close();
  server = createApp(options);
  await server.app.listen({ host: '127.0.0.1', port: 3005 });
  for (let i = 0; i < 300 && server.voice!.leases.size !== 10; i++) await delay(100);
  assert.equal(server.voice!.leases.size, 10);
  assert.ok([...server.voice!.leases.values()].every((l) => !previousIds.includes(l.id)));
  await waitForAll();
  checks.push('all ten clients recover after API restart without duplicate active connections');
  await browsers[9]!.js('document.querySelector(\'button[aria-label="Leave voice"]\').click()');
  for (let i = 0; i < 100 && Number(server.voice!.leases.size) !== 9; i++) await delay(100);
  assert.equal(server.voice!.leases.size, 9);
  const replacement = await api(users[10]!, '/join', { channelId });
  assert.equal(replacement.statusCode, 200);
  assert.equal(server.voice!.leases.size, 10);
  await api(users[10]!, '/leave', { leaseId: replacement.json().id });
  checks.push('manual leave frees a slot for the waiting account');
  for (const browser of browsers.slice(0, 9))
    await browser.js('document.querySelector(\'button[aria-label="Leave voice"]\').click()');
  for (let i = 0; i < 100 && server.voice!.leases.size; i++) await delay(100);
  assert.equal(server.voice!.leases.size, 0);
  await delay(1500);
  assert.equal((await server.voice!.media.listParticipants(room)).length, 0);
  assert.ok((await collect()).every((s) => s.connections === 0 && s.microphones === 0));
  checks.push('all media participants and peer connections are gone after leaving');
  assert.equal(
    browsers.flatMap((b) => b.httpErrors).filter((e) => e.status === 429).length,
    0,
    'Recovery must also stay within rate limits',
  );
  passed = true;
} catch (error) {
  failure = (error as Error).message;
  diagnostics = await Promise.allSettled(
    browsers.map(async (b) => ({
      stats: await b.js(statsExpression),
      tracks: await b.js(
        'window.__captures.map(t=>({readyState:t.readyState,enabled:t.enabled,muted:t.muted}))',
      ),
      ui: await b.js("document.querySelector('.voice-controls')?.innerText"),
      button: await b.js(
        "document.querySelector('button[aria-label*=microphone]')?.getAttribute('aria-label')",
      ),
    })),
  );
  throw error;
} finally {
  loop.disable();
  const cleanup = await Promise.allSettled(browsers.map((b) => b.close()));
  cleanup.push(...(await Promise.allSettled([server.app.close()])));
  cleanup.push(
    ...(await Promise.allSettled([
      (async () => {
        for (const room of await server.voice!.media.listRooms())
          if (room.name.startsWith(server.voice!.prefix))
            await server.voice!.media.deleteRoom(room.name);
      })(),
    ])),
  );
  cleanup.push(...(await Promise.allSettled([fixture.cleanup()])));
  if (cleanup.some((result) => result.status === 'rejected')) {
    passed = false;
    failure ??= 'Test resource cleanup failed.';
    process.exitCode = 1;
    console.error('Test resource cleanup failed.');
  }
  await writeFile(
    artifacts + '/voice-load.json',
    JSON.stringify(
      {
        passed,
        failure,
        diagnostics,
        clients: 10,
        scope:
          'Synthetic audio, one Windows host, loopback Docker; not a WAN or physical-headset benchmark',
        checks,
        samples,
        httpErrors: browsers.flatMap((b, i) => b.httpErrors.map((e) => ({ client: i + 1, ...e }))),
      },
      null,
      2,
    ),
  );
  if (passed) console.log('PASS: ten-client voice capacity, recovery and cleanup checks.');
}
