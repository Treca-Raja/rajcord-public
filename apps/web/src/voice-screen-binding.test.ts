import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceController } from './voice-controller';
import { ScreenBindingOwner, type ScreenBindingDependency } from './screen-binding';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
const channel = '1e2dc786-e797-45d4-a832-f9f7c65f8785';
const leaseId = '4ee805dc-a248-4791-b1df-c4f8fc4acd7a';
const epoch = 'db749c62-b5cb-4d54-9a12-7dbbed39c8c9';
const reply = () => ({ epoch, channelId: channel, remainingMs: 45000 });
const lease = { id: leaseId, channelId: channel, credential: 'private-credential' };
const rooms: {
  connected: ReturnType<typeof deferred<void>>;
  disconnected: ReturnType<typeof deferred<void>>;
}[] = [];
vi.mock('livekit-client', () => ({
  Room: class {
    connected = deferred<void>();
    disconnected = deferred<void>();
    remoteParticipants = new Map();
    localParticipant = {};
    constructor() {
      rooms.push(this);
    }
    on() {
      return this;
    }
    connect() {
      return this.connected.promise;
    }
    disconnect() {
      return this.disconnected.promise;
    }
    removeAllListeners() {}
  },
  RoomEvent: Object.fromEntries(
    [
      'ParticipantConnected',
      'ParticipantDisconnected',
      'LocalTrackPublished',
      'LocalTrackUnpublished',
      'TrackMuted',
      'TrackUnmuted',
      'ActiveSpeakersChanged',
      'TrackSubscribed',
      'TrackUnsubscribed',
      'Reconnecting',
      'Reconnected',
      'Disconnected',
    ].map((name) => [name, name]),
  ),
}));
const controllers: VoiceController[] = [];
const owners: ScreenBindingOwner[] = [];
const drains: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
function transport() {
  const raw = deferred<unknown>(),
    retired = deferred<void>();
  const retire = vi.fn(() => retired.promise);
  const bind = vi.fn((_request: unknown, _signal: AbortSignal) => raw.promise);
  const errors = vi.fn();
  const create = vi.fn<ScreenBindingDependency['create']>((own) => {
    own(retire);
    return { bind, retire };
  });
  drains.push(() => {
    raw.resolve(reply());
    retired.resolve();
  });
  return { raw, retired, retire, bind, create, errors, dependency: { create, onError: errors } };
}
function fixture(dependency?: ScreenBindingDependency) {
  const initial = deferred<unknown>(),
    heartbeat = deferred<unknown>(),
    replacement = deferred<unknown>();
  const request = vi.fn(async (path: string) => {
    if (path === '/voice/join')
      return request.mock.calls.filter(([p]) => p === path).length === 1
        ? initial.promise
        : replacement.promise;
    if (path === '/voice/heartbeat') return heartbeat.promise;
    return { ok: true };
  });
  const controller = new VoiceController(
    <T>(path: string) => request(path) as Promise<T>,
    dependency,
  );
  controllers.push(controller);
  controller.update({ input: 'fixture-mic', output: 'fixture-speaker', inputMissing: true });
  drains.push(() => {
    initial.resolve(lease);
    heartbeat.resolve({ ok: true });
    replacement.resolve({ ...lease, id: crypto.randomUUID() });
  });
  async function join() {
    const work = controller.join(channel);
    pending.push(work);
    initial.resolve(lease);
    await flush();
    rooms.at(-1)!.connected.resolve();
    await work;
  }
  return { controller, request, initial, heartbeat, replacement, join };
}
function outcome<T>(work: Promise<T>) {
  const result = work.then(
    (value) => ({ value }),
    (cause) => ({ cause: cause as Error }),
  );
  pending.push(result);
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getUserMedia: () => {
        throw new Error('Physical capture forbidden');
      },
    },
  });
  vi.stubGlobal('location', { href: 'http://127.0.0.1:3000', protocol: 'http:' });
});
afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  owners.splice(0).forEach((owner) => owner.dispose());
  drains.splice(0).forEach((drain) => drain());
  rooms.forEach((room) => {
    room.connected.resolve();
    room.disconnected.resolve();
  });
  await flush();
  rooms.splice(0);
  await Promise.all(pending.splice(0));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('denies absent lease, pending join, left/disposed voice and absent injection before allocation', async () => {
  const t = transport(),
    f = fixture(t.dependency);
  await expect(f.controller.bindScreens()).rejects.toThrow('Join voice');
  const join = f.controller.join(channel);
  pending.push(join);
  await expect(f.controller.bindScreens()).rejects.toThrow('Join voice');
  f.initial.resolve(lease);
  await flush();
  await expect(f.controller.bindScreens()).rejects.toThrow('Join voice');
  rooms[0]!.connected.resolve();
  await join;
  const left = f.controller.leave();
  pending.push(left);
  await expect(f.controller.bindScreens()).rejects.toThrow('Join voice');
  f.controller.dispose();
  await expect(f.controller.bindScreens()).rejects.toThrow('Join voice');
  expect(t.create).not.toHaveBeenCalled();
  const without = fixture();
  await without.join();
  await expect(without.controller.bindScreens()).rejects.toThrow('unavailable');
});

