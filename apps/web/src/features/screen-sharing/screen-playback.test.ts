import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScreenPlaybackOwner, type ScreenPlaybackElement } from './screen-playback';
import type { ScreenPeerLifecycle } from './screen-peer';

class Track extends EventTarget {
  readyState = 'live';
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(readonly kind: 'video' | 'audio') {
    super();
  }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
  get media() {
    return this as unknown as MediaStreamTrack;
  }
}
class Stream {
  constructor(public tracks: readonly MediaStreamTrack[]) {}
  getTracks() {
    return [...this.tracks];
  }
  get media() {
    return this as unknown as MediaStream;
  }
}
class Element extends EventTarget implements ScreenPlaybackElement {
  srcObject: HTMLVideoElement['srcObject'] = null;
  muted = false;
  volume = 1;
  paused = true;
  sinkId = '';
  pause = vi.fn(() => {
    this.paused = true;
  });
  setSinkId = vi.fn(async (id: string) => {
    this.sinkId = id;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
}
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const value = { promise, resolve, reject };
  drains.push(resolve);
  return value;
}
const drains: (() => void)[] = [];
const fixtures: { owner: ScreenPlaybackOwner; verify(): void }[] = [];
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
function fixture(audio = true) {
  const video = new Track('video'),
    sound = new Track('audio');
  const trackList = audio ? [video, sound] : [video];
  const trackListeners = trackList.map((track) => ({
    add: vi.spyOn(track, 'addEventListener'),
    remove: vi.spyOn(track, 'removeEventListener'),
  }));
  let current: ReturnType<ScreenPeerLifecycle['inspect']> = {
    generation: {},
    deadline: Date.now() + 60000,
  };
  const listeners = new Set<() => void>();
  const lifecycle: ScreenPeerLifecycle = {
    inspect: vi.fn(() => current),
    onInvalidated: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const elements: Element[] = [];
  const options = {
    lifecycle,
    video: video.media,
    audio: audio ? sound.media : null,
    createElement: vi.fn(() => {
      const element = new Element();
      elements.push(element);
      return element;
    }),
    createStream: vi.fn((tracks: readonly MediaStreamTrack[]) => new Stream(tracks).media),
    onStopIncoming: vi.fn(),
    onError: vi.fn(),
  };
  const owner = new ScreenPlaybackOwner(options);
  const value = {
    owner,
    options,
    video,
    sound,
    elements,
    trackListeners,
    listeners,
    current: () => current,
    setCurrent: (next: typeof current) => {
      current = next;
    },
    invalidate: () => {
      current = null;
      for (const listener of [...listeners]) listener();
    },
  };
  fixtures.push({
    owner,
    verify() {
      expect(listeners.size).toBe(0);
      expect(video.stop).not.toHaveBeenCalled();
      expect(sound.stop).not.toHaveBeenCalled();
      for (const element of elements)
        expect(element).toMatchObject({ muted: true, paused: true, srcObject: null });
      for (const track of trackListeners)
        expect(track.remove.mock.calls.length).toBe(track.add.mock.calls.length);
    },
  });
  return value;
}
async function held(stage: 'sink' | 'play') {
  const f = fixture(),
    raw = deferred(),
    element = new Element();
  f.options.createElement.mockImplementationOnce(() => {
    f.elements.push(element);
    return element;
  });
  if (stage === 'sink')
    element.setSinkId.mockImplementationOnce(async (id) => {
      await raw.promise;
      element.sinkId = id;
    });
  else
    element.play.mockImplementationOnce(async () => {
      await raw.promise;
      element.paused = false;
    });
  f.owner.setOutput('exact-A');
  const result = f.owner.play();
  const rejected = result.then(
    () => {
      throw new Error('Expected cancelled playback');
    },
    (error: unknown) => error,
  );
  await flush();
  return { ...f, raw, element, result, rejected };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
});
afterEach(async () => {
  for (const f of fixtures) f.owner.dispose();
  for (const drain of drains.splice(0)) drain();
  await flush();
  for (const f of fixtures.splice(0)) f.verify();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('starts idle with no element, exposes immutable local preferences and requires an explicit output', async () => {
  const f = fixture();
  expect(Object.isFrozen(f.owner.inspect())).toBe(true);
  expect(f.owner.inspect()).toMatchObject({
    phase: 'idle',
    output: null,
    volume: 1,
    closed: false,
    pendingNative: false,
  });
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'output-required' });
  expect(f.options.createElement).not.toHaveBeenCalled();
  expect(f.owner.inspect().phase).toBe('blocked-output');
});
it.each([false, true])(
  'routes exact output before attaching corresponding video/audio, audio=%s',
  async (audio) => {
    const f = fixture(audio),
      element = new Element(),
      raw = deferred();
    f.options.createElement.mockImplementationOnce(() => {
      f.elements.push(element);
      return element;
    });
    element.setSinkId.mockImplementationOnce(async (id) => {
      expect(element).toMatchObject({ muted: true, paused: true, srcObject: null });
      element.sinkId = id;
    });
    element.play.mockImplementationOnce(async () => {
      expect(element.muted).toBe(true);
      expect(element.sinkId).toBe('exact-A');
      expect((element.srcObject as MediaStream).getTracks()).toEqual(
        audio ? [f.video.media, f.sound.media] : [f.video.media],
      );
      await raw.promise;
      element.paused = false;
    });
    f.owner.setOutput('exact-A');
    const playing = f.owner.play();
    await flush();
    expect(f.owner.inspect().phase).toBe('starting');
    expect(element.muted).toBe(true);
    raw.resolve();
    await playing;
    expect(element).toMatchObject({ muted: false, paused: false });
    expect(f.owner.inspect()).toMatchObject({ phase: 'playing', pendingNative: false });
    await f.owner.play();
    expect(element.play).toHaveBeenCalledTimes(1);
  },
);
it.each(['', 4, undefined, 'x'.repeat(513)])(
  'rejects invalid output %j before touching native work',
  (id) => {
    const f = fixture();
    expect(() => f.owner.setOutput(id as string)).toThrow();
    expect(f.owner.inspect().output).toBeNull();
    expect(f.options.createElement).not.toHaveBeenCalled();
  },
);
it.each(['unsupported', 'reject', 'readback'] as const)(
  'fails closed on %s exact sink selection',
  async (mode) => {
    const f = fixture(),
      element = new Element();
    f.options.createElement.mockImplementationOnce(() => {
      f.elements.push(element);
      return element;
    });
    if (mode === 'unsupported') Reflect.set(element, 'setSinkId', undefined);
    if (mode === 'reject')
      element.setSinkId.mockRejectedValueOnce(new Error('Synthetic output not found'));
    if (mode === 'readback') element.setSinkId.mockResolvedValueOnce();
    f.owner.setOutput('exact-A');
    await expect(f.owner.play()).rejects.toMatchObject({
      code: mode === 'unsupported' ? 'output-unsupported' : 'output-failed',
    });
    expect(f.owner.inspect()).toMatchObject({
      phase: 'blocked-output',
      output: 'exact-A',
      outputAvailable: false,
    });
    expect(element.play).not.toHaveBeenCalled();
    expect(element.srcObject).toBeNull();
  },
);
it('reports rejected autoplay, preserves preferences and requires explicit retry with a fresh element', async () => {
  const f = fixture(),
    element = new Element();
  f.options.createElement.mockImplementationOnce(() => {
    f.elements.push(element);
    return element;
  });
  element.play.mockRejectedValueOnce(
    new DOMException('Synthetic autoplay denied', 'NotAllowedError'),
  );
  f.owner.setOutput('exact-A');
  f.owner.setVolume(0.4);
  f.owner.setMuted(true);
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'autoplay-blocked' });
  expect(f.owner.inspect()).toMatchObject({
    phase: 'blocked-autoplay',
    output: 'exact-A',
    muted: true,
    volume: 0.4,
  });
  expect(f.options.createElement).toHaveBeenCalledTimes(1);
  await f.owner.play();
  expect(f.elements[1]).toMatchObject({ muted: true, volume: 0.4, paused: false });
  expect(f.elements[1]).not.toBe(element);
});
it('keeps screen mute/volume and injected deafen independent, with video and borrowed tracks intact', async () => {
  const f = fixture(),
    other = fixture();
  f.owner.setOutput('exact-A');
  other.owner.setOutput('exact-other');
  await f.owner.play();
  await other.owner.play();
  const element = f.elements[0]!;
  f.owner.setVolume(0.2);
  f.owner.setMuted(true);
  f.owner.setDeafened(true);
  f.owner.setMuted(false);
  expect(element).toMatchObject({ muted: true, volume: 0.2, paused: false });
  f.owner.setDeafened(false);
  expect(element).toMatchObject({ muted: false, volume: 0.2, paused: false });
  expect(other.elements[0]).toMatchObject({ muted: false, volume: 1, paused: false });
  expect(f.sound.enabled).toBe(true);
  expect(f.video.enabled).toBe(true);
  expect(f.options.onStopIncoming).not.toHaveBeenCalled();
});
it.each([-1, 1.1, NaN, Infinity])(
  'rejects invalid volume %s and preserves preferences',
  (volume) => {
    const f = fixture();
    expect(() => f.owner.setVolume(volume)).toThrow();
    expect(f.owner.inspect().volume).toBe(1);
  },
);
it('handles matching output loss only, without fallback or automatic restart', async () => {
  const f = fixture();
  f.owner.setOutput('exact-A');
  await f.owner.play();
  f.owner.outputLost('unrelated');
  expect(f.owner.inspect().phase).toBe('playing');
  f.owner.outputLost('exact-A');
  expect(f.owner.inspect()).toMatchObject({
    phase: 'blocked-output',
    output: 'exact-A',
    outputAvailable: false,
  });
  expect(f.elements[0]).toMatchObject({ muted: true, paused: true, srcObject: null });
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'output-required' });
  f.owner.setOutput('exact-B');
  expect(f.options.createElement).toHaveBeenCalledTimes(1);
  await f.owner.play();
  expect(f.elements[1]!.sinkId).toBe('exact-B');
});
it.each(['sink', 'play'] as const)(
  'bounds pending %s work through output replacement and late success/failure',
  async (stage) => {
    for (const late of ['success', 'failure']) {
      const f = await held(stage);
      f.owner.setOutput('exact-B');
      expect(await f.rejected).toMatchObject({ code: 'cancelled' });
      expect(f.owner.inspect()).toMatchObject({
        phase: 'paused',
        pendingNative: true,
        output: 'exact-B',
      });
      expect(f.element).toMatchObject({ muted: true, paused: true, srcObject: null });
      for (let i = 0; i < 10; i++)
        await expect(f.owner.play()).rejects.toMatchObject({ code: 'busy' });
      expect(f.options.createElement).toHaveBeenCalledTimes(1);
      if (late === 'success') f.raw.resolve();
      else f.raw.reject(new Error('Owned late failure'));
      await flush();
      expect(f.owner.inspect()).toMatchObject({ phase: 'paused', pendingNative: false });
      await f.owner.play();
      expect(f.elements[1]).toMatchObject({ sinkId: 'exact-B', paused: false, muted: false });
      expect(f.element).toMatchObject({ paused: true, muted: true, srcObject: null });
    }
  },
);
it.each(['sink', 'play'] as const)(
  'times out logical %s promptly but keeps the raw slot until settlement',
  async (stage) => {
    const f = await held(stage);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await f.rejected).toMatchObject({ code: 'timeout' });
    expect(f.owner.inspect()).toMatchObject({ phase: 'error', pendingNative: true });
    await expect(f.owner.play()).rejects.toMatchObject({ code: 'busy' });
    f.raw.resolve();
    await flush();
    await f.owner.play();
    expect(f.owner.inspect().phase).toBe('playing');
  },
);
it.each(['hidden', 'stopped', 'disposed', 'invalidated', 'expired', 'track-ended'] as const)(
  '%s synchronously detaches and revokes incoming once without waiting for native completion',
  async (reason) => {
    const f = await held('play');
    f.owner.setVolume(0.3);
    f.owner.setMuted(true);
    if (reason === 'hidden') f.owner.hide();
    if (reason === 'stopped') f.owner.stop();
    if (reason === 'disposed') f.owner.dispose();
    if (reason === 'invalidated') f.invalidate();
    if (reason === 'track-ended') f.sound.end();
    if (reason === 'expired') {
      f.setCurrent({ generation: f.current()!.generation, deadline: Date.now() + 50 });
      f.owner.inspect();
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(f.element).toMatchObject({ muted: true, paused: true, srcObject: null });
    expect(f.owner.inspect()).toMatchObject({
      closed: true,
      pendingNative: true,
      volume: 0.3,
      muted: true,
    });
    expect(f.listeners.size).toBe(0);
    expect(f.options.onStopIncoming).toHaveBeenCalledExactlyOnceWith(
      reason === 'invalidated' ? 'lifecycle-lost' : reason,
    );
    await f.rejected;
    await expect(f.owner.play()).rejects.toMatchObject({ code: 'closed' });
    const replacement = fixture();
    replacement.owner.setOutput('exact-new');
    await replacement.owner.play();
    f.raw.resolve();
    await flush();
    expect(replacement.elements[0]).toMatchObject({
      paused: false,
      muted: false,
      sinkId: 'exact-new',
    });
    expect(f.owner.inspect().pendingNative).toBe(false);
    expect(f.element).toMatchObject({ muted: true, paused: true, srcObject: null });
    f.owner.stop();
    f.owner.dispose();
    f.owner.hide();
    expect(f.options.onStopIncoming).toHaveBeenCalledTimes(1);
  },
);
it('never renews its hard deadline from a later lifecycle observation', async () => {
  const f = fixture();
  f.setCurrent({ generation: f.current()!.generation, deadline: Date.now() + 600000 });
  f.owner.inspect();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.owner.inspect()).toMatchObject({ closed: true, reason: 'expired' });
});
it.each(['generation', 'missing', 'exception'] as const)(
  'inspection fails closed on unnotified %s lifecycle loss',
  async (loss) => {
    const f = fixture();
    f.owner.setOutput('exact-A');
    await f.owner.play();
    if (loss === 'generation') f.setCurrent({ generation: {}, deadline: Date.now() + 60000 });
    if (loss === 'missing') f.setCurrent(null);
    if (loss === 'exception')
      vi.mocked(f.options.lifecycle.inspect).mockImplementation(() => {
        throw new Error('Owned authorization outage');
      });
    expect(f.owner.inspect()).toMatchObject({ closed: true, reason: 'lifecycle-lost' });
  },
);
it('detects silent sink loss before unmuting or claiming successful playback', async () => {
  const f = fixture();
  f.owner.setOutput('exact-A');
  await f.owner.play();
  f.elements[0]!.sinkId = 'unexpected';
  f.owner.setMuted(false);
  expect(f.owner.inspect()).toMatchObject({ phase: 'blocked-output', outputAvailable: false });
  expect(f.elements[0]).toMatchObject({ muted: true, paused: true, srcObject: null });
});
it.each(['extra-track', 'replaced-stream'] as const)(
  'rejects %s mutation while play is pending',
  async (change) => {
    const f = await held('play');
    if (change === 'extra-track')
      (f.element.srcObject as unknown as Stream).tracks = [
        f.video.media,
        f.sound.media,
        new Track('audio').media,
      ];
    else f.element.srcObject = new Stream([f.video.media, f.sound.media]).media;
    f.raw.resolve();
    expect(await f.rejected).toMatchObject({ code: 'playback-failed' });
    expect(f.owner.inspect().phase).toBe('error');
  },
);
it('rejects a factory stream containing unrelated tracks before play', async () => {
  const f = fixture();
  f.options.createStream.mockReturnValueOnce(
    new Stream([f.video.media, new Track('audio').media]).media,
  );
  f.owner.setOutput('exact-A');
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'invalid' });
  expect(f.elements[0]!.play).not.toHaveBeenCalled();
});
it('rejects an element already owned by another owner without touching that playback', async () => {
  const first = fixture(),
    second = fixture();
  first.owner.setOutput('exact-A');
  await first.owner.play();
  second.options.createElement.mockReturnValueOnce(first.elements[0]!);
  second.owner.setOutput('exact-B');
  await expect(second.owner.play()).rejects.toMatchObject({ code: 'invalid' });
  expect(first.elements[0]).toMatchObject({ paused: false, muted: false, sinkId: 'exact-A' });
  expect(first.owner.inspect().phase).toBe('playing');
});
it.each(['sink', 'play'] as const)(
  'caller abort cancels pending %s and observes a late failure',
  async (stage) => {
    const f = fixture(),
      signal = new AbortController(),
      raw = deferred(),
      element = new Element();
    f.options.createElement.mockImplementationOnce(() => {
      f.elements.push(element);
      return element;
    });
    if (stage === 'sink') element.setSinkId.mockImplementationOnce(() => raw.promise);
    else element.play.mockImplementationOnce(() => raw.promise);
    f.owner.setOutput('exact-A');
    const result = expect(f.owner.play({ signal: signal.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    await flush();
    signal.abort();
    await result;
    expect(f.owner.inspect()).toMatchObject({ phase: 'paused', pendingNative: true });
    raw.reject(new Error('Late owned cancellation failure'));
    await flush();
    expect(f.owner.inspect().pendingNative).toBe(false);
  },
);
it('rejects pre-aborted work before creating an element', async () => {
  const f = fixture(),
    signal = new AbortController();
  signal.abort();
  f.owner.setOutput('exact-A');
  await expect(f.owner.play({ signal: signal.signal })).rejects.toMatchObject({
    code: 'cancelled',
  });
  expect(f.options.createElement).not.toHaveBeenCalled();
});
it('a media error immediately cancels pending playback and fences its removed callback', async () => {
  const f = await held('play');
  f.element.dispatchEvent(new Event('error'));
  expect(await f.rejected).toMatchObject({ code: 'playback-failed' });
  expect(f.owner.inspect()).toMatchObject({ phase: 'error', pendingNative: true });
  f.raw.resolve();
  await flush();
  await f.owner.play();
  f.element.dispatchEvent(new Event('error'));
  expect(f.owner.inspect().phase).toBe('playing');
});
it('still detaches, unsubscribes and notifies when pause cleanup throws', async () => {
  const f = fixture();
  f.owner.setOutput('exact-A');
  await f.owner.play();
  f.elements[0]!.pause.mockImplementationOnce(() => {
    f.elements[0]!.paused = true;
    throw new Error('Owned cleanup failure');
  });
  f.owner.stop();
  expect(f.elements[0]).toMatchObject({ muted: true, paused: true, srcObject: null });
  expect(f.options.onStopIncoming).toHaveBeenCalledExactlyOnceWith('stopped');
  expect(f.options.onError).toHaveBeenCalledWith(expect.any(AggregateError));
  expect(f.listeners.size).toBe(0);
});
it('surfaces subscriber failures without skipping other subscribers or synchronous Stop', async () => {
  const f = fixture(),
    listener = vi.fn();
  f.owner.subscribe(() => {
    throw new Error('Owned observer failure');
  });
  f.owner.subscribe(listener);
  f.owner.setOutput('exact-A');
  await f.owner.play();
  f.owner.stop();
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({ closed: true, phase: 'stopped' }),
  );
  expect(f.options.onError).toHaveBeenCalled();
});
it('fences reentrant Stop before native invocation and releases the unused slot', async () => {
  const f = fixture();
  f.owner.setOutput('exact-A');
  f.owner.subscribe((state) => {
    if (state.pendingNative) f.owner.stop();
  });
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'closed' });
  expect(f.elements[0]!.setSinkId).not.toHaveBeenCalled();
  expect(f.owner.inspect()).toMatchObject({ phase: 'stopped', pendingNative: false });
});
it('cleans up synchronous invalidation during subscription without retaining listeners', () => {
  const video = new Track('video'),
    remove = vi.spyOn(video, 'removeEventListener'),
    unsubscribe = vi.fn();
  expect(
    () =>
      new ScreenPlaybackOwner({
        video: video.media,
        audio: null,
        lifecycle: {
          inspect: () => ({ generation: {}, deadline: Date.now() + 1000 }),
          onInvalidated: (listener) => {
            listener();
            return unsubscribe;
          },
        },
        createElement: vi.fn(),
        createStream: vi.fn(),
        onStopIncoming: vi.fn(),
        onError: vi.fn(),
      }),
  ).toThrow();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(video.stop).not.toHaveBeenCalled();
});

