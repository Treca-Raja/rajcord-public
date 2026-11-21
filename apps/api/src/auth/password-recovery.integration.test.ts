import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { createApp } from '../app.js';
import { testDatabase } from '../db/test-database.js';
import { AuthService, digest } from './service.js';
import { PasswordRecoveryService } from './password-recovery.js';
import type { AuthState } from '@tricord/shared';

const origin = 'http://127.0.0.1:5173';
const secret = 'Recovery-fixture-' + randomUUID();
type Login = AuthState & { cookie: string };
let database: Awaited<ReturnType<typeof testDatabase>>;
let server: ReturnType<typeof createApp>,
  service: AuthService,
  owner: Login,
  ownerName: string,
  address: string;
const name = () => 'recovery_' + randomUUID().replaceAll('-', '').slice(0, 20);
const post = (path: string, body: Record<string, unknown>, account?: Login) =>
  server.app.inject({
    method: 'POST',
    url: '/api' + path,
    headers: {
      origin,
      ...(account ? { cookie: account.cookie, 'x-csrf-token': account.csrfToken } : {}),
    },
    payload: body,
  });
async function login(username: string, password = secret) {
  const response = await post('/auth/login', { username, password, remember: false });
  expect(response.statusCode).toBe(200);
  return {
    ...response.json(),
    cookie: response.headers['set-cookie']!.toString().split(';')[0]!,
  } as Login;
}
async function member() {
  const username = name();
  const user = await service.register({
    username,
    displayName: 'Recovery member',
    password: secret,
  });
  await service.changeStatus(owner.cookie.split('=')[1]!, user.id, 'approve');
  return { user, auth: await login(username) };
}
async function issue(id: string) {
  const response = await post('/admin/password-recovery/' + id, { currentPassword: secret }, owner);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json() as { code: string; expiresAt: string };
}
const me = (account: Login) =>
  server.app.inject({ url: '/api/auth/me', headers: { cookie: account.cookie } });
beforeAll(async () => {
  database = await testDatabase();
  service = new AuthService(database.database.pool);
  ownerName = name();
  await service.bootstrap(ownerName, 'Recovery owner', secret);
  server = createApp({ databaseUrl: database.url, rateLimits: false });
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  owner = await login(ownerName);
});
afterAll(async () => {
  await server?.app.close();
  await database?.cleanup();
});

