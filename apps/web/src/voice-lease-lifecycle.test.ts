import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceController } from './voice-controller';
import { ScreenPreviewOwner } from './screen-preview';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const rooms: {
  connected: ReturnType<typeof deferred<void>>;
  disconnected: ReturnType<typeof deferred<void>>;
}[] = [];
vi.mock('livekit-client', () => ({
  Room: class {
    connected = deferred<void>();
    disconnected = deferred<void>();
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
    ].map((key) => [key, key]),
  ),
}));

const controllers: VoiceController[] = [];
const pending: Promise<unknown>[] = [];
const drains: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
function fixture() {
  const heartbeat = deferred<unknown>();
  const replacement = deferred<unknown>();
  const request = vi.fn(
    async (...[path]: Parameters<ConstructorParameters<typeof VoiceController>[0]>) => {
      if (path === '/voice/heartbeat') return heartbeat.promise;
      if (path === '/voice/join') {
        if (request.mock.calls.filter(([p]) => p === '/voice/join').length > 1)
          return replacement.promise;
        return { id: 'owned-initial-lease', channelId: 'room', credential: 'synthetic' };
      }
      return { ok: true };
    },
  );
  const controller = new VoiceController(
    <T>(...args: Parameters<ConstructorParameters<typeof VoiceController>[0]>) =>
      request(...args) as Promise<T>,
  );
  controllers.push(controller);
  controller.update({ input: 'synthetic-mic', output: 'synthetic-speakers' });
  const join = controller.join('room');
  pending.push(join);
  drains.push(() => {
    heartbeat.resolve({ ok: true });
    replacement.resolve({ id: 'owned-next-lease', channelId: 'room', credential: 'synthetic' });
  });
  return { controller, heartbeat, replacement, request, join };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getUserMedia: vi.fn(() => {
        throw new Error('Physical capture forbidden');
      }),
    },
  });
  vi.stubGlobal('location', { href: 'http://127.0.0.1:3000', protocol: 'http:' });
});
afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  drains.splice(0).forEach((drain) => drain());
  await flush();
  rooms.forEach((room) => {
    room.connected.resolve();
    room.disconnected.resolve();
  });
  await flush();
  rooms.splice(0);
  await Promise.all(pending.splice(0));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([401, 403, 409, 410, 503, undefined])(
  'heartbeat failure %s revokes synchronously before recovery/room cleanup',
  async (status) => {
    const f = fixture();
    const invalidated = vi.fn();
    f.controller.onLeaseInvalidated(invalidated);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.request).toHaveBeenCalledWith('/voice/heartbeat', 'POST', {
      leaseId: 'owned-initial-lease',
    });
    f.heartbeat.reject(Object.assign(new Error('Owned denial'), { status }));
    await flush();
    expect(invalidated).toHaveBeenCalled();
    expect(invalidated.mock.calls.every((call) => call.length === 0)).toBe(true);
    if (status === 410)
      expect(f.request).toHaveBeenCalledWith('/voice/join', 'POST', {
        channelId: 'room',
        leaseId: 'owned-initial-lease',
      });
    if (status === 503 || status === undefined || status === 410)
      expect(f.controller.state.status).toBe('joining');
    else expect(f.controller.state.status).toBe('idle');
    expect(rooms[0]).toBeDefined(); // Its disconnect remains unresolved until fixture teardown.
  },
);

it('successful heartbeat emits no permission or renewal notification', async () => {
  const f = fixture();
  const listener = vi.fn();
  f.controller.onLeaseInvalidated(listener);
  await vi.advanceTimersByTimeAsync(10000);
  f.heartbeat.resolve({ ok: true });
  await flush();
  expect(listener).not.toHaveBeenCalled();
  expect(f.controller.state.status).toBe('joining');
});

it.each(['leave', 'dispose'] as const)(
  '%s revokes before asynchronous room cleanup completes',
  async (method) => {
    const f = fixture();
    const listener = vi.fn();
    f.controller.onLeaseInvalidated(listener);
    await vi.advanceTimersByTimeAsync(1);
    const result = f.controller[method]();
    if (result) pending.push(result);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.controller.state.status).toBe('idle');
    expect(f.request.mock.calls.some(([path]) => path === '/voice/leave')).toBe(false);
  },
);

