import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AuthState } from '@tricord/shared';
import type { FastifyRequest } from 'fastify';
import { createApp } from '../app.js';
import { testDatabase } from '../db/test-database.js';
import { launch, type Browser } from '../voice/browser-harness.js';
import { AuthService } from './service.js';

const origin = 'http://127.0.0.1:3007';
type Mutation = 'logout' | 'self-revoke' | 'password';
let database: Awaited<ReturnType<typeof testDatabase>>;
let server: ReturnType<typeof createApp>;
let service: AuthService;
let ownerToken: string;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
type Gate = {
  url: string;
  entered: boolean;
  request?: FastifyRequest;
  release: ReturnType<typeof deferred>;
  sent: ReturnType<typeof deferred>;
  cookieHeader?: boolean;
};
let gate: Gate | undefined;

beforeAll(async () => {
  database = await testDatabase();
  service = new AuthService(database.database.pool);
  const password = randomUUID() + '-Fixture';
  const owner = await service.bootstrap('cookie_owner', 'Cookie fixture owner', password);
  ownerToken = (
    await service.login({ username: owner.username, password, remember: false }, undefined)
  ).token;
  server = createApp({ databaseUrl: database.url, allowedOrigins: [origin], rateLimits: false });
  server.app.addHook('onSend', async (request, reply, payload) => {
    const current = gate;
    if (current && !current.entered && request.url === current.url && reply.statusCode === 200) {
      current.entered = true;
      current.request = request;
      current.cookieHeader = reply.getHeader('set-cookie') !== undefined;
      await current.release.promise;
    }
    return payload;
  });
  server.app.addHook('onResponse', async (request) => {
    if (gate?.request === request) gate.sent.resolve();
  });
  server.app.get('/fixture', async (_request, reply) =>
    reply
      .header('Content-Security-Policy', "default-src 'none'; connect-src 'self'")
      .header('Permissions-Policy', 'microphone=(), camera=(), display-capture=()')
      .type('text/html')
      .send('<!doctype html><title>Owned cookie fixture</title><body>Cookie fixture'),
  );
  await server.app.listen({ host: '127.0.0.1', port: 3007 });
}, 20_000);

afterAll(async () => {
  gate?.release.resolve();
  try {
    await server?.app.close();
  } finally {
    await database?.cleanup();
  }
});

async function account() {
  const password = randomUUID() + '-Fixture';
  const user = await service.register({
    username: 'cookie_' + randomUUID().replaceAll('-', '').slice(0, 20),
    displayName: 'Cookie fixture',
    password,
  });
  await service.changeStatus(ownerToken, user.id, 'approve');
  return { username: user.username, password };
}
function requestExpression(path: string, method = 'GET', body?: unknown, csrf?: string) {
  return `fetch(${JSON.stringify(path)},${JSON.stringify({
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })}).then(async response=>({status:response.status,data:await response.json()}))`;
}
async function request<T>(
  browser: Browser,
  path: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
) {
  return (await browser.js(requestExpression(path, method, body, csrf))) as {
    status: number;
    data: T;
  };
}
async function login(
  browser: Browser,
  credentials: Awaited<ReturnType<typeof account>>,
  remember = false,
) {
  const result = await request<AuthState>(browser, '/api/auth/login', 'POST', {
    ...credentials,
    remember,
  });
  expect(result.status).toBe(200);
  return result.data;
}
async function cookie(browser: Browser) {
  const result = await browser.call('Network.getCookies', { urls: [origin] });
  return (
    result.cookies as {
      name: string;
      value: string;
      httpOnly: boolean;
      sameSite: string;
      secure: boolean;
      session: boolean;
    }[]
  ).find((entry) => entry.name === 'tricord_session');
}
async function withBrowser(work: (browser: Browser) => Promise<void>) {
  const browser = await launch({ fakeMicrophone: false });
  try {
    await browser.call('Page.navigate', { url: origin + '/fixture' });
    await browser.wait("document.title==='Owned cookie fixture'");
    await work(browser);
  } finally {
    // Logical disposal is not remote completion: release and read our actual delayed response.
    const current = gate;
    current?.release.resolve();
    try {
      await browser.js('window.delayedMutation ?? null');
      if (current?.entered) await current.sent.promise;
    } finally {
      gate = undefined;
      await browser.close();
    }
  }
}

