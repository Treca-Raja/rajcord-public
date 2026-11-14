import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ScreenCaptureError,
  WebScreenCapture,
  type CaptureEnd,
  type CaptureSound,
  type LocalScreenCapture,
} from './screen-capture';
import {
  ScreenPreviewOwner,
  type PreparedPreviewAuthorization,
  type PreviewAuthorizationSnapshot,
  type PreviewAuthorizationSource,
} from './screen-preview';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Track extends EventTarget {
  readyState = 'live';
  enabled = true;
  label = 'Owned synthetic source';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(readonly kind = 'video') {
    super();
  }
  getSettings() {
    return { displaySurface: 'browser' };
  }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
  get media() {
    return this as unknown as MediaStreamTrack;
  }
}
class Stream extends EventTarget {
  constructor(public tracks = [new Track()]) {
    super();
  }
  getTracks() {
    return this.tracks.map((track) => track.media);
  }
  get media() {
    return this as unknown as MediaStream;
  }
}
const owners: ScreenPreviewOwner[] = [];
const results: LocalScreenCapture[] = [];
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function captured(sound: CaptureSound = 'none') {
  const stream = new Stream(sound === 'tab' ? [new Track(), new Track('audio')] : undefined);
  const ended = deferred<CaptureEnd>();
  let disposed = false;
  const capture: LocalScreenCapture = Object.freeze({
    stream: stream.media,
    video: stream.tracks[0]!.media,
    audio: stream.tracks[1]?.media ?? null,
    displaySurface: 'browser',
    localLabel: 'Synthetic source',
    sound,
    ended: ended.promise,
    dispose: vi.fn(() => {
      if (disposed) return;
      disposed = true;
      for (const track of stream.tracks) track.stop();
    }),
  });
  results.push(capture);
  return { capture, stream, ended };
}
function fixture(real = false, qualified = false) {
  let current: PreviewAuthorizationSnapshot | null = { epoch: {}, deadline: Date.now() + 10000 };
  let first = true;
  const handle = {
    ...current,
    dispose: vi.fn(() => {
      first = false;
    }),
  };
  const listeners = new Set<() => void>();
  const authorization: PreviewAuthorizationSource = {
    prepare: vi.fn(async () => {
      if (first) {
        first = false;
        return handle;
      }
      return { ...current!, dispose: vi.fn() };
    }),
    inspect: vi.fn(() => current),
    onInvalidated: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const value = captured();
  const devices = {
    getDisplayMedia: vi.fn(async () => value.stream.media),
    getUserMedia: vi.fn(() => {
      throw new Error('Physical capture forbidden');
    }),
    enumerateDevices: vi.fn(() => {
      throw new Error('Physical discovery forbidden');
    }),
  };
  const capture = real
    ? new WebScreenCapture(devices, {
        tabAudio: qualified ? 'qualified-selected-tab' : 'unqualified',
        timeoutMs: 30000,
      })
    : {
        start: vi.fn(
          async (_request: { sound: CaptureSound; signal?: AbortSignal }) => value.capture,
        ),
        stop: vi.fn(),
        dispose: vi.fn(),
      };
  const onError = vi.fn();
  const owner = new ScreenPreviewOwner({ authorization, capture, onError, prepareTimeoutMs: 1000 });
  owners.push(owner);
  return {
    owner,
    authorization,
    handle,
    capture,
    devices,
    value,
    onError,
    listeners,
    current: () => current,
    replace: (next: PreviewAuthorizationSnapshot | null) => {
      current = next;
    },
    invalidate: () => {
      current = null;
      for (const listener of listeners) listener();
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const capture of results.splice(0)) capture.dispose();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('prepares separately and starts the real adapter on the fresh caller gesture stack', async () => {
  const f = fixture(true);
  expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'invalid' });
  const changes: string[] = [];
  f.owner.subscribe((state) => changes.push(state.phase));
  await f.owner.prepare({ sound: 'none' });
  expect(f.owner.inspect().phase).toBe('ready');
  expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
  const pending = f.owner.start();
  expect(f.devices.getDisplayMedia).toHaveBeenCalledOnce();
  expect(f.devices.getDisplayMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      audio: false,
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
    }),
  );
  expect(f.authorization.prepare).toHaveBeenCalledOnce();
  await pending;
  const state = f.owner.inspect();
  expect(state.phase).toBe('preview');
  expect(Object.isFrozen(state)).toBe(true);
  if (state.phase === 'preview') expect(state.capture.stream).toBe(f.value.stream.media);
  expect(changes).toEqual(['preparing', 'ready', 'choosing', 'preview']);
  expect(f.devices.getUserMedia).not.toHaveBeenCalled();
  expect(f.devices.enumerateDevices).not.toHaveBeenCalled();
});
it.each(['preparing', 'ready', 'choosing', 'preview'] as const)(
  'stops %s immediately and retains unresolved admission',
  async (phase) => {
    const f = fixture();
    const authorization = deferred<PreparedPreviewAuthorization>(),
      capture = deferred<LocalScreenCapture>();
    if (phase === 'preparing')
      vi.mocked(f.authorization.prepare).mockReturnValueOnce(authorization.promise);
    if (phase === 'choosing') vi.mocked(f.capture.start).mockReturnValueOnce(capture.promise);
    const preparing = f.owner.prepare({ sound: 'none' });
    const prepared = preparing.catch(() => {});
    if (phase !== 'preparing') await preparing;
    let started: Promise<void> | undefined;
    if (phase === 'choosing' || phase === 'preview') started = f.owner.start();
    const ended = started?.catch(() => {});
    if (phase === 'preview') await started;
    f.owner.stop();
    expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'stopped' });
    if (phase === 'preview') expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
    if (phase === 'preparing' || phase === 'choosing')
      await expect(f.owner.prepare({ sound: 'none' })).rejects.toMatchObject({ code: 'busy' });
    authorization.resolve(f.handle);
    capture.resolve(f.value.capture);
    await Promise.all([prepared, ended]);
    await flush();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
    if (phase === 'choosing') expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
    await f.owner.prepare({ sound: 'none' });
    expect(f.owner.inspect().phase).toBe('ready');
  },
);
it.each(['preparing', 'ready', 'choosing', 'preview'] as const)(
  'fences cancellation in %s',
  async (phase) => {
    const f = fixture(),
      abort = new AbortController();
    const authorization = deferred<PreparedPreviewAuthorization>(),
      capture = deferred<LocalScreenCapture>();
    if (phase === 'preparing')
      vi.mocked(f.authorization.prepare).mockReturnValueOnce(authorization.promise);
    if (phase === 'choosing') vi.mocked(f.capture.start).mockReturnValueOnce(capture.promise);
    const preparing = f.owner.prepare({ sound: 'none', signal: abort.signal });
    const prepared = preparing.catch(() => {});
    if (phase !== 'preparing') await preparing;
    const started = phase === 'choosing' || phase === 'preview' ? f.owner.start() : undefined;
    const ended = started?.catch(() => {});
    if (phase === 'preview') await started;
    abort.abort();
    expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'cancelled' });
    if (phase === 'preview')
      expect(f.value.stream.tracks.every((track) => track.readyState === 'ended')).toBe(true);
    authorization.resolve(f.handle);
    capture.resolve(f.value.capture);
    await Promise.all([prepared, ended]);
    await flush();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  },
);
it.each(['preparing', 'choosing', 'preview'] as const)(
  'disposes %s permanently without waiting for ignored abort',
  async (phase) => {
    const f = fixture(),
      authorization = deferred<PreparedPreviewAuthorization>(),
      capture = deferred<LocalScreenCapture>();
    if (phase === 'preparing')
      vi.mocked(f.authorization.prepare).mockReturnValueOnce(authorization.promise);
    if (phase === 'choosing') vi.mocked(f.capture.start).mockReturnValueOnce(capture.promise);
    const preparing = f.owner.prepare({ sound: 'none' }),
      prepared = preparing.catch(() => {});
    if (phase !== 'preparing') await preparing;
    const start = phase !== 'preparing' ? f.owner.start() : undefined,
      ended = start?.catch(() => {});
    if (phase === 'preview') await start;
    f.owner.dispose();
    expect(f.owner.inspect().phase).toBe('disposed');
    expect(f.listeners.size).toBe(0);
    await expect(f.owner.prepare({ sound: 'none' })).rejects.toMatchObject({ code: 'disposed' });
    await expect(f.owner.start()).rejects.toMatchObject({ code: 'disposed' });
    authorization.resolve(f.handle);
    capture.resolve(f.value.capture);
    await Promise.all([prepared, ended]);
    await flush();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
    if (phase !== 'preparing') expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
  },
);
it('revokes all owned preview tracks on authorization/session/lease generation loss', async () => {
  const f = fixture(true, true),
    audio = new Track('audio');
  f.value.stream.tracks.push(audio);
  await f.owner.prepare({ sound: 'tab' });
  await f.owner.start();
  f.invalidate();
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'authorization-lost' });
  expect(f.value.stream.tracks.every((track) => track.readyState === 'ended')).toBe(true);
});
it.each(['preparing', 'choosing', 'preview'] as const)(
  'rejects silent epoch replacement during %s',
  async (phase) => {
    const f = fixture(),
      authorization = deferred<PreparedPreviewAuthorization>(),
      capture = deferred<LocalScreenCapture>();
    if (phase === 'preparing')
      vi.mocked(f.authorization.prepare).mockReturnValueOnce(authorization.promise);
    if (phase === 'choosing') vi.mocked(f.capture.start).mockReturnValueOnce(capture.promise);
    const prepare = f.owner.prepare({ sound: 'none' }),
      prepared = prepare.catch(() => {});
    if (phase !== 'preparing') await prepare;
    const start = phase !== 'preparing' ? f.owner.start() : undefined,
      ended = start?.catch(() => {});
    if (phase === 'preview') await start;
    f.replace({ epoch: {}, deadline: 110000 });
    authorization.resolve(f.handle);
    capture.resolve(f.value.capture);
    await Promise.all([prepared, ended]);
    expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'authorization-lost' });
    if (phase !== 'preparing') expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  },
);
it('invalidates pending authorization promptly and observes late failure without re-entry', async () => {
  const f = fixture(),
    gate = deferred<PreparedPreviewAuthorization>();
  vi.mocked(f.authorization.prepare).mockReturnValueOnce(gate.promise);
  const pending = f.owner.prepare({ sound: 'none' });
  const denied = expect(pending).rejects.toMatchObject({ code: 'denied' });
  f.invalidate();
  await denied;
  await expect(f.owner.prepare({ sound: 'none' })).rejects.toMatchObject({ code: 'busy' });
  gate.reject(new Error('Synthetic obsolete authorization failure'));
  await flush();
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'authorization-lost' });
  expect(f.capture.start).not.toHaveBeenCalled();
});
it('rejects late capture failures after Stop without changing the stopped state', async () => {
  const f = fixture(),
    gate = deferred<LocalScreenCapture>();
  vi.mocked(f.capture.start).mockReturnValueOnce(gate.promise);
  await f.owner.prepare({ sound: 'none' });
  const pending = f.owner.start(),
    stopped = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  f.owner.stop();
  await stopped;
  gate.reject(new Error('Synthetic obsolete capture failure'));
  await flush();
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'stopped' });
});
it('shrinks deadlines and checks expiry without depending on a timer tick', async () => {
  const f = fixture();
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  f.replace({ ...f.current()!, deadline: Date.now() + 500 });
  f.owner.inspect();
  vi.setSystemTime(Date.now() + 501);
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'expired' });
  expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
});
it('copies mutable preparation inputs and authorization identity', async () => {
  const f = fixture(),
    gate = deferred<PreparedPreviewAuthorization>();
  const request = { sound: 'none' as CaptureSound };
  vi.mocked(f.authorization.prepare).mockReturnValueOnce(gate.promise);
  const preparing = f.owner.prepare(request);
  request.sound = 'tab';
  gate.resolve(f.handle);
  await preparing;
  expect(f.owner.inspect()).toMatchObject({ phase: 'ready', sound: 'none' });
  f.handle.epoch = {};
  f.replace(f.handle);
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'denied' });
  expect(f.capture.start).not.toHaveBeenCalled();
});
it('reports cleanup failures while still disposing tracks and prepared authorization', async () => {
  const f = fixture();
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  vi.mocked(f.capture.stop).mockImplementationOnce(() => {
    throw new Error('Synthetic stop failure');
  });
  f.owner.stop();
  expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
  expect(f.handle.dispose).toHaveBeenCalledOnce();
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', error: { code: 'failed' } });
  expect(f.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Preview cleanup failed.' }),
  );
});
it('reports obsolete cleanup failure without stopping a new preview', async () => {
  const f = fixture(),
    old = f.value,
    replacement = captured();
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  f.owner.stop();
  vi.mocked(f.capture.start).mockResolvedValueOnce(replacement.capture);
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  vi.mocked(old.capture.dispose).mockImplementationOnce(() => {
    throw new Error('Synthetic old cleanup failure');
  });
  old.ended.resolve('stopped');
  await flush();
  expect(f.onError).toHaveBeenCalledOnce();
  expect(f.owner.inspect().phase).toBe('preview');
  expect(replacement.stream.tracks[0]!.stop).not.toHaveBeenCalled();
});
it.each(['noninteger-deadline', 'invalid-epoch'] as const)(
  'rejects malformed %s preparation with scoped cleanup',
  async (change) => {
    const f = fixture();
    if (change === 'noninteger-deadline') f.handle.deadline = 1.5;
    if (change === 'invalid-epoch') f.handle.epoch = null as never;
    await expect(f.owner.prepare({ sound: 'none' })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.handle.dispose).toHaveBeenCalledOnce();
    expect(f.capture.start).not.toHaveBeenCalled();
  },
);
it('bounds preparation and rejects a late authorization result without creating a capture', async () => {
  const f = fixture(),
    gate = deferred<PreparedPreviewAuthorization>();
  vi.mocked(f.authorization.prepare).mockReturnValueOnce(gate.promise);
  const pending = f.owner.prepare({ sound: 'none' });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  await expect(f.owner.prepare({ sound: 'none' })).rejects.toMatchObject({ code: 'busy' });
  gate.resolve(f.handle);
  await flush();
  expect(f.handle.dispose).toHaveBeenCalledOnce();
  expect(f.capture.start).not.toHaveBeenCalled();
});
it.each(['ready', 'choosing', 'preview'] as const)(
  'enforces the authorization deadline during %s',
  async (phase) => {
    const f = fixture(),
      gate = deferred<LocalScreenCapture>();
    await f.owner.prepare({ sound: 'none' });
    if (phase === 'choosing') vi.mocked(f.capture.start).mockReturnValueOnce(gate.promise);
    const start = phase !== 'ready' ? f.owner.start() : undefined,
      ended = start?.catch(() => {});
    if (phase === 'preview') await start;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.owner.inspect()).toMatchObject({ phase: 'idle', reason: 'expired' });
    if (phase === 'preview') expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
    gate.resolve(f.value.capture);
    await ended;
    await flush();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  },
);
it('copies the epoch/deadline and cannot extend a preview or start after silent replacement', async () => {
  const f = fixture();
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  f.handle.deadline += 20000;
  f.replace({ ...f.current()!, deadline: 130000 });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.owner.inspect()).toMatchObject({ reason: 'expired' });
  const replacement = { epoch: {}, deadline: Date.now() + 10000, dispose: vi.fn() };
  f.replace(replacement);
  vi.mocked(f.authorization.prepare).mockResolvedValueOnce(replacement);
  await f.owner.prepare({ sound: 'none' });
  f.replace({ epoch: {}, deadline: replacement.deadline });
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'denied' });
  expect(replacement.dispose).toHaveBeenCalledOnce();
});
it.each(['video', 'audio', 'addtrack', 'removetrack'] as const)(
  'ends preview synchronously on %s source changes',
  async (reason) => {
    const f = fixture(true, true);
    f.value.stream.tracks.push(new Track('audio'));
    await f.owner.prepare({ sound: 'tab' });
    await f.owner.start();
    if (reason === 'video') f.value.stream.tracks[0]!.end();
    else if (reason === 'audio') f.value.stream.tracks[1]!.end();
    else f.value.stream.dispatchEvent(new Event(reason));
    expect(f.owner.inspect().phase).toBe('idle');
    expect(f.value.stream.tracks.every((track) => track.readyState === 'ended')).toBe(true);
  },
);
it('does not let old ended callbacks or stale preparation cleanup stop a replacement', async () => {
  const f = fixture(),
    old = f.value;
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  f.owner.stop();
  const next = captured();
  vi.mocked(f.capture.start).mockResolvedValueOnce(next.capture);
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  old.ended.resolve('video-ended');
  await flush();
  expect(f.owner.inspect().phase).toBe('preview');
  expect(next.stream.tracks[0]!.stop).not.toHaveBeenCalled();
  old.stream.tracks[0]!.end();
  expect(next.stream.tracks[0]!.stop).not.toHaveBeenCalled();
});
it('leaves missing/unqualified sound as failures, with no microphone fallback', async () => {
  const f = fixture(true);
  await f.owner.prepare({ sound: 'tab' });
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'unsupported' });
  expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
  const qualified = fixture(true, true);
  await qualified.owner.prepare({ sound: 'tab' });
  await expect(qualified.owner.start()).rejects.toMatchObject({ code: 'missing_sound' });
  expect(qualified.value.stream.tracks[0]!.readyState).toBe('ended');
  expect(qualified.devices.getUserMedia).not.toHaveBeenCalled();
});
it('requires explicit sound, available authority and an uncancelled preparation', async () => {
  const f = fixture();
  await expect(f.owner.prepare({ sound: 'system' } as never)).rejects.toMatchObject({
    code: 'invalid',
  });
  const abort = new AbortController();
  abort.abort();
  await expect(f.owner.prepare({ sound: 'none', signal: abort.signal })).rejects.toMatchObject({
    code: 'cancelled',
  });
  const absent = new ScreenPreviewOwner({ capture: f.capture, onError: vi.fn() });
  owners.push(absent);
  await expect(absent.prepare({ sound: 'none' })).rejects.toMatchObject({ code: 'unsupported' });
  expect(f.capture.start).not.toHaveBeenCalled();
});
it('surfaces authorization/capture failures and releases their current resources', async () => {
  const f = fixture(),
    failure = new Error('Synthetic authority failure');
  vi.mocked(f.authorization.prepare).mockRejectedValueOnce(failure);
  await expect(f.owner.prepare({ sound: 'none' })).rejects.toMatchObject({ cause: failure });
  await f.owner.prepare({ sound: 'none' });
  vi.mocked(f.capture.start).mockRejectedValueOnce(
    new ScreenCaptureError('denied', 'Synthetic denial'),
  );
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'denied' });
  expect(f.handle.dispose).toHaveBeenCalledOnce();
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', error: { code: 'denied' } });
});
it('keeps reentrant Stop usable when choosing is announced', async () => {
  const f = fixture(),
    pending = deferred<LocalScreenCapture>();
  vi.mocked(f.capture.start).mockReturnValueOnce(pending.promise);
  f.owner.subscribe((state) => {
    if (state.phase === 'choosing') f.owner.stop();
  });
  await f.owner.prepare({ sound: 'none' });
  const start = f.owner.start(),
    stopped = expect(start).rejects.toMatchObject({ code: 'cancelled' });
  await stopped;
  pending.resolve(f.value.capture);
  await flush();
  expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
});
it('rejects overlapping preparation/start without stopping the current owned result', async () => {
  const f = fixture();
  await f.owner.prepare({ sound: 'none' });
  await expect(f.owner.prepare({ sound: 'tab' })).rejects.toMatchObject({ code: 'busy' });
  const start = f.owner.start();
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'invalid' });
  await start;
  expect(f.capture.start).toHaveBeenCalledOnce();
  expect(f.value.stream.tracks[0]!.stop).not.toHaveBeenCalled();
  expect(Object.keys(vi.mocked(f.authorization.prepare).mock.calls[0]![0]).sort()).toEqual([
    'signal',
    'sound',
  ]);
});
it('fails closed when synchronous authority inspection throws', async () => {
  const f = fixture();
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  vi.mocked(f.authorization.inspect).mockImplementationOnce(() => {
    throw new Error('Synthetic authority outage');
  });
  expect(f.owner.inspect()).toMatchObject({
    phase: 'idle',
    reason: 'authorization-lost',
    error: { code: 'failed' },
  });
  expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
});
it('rejects sources that end or change sound before the owner receives them', async () => {
  const f = fixture(),
    gate = deferred<LocalScreenCapture>();
  vi.mocked(f.capture.start).mockReturnValueOnce(gate.promise);
  await f.owner.prepare({ sound: 'none' });
  const start = f.owner.start(),
    rejected = expect(start).rejects.toMatchObject({ code: 'source_ended' });
  f.value.stream.tracks[0]!.end();
  gate.resolve(f.value.capture);
  await rejected;
  expect(f.owner.inspect().phase).toBe('idle');
  const next = captured('tab');
  vi.mocked(f.capture.start).mockResolvedValueOnce(next.capture);
  await f.owner.prepare({ sound: 'none' });
  await expect(f.owner.start()).rejects.toMatchObject({ code: 'source_ended' });
  expect(next.stream.tracks.every((track) => track.readyState === 'ended')).toBe(true);
});
it('observes a rejected source lifecycle and releases the preview', async () => {
  const f = fixture();
  await f.owner.prepare({ sound: 'none' });
  await f.owner.start();
  f.value.ended.reject(new Error('Synthetic lifecycle failure'));
  await flush();
  expect(f.owner.inspect()).toMatchObject({ phase: 'idle', error: { code: 'failed' } });
  expect(f.value.stream.tracks[0]!.readyState).toBe('ended');
});
