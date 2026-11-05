import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import {
  PRESENCE_TIMING,
  type ChatAck,
  type PresenceDelta,
  type PresenceSnapshot,
} from '@tricord/shared';
import { createApp } from './app.js';
import { testDatabase } from './db/test-database.js';
import { digest } from './auth/service.js';

const origin = 'http://127.0.0.1:5173';
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let instance: ReturnType<typeof createApp>;
let address: string;
const sockets: Socket[] = [];
beforeEach(async () => {
  fixture = await testDatabase();
  instance = createApp({ databaseUrl: fixture.url });
  address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  await instance?.app.close();
  await fixture?.cleanup();
  sockets.length = 0;
});
async function session(userId: string) {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await fixture.database.pool.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_token,remember,expires_at,device_label) VALUES($1,$2,$3,false,now()+interval '1 hour','Presence fixture')",
    [userId, digest(token), csrfToken],
  );
  return { cookie: 'tricord_session=' + token, csrfToken };
}
async function socket(
  auth: Awaited<ReturnType<typeof session>>,
  requestOrigin = origin,
  csrfToken = auth.csrfToken,
) {
  const result = connect(address, {
    transports: ['websocket'],
    autoConnect: false,
    reconnection: false,
    extraHeaders: { origin: requestOrigin, cookie: auth.cookie },
    auth: { csrfToken },
  });
  sockets.push(result);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Presence fixture connection deadline exceeded')),
      PRESENCE_TIMING.snapshotTimeoutMs,
    );
    result.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    result.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    result.connect();
  });
  return result;
}
async function snapshot(client: Socket) {
  const result = (await client
    .timeout(5000)
    .emitWithAck('presence:snapshot')) as ChatAck<PresenceSnapshot>;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
it('ten real accounts aggregate twenty connections with ordered bounded deltas, logout and revoked delivery', async () => {
  const ids: string[] = [];
  for (let index = 0; index < 10; index++) {
    const row = await fixture.database.pool.query(
      "INSERT INTO users(username,display_name,status) VALUES($1,$2,'approved') RETURNING id",
      ['presence_' + index, 'Presence fixture ' + index],
    );
    ids.push(row.rows[0].id);
  }
  await fixture.database.pool.query('INSERT INTO platform(id,owner_id) VALUES(1,$1)', [ids[0]]);
  const viewerAuth = await session(ids[0]!);
  const viewer = await socket(viewerAuth);
  await snapshot(viewer);
  const updates: PresenceDelta[] = [];
  viewer.on('presence:changed', (payload) => updates.push(payload));
  const clients = [viewer];
  const auths = [viewerAuth];
  for (let index = 0; index < 10; index++) {
    if (index > 0) {
      const auth = await session(ids[index]!);
      auths.push(auth);
      clients.push(await socket(auth));
    }
    clients.push(await socket(await session(ids[index]!)));
  }
  const full = await snapshot(viewer);
  expect(full.onlineIds).toEqual([...ids].sort());
  expect(updates.length).toBeLessThanOrEqual(10);
  expect(updates.flatMap((delta) => delta.changes).filter((change) => change.online)).toHaveLength(
    9,
  );
  expect(
    updates.every((delta, index) => index === 0 || delta.revision > updates[index - 1]!.revision),
  ).toBe(true);
  // Actual HTTP logout uses the existing CSRF/session flow, retaining the second valid device.
  const logout = await instance.app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { origin, cookie: auths[1]!.cookie, 'x-csrf-token': auths[1]!.csrfToken },
  });
  expect(logout.statusCode).toBe(200);
  expect((await snapshot(viewer)).onlineIds).toEqual([...ids].sort());
  // Revoke every session for another account. Snapshot revalidates the sources and recipients.
  await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [
    ids[2],
  ]);
  const revoked = clients[4]!;
  let revokedDeliveries = 0;
  revoked.on('presence:changed', () => revokedDeliveries++);
  const remaining = await snapshot(viewer);
  expect(remaining.onlineIds).toEqual(ids.filter((id) => id !== ids[2]).sort());
  expect(revokedDeliveries).toBe(0);
  const suspend = await instance.app.inject({
    method: 'POST',
    url: '/api/admin/accounts/' + ids[9],
    headers: { origin, cookie: viewerAuth.cookie, 'x-csrf-token': viewerAuth.csrfToken },
    payload: { action: 'suspend' },
  });
  expect(suspend.statusCode).toBe(200);
  expect((await snapshot(viewer)).onlineIds).not.toContain(ids[9]);
  // Pending sockets may retain existing account-approval UX but receive no presence.
  const pending = await fixture.database.pool.query(
    "INSERT INTO users(username,display_name) VALUES('presence_pending','Presence pending') RETURNING id",
  );
  const pendingSocket = await socket(await session(pending.rows[0].id));
  expect(await pendingSocket.timeout(5000).emitWithAck('presence:snapshot')).toMatchObject({
    ok: false,
    status: 403,
  });
  const approve = await instance.app.inject({
    method: 'POST',
    url: '/api/admin/accounts/' + pending.rows[0].id,
    headers: { origin, cookie: viewerAuth.cookie, 'x-csrf-token': viewerAuth.csrfToken },
    payload: { action: 'approve' },
  });
  expect(approve.statusCode).toBe(200);
  expect((await snapshot(pendingSocket)).onlineIds).toContain(pending.rows[0].id);
});

