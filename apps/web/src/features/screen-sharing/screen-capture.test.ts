import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebScreenCapture, ScreenCaptureError, type LocalScreenCapture } from './screen-capture';

class Track extends EventTarget {
  readonly kind: string;
  readonly label = 'Synthetic source';
  readyState = 'live';
  enabled = true;
  muted = false;
  settings: MediaTrackSettings = {
    displaySurface: 'browser',
    width: 1920,
    height: 1080,
    frameRate: 60,
  };
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  getSettings = vi.fn(() => this.settings);
  addEventListener = vi.fn(super.addEventListener.bind(this));
  removeEventListener = vi.fn(super.removeEventListener.bind(this));
  constructor(kind = 'video') {
    super();
    this.kind = kind;
  }
  get media() {
    return this as unknown as MediaStreamTrack;
  }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}
class Stream extends EventTarget {
  addEventListener = vi.fn(super.addEventListener.bind(this));
  removeEventListener = vi.fn(super.removeEventListener.bind(this));
  constructor(public tracks: Track[] = [new Track()]) {
    super();
  }
  getTracks() {
    return this.tracks.map((track) => track.media);
  }
  get media() {
    return this as unknown as MediaStream;
  }
  add(track: Track) {
    this.tracks.push(track);
    this.dispatchEvent(new Event('addtrack'));
  }
  remove(track: Track) {
    this.tracks = this.tracks.filter((t) => t !== track);
    this.dispatchEvent(new Event('removetrack'));
  }
}
const adapters: WebScreenCapture[] = [];
function fixture(options: ConstructorParameters<typeof WebScreenCapture>[1] = {}) {
  let resolve!: (stream: MediaStream) => void, reject!: (error: unknown) => void;
  const native = new Promise<MediaStream>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const devices = {
    getDisplayMedia: vi.fn().mockReturnValue(native),
    getUserMedia: vi.fn(() => {
      throw new Error('Microphone capture is forbidden in this fixture');
    }),
    enumerateDevices: vi.fn(() => {
      throw new Error('Device enumeration is forbidden in this fixture');
    }),
  };
  const adapter = new WebScreenCapture(devices, { timeoutMs: 1000, ...options });
  adapters.push(adapter);
  return { adapter, devices, resolve: (stream: Stream) => resolve(stream.media), reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
it('invokes the native chooser on the gesture stack with independently selected dimensions and fps', async () => {
  const f = fixture(),
    stream = new Stream();
  const work = f.adapter.start({ sound: 'none', resolution: 720, frameRate: 60 });
  expect(f.devices.getDisplayMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } },
      audio: false,
    }),
  );
  f.resolve(stream);
  const capture = await work;
  capture.dispose();
});
it('rejects incomplete video choices before invoking native capture', async () => {
  const f = fixture();
  await expect(f.adapter.start({ sound: 'none', resolution: 720 })).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
});

