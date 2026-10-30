import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app.js';
import { AuthService, SESSION_COOKIE, approved, equal, identity } from '../auth/service.js';
import { HttpError } from '../auth/validation.js';
import { testDatabase } from '../db/test-database.js';
import { registerGifSearch } from './gif-search.js';
import type { GifSearchConfig } from './gif-search.js';

type Person = { id: string; token: string; csrf: string };
const origin = 'http://127.0.0.1:5173';
const password = 'GIF-Fixture-' + randomUUID();
const config: GifSearchConfig = {
  giphyApiKey: 'fixture-giphy-key',
  tenorApiKey: 'fixture-tenor-key',
  klipyApiKey: 'fixture-klipy-key',
};
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let server: ReturnType<typeof createApp>;
let auth: AuthService;
let owner: Person, pending: Person, suspended: Person, friend: Person;
const fetcher = vi.fn<typeof fetch>();
const emptyResponse = () =>
  new Response(JSON.stringify({ results: [], next: '' }), {
    headers: { 'content-type': 'application/json' },
  });
const headers = (person: Person = owner) => ({
  origin,
  cookie: SESSION_COOKIE + '=' + person.token,
  'x-csrf-token': person.csrf,
});
const search = (person: Person = owner, provider: 'giphy' | 'tenor' = 'tenor') =>
  server.app.inject({
    method: 'POST',
    url: '/api/gifs/search',
    payload: { provider, query: 'friendly wave' },
    headers: headers(person),
  });

beforeAll(async () => {
  fixture = await testDatabase();
  auth = new AuthService(fixture.database.pool);
  const login = async (username: string): Promise<Person> => {
    const result = await auth.login({ username, password, remember: true }, undefined);
    return { id: result.auth.user.id, token: result.token, csrf: result.auth.csrfToken };
  };
  const first = await auth.bootstrap('gif_owner_' + randomUUID().slice(0, 8), 'Owner', password);
  owner = await login(first.username);
  const person = async (allow: boolean) => {
    const user = await auth.register({
      username: 'gif_' + randomUUID().replaceAll('-', '').slice(0, 20),
      displayName: 'GIF fixture',
      password,
    });
    if (allow) await auth.changeStatus(owner.token, user.id, 'approve');
    return login(user.username);
  };
  pending = await person(false);
  suspended = await person(true);
  await auth.changeStatus(owner.token, suspended.id, 'suspend');
  friend = await person(true);
  // Keep the new routes isolated while using the production origin, cookie,
  // error-sanitization, no-store and global rate-limit hooks.
  server = createApp();
  server.app.register(async (routes) => {
    registerGifSearch(routes, {
      config,
      limits: true,
      fetcher,
      async guard(req) {
        const session = approved(
          await identity(fixture.database.pool, req.cookies[SESSION_COOKIE] ?? ''),
        );
        if (
          !['GET', 'HEAD'].includes(req.method) &&
          !equal(req.headers['x-csrf-token'], session.csrfToken)
        )
          throw new HttpError(403, 'Invalid CSRF token.');
      },
    });
  });
  await server.app.ready();
});

beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockImplementation(async () => emptyResponse());
});

afterAll(async () => {
  await server?.app.close();
  await fixture?.cleanup();
});

it('returns public GIPHY/KLIPY keys only to approved clients without upstream requests', async () => {
  const response = await server.app.inject({ url: '/api/gifs/providers', headers: headers() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    providers: [
      { id: 'giphy', label: 'GIPHY', enabled: true, publicKey: 'fixture-giphy-key' },
      { id: 'tenor', label: 'Tenor', enabled: true },
      { id: 'klipy', label: 'KLIPY', enabled: true, publicKey: 'fixture-klipy-key' },
    ],
  });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain('fixture-tenor-key');
  expect(response.json().providers[1]).not.toHaveProperty('publicKey');
  expect(fetcher).not.toHaveBeenCalled();
});

it('never proxies KLIPY searches through the server', async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/gifs/search',
    headers: headers(),
    payload: { provider: 'klipy', query: 'friendly wave' },
  });
  expect(response.statusCode).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
});