it('binds the private exact lease and returns a copied frozen finite lifecycle without credentials', async () => {
  const t = transport(),
    f = fixture(t.dependency);
  await f.join();
  const work = f.controller.bindScreens();
  await vi.advanceTimersByTimeAsync(200);
  const response = reply();
  t.raw.resolve(response);
  const handle = await work;
  expect(t.bind.mock.calls[0]![0]).toEqual({ version: 2, leaseId, requestId: expect.any(String) });
  expect(handle.binding).toEqual(reply());
  expect(Object.isFrozen(handle)).toBe(true);
  expect(Object.isFrozen(handle.binding)).toBe(true);
  response.remainingMs = 999999;
  expect(handle.inspect()?.deadline).toBe(Date.now() - 200 + 45000);
  expect(JSON.stringify(handle)).not.toContain('credential');
  expect(JSON.stringify(handle)).not.toContain(leaseId);
  const invalidated = vi.fn();
  handle.onInvalidated(invalidated);
  handle.release();
  handle.release();
  expect(invalidated).toHaveBeenCalledTimes(1);
  expect(handle.inspect()).toBeNull();
  expect(t.retire).toHaveBeenCalledTimes(1);
  await expect(f.controller.bindScreens()).rejects.toThrow('still owned');
  t.retired.resolve();
  await flush();
  response.remainingMs = 45000;
  const next = await f.controller.bindScreens();
  next.release();
});

it.each([
  null,
  [],
  {},
  { ...reply(), extra: true },
  { ...reply(), epoch: 'not-uuid' },
  { ...reply(), channelId: 'different' },
  { ...reply(), remainingMs: 0 },
  { ...reply(), remainingMs: NaN },
  { ...reply(), remainingMs: 45001 },
  { ...reply(), remainingMs: 1.5 },
])('rejects malformed binding %j and retires only its screen transport', async (response) => {
  const t = transport(),
    f = fixture(t.dependency);
  await f.join();
  const work = outcome(f.controller.bindScreens());
  t.raw.resolve(response);
  expect(await work).toHaveProperty('cause');
  expect(t.retire).toHaveBeenCalledTimes(1);
  expect(f.controller.state.status).toBe('connected');
  expect(f.request.mock.calls.filter(([path]) => path === '/voice/leave')).toHaveLength(0);
});

it.each(['success', 'failure'] as const)(
  'keeps timed-out raw bind charged through late %s and retirement',
  async (mode) => {
    const t = transport(),
      f = fixture(t.dependency);
    await f.join();
    const work = outcome(f.controller.bindScreens());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await work).toHaveProperty('cause');
    expect(t.bind.mock.calls[0]![1].aborted).toBe(true);
    t.retired.resolve();
    await flush();
    await expect(f.controller.bindScreens()).rejects.toThrow('still owned');
    if (mode === 'success') t.raw.resolve(reply());
    else t.raw.reject(new Error('late failure'));
    await flush();
    expect(t.errors).not.toHaveBeenCalled();
    expect(f.controller.state.status).toBe('connected');
  },
);