async function account(name: string) {
  const result = await fixture.database.pool.query(
    "INSERT INTO users(username,display_name,status) VALUES($1,$2,'approved') RETURNING id",
    [name, 'Presence fixture ' + name],
  );
  return result.rows[0].id as string;
}

it('expiry during reconnect grace removes the last session without waiting out network grace', async () => {
  const viewerId = await account('viewer'),
    memberId = await account('member');
  const viewer = await socket(await session(viewerId));
  const memberAuth = await session(memberId);
  const member = await socket(memberAuth);
  await snapshot(viewer);
  member.disconnect();
  expect((await snapshot(viewer)).onlineIds).toContain(memberId);
  await fixture.database.pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [memberId],
  );
  const began = performance.now();
  expect((await snapshot(viewer)).onlineIds).not.toContain(memberId);
  expect(performance.now() - began).toBeLessThan(PRESENCE_TIMING.snapshotTimeoutMs);
  await expect(socket(memberAuth)).rejects.toThrow('Sign in required');
});

it('expired or forged connections receive no presence and cannot impersonate another account', async () => {
  const viewerId = await account('viewer'),
    memberId = await account('member');
  const viewerAuth = await session(viewerId),
    memberAuth = await session(memberId);
  const viewer = await socket(viewerAuth);
  const member = await socket(memberAuth);
  await snapshot(viewer);
  const deliveries: string[] = [];
  member.on('presence:changed', () => deliveries.push('delta'));
  member.on('presence:unavailable', () => deliveries.push('unavailable'));
  await fixture.database.pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [memberId],
  );
  expect((await snapshot(viewer)).onlineIds).toEqual([viewerId]);
  await expect
    .poll(() => member.connected, { timeout: PRESENCE_TIMING.snapshotTimeoutMs })
    .toBe(false);
  expect(deliveries).toEqual([]);
  await expect(socket(viewerAuth, origin, 'forged')).rejects.toThrow('Sign in required');
  await expect(socket(viewerAuth, 'http://untrusted.invalid')).rejects.toThrow();
  await expect(socket({ cookie: '', csrfToken: viewerAuth.csrfToken })).rejects.toThrow(
    'Sign in required',
  );
  viewer.emit('presence:set', { userId: memberId, online: true });
  expect((await snapshot(viewer)).onlineIds).toEqual([viewerId]);
});

