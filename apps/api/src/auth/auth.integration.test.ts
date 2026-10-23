import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { createApp } from '../app.js';
import { testDatabase } from '../db/test-database.js';
import { AuthService, digest, identity } from './service.js';
import { checkPassword } from './password.js';
import type { AuthState } from '@tricord/shared';
const origin = 'http://127.0.0.1:5173';
const secret = 'Test-only-' + randomUUID();
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let instance: ReturnType<typeof createApp>, address: string, service: AuthService;
type Login = AuthState & { cookie: string };
let owner: Login;
const sockets: Socket[] = [];
const name = () => 'test_' + randomUUID().replaceAll('-', '').slice(0, 22);
const send = (url: string, method: 'POST' | 'PATCH' | 'DELETE', payload: unknown, auth?: Login) =>
  instance.app.inject({
    url,
    method,
    payload,
    headers: { origin, ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken } : {}) },
  });
async function register() {
  const username = name();
  const response = await send('/api/auth/register', 'POST', {
    username,
    displayName: 'Test member',
    password: secret,
  });
  expect(response.statusCode).toBe(201);
  return response.json().user;
}
async function login(username: string, remember = false, oldCookie?: string) {
  const response = await instance.app.inject({
    url: '/api/auth/login',
    method: 'POST',
    headers: { origin, ...(oldCookie ? { cookie: oldCookie } : {}) },
    payload: { username, password: secret, remember },
  });
  expect(response.statusCode).toBe(200);
  return {
    ...response.json(),
    cookie: response.headers['set-cookie']!.toString().split(';')[0]!,
  } as Login;
}
async function account(approve = false) {
  const user = await register();
  if (approve)
    expect(
      (await send('/api/admin/accounts/' + user.id, 'POST', { action: 'approve' }, owner))
        .statusCode,
    ).toBe(200);
  return login(user.username);
}
function get(url: string, auth?: Login) {
  return instance.app.inject({ url, headers: auth ? { cookie: auth.cookie } : {} });
}
function socket(auth?: Login, headers: Record<string, string> = { origin }, csrf?: string) {
  const s = connect(address, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { ...headers, ...(auth ? { cookie: auth.cookie } : {}) },
    auth: { csrfToken: csrf ?? auth?.csrfToken },
  });
  sockets.push(s);
  return s;
}
function connected(s: Socket) {
  return new Promise<void>((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
}
function denied(s: Socket) {
  return new Promise<void>((resolve) => s.once('connect_error', () => resolve()));
}
beforeAll(async () => {
  fixture = await testDatabase();
  service = new AuthService(fixture.database.pool);
  const first = await service.bootstrap(name(), 'Test owner', secret);
  instance = createApp({ databaseUrl: fixture.url, rateLimits: false });
  address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
  owner = await login(first.username);
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});
afterAll(async () => {
  await instance?.app.close();
  await fixture?.cleanup();
});
describe('authentication on real PostgreSQL', () => {
  it('does not authenticate preserved legacy users without credentials', async () => {
    const username = name();
    await fixture.database.pool.query('INSERT INTO users(username,display_name) VALUES($1,$2)', [
      username,
      'Legacy account',
    ]);
    const response = await send('/api/auth/login', 'POST', {
      username,
      password: 'not-a-real-account-password',
      remember: false,
    });
    expect(response.statusCode).toBe(401);
  });
  it('normalizes UUIDs before self and owner protection checks', async () => {
    for (const action of ['suspend', 'remove', 'approve'])
      expect(
        (
          await send(
            '/api/admin/accounts/' + owner.user.id.toUpperCase(),
            'POST',
            { action },
            owner,
          )
        ).statusCode,
      ).toBe(403);
    expect((await get('/api/auth/me', owner)).json().user.status).toBe('approved');
  });

  it('registers pending accounts and stores an Argon2id hash only', async () => {
    const user = await register();
    expect(user.status).toBe('pending');
    expect(user.isOwner).toBe(false);
    expect(Object.keys(user).sort()).toEqual([
      'displayName',
      'id',
      'isOwner',
      'status',
      'username',
    ]);
    const row = (
      await fixture.database.pool.query('SELECT password_hash FROM credentials WHERE user_id=$1', [
        user.id,
      ])
    ).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await checkPassword(row.password_hash, secret)).toBe(true);
    expect(row.password_hash).not.toContain(secret);
  });
  it('rejects case-insensitive duplicate usernames without altering the account', async () => {
    const user = await register();
    const res = await send('/api/auth/register', 'POST', {
      username: user.username.toUpperCase(),
      displayName: 'Other',
      password: secret,
    });
    expect(res.statusCode).toBe(409);
  });
  it('rejects weak passwords, invalid usernames and privilege injection', async () => {
    for (const payload of [
      { username: 'bad username', password: secret, displayName: 'A' },
      { username: name(), password: 'short', displayName: 'A' },
      { username: name(), password: secret, displayName: 'A', status: 'approved' },
      { username: name(), password: secret, displayName: 'A', isOwner: true },
    ])
      expect((await send('/api/auth/register', 'POST', payload)).statusCode).toBe(400);
  });
  it('logs in pending users with a new HttpOnly session and no persistent cookie', async () => {
    const user = await register();
    const res = await send('/api/auth/login', 'POST', {
      username: user.username,
      password: secret,
      remember: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('HttpOnly');
    expect(res.headers['set-cookie']).toContain('SameSite=Strict');
    expect(res.headers['set-cookie']).not.toContain('Max-Age');
    expect(res.headers['cache-control']).toBe('no-store');
    const token = res.cookies[0]!.value;
    const row = (
      await fixture.database.pool.query('SELECT * FROM sessions WHERE token_hash=$1', [
        digest(token),
      ])
    ).rows[0];
    expect(row.token_hash).not.toBe(token);
    expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(11 * 3600000);
  });
  it('gives identical invalid-login responses for unknown and wrong-password accounts', async () => {
    const user = await register();
    const bad = await send('/api/auth/login', 'POST', {
      username: user.username,
      password: secret + 'wrong',
      remember: false,
    });
    const missing = await send('/api/auth/login', 'POST', {
      username: name(),
      password: secret,
      remember: false,
    });
    expect(bad.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(bad.body).toBe(missing.body);
  });
  it('sets a bounded persistent cookie only when remembering the device', async () => {
    const user = await register();
    const res = await send('/api/auth/login', 'POST', {
      username: user.username,
      password: secret,
      remember: true,
    });
    expect(res.headers['set-cookie']).toContain('Max-Age=2592000');
    expect(res.json().remember).toBe(true);
  });
  it('rotates sessions at login, preventing fixation', async () => {
    const first = await account();
    const second = await login(first.user.username, false, first.cookie);
    expect(second.cookie).not.toBe(first.cookie);
    expect((await get('/api/auth/me', first)).statusCode).toBe(401);
    expect((await get('/api/auth/me', second)).statusCode).toBe(200);
  });
  it('denies all private reads to anonymous and pending accounts', async () => {
    const pending = await account();
    for (const path of ['/api/members', '/api/admin/accounts', '/api/admin/history']) {
      expect((await get(path)).statusCode).toBe(401);
      expect((await get(path, pending)).statusCode).toBe(403);
    }
  });
  it('requires trusted origins and session-bound CSRF on mutations', async () => {
    const user = await account();
    for (const unsafeOrigin of [undefined, 'null', 'file://', 'https://evil.example']) {
      const res = await instance.app.inject({
        url: '/api/account',
        method: 'PATCH',
        headers: {
          cookie: user.cookie,
          'x-csrf-token': user.csrfToken,
          ...(unsafeOrigin ? { origin: unsafeOrigin } : {}),
        },
        payload: { displayName: 'Changed' },
      });
      expect(res.statusCode).toBe(403);
    }
    for (const csrf of ['', owner.csrfToken, 'é'.repeat(64)])
      expect(
        (
          await instance.app.inject({
            url: '/api/account',
            method: 'PATCH',
            headers: { origin, cookie: user.cookie, 'x-csrf-token': csrf },
            payload: { displayName: 'Changed' },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('rejects unauthenticated and pending approval attempts, including self approval', async () => {
    const pending = await account(),
      target = await register();
    expect(
      (await send('/api/admin/accounts/' + target.id, 'POST', { action: 'approve' })).statusCode,
    ).toBe(401);
    expect(
      (await send('/api/admin/accounts/' + target.id, 'POST', { action: 'approve' }, pending))
        .statusCode,
    ).toBe(403);
    expect(
      (await send('/api/admin/accounts/' + pending.user.id, 'POST', { action: 'approve' }, pending))
        .statusCode,
    ).toBe(403);
    expect(
      (await send('/api/admin/accounts/' + owner.user.id, 'POST', { action: 'approve' }, owner))
        .statusCode,
    ).toBe(403);
  });
  it('allows an approved member to approve pending users and records actor/time', async () => {
    const admin = await account(true),
      pending = await account();
    expect(
      (await send('/api/admin/accounts/' + pending.user.id, 'POST', { action: 'approve' }, admin))
        .statusCode,
    ).toBe(200);
    expect((await get('/api/members', pending)).statusCode).toBe(200);
    const row = (
      await fixture.database.pool.query('SELECT * FROM approval_history WHERE target_id=$1', [
        pending.user.id,
      ])
    ).rows[0];
    expect(row.actor_id).toBe(admin.user.id);
    expect(row.action).toBe('approve');
    expect(row.created_at).toBeInstanceOf(Date);
  });
  it('rejects pending registrations and keeps rejected accounts outside the private app', async () => {
    const admin = await account(true),
      pending = await account();
    expect(
      (await send('/api/admin/accounts/' + pending.user.id, 'POST', { action: 'reject' }, admin))
        .statusCode,
    ).toBe(200);
    expect((await get('/api/auth/me', pending)).json().user.status).toBe('rejected');
    expect((await get('/api/members', pending)).statusCode).toBe(403);
    expect((await login(pending.user.username)).user.status).toBe('rejected');
  });
  it('serializes conflicting approval decisions and records only one', async () => {
    const pending = await account();
    const results = await Promise.all(
      ['approve', 'reject'].map((action) =>
        send('/api/admin/accounts/' + pending.user.id, 'POST', { action }, owner),
      ),
    );
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(
      (
        await fixture.database.pool.query('SELECT id FROM approval_history WHERE target_id=$1', [
          pending.user.id,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('reserves suspension and removal for the owner', async () => {
    const admin = await account(true),
      target = await account(true);
    for (const action of ['suspend', 'remove'])
      expect(
        (await send('/api/admin/accounts/' + target.user.id, 'POST', { action }, admin)).statusCode,
      ).toBe(403);
    expect(
      (await send('/api/admin/accounts/' + target.user.id, 'POST', { action: 'remove' }, owner))
        .statusCode,
    ).toBe(200);
    expect((await get('/api/auth/me', target)).statusCode).toBe(401);
    const row = (
      await fixture.database.pool.query('SELECT status FROM users WHERE id=$1', [target.user.id])
    ).rows[0];
    expect(row.status).toBe('removed');
  });
  it('suspension revokes every session immediately; restoration never revives them', async () => {
    const target = await account(true),
      second = await login(target.user.username, true);
    expect(
      (await send('/api/admin/accounts/' + target.user.id, 'POST', { action: 'suspend' }, owner))
        .statusCode,
    ).toBe(200);
    for (const auth of [target, second])
      expect((await get('/api/auth/me', auth)).statusCode).toBe(401);
    expect(
      (
        await send('/api/auth/login', 'POST', {
          username: target.user.username,
          password: secret,
          remember: false,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await send('/api/admin/accounts/' + target.user.id, 'POST', { action: 'restore' }, owner))
        .statusCode,
    ).toBe(200);
    expect((await get('/api/auth/me', target)).statusCode).toBe(401);
    expect((await login(target.user.username)).user.status).toBe('approved');
  });
  it('protects owner designation, supports explicit transfer and prevents repeated bootstrap', async () => {
    const target = await account(true),
      pending = await account();
    expect(
      (await send('/api/owner/transfer', 'POST', { userId: target.user.id }, target)).statusCode,
    ).toBe(403);
    expect(
      (await send('/api/owner/transfer', 'POST', { userId: pending.user.id }, owner)).statusCode,
    ).toBe(409);
    expect(
      (await send('/api/admin/accounts/' + owner.user.id, 'POST', { action: 'remove' }, target))
        .statusCode,
    ).toBe(403);
    await expect(service.bootstrap(name(), 'Another owner', secret)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(
      (await send('/api/owner/transfer', 'POST', { userId: target.user.id }, owner)).statusCode,
    ).toBe(200);
    expect((await get('/api/auth/me', owner)).json().user.isOwner).toBe(false);
    expect((await get('/api/auth/me', target)).json().user.isOwner).toBe(true);
    expect(
      (await send('/api/owner/transfer', 'POST', { userId: owner.user.id }, target)).statusCode,
    ).toBe(200);
    expect((await send('/api/owner/bootstrap', 'POST', {})).statusCode).toBe(404);
  });
  it('logs out, clears the cookie and makes replayed tokens unusable', async () => {
    const auth = await account();
    const res = await send('/api/auth/logout', 'POST', undefined, auth);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('Max-Age=0');
    expect((await get('/api/auth/me', auth)).statusCode).toBe(401);
  });
  it('rejects expired sessions on protected routes and socket handshakes', async () => {
    const auth = await account(true);
    await fixture.database.pool.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [digest(auth.cookie.split('=')[1]!)],
    );
    expect((await get('/api/members', auth)).statusCode).toBe(401);
    await denied(socket(auth));
  });
  it('lists only own sessions and cannot revoke another user session', async () => {
    const a = await account(),
      b = await account();
    const id = (await get('/api/account/sessions', b)).json().sessions[0].id;
    expect((await send('/api/account/sessions/' + id, 'DELETE', undefined, a)).statusCode).toBe(
      200,
    );
    expect((await get('/api/auth/me', b)).statusCode).toBe(200);
    expect((await send('/api/account/sessions/' + id, 'DELETE', undefined, b)).statusCode).toBe(
      200,
    );
    expect((await get('/api/auth/me', b)).statusCode).toBe(401);
  });
  it('changes only own display name and rejects privilege changes', async () => {
    const auth = await account();
    expect((await send('/api/account', 'PATCH', { displayName: 'Renamed' }, auth)).statusCode).toBe(
      200,
    );
    expect((await get('/api/auth/me', auth)).json().user.displayName).toBe('Renamed');
    expect((await send('/api/account', 'PATCH', { isOwner: true }, auth)).statusCode).toBe(400);
  });
  it('requires current password and revokes every session after changing it', async () => {
    const auth = await account(),
      second = await login(auth.user.username, true);
    expect(
      (
        await send(
          '/api/account/password',
          'POST',
          { currentPassword: secret + 'bad', newPassword: secret + 'new' },
          auth,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(
          '/api/account/password',
          'POST',
          { currentPassword: secret, newPassword: secret + 'new' },
          auth,
        )
      ).statusCode,
    ).toBe(200);
    expect((await get('/api/auth/me', auth)).statusCode).toBe(401);
    expect((await get('/api/auth/me', second)).statusCode).toBe(401);
    expect(
      (
        await send('/api/auth/login', 'POST', {
          username: auth.user.username,
          password: secret,
          remember: false,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await send('/api/auth/login', 'POST', {
          username: auth.user.username,
          password: secret + 'new',
          remember: false,
        })
      ).statusCode,
    ).toBe(200);
  });
  it('rejects anonymous, untrusted-origin and invalid-CSRF sockets', async () => {
    await denied(socket());
    const auth = await account(true);
    await denied(socket(auth, { origin: 'https://evil.example' }));
    await denied(socket(auth, {}, auth.csrfToken));
    await denied(socket(auth, { origin }, 'wrong'));
  });
  it('limits pending sockets to own status and notifies approval in real time', async () => {
    const auth = await account(),
      s = socket(auth);
    let welcome = false;
    s.on('connection:welcome', () => {
      welcome = true;
    });
    await connected(s);
    expect(await s.timeout(2000).emitWithAck('connection:ping')).toEqual({ ok: false });
    expect(welcome).toBe(false);
    const changed = new Promise<void>((resolve) => s.once('account:changed', resolve));
    await send('/api/admin/accounts/' + auth.user.id, 'POST', { action: 'approve' }, owner);
    await changed;
    expect(await s.timeout(2000).emitWithAck('connection:ping')).toEqual({ ok: true });
  });
  it('rechecks status for each socket event and disconnects revoked sessions', async () => {
    const auth = await account(true),
      s = socket(auth);
    await connected(s);
    expect(await s.timeout(2000).emitWithAck('connection:ping')).toEqual({ ok: true });
    await fixture.database.pool.query("UPDATE users SET status='rejected' WHERE id=$1", [
      auth.user.id,
    ]);
    expect(await s.timeout(2000).emitWithAck('connection:ping')).toEqual({ ok: false });
    await fixture.database.pool.query("UPDATE users SET status='approved' WHERE id=$1", [
      auth.user.id,
    ]);
    const disconnected = new Promise<void>((resolve) => s.once('disconnect', () => resolve()));
    await send('/api/admin/accounts/' + auth.user.id, 'POST', { action: 'suspend' }, owner);
    await disconnected;
    expect(s.connected).toBe(false);
  });
  it('persists a remembered session across backend restart', async () => {
    const auth = await account(true);
    const raw = auth.cookie.split('=')[1]!;
    await instance.app.close();
    instance = createApp({ databaseUrl: fixture.url, rateLimits: false });
    address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await get('/api/auth/me', auth)).statusCode).toBe(200);
    expect((await identity(fixture.database.pool, raw))?.user.id).toBe(auth.user.id);
  });
  it('rate-limits registration and login requests', async () => {
    const limited = createApp({ databaseUrl: fixture.url });
    try {
      for (const [path, count] of [
        ['register', 5],
        ['login', 10],
      ] as const) {
        for (let i = 0; i < count; i++)
          await limited.app.inject({
            url: '/api/auth/' + path,
            method: 'POST',
            headers: { origin },
            payload: {},
          });
        const res = await limited.app.inject({
          url: '/api/auth/' + path,
          method: 'POST',
          headers: { origin },
          payload: {},
        });
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
      }
    } finally {
      await limited.app.close();
    }
  });
  it('requires HTTPS origins for production cookies and sets Secure correctly', async () => {
    expect(() => createApp({ secureCookies: true })).toThrow();
    const secure = createApp({
      databaseUrl: fixture.url,
      secureCookies: true,
      allowedOrigins: ['https://tricord.example'],
    });
    try {
      const res = await secure.app.inject({
        url: '/api/auth/login',
        method: 'POST',
        headers: { origin: 'https://tricord.example' },
        payload: { username: owner.user.username, password: secret, remember: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toContain('Secure');
    } finally {
      await secure.app.close();
    }
  });
});
