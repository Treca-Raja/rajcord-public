import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CallPreviewLifetime, type CallPreviewDependency } from './call-preview';
import { ScreenPreviewOwner, type PreparedPreviewAuthorization } from './screen-preview';
import { WebScreenCapture } from './screen-capture';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Track extends EventTarget {
  kind = 'video';
  readyState = 'live';
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  getSettings() {
    return { displaySurface: 'browser' };
  }
}
class Stream extends EventTarget {
  track = new Track();
  getTracks() {
    return [this.track as unknown as MediaStreamTrack];
  }
  getVideoTracks() {
    return this.getTracks();
  }
  getAudioTracks() {
    return [];
  }
  get media() {
    return this as unknown as MediaStream;
  }
}
const lifetimes: CallPreviewLifetime[] = [];
const drains: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function fixture() {
  const raw = deferred<MediaStream>();
  const prepared = deferred<PreparedPreviewAuthorization>();
  const stream = new Stream();
  const current = { epoch: {}, deadline: Date.now() + 1000 };
  const handle = { ...current, dispose: vi.fn() };
  drains.push(() => {
    prepared.resolve(handle);
    raw.resolve(stream.media);
    stream.track.stop();
  });
  const listeners = new Set<() => void>();
  const getDisplayMedia = vi.fn(() => raw.promise);
  const capture = new WebScreenCapture({ getDisplayMedia });
  const onError = vi.fn();
  let preview!: ScreenPreviewOwner;
  const dependency: CallPreviewDependency = {
    onError,
    create: vi.fn((own) => {
      own(() => capture.dispose());
      preview = new ScreenPreviewOwner({
        capture,
        authorization: {
          prepare: () => prepared.promise,
          inspect: () => current,
          onInvalidated: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        onError,
      });
      return preview;
    }),
  };
  const lifetime = new CallPreviewLifetime(dependency);
  lifetimes.push(lifetime);
  return {
    lifetime,
    preview,
    capture,
    dependency,
    raw,
    prepared,
    stream,
    handle,
    getDisplayMedia,
    listeners,
    onError,
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  const pending = f.preview.prepare({ sound: 'none' });
  f.prepared.resolve(f.handle);
  await pending;
}
async function playing(f: ReturnType<typeof fixture>) {
  await ready(f);
  const pending = f.preview.start();
  f.raw.resolve(f.stream.media);
  await pending;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  lifetimes.splice(0).forEach((lifetime) => lifetime.dispose());
  drains.splice(0).forEach((drain) => drain());
  await flush();
  vi.useRealTimers();
});

it('default absence allocates no preview and all lifecycle hints are inert', () => {
  const lifetime = new CallPreviewLifetime();
  lifetime.observeVoice({ status: 'joining', channelId: 'room' });
  lifetime.observeVoice({ status: 'idle', channelId: null });
  lifetime.stop();
  lifetime.dispose();
  lifetime.dispose();
});

it('constructs once without authorizing, preparing or capturing', () => {
  const f = fixture();
  expect(f.dependency.create).toHaveBeenCalledTimes(1);
  expect(f.preview.inspect()).toEqual({ phase: 'idle' });
  f.lifetime.observeVoice({ status: 'connected', channelId: 'room' });
  expect(f.preview.inspect()).toEqual({ phase: 'idle' });
  expect(f.getDisplayMedia).not.toHaveBeenCalled();
});

it('prepares separately and enters injected capture synchronously on the start stack', async () => {
  const f = fixture();
  await ready(f);
  expect(f.getDisplayMedia).not.toHaveBeenCalled();
  const pending = f.preview.start();
  expect(f.getDisplayMedia).toHaveBeenCalledTimes(1);
  f.raw.resolve(f.stream.media);
  await pending;
  expect(f.preview.inspect().phase).toBe('preview');
});

it.each(['manual', 'observed', 'dispose'] as const)(
  '%s voice cleanup stops tracks synchronously',
  async (mode) => {
    const f = fixture();
    await playing(f);
    if (mode === 'dispose') f.lifetime.dispose();
    else if (mode === 'manual') f.lifetime.stop();
    else {
      f.lifetime.observeVoice({ status: 'joining', channelId: 'room' });
      f.lifetime.observeVoice({ status: 'idle', channelId: null });
    }
    expect(f.stream.track.readyState).toBe('ended');
    expect(f.handle.dispose).toHaveBeenCalledTimes(1);
  },
);

it('idle snapshots do not grant, renew or spontaneously cancel a separately authorized preview', async () => {
  const f = fixture();
  await playing(f);
  f.lifetime.observeVoice({ status: 'idle', channelId: null });
  f.lifetime.observeVoice({ status: 'connected', channelId: 'room' });
  f.lifetime.observeVoice({ status: 'reconnecting', channelId: 'room' });
  expect(f.preview.inspect().phase).toBe('preview');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.stream.track.readyState).toBe('ended');
  expect(f.preview.inspect()).toMatchObject({ reason: 'expired' });
});

