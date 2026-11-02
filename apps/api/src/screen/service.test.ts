import { randomBytes, randomUUID } from 'node:crypto';
import type { ScreenSelectRequest } from '@tricord/shared';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceService, type Lease } from '../voice/service.js';
import { HttpError } from '../auth/validation.js';
import { ScreenService, type ScreenCaller } from './service.js';
import { screenSdp, screenIce } from './signaling-fixture.js';
import { selectionFixture } from './selection-fixture.js';

const active: ScreenService[] = [];

async function signalingFixture() {
  const f = fixture(),
    publisher = f.user(),
    viewer = f.user();
  const p = await f.bind(publisher),
    v = await f.bind(viewer);
  const share = await f.publish(publisher.caller, p.epoch);
  const grant = (await f.screen.select(viewer.caller, selection(v.epoch, share.id)))!;
  const offer = {
    epoch: p.epoch,
    linkId: grant.link.id,
    revision: 1,
    sequence: 1,
    payload: { type: 'offer' as const, sdp: screenSdp('offer') },
  };
  const answer = {
    ...offer,
    epoch: v.epoch,
    payload: { type: 'answer' as const, sdp: screenSdp('answer') },
  };
  const candidate = {
    ...offer,
    sequence: 2,
    payload: { type: 'ice' as const, candidate: screenIce },
  };
  return { ...f, publisher, viewer, p, v, share, grant, offer, answer, candidate };
}
describe('authorized signaling and private delivery fences', () => {
  it('delivers private lifecycle replies before releasing the lease-sensitive commit', async () => {
    const f = await signalingFixture(),
      started = deferred(),
      gate = deferred(),
      order: string[] = [];
    let blocked = false;
    f.setHook(async () => {
      if (!blocked) {
        blocked = true;
        started.resolve();
        await gate.promise;
      }
    });
    const pending = f.screen.renew(
      f.viewer.caller,
      { epoch: f.v.epoch, requestId: randomUUID(), revision: 1 },
      () => {
        order.push('reply');
      },
    );
    await started.promise;
    const invalidating = f.voice.exclusive(async () => {
      order.push('invalidate');
      f.voice.invalidate(f.publisher.lease);
    });
    gate.resolve();
    await pending;
    await invalidating;
    expect(order).toEqual(['reply', 'invalidate']);
  });
  it('delivers only to the opposite current transport and rejects replay, wrong roles and pending offers', async () => {
    const f = await signalingFixture(),
      deliver = vi.fn(() => true);
    await expect(
      f.screen.relay(f.viewer.caller, { ...f.offer, epoch: f.v.epoch }, deliver),
    ).rejects.toMatchObject({ code: 'stale' });
    await f.screen.relay(f.publisher.caller, f.offer, deliver);
    expect(deliver).toHaveBeenLastCalledWith(
      { transportId: f.viewer.caller.transportId, epoch: f.v.epoch },
      { ...f.offer, epoch: f.v.epoch },
    );
    await expect(f.screen.relay(f.publisher.caller, f.offer, deliver)).rejects.toMatchObject({
      code: 'stale',
    });
    await expect(
      f.screen.relay(f.publisher.caller, { ...f.offer, revision: 2, sequence: 2 }, deliver),
    ).rejects.toMatchObject({ code: 'stale' });
    await f.screen.relay(f.viewer.caller, f.answer, deliver);
    await f.screen.relay(f.publisher.caller, f.candidate, deliver);
    await f.screen.relay(f.publisher.caller, { ...f.offer, revision: 2, sequence: 3 }, deliver);
    await expect(
      f.screen.relay(f.publisher.caller, { ...f.candidate, sequence: 4 }, deliver),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(deliver).toHaveBeenCalledTimes(4);
  });
  it('bounds early and total ICE; checks mid, ufrag and negotiation timeout', async () => {
    const f = await signalingFixture(),
      deliver = vi.fn(() => true);
    await f.screen.relay(f.publisher.caller, f.offer, deliver);
    await expect(
      f.screen.relay(
        f.publisher.caller,
        { ...f.candidate, payload: { type: 'ice', candidate: { ...screenIce, sdpMid: '1' } } },
        deliver,
      ),
    ).rejects.toMatchObject({ code: 'stale' });
    for (let i = 2; i <= 33; i++)
      await f.screen.relay(f.publisher.caller, { ...f.candidate, sequence: i }, deliver);
    await expect(
      f.screen.relay(f.publisher.caller, { ...f.candidate, sequence: 34 }, deliver),
    ).rejects.toMatchObject({ code: 'stale' });
    f.setTime(f.time() + 10001);
    await expect(f.screen.relay(f.viewer.caller, f.answer, deliver)).rejects.toMatchObject({
      code: 'stale',
    });
    await f.screen.relay(f.publisher.caller, { ...f.offer, revision: 2, sequence: 34 }, deliver);
    await f.screen.relay(f.viewer.caller, { ...f.answer, revision: 2 }, deliver);
    for (let i = 35; i < 163; i++)
      await f.screen.relay(
        f.publisher.caller,
        { ...f.candidate, revision: 2, sequence: i },
        deliver,
      );
    await expect(
      f.screen.relay(f.publisher.caller, { ...f.candidate, revision: 2, sequence: 163 }, deliver),
    ).rejects.toMatchObject({ code: 'stale' });
  });
  it.each(['publisher', 'viewer'] as const)(
    'reauthorizes the %s for every relay and snapshot, with no cached grant',
    async (role) => {
      const f = await signalingFixture(),
        deliver = vi.fn(() => true);
      await f.screen.authorizeLink(f.publisher.caller, {
        epoch: f.p.epoch,
        linkId: f.grant.link.id,
      });
      f[role].auth.revoked = true;
      await expect(f.screen.relay(f.publisher.caller, f.offer, deliver)).rejects.toMatchObject({
        code: 'not_authorized',
      });
      expect(deliver).not.toHaveBeenCalled();
      const fresh = await signalingFixture();
      fresh[role].auth.revoked = true;
      await expect(
        fresh.screen.snapshot(fresh.viewer.caller, { epoch: fresh.v.epoch }, deliver),
      ).rejects.toBeDefined();
    },
  );
  it('does not deliver to cross-channel references or expired grants', async () => {
    const f = await signalingFixture(),
      outsider = f.user(randomUUID()),
      b = await f.bind(outsider),
      deliver = vi.fn(() => true);
    const snapshot = await f.screen.snapshot(outsider.caller, { epoch: b.epoch }, deliver);
    expect(snapshot.shares).toEqual([]);
    deliver.mockClear();
    await expect(
      f.screen.relay(outsider.caller, { ...f.offer, epoch: b.epoch }, deliver),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    f.setTime(f.time() + 45001);
    await expect(f.screen.relay(f.publisher.caller, f.offer, deliver)).rejects.toBeDefined();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('fences disconnect and rebind during pending authorization; late cleanup cannot affect the replacement', async () => {
    const f = await signalingFixture(),
      started = deferred(),
      gate = deferred(),
      deliver = vi.fn(() => true);
    f.setHook(async (token) => {
      if (token === f.viewer.caller.token) {
        started.resolve();
        await gate.promise;
      }
    });
    const pending = f.screen.relay(f.publisher.caller, f.offer, deliver);
    await started.promise;
    f.viewer.connected = false;
    f.screen.disconnect(f.viewer.caller.transportId, f.v.epoch);
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'stale' });
    f.setHook();
    f.viewer.connected = true;
    const next = await f.bind(f.viewer);
    f.screen.disconnect(f.viewer.caller.transportId, f.v.epoch);
    expect((await f.screen.snapshot(f.viewer.caller, { epoch: next.epoch }, () => {})).epoch).toBe(
      next.epoch,
    );
    expect(deliver).not.toHaveBeenCalled();
  });
  it('rechecks every snapshot endpoint after asynchronous work, not only the last peer', async () => {
    const f = await signalingFixture(),
      third = f.user(),
      b = await f.bind(third),
      deliver = vi.fn();
    await f.publish(third.caller, b.epoch);
    f.setHook(async (token) => {
      if (token === third.caller.token) f.voice.invalidate(f.publisher.lease);
    });
    await expect(
      f.screen.snapshot(f.viewer.caller, { epoch: f.v.epoch }, deliver),
    ).rejects.toBeDefined();
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not consume negotiation state if the exact destination has disappeared', async () => {
    const f = await signalingFixture();
    await expect(f.screen.relay(f.publisher.caller, f.offer, () => false)).rejects.toMatchObject({
      code: 'stale',
    });
    await expect(f.screen.relay(f.publisher.caller, f.offer, () => true)).resolves.toEqual({
      delivered: true,
    });
  });
});
afterEach(() => {
  for (const service of active.splice(0)) service.dispose();
  vi.restoreAllMocks();
});
function fixture() {
  let now = 100000;
  const channel = randomUUID();
  const voice = new VoiceService({} as Pool, {
    url: 'http://127.0.0.1:7880',
    key: 'test',
    secret: 'screen-test-secret',
  });
  const identities = new Map<
    string,
    { userId: string; sessionId: string; approved: boolean; revoked: boolean }
  >();
  let hook: ((token: string) => Promise<void>) | undefined;
  vi.spyOn(voice, 'authorize').mockImplementation(async (token, credential) => {
    await hook?.(token);
    const auth = identities.get(token);
    if (!auth || auth.revoked) throw new HttpError(401, 'Revoked');
    if (!auth.approved) throw new HttpError(403, 'Pending');
    const lease = voice.leases.get(auth.userId);
    if (
      !lease ||
      lease.id !== credential ||
      lease.sessionId !== auth.sessionId ||
      lease.revoked ||
      lease.expires <= now
    )
      throw new HttpError(401, 'Lease ended');
    return lease;
  });
  const screen = new ScreenService(voice, () => now);
  active.push(screen);
  const user = (channelId = channel) => {
    const lease: Lease = {
      id: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      token: randomBytes(32).toString('hex'),
      name: 'Fixture',
      channelId,
      room: 'fixture',
      expires: now + 45000,
      revoked: false,
    };
    voice.leases.set(lease.userId, lease);
    const auth = {
      userId: lease.userId,
      sessionId: lease.sessionId,
      approved: true,
      revoked: false,
    };
    identities.set(lease.token, auth);
    const person = { lease, auth, connected: true, caller: undefined as unknown as ScreenCaller };
    person.caller = {
      token: lease.token,
      transportId: randomUUID(),
      isConnected: () => person.connected,
    };
    return person;
  };
  const bind = async (person: ReturnType<typeof user>) =>
    screen.bind(person.caller, { version: 1, leaseId: person.lease.id, requestId: randomUUID() });
  const publish = (caller: ScreenCaller, epoch: string, sourceGeneration = 1) =>
    screen.publish(caller, {
      epoch,
      requestId: randomUUID(),
      sourceGeneration,
      profile: 'smooth',
      videoBitrate: 8000000,
      sound: 'tab',
    });
  return {
    voice,
    screen,
    user,
    bind,
    publish,
    setTime: (time: number) => {
      now = time;
    },
    time: () => now,
    setHook: (value?: typeof hook) => {
      hook = value;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const selection = (
  epoch: string,
  shareId: string | null,
  revision = 1,
  videoBitrate: number | null = 8000000,
) => ({ epoch, shareId, revision, requestId: randomUUID(), profile: 'smooth', videoBitrate });
async function linked(f: ReturnType<typeof fixture>) {
  const publisher = f.user(),
    viewer = f.user();
  const p = await f.bind(publisher),
    v = await f.bind(viewer);
  const share = await f.publish(publisher.caller, p.epoch);
  const link = (await f.screen.select(viewer.caller, selection(v.epoch, share.id)))!;
  return { publisher, viewer, p, v, share, link };
}

async function orderedSelections() {
  const f = fixture(),
    publisher = f.user(),
    second = f.user(),
    viewer = f.user();
  const p = await f.bind(publisher),
    q = await f.bind(second),
    v = await f.bind(viewer);
  const share = await f.publish(publisher.caller, p.epoch),
    other = await f.publish(second.caller, q.epoch),
    caller = Object.freeze({ ...viewer.caller }),
    delivered = vi.fn(),
    gate = deferred();
  let holdCleanup = false;
  const send = vi.fn(async (request: Readonly<ScreenSelectRequest>) => {
    if (holdCleanup && request.shareId === null) await gate.promise;
    return f.screen.select(caller, request, delivered);
  });
  const plan = selectionFixture(v.epoch, send),
    a = plan.select(share.id),
    first = (await a.operation.run())!;
  delivered.mockClear();
  send.mockClear();
  return {
    ...f,
    publisher,
    second,
    viewer,
    v,
    share,
    other,
    caller,
    plan,
    a,
    first,
    delivered,
    send,
    hold: () => {
      holdCleanup = true;
    },
    release: gate.resolve,
  };
}

describe('conditional selection cleanup revision contract', () => {
  it.each(['cleanup-first', 'replacement-first'] as const)(
    'preserves B when reserved A cleanup arrives %s, including repeated old work',
    async (order) => {
      const f = await orderedSelections(),
        cleanup = f.a.reserveCleanup()!;
      expect(cleanup.request).toMatchObject({ revision: 2, shareId: null, epoch: f.v.epoch });
      expect(f.a.reserveCleanup()).toBe(cleanup);
      expect(Object.isFrozen(cleanup.request)).toBe(true);
      expect(f.send).not.toHaveBeenCalled();
      expect(
        await f.screen.authorizeLink(f.caller, { epoch: f.v.epoch, linkId: f.first.link.id }),
      ).toMatchObject({ link: f.first.link });
      f.hold();
      const pending = cleanup.run().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      try {
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(f.delivered).not.toHaveBeenCalled();
        if (order === 'cleanup-first') {
          f.release();
          expect(await pending).toEqual({ ok: true, value: null });
          expect(await cleanup.run()).toBeNull();
          expect(f.delivered).toHaveBeenCalledTimes(2);
        }
        const b = f.plan.select(f.other.id),
          next = (await b.operation.run())!;
        expect(b.operation.request.revision).toBe(3);
        const replies = f.delivered.mock.calls.length;
        f.release();
        if (order === 'replacement-first')
          expect(await pending).toMatchObject({ ok: false, error: { code: 'stale' } });
        expect(f.a.reserveCleanup()).toBeNull();
        await expect(cleanup.run()).rejects.toMatchObject({ code: 'stale' });
        expect(f.delivered).toHaveBeenCalledTimes(replies);
        expect(b.reserveCleanup()!.request.revision).toBe(4);
        expect(
          await f.screen.authorizeLink(f.caller, { epoch: f.v.epoch, linkId: next.link.id }),
        ).toMatchObject({ link: next.link });
        await expect(
          f.screen.authorizeLink(f.caller, { epoch: f.v.epoch, linkId: f.first.link.id }),
        ).rejects.toMatchObject({ code: 'not_authorized' });
      } finally {
        f.release();
        await pending;
      }
    },
  );
  it('reserves old cleanup before an implicit replacement and suppresses obsolete callbacks', async () => {
    const f = await orderedSelections(),
      b = f.plan.select(f.other.id);
    expect(b.operation.request.revision).toBe(3);
    const next = (await b.operation.run())!;
    for (let i = 0; i < 10; i++) expect(f.a.reserveCleanup()).toBeNull();
    expect(f.send).toHaveBeenCalledOnce();
    expect(b.reserveCleanup()!.request.revision).toBe(4);
    expect(
      await f.screen.authorizeLink(f.caller, { epoch: f.v.epoch, linkId: next.link.id }),
    ).toMatchObject({ link: next.link });
  });
  it('shows that a newer null selection is not a conditional old-link delete', async () => {
    const f = await orderedSelections(),
      b = f.plan.select(f.other.id),
      next = (await b.operation.run())!;
    expect(await f.screen.select(f.caller, selection(f.v.epoch, null, 4))).toBeNull();
    await expect(
      f.screen.authorizeLink(f.caller, { epoch: f.v.epoch, linkId: next.link.id }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
  });
  it('pins reserved credentials and request identity rather than reading a replacement caller', async () => {
    const f = await orderedSelections(),
      cleanup = f.a.reserveCleanup()!,
      stranger = f.user();
    f.viewer.caller.token = stranger.caller.token;
    expect(await cleanup.run()).toBeNull();
    expect(await cleanup.run()).toBeNull();
    expect(f.send.mock.calls[0]![0]).toBe(cleanup.request);
    expect(f.send.mock.calls[1]![0]).toBe(cleanup.request);
    expect(f.delivered).toHaveBeenCalledTimes(2);
  });
  it.each(['epoch', 'lease'] as const)(
    'cannot remove a replacement binding after %s replacement',
    async (kind) => {
      const f = await orderedSelections(),
        cleanup = f.a.reserveCleanup()!;
      if (kind === 'epoch') f.screen.disconnect(f.caller.transportId, f.v.epoch);
      else {
        f.voice.invalidate(f.viewer.lease);
        f.viewer.lease = { ...f.viewer.lease, id: randomUUID(), revoked: false };
        f.voice.leases.set(f.viewer.lease.userId, f.viewer.lease);
      }
      const binding = await f.bind(f.viewer),
        replacement = selectionFixture(binding.epoch, (request) =>
          f.screen.select(f.viewer.caller, request),
        ),
        b = replacement.select(f.other.id),
        next = (await b.operation.run())!;
      expect(binding.epoch).not.toBe(f.v.epoch);
      expect(b.operation.request.revision).toBe(1);
      await expect(cleanup.run()).rejects.toMatchObject({ code: 'stale' });
      expect(
        await f.screen.authorizeLink(f.viewer.caller, {
          epoch: binding.epoch,
          linkId: next.link.id,
        }),
      ).toMatchObject({ link: next.link });
    },
  );
  it.each(['session', 'approval', 'lease', 'expiry'] as const)(
    'freshly rejects even an acknowledged cleanup replay after %s loss',
    async (loss) => {
      const f = await orderedSelections(),
        cleanup = f.a.reserveCleanup()!;
      expect(await cleanup.run()).toBeNull();
      f.delivered.mockClear();
      if (loss === 'session') f.viewer.auth.revoked = true;
      else if (loss === 'approval') f.viewer.auth.approved = false;
      else if (loss === 'lease') f.voice.invalidate(f.viewer.lease);
      else f.setTime(f.time() + 45001);
      await expect(cleanup.run()).rejects.toMatchObject({
        code: loss === 'session' || loss === 'approval' ? 'not_authorized' : 'stale',
      });
      expect(f.delivered).not.toHaveBeenCalled();
    },
  );
  it('rechecks revocation after cleanup authorization was held', async () => {
    const f = await orderedSelections(),
      cleanup = f.a.reserveCleanup()!,
      started = deferred(),
      gate = deferred();
    f.setHook(async (token) => {
      if (token === f.caller.token) {
        started.resolve();
        await gate.promise;
      }
    });
    const pending = cleanup.run();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'not_authorized' });
    try {
      await started.promise;
      f.viewer.auth.revoked = true;
      gate.resolve();
      await rejected;
      expect(f.delivered).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await rejected;
      f.setHook();
    }
  });
});

describe('ephemeral screen authorization', () => {
  it('cannot authorize beyond either current lease or extend an existing grant just because voice renewed', async () => {
    const f = fixture(),
      peers = await linked(f);
    peers.publisher.lease.expires = f.time() + 10000;
    const request = { epoch: peers.v.epoch, linkId: peers.link.link.id };
    expect((await f.screen.authorizeLink(peers.viewer.caller, request)).remainingMs).toBe(10000);
    peers.publisher.lease.expires += 45000;
    expect((await f.screen.authorizeLink(peers.viewer.caller, request)).remainingMs).toBe(10000);
  });
  it('caps a viewer bitrate at the publisher ceiling and rejects a higher profile without replacing the live selection', async () => {
    const f = fixture(),
      peers = await linked(f);
    const request = selection(peers.v.epoch, peers.share.id, 2, 20000000);
    const capped = (await f.screen.select(peers.viewer.caller, request))!;
    expect(capped.link.quality.videoBitrate).toBe(20000000);
    expect(capped.link.videoBitrate).toBe(8000000);
    await expect(
      f.screen.select(peers.viewer.caller, {
        ...selection(peers.v.epoch, peers.share.id, 3),
        profile: 'ultra',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(
      (
        await f.screen.authorizeLink(peers.viewer.caller, {
          epoch: peers.v.epoch,
          linkId: capped.link.id,
        })
      ).link.id,
    ).toBe(capped.link.id);
  });

  it('keeps nine selected viewers independent and removes only the viewer that closes', async () => {
    const f = fixture(),
      publisher = f.user(),
      p = await f.bind(publisher),
      share = await f.publish(publisher.caller, p.epoch);
    const viewers = Array.from({ length: 9 }, () => f.user());
    const bindings = await Promise.all(viewers.map((viewer) => f.bind(viewer)));
    await Promise.all(
      viewers.map((viewer, index) =>
        f.screen.select(viewer.caller, selection(bindings[index]!.epoch, share.id)),
      ),
    );
    const renew = (revision: number) =>
      f.screen.renew(publisher.caller, { epoch: p.epoch, requestId: randomUUID(), revision });
    expect((await renew(1)).links).toHaveLength(9);
    await f.screen.select(viewers[0]!.caller, selection(bindings[0]!.epoch, null, 2));
    expect((await renew(2)).links).toHaveLength(8);
  });

  it('binds one transport per account and retries without replacing its epoch', async () => {
    const f = fixture(),
      person = f.user(),
      first = await f.bind(person);
    expect(await f.bind(person)).toEqual(first);
    await expect(
      f.screen.bind(
        { ...person.caller, transportId: randomUUID() },
        { version: 1, leaseId: person.lease.id, requestId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'capacity' });
    expect(() =>
      f.screen.bind(person.caller, {
        version: 2,
        leaseId: person.lease.id,
        requestId: randomUUID(),
      }),
    ).toThrow('protocol');
  });

  it('enforces one source, publish replay, source generations and stale Stop fencing', async () => {
    const f = fixture(),
      person = f.user(),
      b = await f.bind(person);
    const request = {
      epoch: b.epoch,
      requestId: randomUUID(),
      sourceGeneration: 1,
      profile: 'smooth',
      videoBitrate: 8000000,
      sound: 'tab',
    };
    const first = await f.screen.publish(person.caller, request);
    expect(await f.screen.publish(person.caller, request)).toEqual(first);
    await expect(f.publish(person.caller, b.epoch, 2)).rejects.toMatchObject({ code: 'capacity' });
    await f.screen.stop(person.caller, { epoch: b.epoch, shareId: first.id });
    const second = await f.publish(person.caller, b.epoch, 2);
    await expect(
      f.screen.stop(person.caller, { epoch: b.epoch, shareId: first.id }),
    ).rejects.toMatchObject({ code: 'stale' });
    await expect(f.screen.publish(person.caller, request)).rejects.toMatchObject({ code: 'stale' });
    expect(second.id).not.toBe(first.id);
    await expect(
      f.screen.publish(person.caller, { ...request, sourceGeneration: 3 }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('atomically switches a viewer and cannot revive an earlier selection', async () => {
    const f = fixture(),
      { publisher, viewer, v, share, link } = await linked(f);
    const second = f.user(),
      secondBinding = await f.bind(second),
      secondShare = await f.publish(second.caller, secondBinding.epoch);
    const request = selection(v.epoch, secondShare.id, 2);
    const next = await f.screen.select(viewer.caller, request);
    expect(await f.screen.select(viewer.caller, request)).toEqual(next);
    await expect(
      f.screen.authorizeLink(publisher.caller, {
        epoch: (await f.bind(publisher)).epoch,
        linkId: link.link.id,
      }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(
      f.screen.select(viewer.caller, selection(v.epoch, share.id, 1)),
    ).rejects.toMatchObject({ code: 'stale' });
    await f.screen.select(viewer.caller, selection(v.epoch, null, 3));
    await expect(
      f.screen.authorizeLink(second.caller, { epoch: secondBinding.epoch, linkId: next!.link.id }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('keeps publisher/viewer quality independent and copies returned DTOs', async () => {
    const f = fixture(),
      { publisher, p, share } = await linked(f);
    const other = f.user(),
      binding = await f.bind(other);
    const low = (await f.screen.select(other.caller, {
      ...selection(binding.epoch, share.id, 1, 2000000),
      profile: 'low',
    }))!;
    expect(low.link.videoBitrate).toBe(2000000);
    low.link.quality.profile = 'ultra';
    expect(
      (await f.screen.authorizeLink(publisher.caller, { epoch: p.epoch, linkId: low.link.id })).link
        .quality.profile,
    ).toBe('low');
    const own = await f.publish(other.caller, binding.epoch);
    expect(own.publisherId).toBe(other.lease.userId);
    await expect(
      f.screen.select(other.caller, selection(binding.epoch, own.id, 2)),
    ).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('denies guessed, cross-channel and non-endpoint links', async () => {
    const f = fixture(),
      { publisher, p, viewer, v, share, link } = await linked(f);
    const stranger = f.user(randomUUID()),
      b = await f.bind(stranger);
    await expect(
      f.screen.select(stranger.caller, selection(b.epoch, share.id)),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.screen.select(stranger.caller, selection(b.epoch, randomUUID())),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.screen.authorizeLink(stranger.caller, { epoch: b.epoch, linkId: link.link.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    viewer.lease.channelId = randomUUID();
    await expect(
      f.screen.authorizeLink(publisher.caller, { epoch: p.epoch, linkId: link.link.id }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(
      f.screen.authorizeLink(viewer.caller, { epoch: v.epoch, linkId: link.link.id }),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it.each(['publisher', 'viewer'] as const)(
    'rechecks %s status/session rather than trusting cached bindings',
    async (role) => {
      const f = fixture(),
        peers = await linked(f);
      peers[role].auth.revoked = true;
      const other = role === 'publisher' ? peers.viewer : peers.publisher;
      const epoch = role === 'publisher' ? peers.v.epoch : peers.p.epoch;
      await expect(
        f.screen.authorizeLink(other.caller, { epoch, linkId: peers.link.link.id }),
      ).rejects.toMatchObject({ code: 'not_authorized' });
      peers[role].auth.revoked = false;
      await expect(
        f.screen.authorizeLink(other.caller, { epoch, linkId: peers.link.link.id }),
      ).rejects.toMatchObject({ code: 'not_authorized' });
    },
  );

  it('denies pending accounts and a different session of the same account', async () => {
    const f = fixture(),
      person = f.user();
    person.auth.approved = false;
    await expect(f.bind(person)).rejects.toMatchObject({ statusCode: 403 });
    person.auth.approved = true;
    person.auth.sessionId = randomUUID();
    await expect(f.bind(person)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('bounds renewals by both leases, never renews voice, and cannot rebase a replay', async () => {
    const f = fixture(),
      peers = await linked(f);
    peers.publisher.lease.expires = f.time() + 30000;
    const request = { epoch: peers.v.epoch, requestId: randomUUID(), revision: 1 };
    const renewal = await f.screen.renew(peers.viewer.caller, request);
    expect(renewal.links[0]!.remainingMs).toBe(30000);
    expect(peers.publisher.lease.expires).toBe(130000);
    expect(peers.viewer.lease.expires).toBe(145000);
    f.setTime(f.time() + 1000);
    peers.publisher.lease.expires += 10000;
    peers.viewer.lease.expires += 10000;
    expect((await f.screen.renew(peers.viewer.caller, request)).links[0]!.remainingMs).toBe(29000);
    expect(
      (
        await f.screen.renew(peers.viewer.caller, {
          ...request,
          requestId: randomUUID(),
          revision: 2,
        })
      ).links[0]!.remainingMs,
    ).toBe(39000);
    await expect(f.screen.renew(peers.viewer.caller, request)).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it('does not revive an expired link even when its voice leases were extended', async () => {
    const f = fixture(),
      peers = await linked(f);
    peers.publisher.lease.expires += 45000;
    peers.viewer.lease.expires += 45000;
    f.setTime(145000);
    await expect(
      f.screen.authorizeLink(peers.viewer.caller, {
        epoch: peers.v.epoch,
        linkId: peers.link.link.id,
      }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    const next = await f.screen.select(
      peers.viewer.caller,
      selection(peers.v.epoch, peers.share.id, 2),
    );
    expect(next!.link.id).not.toBe(peers.link.link.id);
    f.setTime(190000);
    await expect(f.bind(peers.publisher)).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('fences a disconnected initial bind and stale disconnect/revocation completions', async () => {
    const f = fixture(),
      person = f.user(),
      started = deferred(),
      release = deferred();
    f.setHook(async () => {
      started.resolve();
      await release.promise;
    });
    const pending = f.bind(person);
    await started.promise;
    person.connected = false;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'stale' });
    f.setHook();
    person.connected = true;
    const old = await f.bind(person);
    f.screen.disconnect(person.caller.transportId, old.epoch);
    const next = await f.bind(person);
    f.screen.disconnect(person.caller.transportId, old.epoch);
    expect((await f.bind(person)).epoch).toBe(next.epoch);
    const oldLease = person.lease;
    const replacement = { ...oldLease, id: randomUUID(), revoked: false };
    person.lease = replacement;
    f.voice.leases.set(replacement.userId, replacement);
    const current = await f.bind(person);
    f.voice.invalidate(oldLease);
    expect((await f.bind(person)).epoch).toBe(current.epoch);
  });

  it('rejects a selection completed after its transport disconnected', async () => {
    const f = fixture(),
      peers = await linked(f),
      started = deferred(),
      release = deferred();
    f.setHook(async (token) => {
      if (token === peers.publisher.lease.token) {
        started.resolve();
        await release.promise;
      }
    });
    const pending = f.screen.select(
      peers.viewer.caller,
      selection(peers.v.epoch, peers.share.id, 2),
    );
    await started.promise;
    f.screen.disconnect(peers.viewer.caller.transportId, peers.v.epoch);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'stale' });
  });

  it('rechecks all links after asynchronous fan-out renewal authorization', async () => {
    const f = fixture(),
      peers = await linked(f),
      other = f.user(),
      b = await f.bind(other);
    const second = (await f.screen.select(other.caller, selection(b.epoch, peers.share.id)))!;
    f.setTime(f.time() + 1000);
    for (const lease of f.voice.leases.values()) lease.expires += 10000;
    const started = deferred(),
      release = deferred();
    f.setHook(async (token) => {
      if (token === other.lease.token) {
        started.resolve();
        await release.promise;
      }
    });
    const pending = f.screen.renew(peers.publisher.caller, {
      epoch: peers.p.epoch,
      requestId: randomUUID(),
      revision: 1,
    });
    await started.promise;
    f.voice.invalidate(peers.viewer.lease);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'stale' });
    f.setHook();
    expect(
      (await f.screen.authorizeLink(other.caller, { epoch: b.epoch, linkId: second.link.id }))
        .remainingMs,
    ).toBe(44000);
  });

  it('removes grants synchronously before failed LiveKit removal and notifies only once', async () => {
    const f = fixture(),
      peers = await linked(f),
      release = deferred();
    const notices = vi.fn(),
      closed = vi.fn();
    f.voice.onLeaseInvalidated(notices);
    peers.publisher.lease.close = closed;
    vi.spyOn(f.voice.media, 'removeParticipant').mockImplementation(async () => {
      await release.promise;
      throw new Error('Media unavailable');
    });
    const removing = f.voice.remove(peers.publisher.lease);
    expect(notices).toHaveBeenCalledWith({
      id: peers.publisher.lease.id,
      userId: peers.publisher.lease.userId,
    });
    expect(closed).toHaveBeenCalledOnce();
    await expect(
      f.screen.authorizeLink(peers.viewer.caller, {
        epoch: peers.v.epoch,
        linkId: peers.link.link.id,
      }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
    release.resolve();
    await expect(removing).rejects.toThrow('Media unavailable');
    f.voice.invalidateAll();
    expect(
      notices.mock.calls.filter(([notice]) => notice.id === peers.publisher.lease.id),
    ).toHaveLength(1);
  });

  it('fails closed on authorization outages without revoking microphone leases itself', async () => {
    const f = fixture(),
      peers = await linked(f);
    f.setHook(async () => {
      throw new Error('Database unavailable');
    });
    await expect(
      f.screen.renew(peers.viewer.caller, {
        epoch: peers.v.epoch,
        requestId: randomUUID(),
        revision: 1,
      }),
    ).rejects.toThrow('Database unavailable');
    f.setHook();
    expect(peers.publisher.lease.revoked).toBe(false);
    expect((await f.bind(peers.publisher)).epoch).not.toBe(peers.p.epoch);
    await expect(
      f.screen.authorizeLink(peers.viewer.caller, {
        epoch: peers.v.epoch,
        linkId: peers.link.link.id,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
  });

  it('supports ten independent sharers each watching one other share', async () => {
    const f = fixture(),
      people = Array.from({ length: 10 }, () => f.user());
    const bindings = await Promise.all(people.map((person) => f.bind(person)));
    const shares = await Promise.all(
      people.map((person, index) => f.publish(person.caller, bindings[index]!.epoch)),
    );
    const links = await Promise.all(
      people.map((person, index) =>
        f.screen.select(
          person.caller,
          selection(bindings[index]!.epoch, shares[(index + 1) % 10]!.id),
        ),
      ),
    );
    expect(new Set(links.map((link) => link!.link.id)).size).toBe(10);
    for (const [index, person] of people.entries())
      expect(
        (
          await f.screen.renew(person.caller, {
            epoch: bindings[index]!.epoch,
            requestId: randomUUID(),
            revision: 1,
          })
        ).links,
      ).toHaveLength(2);
  });

  it('rejects unsupported fields and invalid bitrate/generation values', async () => {
    const f = fixture(),
      person = f.user(),
      b = await f.bind(person);
    const request = {
      epoch: b.epoch,
      requestId: randomUUID(),
      sourceGeneration: 1,
      profile: 'smooth',
      videoBitrate: 8000000,
      sound: 'none',
    };
    for (const extra of [
      { sourceName: 'private' },
      { sourceGeneration: -1 },
      { videoBitrate: 1 },
      { sound: 'microphone' },
    ])
      expect(() => f.screen.publish(person.caller, { ...request, ...extra })).toThrow();
    f.screen.dispose();
    await expect(f.bind(person)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
