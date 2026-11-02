import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../apps/api/src/db/test-database.js';
import { AuthService, digest } from '../apps/api/src/auth/service.js';
import { voiceConfig } from '../apps/api/src/voice/config.js';
import { createApp } from '../apps/api/src/app.js';
import {
  ServerCaptureAuthority,
  type CaptureAuthorityContext,
} from '../apps/desktop/src/capture-authority.js';
import { sessionCaptureTransport } from '../apps/desktop/src/capture-authority-http.js';

const origin = 'http://127.0.0.1:5173',
  password = randomUUID() + '-Authority';
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  app: ReturnType<typeof createApp>,
  auth: AuthService,
  channel: string;
type Person = { id: string; token: string; csrf: string };
let owner: Person, member: Person, other: Person, pending: Person;
const authorities: ServerCaptureAuthority[] = [];
const login = async (username: string) => {
  const result = await auth.login({ username, password, remember: false }, undefined);
  return { id: result.auth.user.id, token: result.token, csrf: result.auth.csrfToken };
};
const post = (person: Person, operation: string, body: unknown, headers = {}) =>
  app.app.inject({
    method: 'POST',
    url: '/api/screen/capture/' + operation,
    headers: {
      origin,
      cookie: 'tricord_session=' + person.token,
      'x-csrf-token': person.csrf,
      ...headers,
    },
    payload: body,
  });
beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  await auth.bootstrap('capture_owner', 'Capture owner', password);
  owner = await login('capture_owner');
  for (const name of ['capture_member', 'capture_other', 'capture_pending']) {
    const person = await auth.register({ username: name, displayName: name, password });
    if (name !== 'capture_pending') await auth.changeStatus(owner.token, person.id, 'approve');
  }
});
beforeEach(async () => {
  member = await login('capture_member');
  other = await login('capture_other');
  pending = await login('capture_pending');
  const config = voiceConfig();
  if (!config) throw new Error('Local voice fixtures required.');
  app = createApp({
    databaseUrl: fixture.url,
    allowedOrigins: [origin],
    voiceConfig: { ...config, prefix: 'tricord-capture-authority-' + randomUUID() + '-' },
  });
  await app.app.ready();
  channel = (await app.voice!.channels(owner.token))[0]!.id;
});
afterEach(async () => {
  await Promise.all(authorities.splice(0).map((authority) => authority.dispose()));
  vi.restoreAllMocks();
  for (const lease of [...app.voice!.leases.values()]) await app.voice!.remove(lease);
  const status = (
    await fixture.database.pool.query('SELECT status FROM users WHERE id=$1', [member.id])
  ).rows[0]?.status;
  if (status === 'suspended') await auth.changeStatus(owner.token, member.id, 'restore');
  await app?.app.close();
  if (app?.voice)
    for (const room of await app.voice.media.listRooms())
      if (room.name.startsWith(app.voice.prefix)) await app.voice.media.deleteRoom(room.name);
});
afterAll(async () => {
  await fixture?.cleanup();
});
it('requires approved current sessions, origin, CSRF and the exact session-owned voice lease', async () => {
  const body = { requestId: randomUUID(), sound: 'none' };
  expect((await post(pending, 'prepare', body)).statusCode).toBe(403);
  expect((await post(member, 'prepare', body)).statusCode).toBe(403);
  await app.voice!.join(member.token, { channelId: channel });
  expect((await post(member, 'prepare', body, { origin: 'https://evil.example' })).statusCode).toBe(
    403,
  );
  expect((await post(member, 'prepare', body, { 'x-csrf-token': 'invalid' })).statusCode).toBe(403);
  const device = await login('capture_member');
  expect((await post(device, 'prepare', body)).statusCode).toBe(403);
  const grant = await post(member, 'prepare', body);
  expect(grant.statusCode).toBe(200);
  expect(Object.keys(grant.json()).sort()).toEqual(['id', 'remainingMs']);
});
it('consumes once, denies foreign references and never extends voice or duplicate request deadlines', async () => {
  const lease = await app.voice!.join(member.token, { channelId: channel });
  const expires = app.voice!.leases.get(member.id)!.expires,
    body = { requestId: randomUUID(), sound: 'none' };
  const grant = (await post(member, 'prepare', body)).json();
  expect((await post(member, 'prepare', body)).json().remainingMs).toBeLessThanOrEqual(
    grant.remainingMs,
  );
  expect((await post(other, 'consume', { id: grant.id })).statusCode).toBe(403);
  expect((await post(member, 'consume', { id: grant.id })).statusCode).toBe(200);
  expect((await post(member, 'consume', { id: grant.id })).statusCode).toBe(409);
  expect(app.voice!.leases.get(member.id)!.expires).toBe(expires);
  expect(app.voice!.leases.get(member.id)!.id).toBe(lease.id);
  expect((await post(member, 'prepare', { ...body, sourceTitle: 'Synthetic' })).statusCode).toBe(
    400,
  );
});
it('recovers valid capture admission after an unverified-cookie burst and preserves voice heartbeat', async () => {
  const lease = await app.voice!.join(member.token, { channelId: channel });
  const requests = Array.from({ length: 1024 }, (_, index) => {
    const operation = index % 2 === 0 ? 'prepare' : 'check';
    return post(
      { ...member, token: index.toString(16).padStart(64, '0'), csrf: 'invalid' },
      operation,
      operation === 'prepare' ? { requestId: randomUUID(), sound: 'none' } : { id: randomUUID() },
    );
  });
  const responses = await Promise.all(requests);
  expect(responses.every((response) => [401, 429].includes(response.statusCode))).toBe(true);
  const heartbeat = await app.app.inject({
    method: 'POST',
    url: '/api/voice/heartbeat',
    headers: { origin, cookie: 'tricord_session=' + member.token, 'x-csrf-token': member.csrf },
    payload: { leaseId: lease.id },
  });
  expect(heartbeat.statusCode).toBe(200);
  // Poll for the unchanged aggregate budget to refill, not for bucket eviction (60 seconds).
  await vi.waitFor(
    async () => {
      const response = await post(member, 'prepare', { requestId: randomUUID(), sound: 'none' });
      expect(response.statusCode).toBe(200);
    },
    { timeout: 3000, interval: 50 },
  );
});
it.each(['revocation', 'suspension', 'lease-expiry', 'replacement'] as const)(
  'denies pending grant on real %s',
  async (change) => {
    await app.voice!.join(member.token, { channelId: channel });
    const grant = (
      await post(member, 'prepare', { requestId: randomUUID(), sound: 'none' })
    ).json();
    if (change === 'revocation')
      await fixture.database.pool.query(
        'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',
        [digest(member.token)],
      );
    if (change === 'suspension') await auth.changeStatus(owner.token, member.id, 'suspend');
    if (change === 'lease-expiry') app.voice!.leases.get(member.id)!.expires = Date.now() - 1;
    if (change === 'replacement') {
      await app.voice!.remove(app.voice!.leases.get(member.id)!);
      await app.voice!.join(member.token, { channelId: channel });
    }
    expect((await post(member, 'consume', { id: grant.id })).statusCode).toBeGreaterThanOrEqual(
      400,
    );
  },
);
it('feeds the main provider through the fixed Session.fetch adapter against real API authorization', async () => {
  await app.voice!.join(member.token, { channelId: channel });
  const context = {
    mainFrame: {} as CaptureAuthorityContext['mainFrame'],
    url: origin + '/app',
    navigation: 1,
    alive: true,
  };
  const nativeFetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    expect(options.credentials).toBe('include');
    expect(options.redirect).toBe('error');
    const response = await app.app.inject({
      method: (options.method ?? 'GET') as 'GET' | 'POST',
      url: new URL(url).pathname,
      headers: {
        ...Object.fromEntries(new Headers(options.headers)),
        cookie: 'tricord_session=' + member.token,
      },
      payload: options.body ? JSON.parse(String(options.body)) : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  });
  const authority = new ServerCaptureAuthority({
    context: () => context,
    transport: sessionCaptureTransport(
      { fetch: nativeFetch } as unknown as Parameters<typeof sessionCaptureTransport>[0],
      origin,
    ),
    onError: () => {},
  });
  authorities.push(authority);
  const intent = await authority.prepare('none');
  expect(await authority.verify(intent)).toBe(true);
  expect(await authority.verify(intent)).toBe(false);
  expect(nativeFetch.mock.calls.some((call) => call[0].endsWith('/consume'))).toBe(true);
  const invalidated = vi.fn();
  authority.onInvalidated(invalidated);
  await fixture.database.pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [
    digest(member.token),
  ]);
  await vi.waitFor(() => expect(authority.inspect()).toBeNull(), { timeout: 3000 });
  expect(invalidated).toHaveBeenCalled();
});
