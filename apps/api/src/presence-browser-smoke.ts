import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { PRESENCE_TIMING, type ChatAck, type PresenceSnapshot } from '@tricord/shared';
import { createApp } from './app.js';
import { digest } from './auth/service.js';
import { testDatabase } from './db/test-database.js';
import { launch, type Browser } from './voice/browser-harness.js';

const origin = 'http://127.0.0.1:3006';
const fixture = await testDatabase();
const options = {
  databaseUrl: fixture.url,
  allowedOrigins: [origin],
  staticRoot: fileURLToPath(new URL('../../web/dist', import.meta.url)),
};
let server = createApp(options);
const browsers: Browser[] = [];
const peers: Socket[] = [];
const query = Pool.prototype.query;
let failRoster = false;
Pool.prototype.query = new Proxy(query, {
  apply(target, receiver, args) {
    if (
      failRoster &&
      typeof args[0] === 'string' &&
      args[0].startsWith('SELECT u.id,u.username,u.display_name')
    )
      return Promise.reject(new Error('Presence fixture roster outage'));
    return Reflect.apply(target, receiver, args);
  },
});
const requests = new Map<string, number>();
let deltas = 0,
  unavailable = 0,
  connections = 0;
let holdNext = false;
let releaseSnapshot: (() => void) | undefined;
let viewerId = '';
const changes: { userId: string; online: boolean }[] = [];
function observe() {
  server.io.on('connection', (socket) => {
    connections++;
    socket.onAny((event) => {
      if (event === 'presence:snapshot')
        requests.set(socket.id, (requests.get(socket.id) ?? 0) + 1);
    });
    socket.onAnyOutgoing((event, data) => {
      if (event === 'presence:changed') {
        deltas++;
        changes.push(...data.changes);
      }
      if (event === 'presence:unavailable') unavailable++;
    });
    socket.use((packet, next) => {
      if (
        holdNext &&
        packet[0] === 'presence:snapshot' &&
        socket.data.auth.user.id === viewerId &&
        String(socket.handshake.headers['user-agent']).includes('Mozilla')
      ) {
        holdNext = false;
        const ack = packet[1] as (
          response: ChatAck<PresenceSnapshot> & { fixtureDelayed?: boolean },
        ) => void;
        packet[1] = (response: ChatAck<PresenceSnapshot>) => {
          releaseSnapshot = () => ack({ ...response, fixtureDelayed: true });
        };
      }
      next();
    });
  });
}
observe();
async function until(
  test: () => Promise<unknown> | unknown,
  label: string,
  timeout: number = PRESENCE_TIMING.snapshotTimeoutMs,
) {
  const began = performance.now();
  while (performance.now() - began < timeout) {
    if (await test()) return performance.now() - began;
    await delay(25);
  }
  throw new Error('Presence acceptance deadline exceeded: ' + label);
}
const wait = (browser: Browser, expression: string, label = expression) =>
  until(() => browser.js(expression), label);
async function account(name: string) {
  const { rows } = await fixture.database.pool.query(
    "INSERT INTO users(username,display_name,status) VALUES($1,$2,'approved') RETURNING id",
    [name, 'Presence fixture ' + name],
  );
  const token = randomBytes(32).toString('hex'),
    csrfToken = randomBytes(32).toString('hex');
  await fixture.database.pool.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_token,remember,expires_at,device_label) VALUES($1,$2,$3,false,now()+interval '1 hour','Presence browser fixture')",
    [rows[0].id, digest(token), csrfToken],
  );
  return { id: rows[0].id as string, token, csrfToken };
}
async function connected(peer: Socket) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Presence peer connection deadline exceeded'));
    }, PRESENCE_TIMING.snapshotTimeoutMs);
    function cleanup() {
      clearTimeout(timer);
      peer.off('connect', done);
      peer.off('connect_error', failed);
    }
    function done() {
      cleanup();
      resolve();
    }
    function failed(error: Error) {
      cleanup();
      reject(error);
    }
    peer.once('connect', done);
    peer.once('connect_error', failed);
    peer.connect();
  });
}
async function peer(auth: Awaited<ReturnType<typeof account>>) {
  const client = io(origin, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: 'tricord_session=' + auth.token },
    auth: { csrfToken: auth.csrfToken },
  });
  peers.push(client);
  await connected(client);
  return client;
}
async function snapshot(peer: Socket) {
  const ack = (await peer
    .timeout(PRESENCE_TIMING.snapshotTimeoutMs)
    .emitWithAck('presence:snapshot')) as ChatAck<PresenceSnapshot>;
  assert.equal(ack.ok, true, 'Authorized presence synchronization must succeed');
  return ack.data;
}
const ready = "document.querySelector('.presence-panel')?.dataset.presenceState==='ready'";
const row = (id: string) => `document.querySelector('[data-member-id="${id}"]')`;
const state = (id: string, status: string) => `${row(id)}?.dataset.presence==='${status}'`;
const browserSocket = (id: string) =>
  [...server.io.sockets.sockets.values()].find(
    (socket) =>
      socket.data.auth.user.id === id &&
      String(socket.handshake.headers['user-agent']).includes('Mozilla'),
  )!;