async function mutation(
  browser: Browser,
  kind: Mutation,
  auth: AuthState,
  credentials: Awaited<ReturnType<typeof account>>,
) {
  if (kind === 'logout')
    return {
      path: '/api/auth/logout',
      method: 'POST',
      body: undefined,
      nextCredentials: credentials,
    };
  if (kind === 'password')
    return {
      path: '/api/account/password',
      method: 'POST',
      body: {
        currentPassword: credentials.password,
        newPassword: credentials.password + '-Changed',
      },
      nextCredentials: { ...credentials, password: credentials.password + '-Changed' },
    };
  const sessions = await request<{ sessions: { id: string; current: boolean }[] }>(
    browser,
    '/api/account/sessions',
  );
  expect(sessions.status).toBe(200);
  const current = sessions.data.sessions.find((entry) => entry.current);
  expect(!!current).toBe(true);
  // auth is deliberately the verified response for this exact current browser session.
  expect(auth.user.status).toBe('approved');
  return {
    path: '/api/account/sessions/' + current!.id,
    method: 'DELETE',
    body: undefined,
    nextCredentials: credentials,
  };
}

async function race(kind: Mutation, differentAccount = false) {
  await withBrowser(async (browser) => {
    const credentials = await account();
    const old = await login(browser, credentials);
    const oldCookie = await cookie(browser);
    expect(!!oldCookie?.httpOnly && oldCookie.sameSite === 'Strict').toBe(true);
    expect(await browser.js("document.cookie.includes('tricord_session')")).toBe(false);
    const change = await mutation(browser, kind, old, credentials);
    gate = { url: change.path, entered: false, release: deferred(), sent: deferred() };
    // Observe both outcomes while holding the real response before its headers reach Chromium.
    await browser.js(
      `window.delayedMutation=${requestExpression(change.path, change.method, change.body, old.csrfToken)}.catch(()=>({status:0}));void 0`,
    );
    await vi.waitFor(() => expect(gate?.entered).toBe(true), { timeout: 10_000 });
    const revoked = await server.app.inject({
      url: '/api/auth/me',
      headers: { cookie: 'tricord_session=' + oldCookie!.value },
    });
    expect(revoked.statusCode).toBe(401);
    const replacement = await login(
      browser,
      differentAccount ? await account() : change.nextCredentials,
      true,
    );
    const replacementCookie = await cookie(browser);
    expect(
      !!replacementCookie?.httpOnly &&
        replacementCookie.sameSite === 'Strict' &&
        !replacementCookie.session,
    ).toBe(true);
    expect(replacementCookie?.value !== oldCookie?.value).toBe(true);
    gate.release.resolve();
    const completed = (await browser.js('window.delayedMutation')) as { status: number };
    expect(completed.status).toBe(200);
    await gate.sent.promise;
    expect((await cookie(browser))?.value === replacementCookie?.value).toBe(true);
    const me = await request<AuthState>(browser, '/api/auth/me');
    expect(me.status).toBe(200);
    expect(
      me.data.csrfToken === replacement.csrfToken && me.data.user.id === replacement.user.id,
    ).toBe(true);
    expect(gate.cookieHeader).toBe(false);
    const replay = await server.app.inject({
      url: '/api/members',
      headers: { cookie: 'tricord_session=' + oldCookie!.value },
    });
    expect(replay.statusCode).toBe(401);
  });
}

it.each(['logout', 'self-revoke', 'password'] as const)(
  'a late %s response preserves the same-account replacement native cookie',
  async (kind) => {
    await race(kind);
  },
);
it('a late logout response also preserves a different account in the same native cookie jar', async () => {
  await race('logout', true);
});

it.each([false, true])(
  'normal logout retains only an unusable cookie until replacement (remember=%s)',
  async (remember) => {
    await withBrowser(async (browser) => {
      const credentials = await account();
      const auth = await login(browser, credentials, remember);
      const original = await cookie(browser);
      expect(
        !!original?.httpOnly && original.sameSite === 'Strict' && original.session === !remember,
      ).toBe(true);
      const response = await request(
        browser,
        '/api/auth/logout',
        'POST',
        undefined,
        auth.csrfToken,
      );
      expect(response.status).toBe(200);
      expect((await cookie(browser))?.value === original?.value).toBe(true);
      expect((await request(browser, '/api/auth/me')).status).toBe(401);
      expect((await request(browser, '/api/members')).status).toBe(401);
      const next = await login(browser, credentials, remember);
      expect((await cookie(browser))?.value !== original?.value).toBe(true);
      const me = await request<AuthState>(browser, '/api/auth/me');
      expect(me.status === 200 && me.data.csrfToken === next.csrfToken).toBe(true);
    });
  },
);