it('issues only a hash and resets once, preserving approval while revoking every session and live socket', async () => {
  const { user, auth } = await member(),
    second = await login(user.username);
  const socket = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin, cookie: auth.cookie },
    auth: { csrfToken: auth.csrfToken },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const issued = await issue(user.id);
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = (
      await database.database.pool.query(
        'SELECT token_hash,expires_at FROM password_recovery_codes WHERE user_id=$1',
        [user.id],
      )
    ).rows[0];
    expect(row.token_hash).toBe(digest(issued.code));
    expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60000);
    expect((await me(auth)).statusCode).toBe(200);
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    const nextPassword = 'Recovered-fixture-' + randomUUID();
    const reset = await post('/auth/password/reset', {
      username: user.username,
      code: issued.code,
      newPassword: nextPassword,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.headers['set-cookie']).toBeUndefined();
    await disconnected;
    expect((await me(auth)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
    expect(
      (await post('/auth/login', { username: user.username, password: secret, remember: false }))
        .statusCode,
    ).toBe(401);
    expect((await login(user.username, nextPassword)).user.status).toBe('approved');
    expect(
      (
        await post('/auth/password/reset', {
          username: user.username,
          code: issued.code,
          newPassword: secret,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await database.database.pool.query(
          'SELECT user_id FROM password_recovery_codes WHERE user_id=$1',
          [user.id],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    socket.disconnect();
  }
});

it('requires the current owner password, session, CSRF and trusted origin to issue codes', async () => {
  const { user, auth } = await member();
  const path = '/admin/password-recovery/' + user.id;
  expect((await post(path, { currentPassword: secret })).statusCode).toBe(401);
  expect((await post(path, { currentPassword: secret }, auth)).statusCode).toBe(403);
  expect((await post(path, { currentPassword: 'wrong-password-12345' }, owner)).statusCode).toBe(
    403,
  );
  for (const headers of [
    { origin, cookie: owner.cookie, 'x-csrf-token': 'wrong' },
    { origin: 'https://untrusted.example', cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
  ])
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api' + path,
          headers,
          payload: { currentPassword: secret },
        })
      ).statusCode,
    ).toBe(403);
  expect(
    (await post('/admin/password-recovery/' + owner.user.id, { currentPassword: secret }, owner))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await database.database.pool.query(
        'SELECT user_id FROM password_recovery_codes WHERE user_id=$1',
        [user.id],
      )
    ).rowCount,
  ).toBe(0);
});

it('invalidates replacement and expired codes, returns a uniform invalid-code error and does not consume on bad password validation', async () => {
  const { user } = await member(),
    first = await issue(user.id),
    second = await issue(user.id);
  const reset = (username: string, code: string, newPassword = secret) =>
    post('/auth/password/reset', { username, code, newPassword });
  const old = await reset(user.username, first.code),
    unknown = await reset(name(), second.code),
    wrong = await reset(user.username, 'A'.repeat(43));
  expect([old.statusCode, unknown.statusCode, wrong.statusCode]).toEqual([400, 400, 400]);
  expect(old.json().error).toBe(unknown.json().error);
  expect(old.json().error).toBe(wrong.json().error);
  expect((await reset(user.username, second.code, 'short')).statusCode).toBe(400);
  await database.database.pool.query(
    "UPDATE password_recovery_codes SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [user.id],
  );
  expect((await reset(user.username, second.code)).json().error).toBe(old.json().error);
  const third = await issue(user.id);
  expect((await reset(user.username, third.code)).statusCode).toBe(200);
});

it('allows exactly one concurrent redemption and never changes another account', async () => {
  const { user } = await member(),
    other = await member(),
    issued = await issue(user.id);
  const candidates = ['Concurrent-one-' + randomUUID(), 'Concurrent-two-' + randomUUID()];
  const responses = await Promise.all(
    candidates.map((newPassword) =>
      post('/auth/password/reset', { username: user.username, code: issued.code, newPassword }),
    ),
  );
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
  const winner = responses.findIndex((response) => response.statusCode === 200);
  expect((await login(user.username, candidates[winner]!)).user.id).toBe(user.id);
  expect((await me(other.auth)).statusCode).toBe(200);
});

it('invalidates codes on password changes, disabled accounts and ownership transfers', async () => {
  const { user, auth } = await member();
  const first = await issue(user.id);
  expect(
    (await post('/account/password', { currentPassword: secret, newPassword: secret }, auth))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await post('/auth/password/reset', {
        username: user.username,
        code: first.code,
        newPassword: secret,
      })
    ).statusCode,
  ).toBe(400);
  const second = await issue(user.id);
  await service.changeStatus(owner.cookie.split('=')[1]!, user.id, 'suspend');
  expect(
    (
      await post('/auth/password/reset', {
        username: user.username,
        code: second.code,
        newPassword: secret,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await post('/admin/password-recovery/' + user.id, { currentPassword: secret }, owner))
      .statusCode,
  ).toBe(409);
  await service.changeStatus(owner.cookie.split('=')[1]!, user.id, 'restore');
  expect(
    (
      await post('/auth/password/reset', {
        username: user.username,
        code: second.code,
        newPassword: secret,
      })
    ).statusCode,
  ).toBe(400);
  const third = await issue(user.id),
    nextOwner = await login(user.username);
  await service.transfer(owner.cookie.split('=')[1]!, user.id);
  try {
    expect(
      (
        await post('/auth/password/reset', {
          username: user.username,
          code: third.code,
          newPassword: secret,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post('/admin/password-recovery/' + owner.user.id, { currentPassword: secret }, owner))
        .statusCode,
    ).toBe(403);
  } finally {
    await service.transfer(nextOwner.cookie.split('=')[1]!, owner.user.id);
  }
});

it('supports server-local owner recovery without changing ownership or account status', async () => {
  const recovery = new PasswordRecoveryService(database.database.pool);
  const { user } = await member();
  await expect(recovery.issueForOwner(user.username)).rejects.toMatchObject({ statusCode: 404 });
  const issued = await recovery.issueForOwner(ownerName);
  const nextPassword = 'Owner-recovered-' + randomUUID();
  expect(
    (
      await post('/auth/password/reset', {
        username: ownerName,
        code: issued.code,
        newPassword: nextPassword,
      })
    ).statusCode,
  ).toBe(200);
  const changed = await login(ownerName, nextPassword);
  expect(changed.user.isOwner).toBe(true);
  expect(
    (
      await post(
        '/account/password',
        { currentPassword: nextPassword, newPassword: secret },
        changed,
      )
    ).statusCode,
  ).toBe(200);
  owner = await login(ownerName);
});

it('rate limits anonymous redemption attempts without revealing whether the username exists', async () => {
  const limited = createApp({ databaseUrl: database.url });
  try {
    const results = [];
    for (let index = 0; index < 6; index++)
      results.push(
        await limited.app.inject({
          method: 'POST',
          url: '/api/auth/password/reset',
          headers: { origin },
          payload: { username: name(), code: 'B'.repeat(43), newPassword: secret },
        }),
      );
    expect(results.slice(0, 5).map((response) => response.statusCode)).toEqual([
      400, 400, 400, 400, 400,
    ]);
    expect(results[5]!.statusCode).toBe(429);
  } finally {
    await limited.app.close();
  }
});