it.each(['resolve', 'reject'] as const)(
  'disposed preparation observes late %s without touching a replacement',
  async (late) => {
    const old = fixture();
    const result = old.preview.prepare({ sound: 'none' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'disposed' });
    old.lifetime.dispose();
    await rejected;
    const next = fixture();
    await playing(next);
    if (late === 'resolve') old.prepared.resolve(old.handle);
    else old.prepared.reject(new Error('Late authority failure'));
    await flush();
    expect(old.handle.dispose).toHaveBeenCalledTimes(late === 'resolve' ? 1 : 0);
    expect(next.preview.inspect().phase).toBe('preview');
    expect(next.stream.track.readyState).toBe('live');
    expect(old.getDisplayMedia).not.toHaveBeenCalled();
  },
);

it.each(['resolve', 'reject'] as const)(
  'disposed capture observes late %s without touching a replacement',
  async (late) => {
    const old = fixture();
    await ready(old);
    const result = old.preview.start();
    const rejected = expect(result).rejects.toMatchObject({ code: 'disposed' });
    old.lifetime.dispose();
    await rejected;
    const next = fixture();
    await playing(next);
    if (late === 'resolve') old.raw.resolve(old.stream.media);
    else old.raw.reject(new Error('Late picker failure'));
    await flush();
    expect(old.stream.track.readyState).toBe(late === 'resolve' ? 'ended' : 'live');
    expect(next.preview.inspect().phase).toBe('preview');
    expect(next.stream.track.readyState).toBe('live');
  },
);

it('local stop preserves unresolved capture admission until its native promise settles', async () => {
  const f = fixture();
  await ready(f);
  const start = f.preview.start();
  const rejected = expect(start).rejects.toMatchObject({ code: 'cancelled' });
  f.lifetime.stop();
  await rejected;
  await f.preview.prepare({ sound: 'none' });
  await expect(f.preview.start()).rejects.toMatchObject({ code: 'busy' });
  expect(f.getDisplayMedia).toHaveBeenCalledTimes(1);
  f.raw.resolve(f.stream.media);
  await flush();
  expect(f.stream.track.readyState).toBe('ended');
  await f.preview.prepare({ sound: 'none' });
  expect(f.getDisplayMedia).toHaveBeenCalledTimes(1);
});

it('an old ended event cannot stop the replacement preview', async () => {
  const old = fixture();
  await playing(old);
  old.lifetime.dispose();
  const next = fixture();
  await playing(next);
  old.stream.track.dispatchEvent(new Event('ended'));
  await flush();
  expect(next.stream.track.readyState).toBe('live');
});

it('failed factory drains registered partial resources, reports once and is never retried', () => {
  const first = vi.fn();
  const last = vi.fn(() => {
    throw new Error('Partial cleanup failure');
  });
  const onError = vi.fn();
  const create = vi.fn((own: (cleanup: () => void) => void): ScreenPreviewOwner => {
    own(first);
    own(last);
    throw new Error('Factory failed');
  });
  const lifetime = new CallPreviewLifetime({ create, onError });
  lifetime.stop();
  lifetime.dispose();
  lifetime.dispose();
  expect(create).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
  expect(last).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0]![0].errors).toHaveLength(2);
});

it('cleanup failures do not skip other resources and disposal is idempotent', () => {
  const f = fixture();
  const clean = vi.fn();
  const onError = vi.fn();
  const dispose = vi.spyOn(f.preview, 'dispose').mockImplementation(() => {
    throw new Error('Preview dispose failed');
  });
  const lifetime = new CallPreviewLifetime({
    create: (own) => {
      own(clean);
      return f.preview;
    },
    onError,
  });
  lifetime.dispose();
  lifetime.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(clean).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledTimes(1);
  dispose.mockRestore();
});
