import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SignalResponse } from '@livekit/protocol';
import { TokenVerifier } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { testDatabase } from '../db/test-database.js';
import { AuthService } from '../auth/service.js';
import { createApp } from '../app.js';
import { voiceConfig } from './config.js';
import { sanitizeSignal } from './gateway.js';
const origin = 'http://127.0.0.1:5173',
  secret = randomUUID() + 'Voice';
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  server: ReturnType<typeof createApp>,
  auth: AuthService,
  address: string;
type User = { id: string; token: string; csrf: string; cookie: string; username: string };
let owner: User, member: User, pending: User, channel: string, secondChannel: string;
async function user(username: string, ownerAccount = false, approve = true) {
  const u = ownerAccount
    ? await auth.bootstrap(username, username, secret)
    : await auth.register({ username, displayName: username, password: secret });
  if (!ownerAccount && approve) await auth.changeStatus(owner.token, u.id, 'approve');
  return login(username);
}
async function login(username: string): Promise<User> {
  const result = await auth.login({ username, password: secret, remember: true }, undefined);
  return {
    id: result.auth.user.id,
    token: result.token,
    csrf: result.auth.csrfToken,
    cookie: 'tricord_session=' + result.token,
    username,
  };
}
const request = (
  user: User | undefined,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: unknown,
) =>
  server.app.inject({
    url: '/api/voice' + path,
    method,
    payload,
    headers: { origin, ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrf } : {}) },
  });