try {
  await server.app.listen({ host: '127.0.0.1', port: 3006 });
  const viewer = await account('presence_viewer'),
    member = await account('presence_member'),
    late = await account('presence_late');
  viewerId = viewer.id;
  await fixture.database.pool.query('INSERT INTO platform(id,owner_id) VALUES(1,$1)', [viewer.id]);
  const observer = await peer(viewer);
  const a = await launch();
  browsers.push(a);
  const b = await launch();
  browsers.push(b);
  for (const [browser, auth] of [
    [a, viewer],
    [b, member],
  ] as const) {
    await browser.call('Network.setCookie', {
      name: 'tricord_session',
      value: auth.token,
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    });
    await browser.call('Emulation.setDeviceMetricsOverride', {
      width: 1360,
      height: 980,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(()=>{window.__delayedPresenceAck=false;const Base=window.WebSocket;window.WebSocket=class extends Base{constructor(...args){super(...args);this.addEventListener('message',event=>{if(String(event.data).includes('"fixtureDelayed":true'))window.__delayedPresenceAck=true})}}})()`,
    });
    await browser.call('Page.navigate', { url: origin });
    await wait(browser, ready, 'initial authoritative presence');
  }
  await wait(a, state(member.id, 'online'));
  assert.equal(
    await a.js(state(late.id, 'offline')),
    true,
    'An approved account without a connection stays offline',
  );

  failRoster = true;
  assert.deepEqual(await observer.timeout(5000).emitWithAck('presence:snapshot'), {
    ok: false,
    status: 503,
    error: 'Presence temporarily unavailable.',
  });
  await wait(
    a,
    "document.querySelector('.presence-panel')?.dataset.presenceState==='unavailable'&&document.querySelector('.presence-panel').textContent.includes('Counts unavailable')",
  );
  assert.equal(
    await a.js(
      "document.querySelectorAll('.presence-panel [data-presence=offline],.presence-panel [data-presence=online]').length",
    ),
    0,
    'A database outage must not fabricate online/offline rows',
  );
  failRoster = false;
  await snapshot(observer);
  const outageRecoveryMs = await wait(a, ready, 'database recovery snapshot');
  await wait(b, ready);

  const before = await snapshot(observer);
  holdNext = true;
  browserSocket(viewer.id).emit('presence:changed', {
    epoch: before.epoch,
    revision: before.revision + 2,
    changes: [],
    rosterChanged: false,
  });
  await until(() => !!releaseSnapshot, 'hold an obsolete snapshot acknowledgement');
  const latePeer = await peer(late);
  browserSocket(viewer.id).emit('presence:unavailable');
  await wait(
    a,
    `${ready}&&${state(late.id, 'online')}`,
    'recover with a newer authoritative snapshot',
  );
  releaseSnapshot!();
  await wait(a, 'window.__delayedPresenceAck', 'receive obsolete acknowledgement');
  assert.equal(
    await a.js(state(late.id, 'online')),
    true,
    'An obsolete acknowledgement cannot replace newer live state',
  );

  const changeStart = changes.length;
  await b.call('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  browserSocket(member.id).conn.close();
  await wait(
    b,
    "document.querySelector('.presence-panel')?.dataset.presenceState==='unavailable'",
    'transport loss shows uncertainty',
  );
  assert.equal(
    await a.js(state(member.id, 'online')),
    true,
    'A short tolerated transport loss retains peer presence',
  );
  await b.call('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await wait(b, ready, 'transport reconnection snapshot');
  assert.equal(
    changes.slice(changeStart).some((change) => change.userId === member.id && !change.online),
    false,
    'Reconnect within grace must not emit false offline',
  );

  await a.js(
    `window.__presenceFetch=window.fetch;window.fetch=(...args)=>args[0]==='/api/conversations'?Promise.resolve(new Response(JSON.stringify({error:'Presence fixture denied roster'}),{status:403,headers:{'Content-Type':'application/json'}})):window.__presenceFetch(...args);window.dispatchEvent(new Event('focus'))`,
  );
  await wait(
    a,
    "document.querySelector('.presence-panel').textContent.includes('Member list unavailable')",
    'denied roster is unavailable',
  );
  assert.equal(
    await a.js("document.querySelectorAll('.presence-panel [data-member-id]').length"),
    0,
    'Denied roster data must not fall back to community rows',
  );
  await a.js('window.fetch=window.__presenceFetch;delete window.__presenceFetch');
  await a.click('Retry members');
  await wait(a, ready, 'explicit roster recovery');

  const oldEpoch = (await snapshot(observer)).epoch;
  await server.app.close();
  server = createApp(options);
  observe();
  await server.app.listen({ host: '127.0.0.1', port: 3006 });
  await connected(observer);
  const restartRecoveryMs = await wait(a, ready, 'API restart reconstructs fresh presence');
  await wait(b, ready);
  const rebuilt = await snapshot(observer);
  assert.notEqual(rebuilt.epoch, oldEpoch, 'A restarted API must use a new presence epoch');
  assert.equal(
    await a.js(state(late.id, 'offline')),
    true,
    'API restart cannot preserve historical online flags',
  );
  await connected(latePeer);
  await wait(a, state(late.id, 'online'));

  await fixture.database.pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [digest(viewer.token)],
  );
  await snapshot(latePeer);
  await wait(
    a,
    "!document.querySelector('.presence-panel')&&!!document.querySelector('input[name=username]')",
    'expired session clears protected UI',
  );
  await wait(b, state(viewer.id, 'offline'), 'expired session has no reconnect grace');
  assert.equal(
    await b.js('window.__captureCount'),
    0,
    'Presence acceptance must not capture a physical microphone',
  );
  assert.ok(
    Math.max(...requests.values()) <= 12,
    'Synchronization stays inside the per-connection minute budget',
  );
  assert.ok(deltas < 80, 'Reconnects must not generate an unbounded delivery stream');
  const artifacts = fileURLToPath(new URL('../../../artifacts/', import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const checks = [
    'DB outage shows uncertainty rather than false offline',
    'fresh recovery within five seconds',
    'obsolete snapshot acknowledgement cannot replace fresh state',
    'transport reconnect inside grace emits no false offline',
    'denied roster clears protected rows with explicit retry',
    'API restart changes epoch and rebuilds presence',
    'expired sessions lose protected UI and presence',
    'bounded synchronization and no microphone capture',
  ];
  await writeFile(
    artifacts + 'presence-browser.json',
    JSON.stringify(
      {
        passed: true,
        checks,
        outageRecoveryMs,
        restartRecoveryMs,
        connections,
        snapshots: [...requests.values()].reduce((sum, n) => sum + n, 0),
        maxSnapshotsPerConnection: Math.max(...requests.values()),
        deltas,
        unavailable,
      },
      null,
      2,
    ),
  );
  console.log('PASS: ' + checks.length + ' real browser presence acceptance checks.');
} finally {
  Pool.prototype.query = query;
  failRoster = false;
  for (const browser of browsers) await browser.close();
  for (const client of peers) client.disconnect();
  await server.app.close();
  await fixture.cleanup();
}