it('an A to B to A output change cannot revive the original pending attempt', async () => {
  const f = await held('sink');
  f.owner.setOutput('exact-B');
  f.owner.setOutput('exact-A');
  expect(await f.rejected).toMatchObject({ code: 'cancelled' });
  f.raw.resolve();
  await flush();
  expect(f.owner.inspect()).toMatchObject({ phase: 'paused', output: 'exact-A' });
  expect(f.element.play).not.toHaveBeenCalled();
  await f.owner.play();
  expect(f.elements[1]).toMatchObject({ sinkId: 'exact-A', paused: false });
});
it('captures the exact abort signal so caller argument mutation cannot leak its listener', async () => {
  const f = fixture(),
    original = new AbortController(),
    replacement = new AbortController();
  const remove = vi.spyOn(original.signal, 'removeEventListener'),
    request = { signal: original.signal };
  const element = new Element(),
    raw = deferred();
  element.setSinkId.mockImplementationOnce(() => raw.promise);
  f.options.createElement.mockImplementationOnce(() => {
    f.elements.push(element);
    return element;
  });
  f.owner.setOutput('exact-A');
  const result = expect(f.owner.play(request)).rejects.toMatchObject({ code: 'cancelled' });
  request.signal = replacement.signal;
  original.abort();
  await result;
  expect(remove).toHaveBeenCalledOnce();
  raw.resolve();
  await flush();
});
it.each(['muted', 'deafened', 'volume'] as const)(
  'rejects explicitly undefined %s preferences',
  (name) => {
    const f = fixture();
    if (name === 'muted') expect(() => f.owner.setMuted(undefined as unknown as boolean)).toThrow();
    if (name === 'deafened')
      expect(() => f.owner.setDeafened(undefined as unknown as boolean)).toThrow();
    if (name === 'volume')
      expect(() => f.owner.setVolume(undefined as unknown as number)).toThrow();
    expect(f.owner.inspect()).toMatchObject({ muted: false, deafened: false, volume: 1 });
  },
);
it.each(['sink', 'play'] as const)(
  'observes synchronous non-Error %s exceptions and releases the slot',
  async (stage) => {
    const f = fixture(),
      element = new Element();
    f.options.createElement.mockImplementationOnce(() => {
      f.elements.push(element);
      return element;
    });
    const throws = () => {
      throw undefined;
    };
    if (stage === 'sink') element.setSinkId.mockImplementationOnce(throws);
    else element.play.mockImplementationOnce(throws);
    f.owner.setOutput('exact-A');
    await expect(f.owner.play()).rejects.toThrow();
    expect(f.owner.inspect().pendingNative).toBe(false);
    expect(f.owner.inspect().phase).not.toBe('playing');
  },
);
it('does not claim playing when the native promise resolves but the element is paused', async () => {
  const f = fixture(),
    element = new Element();
  f.options.createElement.mockImplementationOnce(() => {
    f.elements.push(element);
    return element;
  });
  element.play.mockResolvedValueOnce();
  f.owner.setOutput('exact-A');
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'playback-failed' });
  expect(f.owner.inspect().phase).toBe('error');
});
it('inspection detects paused playback and stream replacement without restarting', async () => {
  for (const mutation of ['paused', 'stream']) {
    const f = fixture();
    f.owner.setOutput('exact-A');
    await f.owner.play();
    if (mutation === 'paused') f.elements[0]!.paused = true;
    else f.elements[0]!.srcObject = null;
    expect(f.owner.inspect()).toMatchObject({ phase: 'error', error: { code: 'playback-failed' } });
    expect(f.options.createElement).toHaveBeenCalledTimes(1);
  }
});
it('hiding before playback requests delivery revocation once and cannot restore locally', async () => {
  const f = fixture();
  f.owner.setOutput('exact-A');
  f.owner.hide();
  expect(f.owner.inspect()).toMatchObject({
    phase: 'paused-hidden',
    closed: true,
    output: 'exact-A',
  });
  expect(f.options.onStopIncoming).toHaveBeenCalledExactlyOnceWith('hidden');
  await expect(f.owner.play()).rejects.toMatchObject({ code: 'closed' });
  expect(f.options.createElement).not.toHaveBeenCalled();
});
it('a sink changing during pending play fails closed before unmuting', async () => {
  const f = await held('play');
  f.element.sinkId = 'wrong-output';
  f.raw.resolve();
  expect(await f.rejected).toMatchObject({ code: 'output-missing' });
  expect(f.owner.inspect()).toMatchObject({ phase: 'blocked-output', outputAvailable: false });
  expect(f.element.muted).toBe(true);
});

it.each(['attached', 'playing'] as const)(
  'rejects an unowned but %s factory element without altering it',
  async (mode) => {
    const f = fixture(),
      element = new Element(),
      unrelated = new Stream([new Track('audio').media]).media;
    if (mode === 'attached') element.srcObject = unrelated;
    else element.paused = false;
    f.options.createElement.mockReturnValueOnce(element);
    f.owner.setOutput('exact-A');
    await expect(f.owner.play()).rejects.toMatchObject({ code: 'invalid' });
    expect(element.pause).not.toHaveBeenCalled();
    expect(element.muted).toBe(false);
    expect(element.srcObject).toBe(mode === 'attached' ? unrelated : null);
  },
);