it('requires a current approved session for availability and searching', async () => {
  for (const person of [undefined, pending, suspended]) {
    for (const method of ['GET', 'POST'] as const) {
      const response = await server.app.inject({
        method,
        url: method === 'GET' ? '/api/gifs/providers' : '/api/gifs/search',
        ...(method === 'POST' ? { payload: { provider: 'giphy', query: 'hello' } } : {}),
        headers: person ? headers(person) : { origin },
      });
      expect([401, 403]).toContain(response.statusCode);
      expect(response.body).not.toContain('fixture-giphy-key');
      expect(response.body).not.toContain('fixture-tenor-key');
      expect(response.body).not.toContain('fixture-klipy-key');
    }
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('rechecks approval after a previously approved account is suspended', async () => {
  expect((await search(friend)).statusCode).toBe(200);
  fetcher.mockClear();
  await auth.changeStatus(owner.token, friend.id, 'suspend');
  expect([401, 403]).toContain((await search(friend)).statusCode);
  const availability = await server.app.inject({
    url: '/api/gifs/providers',
    headers: headers(friend),
  });
  expect([401, 403]).toContain(availability.statusCode);
  expect(availability.body).not.toContain('fixture-giphy-key');
  expect(fetcher).not.toHaveBeenCalled();
});

it('enforces production trusted-origin and CSRF checks before upstream work', async () => {
  for (const changes of [
    { origin: 'https://evil.invalid' },
    { origin: undefined },
    { 'x-csrf-token': 'wrong-fixture' },
    { 'x-csrf-token': undefined },
  ]) {
    const requestHeaders: Record<string, string> = headers();
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete requestHeaders[name];
      else requestHeaders[name] = value;
    }
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/gifs/search',
      headers: requestHeaders,
      payload: { provider: 'giphy', query: 'hello' },
    });
    expect(response.statusCode).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects GIPHY proxying explicitly and queries only Tenor server-side', async () => {
  const browserOnly = await search(owner, 'giphy');
  expect(browserOnly.statusCode).toBe(409);
  expect(browserOnly.json()).toEqual({
    error: 'GIPHY search must be made directly from your browser.',
  });
  expect(fetcher).not.toHaveBeenCalled();
  const result = await search(owner, 'tenor');
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    provider: 'tenor',
    items: [],
    nextCursor: null,
    omittedCount: 0,
  });
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).not.toContain('fixture-');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
    'tenor.googleapis.com',
  ]);
});

it('rejects blank queries, forged cursors, extra fields and non-JSON bodies without upstream work', async () => {
  for (const payload of [
    { provider: 'tenor', query: ' ' },
    { provider: 'tenor', query: 'hello', cursor: 'giphy:12' },
    { provider: 'tenor', query: 'hello', cursor: 'tenor:12&key=secret' },
    { provider: 'tenor', query: 'hello', url: 'https://evil.invalid' },
    'not JSON',
  ]) {
    const result = await server.app.inject({
      method: 'POST',
      url: '/api/gifs/search',
      headers: headers(),
      payload,
    });
    expect([400, 415]).toContain(result.statusCode);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not expose raw upstream failures, keys, queries, redirects or response headers', async () => {
  fetcher.mockImplementation(async () => {
    throw new Error(
      'fixture-giphy-key and private-query https://api.giphy.com/?key=fixture-giphy-key',
    );
  });
  const failed = await search();
  expect(failed.statusCode).toBe(502);
  expect(failed.json()).toEqual({ error: 'Service temporarily unavailable.' });
  expect(JSON.stringify(failed.headers) + failed.body).not.toMatch(
    /fixture-|private-query|api\.giphy/,
  );
  fetcher.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.invalid/?key=fixture-giphy-key' },
      }),
  );
  const redirect = await search();
  expect(redirect.statusCode).toBe(502);
  expect(redirect.headers.location).toBeUndefined();
  fetcher.mockImplementation(async () => new Response('fixture-giphy-key', { status: 429 }));
  const quota = await search();
  expect(quota.statusCode).toBe(429);
  expect(quota.json()).toEqual({ error: 'GIF provider quota reached. Try again later.' });
});

it('makes missing-provider configuration explicitly unavailable rather than an empty success', async () => {
  delete config.tenorApiKey;
  try {
    const availability = await server.app.inject({
      url: '/api/gifs/providers',
      headers: headers(),
    });
    expect(availability.json().providers[1]).toEqual({
      id: 'tenor',
      label: 'Tenor',
      enabled: false,
    });
    const result = await search(owner, 'tenor');
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: 'Service temporarily unavailable.' });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    config.tenorApiKey = 'fixture-tenor-key';
  }
});

it('omits public provider keys entirely when GIPHY and KLIPY are not configured', async () => {
  delete config.giphyApiKey;
  delete config.klipyApiKey;
  try {
    const result = await server.app.inject({ url: '/api/gifs/providers', headers: headers() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      providers: [
        { id: 'giphy', label: 'GIPHY', enabled: false },
        { id: 'tenor', label: 'Tenor', enabled: true },
        { id: 'klipy', label: 'KLIPY', enabled: false },
      ],
    });
    expect(result.body).not.toContain('fixture-');
    expect((await search(owner, 'giphy')).statusCode).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    config.giphyApiKey = 'fixture-giphy-key';
    config.klipyApiKey = 'fixture-klipy-key';
  }
});

it('preserves the 60/minute search budget and inherited 120/minute availability budget', async () => {
  for (let index = 0; index < 61; index++) {
    const result = await server.app.inject({
      method: 'POST',
      url: '/api/gifs/search',
      remoteAddress: '127.0.0.22',
      headers: headers(),
      payload: { provider: 'tenor', query: 'hello' },
    });
    expect(result.statusCode, result.body).toBe(index < 60 ? 200 : 429);
  }
  expect(fetcher).toHaveBeenCalledTimes(60);
  fetcher.mockClear();
  for (let index = 0; index < 121; index++) {
    const result = await server.app.inject({
      url: '/api/gifs/providers',
      remoteAddress: '127.0.0.23',
      headers: headers(),
    });
    expect(result.statusCode, result.body).toBe(index < 120 ? 200 : 429);
  }
  expect(fetcher).not.toHaveBeenCalled();
});
