import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { VoiceService, type Lease } from '../voice/service.js';
import type { Identity } from '../auth/service.js';
import { HttpError } from '../auth/validation.js';
import { CaptureAuthorizationService } from './capture-authorization.js';

const services: CaptureAuthorizationService[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose());
  vi.restoreAllMocks();
});
function fixture() {
  let now = 100000;
  const voice = new VoiceService({} as Pool, {
    url: 'http://127.0.0.1:7880',
    key: 'fixture',
    secret: 'fixture',
  });
  const auths = new Map<string, Identity>();
  const authenticate = vi.fn(async (token: string) => {
    const auth = auths.get(token);
    if (!auth) throw new HttpError(401, 'Revoked');
    return auth;
  });
  vi.spyOn(voice, 'authorize').mockImplementation(async (token, id) => {
    const auth = auths.get(token),
      lease = auth && voice.leases.get(auth.user.id);
    if (
      !auth ||
      !lease ||
      lease.id !== id ||
      lease.sessionId !== auth.sessionId ||
      lease.revoked ||
      lease.expires <= now
    )
      throw new HttpError(401, 'Unavailable');
    return lease;
  });
  const service = new CaptureAuthorizationService(voice, () => now, authenticate);
  services.push(service);
  const user = () => {
    const token = randomBytes(32).toString('hex');
    const auth: Identity = {
      user: {
        id: randomUUID(),
        username: 'fixture',
        displayName: 'Fixture',
        status: 'approved',
        isOwner: false,
      },
      sessionId: randomUUID(),
      csrfToken: randomBytes(32).toString('hex'),
      expiresAt: new Date(now + 100000),
      remember: false,
      tokenHash: 'fixture',
    };
    const lease: Lease = {
      id: randomUUID(),
      userId: auth.user.id,
      sessionId: auth.sessionId,
      token,
      channelId: randomUUID(),
      room: 'fixture',
      name: 'Fixture',
      expires: now + 45000,
      revoked: false,
    };
    auths.set(token, auth);
    voice.leases.set(auth.user.id, lease);
    return {
      token,
      auth,
      lease,
      request: { requestId: randomUUID(), sound: 'none' },
      prepare: (request?: unknown) =>
        service.prepare(
          token,
          request ?? { requestId: randomUUID(), sound: 'none' },
          auth.csrfToken,
        ),
      verify: (id: string, consume = false) =>
        service.verify(token, { id }, auth.csrfToken, consume),
    };
  };
  return {
    service,
    voice,
    user,
    auths,
    authenticate,
    time: () => now,
    setTime: (value: number) => {
      now = value;
    },
  };
}
it('clamps to the session and lease, returns no identities/credentials, and replays preserve deadlines', async () => {
  const f = fixture(),
    user = f.user();
  user.auth.expiresAt = new Date(f.time() + 30000);
  const grant = await user.prepare(user.request);
  expect(grant.remainingMs).toBe(30000);
  expect(Object.keys(grant).sort()).toEqual(['id', 'remainingMs']);
  f.setTime(f.time() + 1000);
  user.lease.expires += 10000;
  expect(await user.prepare(user.request)).toEqual({ ...grant, remainingMs: 29000 });
  expect((await user.verify(grant.id)).remainingMs).toBe(29000);
});
it('permits one grant/account and one consume, without accepting an ID as bearer authority', async () => {
  const f = fixture(),
    user = f.user(),
    other = f.user(),
    grant = await user.prepare(user.request);
  await expect(user.prepare()).rejects.toMatchObject({ statusCode: 409 });
  await expect(other.verify(grant.id, true)).rejects.toMatchObject({ statusCode: 403 });
  await expect(user.verify(grant.id, true)).resolves.toEqual(grant);
  await expect(user.verify(grant.id, true)).rejects.toMatchObject({ statusCode: 409 });
  await expect(user.prepare(user.request)).rejects.toMatchObject({ statusCode: 409 });
  expect((await user.verify(grant.id)).id).toBe(grant.id);
});
it.each([
  'revoked',
  'pending',
  'other-session',
  'lease-replaced',
  'channel-replaced',
  'expired',
] as const)('rejects %s after issuance', async (change) => {
  const f = fixture(),
    user = f.user(),
    grant = await user.prepare();
  if (change === 'revoked') f.auths.delete(user.token);
  if (change === 'pending') user.auth.user.status = 'pending';
  if (change === 'other-session') user.auth.sessionId = randomUUID();
  if (change === 'lease-replaced')
    f.voice.leases.set(user.auth.user.id, { ...user.lease, id: randomUUID() });
  if (change === 'channel-replaced') user.lease.channelId = randomUUID();
  if (change === 'expired') f.setTime(f.time() + 45001);
  await expect(user.verify(grant.id, true)).rejects.toBeInstanceOf(HttpError);
});
it('invalidates synchronously on lease removal and cannot revive old requests after heartbeat/cancel', async () => {
  const f = fixture(),
    user = f.user(),
    grant = await user.prepare(user.request);
  await f.service.cancel(user.token, { requestId: user.request.requestId }, user.auth.csrfToken);
  await expect(user.prepare(user.request)).rejects.toMatchObject({ statusCode: 409 });
  const next = await user.prepare();
  await f.service.cancel(user.token, { requestId: user.request.requestId }, user.auth.csrfToken);
  expect((await user.verify(next.id)).id).toBe(next.id);
  f.voice.invalidate(user.lease);
  await expect(user.verify(next.id)).rejects.toBeInstanceOf(HttpError);
  expect(grant.id).not.toBe(next.id);
});
it('does not evict a legitimate account grant for another session or invalid CSRF', async () => {
  const f = fixture(),
    user = f.user(),
    grant = await user.prepare(user.request);
  await expect(
    f.service.cancel(user.token, { requestId: user.request.requestId }, 'wrong'),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    f.service.prepare(user.token, { ...user.request, sound: 'system' }, user.auth.csrfToken),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect((await user.verify(grant.id)).id).toBe(grant.id);
});
it('fails closed on outages and bounds slow authorization work before authentication starts', async () => {
  const f = fixture(),
    user = f.user(),
    grant = await user.prepare();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.authenticate.mockImplementationOnce(async () => {
    await gate;
    return user.auth;
  });
  const first = user.verify(grant.id),
    second = user.verify(grant.id);
  expect(() => user.verify(grant.id)).toThrow(/busy/);
  release();
  await Promise.all([first, second]);
  f.authenticate.mockRejectedValueOnce(new Error('Synthetic database outage'));
  await expect(user.verify(grant.id)).rejects.toThrow('Synthetic database outage');
  await expect(user.verify(grant.id)).rejects.toMatchObject({ statusCode: 403 });
});
it('rejects injected source/lease metadata and disposed use', async () => {
  const f = fixture(),
    user = f.user();
  expect(() => user.prepare({ ...user.request, leaseId: user.lease.id })).toThrow();
  expect(() => user.prepare({ ...user.request, sourceName: 'Synthetic' })).toThrow();
  f.service.dispose();
  expect(() => user.prepare()).toThrow(/unavailable/);
});
it('keeps slow unauthenticated work outside the shared voice queue', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.authenticate.mockImplementationOnce(async () => {
    await gate;
    throw new HttpError(401, 'Synthetic invalid session');
  });
  const pending = f.service
    .prepare(
      randomBytes(32).toString('hex'),
      {
        requestId: randomUUID(),
        sound: 'none',
      },
      'invalid',
    )
    .catch((error: HttpError) => error.statusCode);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let voiceRan = false;
  const voiceWork = f.voice.exclusive(async () => {
    voiceRan = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(voiceRan).toBe(true);
  } finally {
    release();
    expect(await pending).toBe(401);
    await voiceWork;
  }
});
it('does not let invalid or rejected cookies exhaust admission state for a valid session', async () => {
  const f = fixture(),
    user = f.user();
  const authenticate = f.authenticate.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.authenticate.mockImplementation(async (token) => {
    if (!f.auths.has(token)) await gate;
    return authenticate(token);
  });
  const pending: Promise<unknown>[] = [];
  let rejected = 0;
  try {
    for (let i = 0; i < 1024; i++) {
      try {
        pending.push(
          f.service
            .prepare(
              i.toString(16).padStart(64, '0'),
              {
                requestId: randomUUID(),
                sound: 'none',
              },
              'invalid',
            )
            .catch((error: HttpError) => error.statusCode),
        );
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 429 });
        rejected++;
      }
    }
    expect(pending).toHaveLength(20);
    expect(rejected).toBe(1004);
  } finally {
    release();
    await Promise.all(pending);
  }
  await expect(user.prepare()).resolves.toHaveProperty('id');
});
it.each(['revocation', 'approval', 'csrf', 'session', 'lease'] as const)(
  'reauthorizes %s after pre-authentication while waiting for the voice queue',
  async (change) => {
    const f = fixture(),
      user = f.user();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const voiceWork = f.voice.exclusive(() => gate);
    const pending = user.prepare().catch((error: HttpError) => error.statusCode);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.authenticate).toHaveBeenCalledOnce();
      if (change === 'revocation') f.auths.delete(user.token);
      if (change === 'approval') user.auth.user.status = 'pending';
      if (change === 'csrf') user.auth.csrfToken = randomBytes(32).toString('hex');
      if (change === 'session') {
        user.auth.sessionId = randomUUID();
        user.lease.sessionId = user.auth.sessionId;
      }
      if (change === 'lease') f.voice.invalidate(user.lease);
    } finally {
      release();
      await voiceWork;
    }
    expect(await pending).toBeGreaterThanOrEqual(400);
  },
);
it('cannot recreate a grant after another concurrent authentication reports an outage', async () => {
  const f = fixture(),
    user = f.user();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(f.voice.authorize).mockImplementationOnce(async () => {
    started();
    await gate;
    return user.lease;
  });
  const pending = user.prepare(user.request).catch((error: HttpError) => error.statusCode);
  await entered;
  try {
    f.authenticate.mockRejectedValueOnce(new Error('Synthetic concurrent authorization outage'));
    await expect(
      f.service.cancel(
        randomBytes(32).toString('hex'),
        {
          requestId: randomUUID(),
        },
        'invalid',
      ),
    ).rejects.toThrow('Synthetic concurrent authorization outage');
  } finally {
    release();
  }
  expect(await pending).toBe(503);
  await expect(user.prepare(user.request)).resolves.toHaveProperty('id');
});
it('retains the verified account rate limit across different session cookies', async () => {
  const f = fixture(),
    user = f.user();
  for (let i = 0; i < 12; i++) {
    const token = randomBytes(32).toString('hex');
    f.auths.set(token, { ...user.auth, sessionId: randomUUID() });
    await f.service.cancel(token, { requestId: randomUUID() }, user.auth.csrfToken);
  }
  await expect(
    f.service.cancel(user.token, { requestId: randomUUID() }, user.auth.csrfToken),
  ).rejects.toMatchObject({ statusCode: 429 });
  f.setTime(f.time() + 500);
  await expect(
    f.service.cancel(user.token, { requestId: randomUUID() }, user.auth.csrfToken),
  ).resolves.toEqual({ cancelled: true });
});
it('bounds queued authenticated work per account even across cookies', async () => {
  const f = fixture(),
    user = f.user();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const voiceWork = f.voice.exclusive(() => gate);
  const tokens = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
  for (const token of tokens) f.auths.set(token, { ...user.auth, sessionId: randomUUID() });
  const pending = tokens.slice(0, 2).map((token) =>
    f.service.cancel(
      token,
      {
        requestId: randomUUID(),
      },
      user.auth.csrfToken,
    ),
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      f.service.cancel(tokens[2]!, { requestId: randomUUID() }, user.auth.csrfToken),
    ).rejects.toMatchObject({ statusCode: 429 });
  } finally {
    release();
    await Promise.all([voiceWork, ...pending]);
  }
});
it('rejects disposal during pre-authentication before entering the voice queue', async () => {
  const f = fixture(),
    user = f.user();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.authenticate.mockImplementationOnce(async () => {
    await gate;
    return user.auth;
  });
  const exclusive = vi.spyOn(f.voice, 'exclusive');
  const pending = user.prepare().catch((error: HttpError) => error.statusCode);
  f.service.dispose();
  release();
  expect(await pending).toBe(503);
  expect(exclusive).not.toHaveBeenCalled();
});