async function join(user: User, channelId = channel) {
  const result = await request(user, '/join', 'POST', { channelId });
  expect(result.statusCode, result.body).toBe(200);
  return result.json() as { id: string; credential: string };
}
beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  owner = await user('voice_owner', true);
  member = await user('voice_member');
  pending = await user('voice_pending', false, false);
  const config = voiceConfig();
  if (!config) throw new Error('Run pnpm voice:setup and pnpm voice:up.');
  server = createApp({
    databaseUrl: fixture.url,
    rateLimits: false,
    voiceConfig: { ...config, prefix: 'tricord-test-' + randomUUID() + '-' },
  });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  channel = (await request(owner, '/channels')).json().channels[0].id;
  secondChannel = (await request(member, '/channels', 'POST', { name: 'Second room' })).json()
    .channel.id;
});
afterEach(async () => {
  if (server?.voice)
    for (const lease of [...server.voice.leases.values()]) await server.voice.remove(lease);
});
afterAll(async () => {
  await server?.app.close();
  if (server?.voice)
    for (const room of await server.voice.media.listRooms())
      if (room.name.startsWith(server.voice.prefix)) await server.voice.media.deleteRoom(room.name);
  await fixture?.cleanup();
});
it('persistent channels are shared only with approved accounts', async () => {
  expect((await request(undefined, '/channels')).statusCode).toBe(401);
  expect((await request(pending, '/channels')).statusCode).toBe(403);
  expect((await request(member, '/channels')).json().channels).toHaveLength(2);
  expect(
    (
      await fixture.database.pool.query('SELECT name FROM voice_channels WHERE id=$1', [
        secondChannel,
      ])
    ).rows[0].name,
  ).toBe('Second room');
});
it('channel names validate and reject case-insensitive duplicates', async () => {
  expect((await request(member, '/channels', 'POST', { name: 'second ROOM' })).statusCode).toBe(
    409,
  );
  expect((await request(member, '/channels', 'POST', { name: ' ' })).statusCode).toBe(400);
  expect(
    (await request(member, '/channels', 'POST', { name: 'Valid', userId: owner.id })).statusCode,
  ).toBe(400);
});
it('mutations require Origin and CSRF', async () => {
  expect(
    (
      await server.app.inject({
        url: '/api/voice/join',
        method: 'POST',
        headers: { cookie: member.cookie, origin },
        payload: { channelId: channel },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.app.inject({
        url: '/api/voice/join',
        method: 'POST',
        headers: {
          cookie: member.cookie,
          'x-csrf-token': member.csrf,
          origin: 'https://evil.test',
        },
        payload: { channelId: channel },
      })
    ).statusCode,
  ).toBe(403);
});
it('only approved users can join and unknown channels are denied', async () => {
  expect((await request(pending, '/join', 'POST', { channelId: channel })).statusCode).toBe(403);
  expect((await request(member, '/join', 'POST', { channelId: randomUUID() })).statusCode).toBe(
    404,
  );
});
it('one active session per account is enforced across concurrent devices', async () => {
  const device = await login(member.username);
  const results = await Promise.all([
    request(member, '/join', 'POST', { channelId: channel }),
    request(device, '/join', 'POST', { channelId: secondChannel }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(server.voice!.leases.size).toBe(1);
});
it('same lease retries are idempotent but another room requires leaving first', async () => {
  const lease = await join(member);
  expect(
    (await request(member, '/join', 'POST', { channelId: channel, leaseId: lease.id })).json().id,
  ).toBe(lease.id);
  expect(
    (await request(member, '/join', 'POST', { channelId: secondChannel, leaseId: lease.id }))
      .statusCode,
  ).toBe(409);
});
it('credentials are opaque and media grants are microphone-only', async () => {
  const response = await join(member);
  expect(response.credential).toBe(response.id);
  expect(response.credential).not.toContain('.');
  const service = server.voice!,
    lease = service.leases.get(member.id)!;
  const grants = await new TokenVerifier(service.config.key, service.config.secret).verify(
    await service.jwt(lease),
  );
  expect(grants.video?.canPublishSources).toEqual(['microphone']);
  expect(grants.video?.canPublishData).toBe(false);
  expect(grants.video?.roomAdmin).not.toBe(true);
  expect(grants.sub).toBe(member.id);
  expect(grants.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
});
it('refresh tokens are removed from binary and JSON signaling', () => {
  const signal = new SignalResponse({
    message: { case: 'refreshToken', value: 'secret.jwt.value' },
  });
  const binary = sanitizeSignal(Buffer.from(signal.toBinary()), true);
  expect(SignalResponse.fromBinary(binary as Uint8Array).message).toEqual({
    case: 'refreshToken',
    value: 'opaque-session',
  });
  expect(String(sanitizeSignal(Buffer.from(signal.toJsonString()), false))).not.toContain(
    'secret.jwt.value',
  );
});
it('leases cannot be used by another account or another session', async () => {
  const lease = await join(member),
    device = await login(member.username);
  await expect(server.voice!.authorize(owner.token, lease.id)).rejects.toMatchObject({
    statusCode: 401,
  });
  await expect(server.voice!.authorize(device.token, lease.id)).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('manual leave revokes the credential and allows switching channels', async () => {
  const lease = await join(member);
  expect((await request(member, '/leave', 'POST', { leaseId: lease.id })).statusCode).toBe(200);
  await expect(server.voice!.authorize(member.token, lease.id)).rejects.toMatchObject({
    statusCode: 401,
  });
  await join(member, secondChannel);
});
it('another session cannot terminate the current voice lease', async () => {
  const lease = await join(member),
    device = await login(member.username);
  await request(device, '/leave', 'POST', { leaseId: lease.id });
  expect(server.voice!.leases.get(member.id)?.id).toBe(lease.id);
});
it('expired heartbeat reservations are removed', async () => {
  const lease = await join(member);
  server.voice!.leases.get(member.id)!.expires = 0;
  await server.voice!.reconcile();
  expect(server.voice!.leases.size).toBe(0);
  expect((await request(member, '/heartbeat', 'POST', { leaseId: lease.id })).statusCode).toBe(410);
});
it('session revocation removes voice authorization', async () => {
  const device = await login(member.username),
    lease = await join(device);
  await fixture.database.pool.query(
    "UPDATE sessions SET revoked_at=now() WHERE token_hash=encode(sha256($1::bytea),'hex')",
    [device.token],
  );
  await server.voice!.reconcile();
  expect(server.voice!.leases.size).toBe(0);
  await expect(server.voice!.authorize(device.token, lease.id)).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('suspension closes active signaling and denies cached credentials', async () => {
  const target = await user('voice_suspend'),
    lease = await join(target);
  let closed = false;
  server.voice!.leases.get(target.id)!.close = () => {
    closed = true;
  };
  await auth.changeStatus(owner.token, target.id, 'suspend');
  await server.voice!.reconcile();
  expect(closed).toBe(true);
  expect(server.voice!.leases.has(target.id)).toBe(false);
  await expect(server.voice!.authorize(target.token, lease.id)).rejects.toMatchObject({
    statusCode: 401,
  });
});
it('unauthorized signaling handshakes fail before reaching LiveKit', async () => {
  const lease = await join(member);
  const result = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(
      address.replace('http:', 'ws:') + '/media/rtc?access_token=' + lease.id,
      { headers: { origin: 'https://evil.test', cookie: member.cookie } },
    );
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode!);
      res.resume();
      socket.terminate();
    });
    socket.on('open', () => {
      socket.terminate();
      reject(new Error('Unauthorized socket opened'));
    });
    socket.on('error', () => {});
  });
  expect(result).toBe(401);
});
