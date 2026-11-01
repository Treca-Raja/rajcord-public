import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import type { ChatAck, PresenceDelta, PresenceSnapshot } from '@tricord/shared';
import { createApp } from './app.js';
import { testDatabase } from './db/test-database.js';
import { digest } from './auth/service.js';

const origin = 'http://127.0.0.1:5173';
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let instance: ReturnType<typeof createApp>;
let address: string;
const sockets: Socket[] = [];
beforeAll(async () => {
  fixture = await testDatabase();
  instance = createApp({ databaseUrl: fixture.url });
  address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await instance?.app.close();
  await fixture?.cleanup();
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
async function socket(auth: Awaited<ReturnType<typeof session>>) {
  const result = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: auth.cookie },
    auth: { csrfToken: auth.csrfToken },
  });
  sockets.push(result);
  await new Promise<void>((resolve, reject) => {
    result.once('connect', resolve);
    result.once('connect_error', reject);
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