describe('local display capture contract', () => {
  it('does not capture on construction; preserves the gesture stack and requests 1080p60 independently of bitrate', async () => {
    const f = fixture();
    expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
    const pending = f.adapter.start({ sound: 'none' });
    expect(f.devices.getDisplayMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } },
      audio: false,
      systemAudio: 'exclude',
      windowAudio: 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });
    const source = new Stream();
    f.resolve(source);
    const capture = await pending;
    expect(capture.stream).toBe(source.media);
    expect(capture.video).toBe(source.tracks[0]!.media);
    expect(capture.audio).toBeNull();
    expect(capture.localLabel).toBe('Synthetic source');
    expect(capture.sound).toBe('none');
    expect(Object.isFrozen(capture)).toBe(true);
    expect(f.devices.getUserMedia).not.toHaveBeenCalled();
    expect(f.devices.enumerateDevices).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    capture.dispose();
    expect(await capture.ended).toBe('stopped');
    expect(source.tracks[0]!.stop).toHaveBeenCalledOnce();
  });
  it.each(['browser', 'window', 'monitor'] as const)(
    'accepts explicitly video-only %s without claiming actual 60fps',
    async (displaySurface) => {
      const f = fixture(),
        source = new Stream();
      source.tracks[0]!.settings = { displaySurface, width: 1280, height: 720, frameRate: 30 };
      const pending = f.adapter.start({ sound: 'none' });
      f.resolve(source);
      expect((await pending).displaySurface).toBe(displaySurface);
    },
  );
  it('requires explicit consent and qualified selected-tab policy before opening a sound chooser', async () => {
    const f = fixture();
    await expect(f.adapter.start({ sound: undefined } as never)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(f.adapter.start({ sound: 'system' } as never)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(f.adapter.start({ sound: 'tab' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
    expect(f.devices.getUserMedia).not.toHaveBeenCalled();
  });
  it('accepts browser video-only capture without optional surface metadata and preserves cleanup', async () => {
    const f = fixture(),
      source = new Stream();
    delete source.tracks[0]!.settings.displaySurface;
    const pending = f.adapter.start({ sound: 'none' });
    f.resolve(source);
    const capture = await pending;
    expect(capture.displaySurface).toBe('unknown');
    expect(capture.audio).toBeNull();
    expect(f.devices.getDisplayMedia.mock.calls[0]![0].audio).toBe(false);
    expect(f.devices.getUserMedia).not.toHaveBeenCalled();
    expect(f.devices.enumerateDevices).not.toHaveBeenCalled();
    source.tracks[0]!.end();
    expect(await capture.ended).toBe('video-ended');
    expect(source.tracks[0]!.stop).toHaveBeenCalledOnce();
  });
  it.each([
    { desktop: true, surface: undefined, audio: false },
    { desktop: false, surface: 'unrecognized', audio: false },
    { desktop: false, surface: 'unknown', audio: false },
    { desktop: false, surface: undefined, audio: true },
  ])(
    'rejects unverified desktop, malformed metadata or unexpected audio %#',
    async ({ desktop, surface, audio }) => {
      const f = fixture({ desktop }),
        source = new Stream([new Track(), ...(audio ? [new Track('audio')] : [])]);
      source.tracks[0]!.settings.displaySurface = surface;
      const pending = f.adapter.start({ sound: 'none' });
      f.resolve(source);
      await expect(pending).rejects.toMatchObject({
        code: audio ? 'invalid_tracks' : 'unsupported',
      });
      expect(source.tracks.every((track) => track.stop.mock.calls.length === 1)).toBe(true);
      expect(f.devices.getDisplayMedia).toHaveBeenCalledOnce();
      expect(f.devices.getUserMedia).not.toHaveBeenCalled();
    },
  );
  it('accepts one consented selected-tab audio track under injected qualification, including legitimate silence', async () => {
    const f = fixture({ tabAudio: 'qualified-selected-tab' }),
      source = new Stream([new Track(), new Track('audio')]);
    source.tracks[1]!.muted = true;
    const pending = f.adapter.start({ sound: 'tab' });
    f.resolve(source);
    const capture = await pending;
    expect(f.devices.getDisplayMedia.mock.calls[0]![0].audio).toBe(true);
    expect(capture.audio).toBe(source.tracks[1]!.media);
    expect(capture.sound).toBe('tab');
    capture.dispose();
    expect(await capture.ended).toBe('stopped');
    expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });
  it.each(['window', 'monitor', undefined] as const)(
    'rejects an unsupported sound result for %s and disposes every returned track',
    async (displaySurface) => {
      const f = fixture({ tabAudio: 'qualified-selected-tab' }),
        source = new Stream([new Track(), new Track('audio')]);
      source.tracks[0]!.settings.displaySurface = displaySurface;
      const pending = f.adapter.start({ sound: 'tab' });
      f.resolve(source);
      await expect(pending).rejects.toMatchObject({ code: 'unsupported' });
      expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    },
  );
  it('fails and cleans up when requested sound is missing; never substitutes a microphone or retries video-only', async () => {
    const f = fixture({ tabAudio: 'qualified-selected-tab' }),
      source = new Stream();
    const pending = f.adapter.start({ sound: 'tab' });
    f.resolve(source);
    await expect(pending).rejects.toMatchObject({ code: 'missing_sound' });
    expect(source.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(f.devices.getDisplayMedia).toHaveBeenCalledOnce();
    expect(f.devices.getUserMedia).not.toHaveBeenCalled();
  });
  it.each([
    () => new Stream([]),
    () => new Stream([new Track('audio')]),
    () => new Stream([new Track(), new Track()]),
    () => new Stream([new Track(), new Track('audio'), new Track('audio')]),
    () => new Stream([new Track(), new Track('data')]),
    () => {
      const t = new Track();
      t.readyState = 'ended';
      return new Stream([t]);
    },
    () => {
      const t = new Track();
      t.enabled = false;
      return new Stream([t]);
    },
  ])('rejects missing, extra or unusable tracks %#', (make) => {
    const f = fixture(),
      source = make();
    const pending = f.adapter.start({ sound: 'none' });
    f.resolve(source);
    return expect(pending)
      .rejects.toMatchObject({ code: 'invalid_tracks' })
      .then(() => {
        expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
      });
  });
  it('rejects unsolicited audio in video-only mode instead of silently retaining or dropping it', async () => {
    const f = fixture(),
      source = new Stream([new Track(), new Track('audio')]);
    const pending = f.adapter.start({ sound: 'none' });
    f.resolve(source);
    await expect(pending).rejects.toMatchObject({ code: 'invalid_tracks' });
    expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });
  it.each(['ended', 'disabled'] as const)(
    'rejects %s source audio and cleans up video too',
    async (state) => {
      const f = fixture({ tabAudio: 'qualified-selected-tab' }),
        source = new Stream([new Track(), new Track('audio')]);
      if (state === 'ended') source.tracks[1]!.readyState = 'ended';
      else source.tracks[1]!.enabled = false;
      const pending = f.adapter.start({ sound: 'tab' });
      f.resolve(source);
      await expect(pending).rejects.toMatchObject({ code: 'invalid_tracks' });
      expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    },
  );
  it('rejects timer overflow instead of turning a long chooser deadline into an immediate timeout', () => {
    expect(() => new WebScreenCapture(undefined, { timeoutMs: 2147483648 })).toThrow(
      ScreenCaptureError,
    );
  });
  it.each(['NotAllowedError', 'AbortError', 'NotReadableError'])(
    'surfaces %s without fallback',
    async (name) => {
      const f = fixture(),
        error = new DOMException('Synthetic browser failure', name);
      const pending = f.adapter.start({ sound: 'none' });
      f.reject(error);
      await expect(pending).rejects.toMatchObject({
        code:
          name === 'NotAllowedError' ? 'denied' : name === 'AbortError' ? 'cancelled' : 'failed',
        cause: error,
      });
      expect(f.devices.getDisplayMedia).toHaveBeenCalledOnce();
    },
  );
  it('handles unavailable and synchronously failing boundaries with no leaked current attempt', async () => {
    await expect(new WebScreenCapture(undefined).start({ sound: 'none' })).rejects.toMatchObject({
      code: 'unsupported',
    });
    const f = fixture(),
      cause = new Error('Synthetic synchronous failure');
    f.devices.getDisplayMedia.mockImplementationOnce(() => {
      throw cause;
    });
    await expect(f.adapter.start({ sound: 'none' })).rejects.toMatchObject({ cause });
    const next = f.adapter.start({ sound: 'none' });
    f.resolve(new Stream());
    (await next).dispose();
  });
});

describe('capture ownership and obsolete completions', () => {
  it('does not open a chooser for a pre-aborted request', async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      f.adapter.start({ sound: 'none', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.devices.getDisplayMedia).not.toHaveBeenCalled();
  });
  it.each(['stop', 'abort', 'timeout', 'dispose'] as const)(
    'fences %s and disposes a late native picker result',
    async (action) => {
      const f = fixture(),
        signal = new AbortController(),
        source = new Stream([new Track(), new Track('audio')]);
      const pending = f.adapter.start({ sound: 'none', signal: signal.signal });
      const rejection = expect(pending).rejects.toMatchObject({
        code: action === 'timeout' ? 'timeout' : 'cancelled',
      });
      if (action === 'stop') f.adapter.stop();
      else if (action === 'dispose') f.adapter.dispose();
      else if (action === 'abort') signal.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      await expect(f.adapter.start({ sound: 'none' })).rejects.toMatchObject({
        code: action === 'dispose' ? 'disposed' : 'busy',
      });
      f.resolve(source);
      await flush();
      expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
      expect(f.devices.getDisplayMedia).toHaveBeenCalledOnce();
    },
  );
  it('consumes a late picker rejection after cancellation without reviving state or leaking a rejection', async () => {
    const f = fixture(),
      pending = f.adapter.start({ sound: 'none' });
    f.adapter.stop();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    f.reject(new DOMException('Late denial', 'NotAllowedError'));
    await flush();
    f.devices.getDisplayMedia.mockResolvedValueOnce(new Stream().media);
    (await f.adapter.start({ sound: 'none' })).dispose();
  });
  it('handles cancellation reentering the native boundary and accepts only cleanup from its late success', async () => {
    const f = fixture(),
      controller = new AbortController(),
      source = new Stream();
    f.devices.getDisplayMedia.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(source.media);
    });
    await expect(
      f.adapter.start({ sound: 'none', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await flush();
    expect(source.tracks[0]!.stop).toHaveBeenCalledOnce();
  });
  it('allows only one picker/owned source; invalid or competing starts cannot stop it', async () => {
    const f = fixture(),
      source = new Stream(),
      pending = f.adapter.start({ sound: 'none' });
    await expect(f.adapter.start({ sound: 'none' })).rejects.toMatchObject({ code: 'busy' });
    f.resolve(source);
    const capture = await pending;
    await expect(f.adapter.start({ sound: 'none' })).rejects.toMatchObject({ code: 'busy' });
    await expect(f.adapter.start({ sound: 'invalid' } as never)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(source.tracks[0]!.stop).not.toHaveBeenCalled();
    capture.dispose();
  });
  it.each(['video', 'audio'] as const)(
    'ends the entire owned result when %s ends, removes listeners and never continues silently',
    async (kind) => {
      const f = fixture({ tabAudio: 'qualified-selected-tab' }),
        source = new Stream([new Track(), new Track('audio')]);
      const pending = f.adapter.start({ sound: 'tab' });
      f.resolve(source);
      const capture = await pending;
      source.tracks.find((t) => t.kind === kind)!.end();
      expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
      expect(await capture.ended).toBe(kind === 'video' ? 'video-ended' : 'audio-ended');
      expect(source.removeEventListener).toHaveBeenCalledTimes(2);
      expect(source.tracks.every((t) => t.removeEventListener.mock.calls.length === 1)).toBe(true);
      capture.dispose();
      f.adapter.stop();
      expect(source.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    },
  );
  it.each(['add', 'remove'] as const)(
    'stops original and changed stream tracks on %s',
    async (mutation) => {
      const f = fixture(),
        original = new Track(),
        source = new Stream([original]);
      const pending = f.adapter.start({ sound: 'none' });
      f.resolve(source);
      const capture = await pending;
      const extra = new Track('audio');
      if (mutation === 'add') source.add(extra);
      else source.remove(original);
      expect(await capture.ended).toBe('stream-changed');
      expect(original.stop).toHaveBeenCalledOnce();
      expect(extra.stop).toHaveBeenCalledTimes(mutation === 'add' ? 1 : 0);
    },
  );
  it('old disposal and queued ended callbacks cannot stop a replacement source', async () => {
    const f = fixture(),
      old = new Stream(),
      pending = f.adapter.start({ sound: 'none' });
    f.resolve(old);
    const first = await pending;
    const endedCallback = old.tracks[0]!.addEventListener.mock.calls[0]![1] as () => void;
    first.dispose();
    const fresh = new Stream();
    f.devices.getDisplayMedia.mockResolvedValueOnce(fresh.media);
    const second = await f.adapter.start({ sound: 'none' });
    first.dispose();
    endedCallback();
    expect(fresh.tracks[0]!.stop).not.toHaveBeenCalled();
    second.dispose();
    expect(fresh.tracks[0]!.stop).toHaveBeenCalledOnce();
  });
  it('keeps AbortSignal ownership after handoff, clears the chooser timeout, and detaches on stop', async () => {
    const f = fixture(),
      controller = new AbortController(),
      source = new Stream();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = f.adapter.start({ sound: 'none', signal: controller.signal });
    f.resolve(source);
    const capture = await pending;
    await vi.advanceTimersByTimeAsync(2000);
    expect(source.tracks[0]!.stop).not.toHaveBeenCalled();
    controller.abort();
    expect(await capture.ended).toBe('cancelled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it('cleans up if settings inspection fails or the source ends before handoff', async () => {
    for (const fails of [true, false]) {
      const f = fixture(),
        source = new Stream();
      source.tracks[0]!.getSettings.mockImplementationOnce(() => {
        if (fails) throw new Error('Fixture settings unavailable');
        source.tracks[0]!.readyState = 'ended';
        return source.tracks[0]!.settings;
      });
      const pending = f.adapter.start({ sound: 'none' });
      f.resolve(source);
      await expect(pending).rejects.toBeInstanceOf(ScreenCaptureError);
      expect(source.tracks[0]!.stop).toHaveBeenCalledOnce();
      expect(source.removeEventListener.mock.calls.length).toBe(fails ? 0 : 2);
    }
  });
  it('disposal is permanent and synchronously ends active ownership', async () => {
    const f = fixture(),
      source = new Stream(),
      pending = f.adapter.start({ sound: 'none' });
    f.resolve(source);
    const capture: LocalScreenCapture = await pending;
    f.adapter.dispose();
    expect(source.tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(await capture.ended).toBe('disposed');
    await expect(f.adapter.start({ sound: 'none' })).rejects.toMatchObject({ code: 'disposed' });
  });
});
