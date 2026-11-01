import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import type { Conversation } from '@tricord/shared';
import { testDatabase } from '../db/test-database.js';
import { createApp } from '../app.js';
import { AuthService, digest } from '../auth/service.js';
import { ChatService } from './service.js';
import { noticePreferences } from './notification-preferences.js';

const origin = 'http://127.0.0.1:5173';
const secret = 'Notification-' + randomUUID();
type Person = { id: string; username: string; token: string; cookie: string; csrf: string };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let server: ReturnType<typeof createApp>;
let auth: AuthService;
let chat: ChatService;
let address: string;
let owner: Person;
const sockets: Socket[] = [];
async function login(username: string): Promise<Person> {
  const result = await auth.login({ username, password: secret, remember: true }, undefined);
  return {
    id: result.auth.user.id,
    username,
    token: result.token,
    cookie: 'tricord_session=' + result.token,
    csrf: result.auth.csrfToken,
  };
}
async function person(approve = true) {
  const user = await auth.register({
    username: 'ntf_' + randomUUID().replaceAll('-', '').slice(0, 24),
    displayName: 'Notification fixture',
    password: secret,
  });
  if (approve) await auth.changeStatus(owner.token, user.id, 'approve');
  return login(user.username);
}
const request = (
  user: Person | undefined,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  payload?: unknown,
) =>
  server.app.inject({
    url,
    method,
    payload,
    headers: { origin, ...(user ? { cookie: user.cookie, 'x-csrf-token': user.csrf } : {}) },
  });
async function conversation(user: Person, kind: 'channel' | 'dm' | 'group', member?: Person) {
  const response = await request(
    user,
    '/api/conversations',
    'POST',
    kind === 'channel'
      ? { kind, name: 'notice-' + randomUUID().slice(0, 12) }
      : kind === 'dm'
        ? { kind, userId: member!.id }
        : { kind, name: 'notice-group-' + randomUUID().slice(0, 8) },
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json().conversation as Conversation;
}
const path = (c: Conversation) => '/api/conversations/' + c.id + '/notification-preference';
async function socketFor(user: Person) {
  const socket = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: user.cookie },
    auth: { csrfToken: user.csrf },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}
beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  chat = new ChatService(fixture.database.pool);
  const initial = await auth.bootstrap('ntf_owner_' + randomUUID().slice(0, 8), 'Owner', secret);
  owner = await login(initial.username);
  server = createApp({ databaseUrl: fixture.url, rateLimits: false });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});