it('unsubscribe and disposal remove observers, including references retained by old owners', async () => {
  const f = fixture();
  const removed = vi.fn(),
    current = vi.fn();
  const unsubscribe = f.controller.onLeaseInvalidated(removed);
  unsubscribe();
  unsubscribe();
  f.controller.onLeaseInvalidated(current);
  f.controller.dispose();
  f.controller.dispose();
  expect(removed).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(1);
  expect(() => f.controller.onLeaseInvalidated(removed)).toThrow('disposed');
});

it.each(['resolve', 'reject'] as const)(
  'late heartbeat %s cannot invalidate a replacement call owner',
  async (late) => {
    const old = fixture();
    const removed = vi.fn();
    const unsubscribe = old.controller.onLeaseInvalidated(removed);
    await vi.advanceTimersByTimeAsync(10000);
    unsubscribe();
    old.controller.dispose();
    const next = fixture();
    const replacement = vi.fn();
    next.controller.onLeaseInvalidated(replacement);
    if (late === 'resolve') old.heartbeat.resolve({ ok: true });
    else old.heartbeat.reject(Object.assign(new Error('Old denial'), { status: 410 }));
    await flush();
    expect(removed).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(old.request.mock.calls.filter(([path]) => path === '/voice/join')).toHaveLength(1);
  },
);

it('a failed subscriber cannot prevent another revocation or synchronous voice cleanup', async () => {
  const f = fixture();
  const errors: (() => void)[] = [];
  vi.stubGlobal('queueMicrotask', (callback: () => void) => errors.push(callback));
  const failure = new Error('Owned subscriber failure');
  const remove = f.controller.onLeaseInvalidated(() => {
    throw failure;
  });
  const next = vi.fn();
  f.controller.onLeaseInvalidated(next);
  const left = f.controller.leave();
  pending.push(left);
  expect(next).toHaveBeenCalledTimes(1);
  expect(f.controller.state.status).toBe('idle');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toThrow(failure);
  remove();
});

it('late old-generation heartbeat failure cannot revoke a new join on the same controller', async () => {
  const f = fixture();
  const listener = vi.fn();
  f.controller.onLeaseInvalidated(listener);
  await vi.advanceTimersByTimeAsync(10000);
  pending.push(f.controller.leave());
  listener.mockClear();
  pending.push(f.controller.join('room'));
  f.replacement.resolve({ id: 'owned-next-lease', channelId: 'room', credential: 'synthetic' });
  await flush();
  f.heartbeat.reject(Object.assign(new Error('Old lease expired'), { status: 410 }));
  await flush();
  expect(listener).not.toHaveBeenCalled();
  expect(f.request.mock.calls.filter(([path]) => path === '/voice/join')).toHaveLength(2);
  expect(f.controller.state.status).toBe('joining');
});

it('heartbeat loss stops a real pending preview preparation without granting or renewing it', async () => {
  const f = fixture();
  const preparation = deferred<{ epoch: object; deadline: number; dispose(): void }>();
  const dispose = vi.fn();
  const capture = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
  const preview = new ScreenPreviewOwner({
    capture,
    authorization: {
      prepare: () => preparation.promise,
      inspect: () => null,
      onInvalidated: () => () => {},
    },
    onError: vi.fn(),
  });
  const unsubscribe = f.controller.onLeaseInvalidated(() => preview.stop());
  const result = preview.prepare({ sound: 'none' });
  const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
  await vi.advanceTimersByTimeAsync(10000);
  f.heartbeat.reject(new Error('Authorization unavailable'));
  await rejected;
  expect(preview.inspect()).toMatchObject({ phase: 'idle', reason: 'stopped' });
  preparation.resolve({ epoch: {}, deadline: Date.now() + 10000, dispose });
  await flush();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(capture.start).not.toHaveBeenCalled();
  unsubscribe();
  preview.dispose();
});