it('final explicit logout immediately removes presence while transport loss has bounded grace', async () => {
  const viewerId = await account('viewer'),
    memberId = await account('member');
  const viewer = await socket(await session(viewerId));
  const auth = await session(memberId);
  const member = await socket(auth);
  await snapshot(viewer);
  const began = performance.now();
  const logout = await instance.app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { origin, cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
  });
  expect(logout.statusCode).toBe(200);
  expect((await snapshot(viewer)).onlineIds).toEqual([viewerId]);
  expect(performance.now() - began).toBeLessThan(PRESENCE_TIMING.snapshotTimeoutMs);
  await expect
    .poll(() => member.connected, { timeout: PRESENCE_TIMING.snapshotTimeoutMs })
    .toBe(false);
});

it('ten accounts survive repeated twenty-connection churn without extra deltas or an unbounded request budget', async () => {
  const ids = await Promise.all(Array.from({ length: 10 }, (_, n) => account('churn_' + n)));
  const auths = await Promise.all(ids.flatMap((id) => [session(id), session(id)]));
  let clients = await Promise.all(auths.map((auth) => socket(auth)));
  const viewer = clients[0]!;
  const baseline = await snapshot(viewer);
  const deltas: PresenceDelta[] = [];
  viewer.on('presence:changed', (delta) => deltas.push(delta));
  const timings: number[] = [];
  for (let round = 0; round < 5; round++) {
    clients.slice(1).forEach((client) => client.disconnect());
    clients = [viewer, ...(await Promise.all(auths.slice(1).map((auth) => socket(auth))))];
    const began = performance.now();
    const state = await snapshot(viewer);
    timings.push(performance.now() - began);
    expect(state).toEqual(baseline);
    await expect
      .poll(() => instance.io.sockets.sockets.size, { timeout: PRESENCE_TIMING.snapshotTimeoutMs })
      .toBe(20);
  }
  expect(deltas).toEqual([]);
  expect(Math.max(...timings)).toBeLessThan(PRESENCE_TIMING.snapshotTimeoutMs);
  // Six synchronization requests so far; the thirteenth is denied without removing eligibility.
  for (let index = 0; index < 6; index++) await snapshot(viewer);
  expect(await viewer.timeout(5000).emitWithAck('presence:snapshot')).toMatchObject({
    ok: false,
    status: 429,
  });
  expect(viewer.connected).toBe(true);
}, 60000);

it('a silent transport reaches offline within heartbeat timeout plus bounded grace, without snapshot polling', async () => {
  const viewerId = await account('heartbeat_viewer'),
    memberId = await account('heartbeat_member');
  const viewer = await socket(await session(viewerId)),
    member = await socket(await session(memberId));
  await snapshot(viewer);
  const expected =
    PRESENCE_TIMING.pingIntervalMs +
    PRESENCE_TIMING.pingTimeoutMs +
    PRESENCE_TIMING.reconnectGraceMs;
  const started = performance.now();
  const offline = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Heartbeat offline deadline exceeded'));
    }, expected + PRESENCE_TIMING.snapshotTimeoutMs);
    const changed = (delta: PresenceDelta) => {
      if (delta.changes.some((change) => change.userId === memberId && !change.online)) {
        cleanup();
        resolve(performance.now() - started);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      viewer.off('presence:changed', changed);
    }
    viewer.on('presence:changed', changed);
  });
  // This test-owned client stops processing packets, so it cannot answer server pings.
  member.io.engine.transport.removeAllListeners('packet');
  const elapsed = await offline;
  expect(elapsed).toBeGreaterThanOrEqual(expected - PRESENCE_TIMING.snapshotTimeoutMs);
  expect(elapsed).toBeLessThan(expected + PRESENCE_TIMING.snapshotTimeoutMs);
  expect((await snapshot(viewer)).onlineIds).toEqual([viewerId]);
  console.info(
    'Presence heartbeat: silent peer offline in ' +
      Math.round(elapsed) +
      ' ms (configured bound ' +
      expected +
      ' ms plus synchronization allowance).',
  );
}, 60000);