afterAll(async () => {
  await server?.app.close();
  await fixture?.cleanup();
});
it('persists account-private defaults, overrides and resets across sessions', async () => {
  const [a, b] = await Promise.all([person(), person()]);
  const channel = await conversation(a, 'channel');
  const dm = await conversation(a, 'dm', b);
  const group = await conversation(a, 'group');
  for (const [c, mode] of [
    [channel, 'mentions'],
    [dm, 'all'],
    [group, 'all'],
  ] as const)
    expect((await request(a, path(c))).json()).toMatchObject({
      mode,
      defaultMode: mode,
      overridden: false,
    });
  expect((await request(a, path(channel), 'PATCH', { mode: 'muted' })).json()).toMatchObject({
    mode: 'muted',
    overridden: true,
  });
  const secondSession = await login(a.username);
  expect((await request(secondSession, path(channel))).json().mode).toBe('muted');
  expect((await request(b, path(channel))).json()).toMatchObject({
    mode: 'mentions',
    overridden: false,
  });
  expect((await request(a, path(channel), 'PATCH', { mode: null })).json()).toMatchObject({
    mode: 'mentions',
    overridden: false,
  });
});
it('rechecks approval, membership, archive, CSRF, origin and input boundaries', async () => {
  const [a, b, outsider, pending] = await Promise.all([
    person(),
    person(),
    person(),
    person(false),
  ]);
  const dm = await conversation(a, 'dm', b);
  expect((await request(outsider, path(dm))).statusCode).toBe(404);
  expect((await request(outsider, path(dm), 'PATCH', { mode: 'all' })).statusCode).toBe(404);
  expect((await request(pending, '/api/sender-alert-preferences')).statusCode).toBe(403);
  expect((await request(undefined, path(dm))).statusCode).toBe(401);
  expect(
    (await request({ ...a, csrf: 'wrong' }, path(dm), 'PATCH', { mode: 'all' })).statusCode,
  ).toBe(403);
  expect(
    (
      await server.app.inject({
        url: path(dm),
        method: 'PATCH',
        payload: { mode: 'all' },
        headers: { origin: 'https://evil.invalid', cookie: a.cookie, 'x-csrf-token': a.csrf },
      })
    ).statusCode,
  ).toBe(403);
  for (const payload of [{}, { mode: 'all', userId: b.id }, { mode: [] }])
    expect((await request(a, path(dm), 'PATCH', payload)).statusCode).toBe(400);
  const channel = await conversation(a, 'channel');
  await fixture.database.pool.query('UPDATE conversations SET archived=true WHERE id=$1', [
    channel.id,
  ]);
  expect((await request(a, path(channel), 'PATCH', { mode: 'all' })).statusCode).toBe(409);
  const group = await conversation(a, 'group');
  await fixture.database.pool.query(
    'UPDATE memberships SET end_seq=0 WHERE user_id=$1 AND conversation_id=$2',
    [a.id, group.id],
  );
  await expect(noticePreferences(chat, a.token, group.id, b.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  await auth.changeStatus(owner.token, a.id, 'suspend');
  expect((await request(a, '/api/sender-alert-preferences')).statusCode).toBe(401);
});
it('bounds sender pagination, keeps rules private and atomically preserves independent fields', async () => {
  const [a, b, pending] = await Promise.all([person(), person(), person(false)]);
  const response = await request(a, '/api/sender-alert-preferences?limit=1');
  expect(response.statusCode).toBe(200);
  expect(response.json().senders).toHaveLength(1);
  expect(response.json().nextCursor).toBeTruthy();
  const next = await request(
    a,
    '/api/sender-alert-preferences?limit=1&after=' + response.json().nextCursor,
  );
  expect(next.json().senders[0].senderId).not.toBe(response.json().senders[0].senderId);
  expect((await request(a, '/api/sender-alert-preferences?limit=101')).statusCode).toBe(400);
  expect((await request(a, '/api/sender-alert-preferences?userId=' + b.id)).statusCode).toBe(400);
  const endpoint = '/api/sender-alert-preferences/' + b.id;
  await Promise.all([
    request(a, endpoint, 'PATCH', { priority: true }),
    request(a, endpoint, 'PATCH', { muted: true }),
  ]);
  const all = (await request(a, '/api/sender-alert-preferences?limit=100')).json().senders;
  expect(all.find((row: { senderId: string }) => row.senderId === b.id)).toMatchObject({
    muted: true,
    priority: true,
  });
  expect(all.some((row: { senderId: string }) => [a.id, pending.id].includes(row.senderId))).toBe(
    false,
  );
  const dm = await conversation(a, 'dm', b);
  expect(await noticePreferences(chat, a.token, dm.id, b.id)).toEqual({
    mode: 'all',
    senderMuted: true,
    priority: true,
  });
  expect(await noticePreferences(chat, b.token, dm.id, a.id)).toEqual({
    mode: 'all',
    senderMuted: false,
    priority: false,
  });
  expect(
    (await request(a, '/api/sender-alert-preferences/' + pending.id, 'PATCH', { muted: true }))
      .statusCode,
  ).toBe(404);
  expect(
    (await request(a, '/api/sender-alert-preferences/' + a.id, 'PATCH', { muted: true }))
      .statusCode,
  ).toBe(400);
});
it('publishes invalidation only to freshly authorized same-account sockets', async () => {
  const [a, b] = await Promise.all([person(), person()]);
  const second = await login(a.username);
  const revoked = await login(a.username);
  const [firstSocket, secondSocket, revokedSocket, otherSocket] = await Promise.all([
    socketFor(a),
    socketFor(second),
    socketFor(revoked),
    socketFor(b),
  ]);
  const events = [0, 0, 0, 0];
  [firstSocket, secondSocket, revokedSocket, otherSocket].forEach((socket, index) =>
    socket.on('notification:preferences-changed', (...args) => {
      expect(args).toEqual([]);
      events[index]++;
    }),
  );
  await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [
    digest(revoked.token),
  ]);
  expect(
    (await request(a, '/api/sender-alert-preferences/' + b.id, 'PATCH', { muted: true }))
      .statusCode,
  ).toBe(200);
  await Promise.all(
    [firstSocket, secondSocket, otherSocket].map((socket) =>
      socket.timeout(3000).emitWithAck('connection:ping'),
    ),
  );
  expect(events).toEqual([1, 1, 0, 0]);
});