it('cancels promptly, observes late success, and never extends a response from its arrival time', async () => {
  const t = transport(),
    f = fixture(t.dependency);
  await f.join();
  const abort = new AbortController();
  const work = outcome(f.controller.bindScreens({ signal: abort.signal }));
  abort.abort();
  expect(await work).toHaveProperty('cause');
  t.raw.resolve(reply());
  await flush();
  expect(t.retire).toHaveBeenCalledTimes(1);
  await expect(f.controller.bindScreens()).rejects.toThrow('still owned');
  t.retired.resolve();
  await flush();
  const short = transport();
  const other = fixture(short.dependency);
  await other.join();
  const expired = outcome(other.controller.bindScreens());
  await vi.advanceTimersByTimeAsync(1000);
  short.raw.resolve({ ...reply(), remainingMs: 1000 });
  expect(await expired).toHaveProperty('cause');
});

it.each([401, 403, 409, 410, 503])(
  'heartbeat %s invalidates pending and owned bindings before recovery',
  async (status) => {
    const t = transport(),
      f = fixture(t.dependency);
    await f.join();
    await vi.advanceTimersByTimeAsync(9000);
    const work = outcome(f.controller.bindScreens());
    await vi.advanceTimersByTimeAsync(1000);
    f.heartbeat.reject(Object.assign(new Error('denied'), { status }));
    await flush();
    expect(await work).toHaveProperty('cause');
    await expect(f.controller.bindScreens()).rejects.toThrow();
    t.raw.resolve(reply());
    t.retired.resolve();
    await flush();
    if (status === 410) {
      f.replacement.resolve({ ...lease, id: '0496e3ef-c336-4437-929f-4cc89466d02e' });
      rooms[0]!.disconnected.resolve();
      await flush();
      const handle = await f.controller.bindScreens();
      expect(t.bind.mock.calls.at(-1)![0]).toMatchObject({
        leaseId: '0496e3ef-c336-4437-929f-4cc89466d02e',
      });
      handle.release();
    }
  },
);

it('lease loss revokes a returned handle synchronously while room disconnect remains pending', async () => {
  const t = transport(),
    f = fixture(t.dependency);
  await f.join();
  const work = f.controller.bindScreens();
  t.raw.resolve(reply());
  const handle = await work;
  const invalidated = vi.fn();
  handle.onInvalidated(invalidated);
  const left = f.controller.leave();
  pending.push(left);
  expect(handle.inspect()).toBeNull();
  expect(invalidated).toHaveBeenCalledTimes(1);
  expect(t.retire).toHaveBeenCalledTimes(1);
});

it('reserves before construction, retires partial resources on reentrant disposal and drains cleanup errors', async () => {
  const retired = deferred<void>(),
    errors = vi.fn();
  const retire = vi.fn(() => retired.promise),
    bind = vi.fn();
  const create = vi.fn<ScreenBindingDependency['create']>((own) => {
    own(retire);
    owner.dispose();
    own(retire);
    return { bind, retire };
  });
  const owner = new ScreenBindingOwner({ create, onError: errors });
  owners.push(owner);
  const work = outcome(owner.bind(lease, () => true));
  expect(await work).toHaveProperty('cause');
  expect(bind).not.toHaveBeenCalled();
  expect(retire).toHaveBeenCalledTimes(1);
  expect(owner.inspect().occupied).toBe(true);
  retired.reject(new Error('cleanup failed'));
  await flush();
  expect(errors).toHaveBeenCalledTimes(1);
  expect(owner.inspect().occupied).toBe(false);
});

it('cleans a throwing factory and retains raw retirement rather than reopening admission', async () => {
  const t = transport();
  t.create.mockImplementation((own) => {
    own(t.retire);
    throw new Error('construction failed');
  });
  const owner = new ScreenBindingOwner(t.dependency);
  owners.push(owner);
  await expect(owner.bind(lease, () => true)).rejects.toThrow('construction failed');
  await expect(owner.bind(lease, () => true)).rejects.toThrow('still owned');
  t.retired.resolve();
  await flush();
  expect(owner.inspect().occupied).toBe(false);
});
