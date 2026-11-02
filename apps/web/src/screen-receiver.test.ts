import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createScreenReceiveLane,
  type ScreenReceiveLane,
  type ScreenReceiveOptions,
} from './screen-receiver';
import type { ScreenPeerLifecycle, ScreenRtcPeer } from './screen-peer';
import type { ScreenPlaybackElement } from './screen-playback';
import { screenSdp } from '../../api/src/screen/signaling-fixture';

class Track extends EventTarget {
  readyState = 'live';
  enabled = true;
  constructor(readonly kind = 'video') {
    super();
  }
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
  get media() {
    return this as unknown as MediaStreamTrack;
  }
}
class Element extends EventTarget implements ScreenPlaybackElement {
  srcObject: HTMLVideoElement['srcObject'] = null;
  paused = true;
  muted = false;
  volume = 1;
  sinkId = '';
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
  setSinkId = vi.fn(async (id: string) => {
    this.sinkId = id;
  });
}
class Rtc extends EventTarget {
  config: RTCConfiguration = {};
  connectionState = 'new';
  callbacks = new Map<string, EventListener>();
  transceivers: { direction?: RTCRtpTransceiverDirection }[] = [];
  addEventListener = vi.fn((name: string, callback: EventListener) => {
    this.callbacks.set(name, callback);
    super.addEventListener(name, callback);
  });
  removeEventListener = vi.fn((name: string, callback: EventListener) => {
    this.callbacks.delete(name);
    super.removeEventListener(name, callback);
  });
  getConfiguration = vi.fn(() => this.config);
  getTransceivers = vi.fn(() => this.transceivers);
  addTransceiver = vi.fn((_kind: string, init: RTCRtpTransceiverInit) => {
    const transceiver = { direction: init.direction };
    this.transceivers.push(transceiver);
    return transceiver;
  });
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: 'offer',
    sdp: screenSdp('offer', true),
  }));
  createAnswer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: 'answer',
    sdp: screenSdp('answer', true),
  }));
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (description.type === 'offer' && !this.transceivers.length)
      this.transceivers = [...description.sdp!.matchAll(/^m=(?:video|audio) /gm)].map(() => ({
        direction: 'sendrecv',
      }));
  });
  setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  deliver(track: Track) {
    this.dispatchEvent(Object.assign(new Event('track'), { track: track.media }));
  }
  get boundary() {
    return this as unknown as ScreenRtcPeer;
  }
}
const lanes: ScreenReceiveLane[] = [],
  drains: (() => void)[] = [];
async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  drains.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}
function fixture(sound: 'none' | 'tab' | 'system' = 'tab') {
  const rtcs: Rtc[] = [],
    elements: Element[] = [];
  const outgoing = new Track(),
    sourceAudio = new Track('audio');
  const options = {
    createRtc: vi.fn((config: RTCConfiguration) => {
      const rtc = new Rtc();
      rtc.config = config;
      rtc.createAnswer.mockResolvedValue({
        type: 'answer',
        sdp: screenSdp('answer', sound !== 'none'),
      });
      rtcs.push(rtc);
      return rtc.boundary;
    }),
    createElement: vi.fn(() => {
      const element = new Element();
      elements.push(element);
      return element;
    }),
    createStream: vi.fn(
      (tracks: readonly MediaStreamTrack[]) => ({ getTracks: () => [...tracks] }) as MediaStream,
    ),
    onError: vi.fn(),
  };
  const lane = createScreenReceiveLane(options);
  lanes.push(lane);
  function selection() {
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
    const sent: unknown[] = [];
    const request: ScreenReceiveOptions = {
      endpoint: { epoch: randomUUID(), linkId: randomUUID(), role: 'viewer', sound },
      lifecycle,
      send: vi.fn<ScreenReceiveOptions['send']>(async (signal) => {
        sent.push(signal);
        return { ok: true, data: { delivered: true } };
      }),
      cleanup: vi.fn(async () => {}),
    };
    return {
      request,
      listeners,
      sent,
      current: () => current!,
      setCurrent: (value: typeof current) => {
        current = value;
      },
      invalidate: () => {
        current = null;
        for (const listener of [...listeners]) listener();
      },
    };
  }
  const selections: ReturnType<typeof selection>[] = [];
  function open() {
    const selected = selection();
    selections.push(selected);
    const receiver = lane.open(selected.request);
    return { ...selected, receiver, rtc: rtcs.at(-1)! };
  }
  const check = () => {
    expect(outgoing.stop).not.toHaveBeenCalled();
    expect(sourceAudio.stop).not.toHaveBeenCalled();
    for (const rtc of rtcs) {
      expect(rtc.close).toHaveBeenCalledOnce();
      expect(rtc.callbacks.size).toBe(0);
    }
    for (const element of elements)
      expect(element).toMatchObject({ paused: true, muted: true, srcObject: null });
    for (const selected of selections) expect(selected.listeners.size).toBe(0);
    expect(Object.values(lane.inspect().pending)).not.toContain(true);
  };
  checks.push(check);
  return { lane, options, rtcs, elements, outgoing, sourceAudio, selection, open };
}
const checks: (() => void)[] = [];
async function negotiated(f: ReturnType<ReturnType<typeof fixture>['open']>) {
  return f.receiver.receive({
    epoch: f.request.endpoint.epoch,
    linkId: f.request.endpoint.linkId,
    revision: 1,
    sequence: 1,
    payload: { type: 'offer', sdp: screenSdp('offer', f.request.endpoint.sound !== 'none') },
  });
}
async function ready(
  f: ReturnType<ReturnType<typeof fixture>['open']>,
  order = ['video', 'audio'],
) {
  await negotiated(f);
  const tracks = order
    .filter((kind) => f.request.endpoint.sound !== 'none' || kind === 'video')
    .map((kind) => new Track(kind));
  for (const track of tracks) f.rtc.deliver(track);
  return tracks;
}
async function playing(f: ReturnType<ReturnType<typeof fixture>['open']>) {
  const tracks = await ready(f);
  f.receiver.setOutput('exact-A');
  await f.receiver.play();
  return tracks;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T15:00:00Z'));
});
afterEach(async () => {
  for (const lane of lanes.splice(0)) lane.dispose();
  for (const drain of drains.splice(0)) drain();
  await flush();
  for (const check of checks.splice(0)) check();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('owns one direct recvonly peer and exposes a narrow lane with immutable local state', async () => {
  const f = fixture(),
    first = f.open();
  expect(Object.keys(f.lane).sort()).toEqual(['dispose', 'inspect', 'open']);
  expect(first.rtc.config).toMatchObject({ iceServers: [], iceCandidatePoolSize: 0 });
  expect(first.rtc.transceivers).toEqual([]);
  await negotiated(first);
  expect(first.rtc.transceivers.map((item) => item.direction)).toEqual(['recvonly', 'recvonly']);
  expect(first.receiver.inspect()).toMatchObject({
    phase: 'receiving',
    hasAudio: false,
    hasVideo: false,
    playback: null,
  });
  expect(Object.isFrozen(first.receiver.inspect())).toBe(true);
  expect(() => f.lane.open(f.selection().request)).toThrowError(/outstanding|owned/);
  expect(f.rtcs).toHaveLength(1);
  first.receiver.stop();
  await flush();
  expect(first.request.cleanup).toHaveBeenCalledExactlyOnceWith(
    { epoch: first.request.endpoint.epoch, linkId: first.request.endpoint.linkId },
    'stopped',
    expect.any(AbortSignal),
  );
});
it.each(['none', 'tab', 'system'] as const)(
  'collects exactly negotiated %s tracks without sound substitution',
  async (sound) => {
    const f = fixture(sound),
      selected = f.open();
    const tracks = await ready(selected, ['audio', 'video']);
    expect(selected.receiver.inspect()).toMatchObject({
      phase: 'ready',
      hasVideo: true,
      hasAudio: sound !== 'none',
    });
    expect(f.options.createElement).not.toHaveBeenCalled();
    selected.receiver.setOutput('exact-A');
    await selected.receiver.play();
    expect((f.elements[0]!.srcObject as MediaStream).getTracks()).toEqual([
      tracks.find((track) => track.kind === 'video')!.media,
      ...tracks.filter((track) => track.kind === 'audio').map((track) => track.media),
    ]);
    selected.receiver.stop();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  },
);
it('fails a missing requested sound track after the bounded wait instead of starting video-only', async () => {
  const f = fixture(),
    selected = f.open();
  await negotiated(selected);
  const video = new Track();
  selected.rtc.deliver(video);
  expect(() => selected.receiver.setOutput('exact-A')).toThrowError(/negotiated/);
  await expect(selected.receiver.play()).rejects.toMatchObject({ code: 'not-ready' });
  await vi.advanceTimersByTimeAsync(10000);
  expect(selected.receiver.inspect()).toMatchObject({
    phase: 'closed',
    reason: 'tracks-timeout',
    playback: null,
  });
  expect(video.stop).toHaveBeenCalledOnce();
  expect(f.options.createElement).not.toHaveBeenCalled();
  expect(selected.request.cleanup).toHaveBeenCalledOnce();
});
it.each(['duplicate-video', 'unexpected-audio', 'wrong-kind', 'ended'] as const)(
  'closes on %s track delivery',
  async (mode) => {
    const f = fixture(mode === 'unexpected-audio' ? 'none' : 'tab'),
      selected = f.open();
    await negotiated(selected);
    const first = new Track();
    selected.rtc.deliver(first);
    const bad = new Track(
      mode === 'unexpected-audio' ? 'audio' : mode === 'wrong-kind' ? 'data' : 'video',
    );
    if (mode === 'ended') bad.readyState = 'ended';
    selected.rtc.deliver(bad);
    await flush();
    expect(selected.receiver.inspect().phase).toBe('closed');
    expect(first.stop).toHaveBeenCalledOnce();
    expect(bad.stop).toHaveBeenCalledOnce();
    expect(selected.request.cleanup).toHaveBeenCalledOnce();
  },
);
it('ignores repeated delivery of the same track and never builds a second playback owner', async () => {
  const f = fixture(),
    selected = f.open(),
    tracks = await ready(selected);
  selected.rtc.deliver(tracks[0]!);
  selected.rtc.deliver(tracks[1]!);
  selected.receiver.setOutput('exact-A');
  await selected.receiver.play();
  expect(f.elements).toHaveLength(1);
  expect(selected.receiver.inspect().phase).toBe('ready');
});
it('keeps output/autoplay errors retryable and screen preferences independent from outgoing tracks', async () => {
  const f = fixture(),
    selected = f.open();
  await ready(selected);
  selected.receiver.setOutput('exact-A');
  selected.receiver.setVolume(0.3);
  selected.receiver.setMuted(true);
  selected.receiver.setDeafened(true);
  const element = new Element();
  element.play.mockRejectedValueOnce(new DOMException('Owned autoplay denial', 'NotAllowedError'));
  f.options.createElement.mockImplementationOnce(() => {
    f.elements.push(element);
    return element;
  });
  await expect(selected.receiver.play()).rejects.toMatchObject({ code: 'autoplay-blocked' });
  expect(selected.receiver.inspect().playback).toMatchObject({
    phase: 'blocked-autoplay',
    muted: true,
    deafened: true,
    volume: 0.3,
  });
  await selected.receiver.play();
  selected.receiver.setMuted(false);
  selected.receiver.setDeafened(false);
  expect(f.elements[1]).toMatchObject({ volume: 0.3, muted: false, paused: false });
  selected.receiver.outputLost('exact-A');
  expect(selected.receiver.inspect().playback?.phase).toBe('blocked-output');
  expect(selected.rtc.close).not.toHaveBeenCalled();
  expect(selected.request.cleanup).not.toHaveBeenCalled();
  expect(f.outgoing.enabled).toBe(true);
  expect(f.sourceAudio.enabled).toBe(true);
});
it.each(['hide', 'stop', 'dispose', 'invalidate', 'ended'] as const)(
  '%s closes playback and peer before asynchronous cleanup',
  async (action) => {
    const f = fixture(),
      selected = f.open(),
      tracks = await playing(selected),
      raw = deferred<void>();
    vi.mocked(selected.request.cleanup).mockImplementationOnce(async () => {
      expect(f.elements[0]).toMatchObject({ muted: true, paused: true, srcObject: null });
      expect(selected.rtc.close).toHaveBeenCalledOnce();
      for (const track of tracks) expect(track.readyState).toBe('ended');
      await raw.promise;
    });
    if (action === 'invalidate') selected.invalidate();
    else if (action === 'ended') tracks[0]!.end();
    else selected.receiver[action]();
    expect(selected.receiver.inspect().phase).toBe(action === 'hide' ? 'paused-hidden' : 'closed');
    expect(selected.receiver.inspect().cleanup).toMatchObject({ status: 'pending', pending: true });
    expect(selected.listeners.size).toBe(0);
    expect(() => f.lane.open(f.selection().request)).toThrow();
    selected.receiver.stop();
    selected.receiver.dispose();
    selected.receiver.hide();
    expect(selected.request.cleanup).toHaveBeenCalledOnce();
    raw.resolve();
    await flush();
    const next = f.open();
    await playing(next);
    expect(next.receiver.inspect().phase).toBe('ready');
  },
);
it.each(['sink', 'play'] as const)(
  'retains pending native %s admission after hide and observes late completion',
  async (stage) => {
    for (const late of ['resolve', 'reject']) {
      const f = fixture(),
        selected = f.open();
      await ready(selected);
      const raw = deferred<void>(),
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
      selected.receiver.setOutput('exact-A');
      const result = expect(selected.receiver.play()).rejects.toThrow();
      await flush();
      selected.receiver.hide();
      await result;
      await flush();
      expect(f.lane.inspect().pending.playback).toBe(true);
      for (let i = 0; i < 10; i++) expect(() => f.lane.open(f.selection().request)).toThrow();
      expect(f.rtcs).toHaveLength(1);
      if (late === 'resolve') raw.resolve();
      else raw.reject(new Error('Owned late native failure'));
      await flush();
      expect(element).toMatchObject({ muted: true, paused: true, srcObject: null });
      const next = f.open();
      await playing(next);
      expect(f.elements.at(-1)).toMatchObject({ paused: false, muted: false });
      expect(selected.receiver.inspect().phase).toBe('paused-hidden');
    }
  },
);
it.each(['rtc', 'signal'] as const)(
  'retains pending %s admission after logical disposal without overlapping replacement work',
  async (kind) => {
    const f = fixture(),
      selected = f.open(),
      raw = deferred<void>();
    if (kind === 'rtc') selected.rtc.setRemoteDescription.mockImplementationOnce(() => raw.promise);
    else
      vi.mocked(selected.request.send).mockImplementationOnce(async () => {
        await raw.promise;
        return { ok: true, data: { delivered: true } };
      });
    const result = expect(negotiated(selected)).rejects.toThrow();
    await flush();
    selected.receiver.stop();
    await result;
    await flush();
    expect(f.lane.inspect().pending[kind]).toBe(true);
    expect(() => f.lane.open(f.selection().request)).toThrow();
    raw.resolve();
    await flush();
    const next = f.open();
    await ready(next);
    expect(next.receiver.inspect().phase).toBe('ready');
  },
);
it.each(['resolve', 'reject'] as const)(
  'cleanup timeout is logical only; late %s is observed without reviving a view',
  async (late) => {
    const f = fixture(),
      selected = f.open(),
      raw = deferred<void>(),
      observer = vi.fn();
    vi.mocked(selected.request.cleanup).mockImplementationOnce(() => raw.promise);
    selected.receiver.subscribe(observer);
    selected.receiver.hide();
    const calls = observer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(selected.receiver.inspect().cleanup).toMatchObject({
      status: 'timed-out',
      pending: true,
    });
    expect(vi.mocked(selected.request.cleanup).mock.calls[0]![2].aborted).toBe(true);
    expect(() => f.lane.open(f.selection().request)).toThrow();
    if (late === 'resolve') raw.resolve();
    else raw.reject(new Error('Owned late cleanup failure'));
    await flush();
    expect(selected.receiver.inspect().cleanup).toMatchObject({
      status: 'timed-out',
      pending: false,
      late: late === 'resolve' ? 'succeeded' : 'failed',
    });
    expect(observer).toHaveBeenCalledTimes(calls);
    const next = f.open();
    await playing(next);
    expect(next.receiver.inspect().phase).toBe('ready');
    expect(f.options.onError).toHaveBeenCalled();
  },
);
it('pins cleanup to copied old references and never notifies old UI listeners after replacement', async () => {
  const f = fixture(),
    selected = f.open(),
    reference = {
      epoch: selected.request.endpoint.epoch,
      linkId: selected.request.endpoint.linkId,
    },
    observer = vi.fn();
  selected.receiver.subscribe(observer);
  selected.request.endpoint.linkId = randomUUID();
  selected.request.endpoint.sound = 'none';
  selected.receiver.stop();
  await flush();
  expect(selected.request.cleanup).toHaveBeenCalledWith(
    reference,
    'stopped',
    expect.any(AbortSignal),
  );
  const calls = observer.mock.calls.length,
    oldCallback = selected.rtc.callbacks.get('track');
  const next = f.open();
  await playing(next);
  oldCallback?.(Object.assign(new Event('track'), { track: new Track().media }));
  selected.receiver.dispose();
  await flush();
  expect(observer).toHaveBeenCalledTimes(calls);
  expect(next.receiver.inspect().phase).toBe('ready');
});
it('a retained late native track callback disposes only the obsolete peer track', async () => {
  const f = fixture(),
    selected = f.open();
  await negotiated(selected);
  const lateCallback = selected.rtc.callbacks.get('track')!;
  selected.receiver.stop();
  await flush();
  const next = f.open();
  await playing(next);
  const late = new Track();
  lateCallback(Object.assign(new Event('track'), { track: late.media }));
  expect(late.stop).toHaveBeenCalledOnce();
  expect(next.receiver.inspect().phase).toBe('ready');
  expect(f.elements.at(-1)!.paused).toBe(false);
});
it('clamps expiry without renewing it and ignores obsolete invalidation callbacks', async () => {
  const f = fixture(),
    selected = f.open(),
    obsolete = [...selected.listeners][0]!;
  selected.setCurrent({ generation: selected.current().generation, deadline: Date.now() + 20 });
  selected.receiver.inspect();
  await vi.advanceTimersByTimeAsync(20);
  expect(selected.receiver.inspect()).toMatchObject({ phase: 'closed', reason: 'expired' });
  await flush();
  const next = f.open();
  await playing(next);
  obsolete();
  expect(next.receiver.inspect().phase).toBe('ready');
});
it('a newer observed deadline cannot extend an already owned link', async () => {
  const f = fixture(),
    selected = f.open();
  await ready(selected);
  selected.setCurrent({ generation: selected.current().generation, deadline: Date.now() + 600000 });
  selected.receiver.inspect();
  await vi.advanceTimersByTimeAsync(60000);
  expect(selected.receiver.inspect()).toMatchObject({ reason: 'expired', phase: 'closed' });
});
it.each(['generation', 'null', 'exception'] as const)(
  'fails closed on unnotified %s lifecycle loss',
  async (kind) => {
    const f = fixture(),
      selected = f.open();
    await playing(selected);
    if (kind === 'generation')
      selected.setCurrent({ generation: {}, deadline: Date.now() + 60000 });
    if (kind === 'null') selected.setCurrent(null);
    if (kind === 'exception')
      vi.mocked(selected.request.lifecycle.inspect).mockImplementation(() => {
        throw new Error('Owned auth outage');
      });
    expect(selected.receiver.inspect().phase).toBe('closed');
  },
);
it('reentrant Stop during track collection prevents playback construction', async () => {
  const f = fixture(),
    selected = f.open();
  await negotiated(selected);
  selected.receiver.subscribe((state) => {
    if (state.hasVideo) selected.receiver.stop();
  });
  const video = new Track();
  selected.rtc.deliver(video);
  expect(selected.receiver.inspect().phase).toBe('closed');
  expect(video.stop).toHaveBeenCalledOnce();
  expect(f.options.createElement).not.toHaveBeenCalled();
});
it('disposes a peer returned after synchronous lifecycle loss inside its native factory', async () => {
  const f = fixture(),
    selected = f.selection(),
    rtc = new Rtc();
  f.options.createRtc.mockImplementationOnce((config) => {
    rtc.config = config;
    f.rtcs.push(rtc);
    selected.invalidate();
    return rtc.boundary;
  });
  expect(() => f.lane.open(selected.request)).toThrow();
  await flush();
  expect(rtc.close).toHaveBeenCalledOnce();
  expect(selected.listeners.size).toBe(0);
  expect(selected.request.cleanup).toHaveBeenCalledOnce();
});
it.each(['resolve', 'reject'] as const)(
  'fences disposal during initial inspection and retains cleanup through late %s',
  async (late) => {
    const f = fixture(),
      selected = f.selection(),
      snapshot = selected.current(),
      raw = deferred<void>(),
      lateError = new Error('Owned late construction cleanup failure');
    let leaked: ReturnType<ScreenReceiveLane['open']> | undefined;
    vi.mocked(selected.request.lifecycle.inspect).mockImplementationOnce(() => {
      f.lane.dispose();
      f.lane.dispose();
      return snapshot;
    });
    vi.mocked(selected.request.cleanup).mockImplementationOnce(() => {
      f.lane.dispose();
      return raw.promise;
    });
    try {
      expect(() => {
        leaked = f.lane.open(selected.request);
      }).toThrow();
      expect(f.lane.inspect()).toMatchObject({
        disposed: true,
        occupied: false,
        pending: { cleanup: true, rtc: false, playback: false, signal: false },
      });
      expect(selected.request.lifecycle.inspect).toHaveBeenCalledOnce();
      expect(selected.request.lifecycle.onInvalidated).not.toHaveBeenCalled();
      expect(selected.request.send).not.toHaveBeenCalled();
      expect(f.options.createRtc).not.toHaveBeenCalled();
      expect(f.options.createElement).not.toHaveBeenCalled();
      expect(selected.request.cleanup).toHaveBeenCalledExactlyOnceWith(
        { epoch: selected.request.endpoint.epoch, linkId: selected.request.endpoint.linkId },
        'disposed',
        expect.any(AbortSignal),
      );
      const signal = vi.mocked(selected.request.cleanup).mock.calls[0]![2];
      await vi.advanceTimersByTimeAsync(5000);
      expect(signal.aborted).toBe(true);
      expect(f.lane.inspect().pending.cleanup).toBe(true);
      f.lane.dispose();
      expect(selected.request.cleanup).toHaveBeenCalledOnce();
      expect(() => f.lane.open(f.selection().request)).toThrow();
      if (late === 'resolve') raw.resolve();
      else raw.reject(lateError);
      await flush();
      expect(f.lane.inspect()).toMatchObject({ disposed: true, occupied: false });
      expect(f.lane.inspect().pending.cleanup).toBe(false);
      if (late === 'reject')
        expect(f.options.onError).toHaveBeenLastCalledWith(
          expect.objectContaining({ message: 'Selection cleanup failed.', cause: lateError }),
        );
      expect(f.options.onError).toHaveBeenCalledTimes(late === 'reject' ? 3 : 2);
      expect(selected.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.options.createRtc).not.toHaveBeenCalled();
    } finally {
      leaked?.dispose();
      raw.resolve();
      await flush();
    }
  },
);
it.each(['throw', 'missing', 'expired'] as const)(
  'cleans up an initial %s inspection failure before admitting a replacement',
  async (kind) => {
    const f = fixture(),
      selected = f.selection(),
      raw = deferred<void>(),
      failure = new Error('Owned initial inspection failure');
    vi.mocked(selected.request.lifecycle.inspect).mockImplementationOnce(() => {
      if (kind === 'throw') throw failure;
      return kind === 'missing' ? null : { generation: {}, deadline: Date.now() };
    });
    vi.mocked(selected.request.cleanup).mockImplementationOnce(() => raw.promise);
    expect(() => f.lane.open(selected.request)).toThrow();
    expect(selected.request.cleanup).toHaveBeenCalledExactlyOnceWith(
      { epoch: selected.request.endpoint.epoch, linkId: selected.request.endpoint.linkId },
      'failed',
      expect.any(AbortSignal),
    );
    expect(f.lane.inspect()).toMatchObject({
      disposed: false,
      occupied: false,
      pending: { cleanup: true },
    });
    expect(selected.request.lifecycle.onInvalidated).not.toHaveBeenCalled();
    expect(f.options.createRtc).not.toHaveBeenCalled();
    expect(() => f.lane.open(f.selection().request)).toThrow();
    expect(f.options.onError).toHaveBeenCalledOnce();
    if (kind === 'throw') expect(f.options.onError).toHaveBeenCalledWith(failure);
    raw.resolve();
    await flush();
    const next = f.open();
    await ready(next);
    expect(next.receiver.inspect().phase).toBe('ready');
    expect(selected.listeners.size).toBe(0);
    expect(selected.request.cleanup).toHaveBeenCalledOnce();
  },
);
it('cleans up once when initial inspection disposes the lane and then throws', async () => {
  const f = fixture(),
    selected = f.selection(),
    failure = new Error('Owned inspection failure after disposal');
  vi.mocked(selected.request.lifecycle.inspect).mockImplementationOnce(() => {
    f.lane.dispose();
    throw failure;
  });
  expect(() => f.lane.open(selected.request)).toThrow(failure);
  f.lane.dispose();
  await flush();
  expect(selected.request.cleanup).toHaveBeenCalledExactlyOnceWith(
    { epoch: selected.request.endpoint.epoch, linkId: selected.request.endpoint.linkId },
    'disposed',
    expect.any(AbortSignal),
  );
  expect(f.lane.inspect()).toMatchObject({ disposed: true, occupied: false });
  expect(f.options.createRtc).not.toHaveBeenCalled();
  expect(selected.request.lifecycle.onInvalidated).not.toHaveBeenCalled();
  expect(f.options.onError).toHaveBeenCalledExactlyOnceWith(failure);
});
it('allows reentrant lane inspection before the initial lifecycle snapshot is installed', async () => {
  const f = fixture(),
    selected = f.selection(),
    snapshot = selected.current();
  vi.mocked(selected.request.lifecycle.inspect).mockImplementationOnce(() => {
    expect(f.lane.inspect()).toMatchObject({ occupied: true, disposed: false });
    return snapshot;
  });
  const receiver = f.lane.open(selected.request);
  expect(receiver.inspect().phase).toBe('receiving');
  expect(selected.request.cleanup).not.toHaveBeenCalled();
  expect(f.options.createRtc).toHaveBeenCalledOnce();
  expect(f.options.onError).not.toHaveBeenCalled();
  receiver.dispose();
  await flush();
  expect(selected.listeners.size).toBe(0);
});
it('cleans up construction failure without accepting another active peer', async () => {
  const f = fixture(),
    selected = f.selection(),
    rtc = new Rtc();
  f.options.createRtc.mockImplementationOnce(() => {
    f.rtcs.push(rtc);
    rtc.getConfiguration.mockImplementationOnce(() => {
      throw new Error('Owned config failure');
    });
    return rtc.boundary;
  });
  expect(() => f.lane.open(selected.request)).toThrow();
  await flush();
  expect(rtc.close).toHaveBeenCalledOnce();
  expect(selected.listeners.size).toBe(0);
  expect(selected.request.cleanup).toHaveBeenCalledOnce();
});
it('continues local cleanup and reports failures when pause, peer close or selection cleanup rejects', async () => {
  const f = fixture(),
    selected = f.open(),
    tracks = await playing(selected);
  f.elements[0]!.pause.mockImplementationOnce(() => {
    f.elements[0]!.paused = true;
    throw new Error('Owned pause failure');
  });
  selected.rtc.close.mockImplementationOnce(() => {
    selected.rtc.connectionState = 'closed';
    throw new Error('Owned peer close failure');
  });
  vi.mocked(selected.request.cleanup).mockRejectedValueOnce(
    new Error('Owned remote cleanup failure'),
  );
  selected.receiver.stop();
  await flush();
  expect(selected.receiver.inspect().cleanup).toMatchObject({ status: 'failed', pending: false });
  expect(selected.listeners.size).toBe(0);
  for (const track of tracks) expect(track.readyState).toBe('ended');
  expect(f.options.onError).toHaveBeenCalled();
});
it('fences disposed lane work while allowing independent lanes and outgoing sources to continue', async () => {
  const first = fixture(),
    old = first.open(),
    independent = fixture(),
    current = independent.open();
  await playing(old);
  await playing(current);
  first.lane.dispose();
  first.lane.dispose();
  expect(() => first.lane.open(first.selection().request)).toThrow();
  expect(current.receiver.inspect().phase).toBe('ready');
  expect(independent.elements[0]!.paused).toBe(false);
  expect(first.outgoing.stop).not.toHaveBeenCalled();
  expect(first.sourceAudio.stop).not.toHaveBeenCalled();
});
it('rejects malformed or publisher endpoints before allocating any native peer', () => {
  const f = fixture(),
    selected = f.selection();
  expect(() =>
    f.lane.open({
      ...selected.request,
      endpoint: { ...selected.request.endpoint, role: 'publisher' },
    } as unknown as ScreenReceiveOptions),
  ).toThrow();
  expect(() =>
    f.lane.open({
      ...selected.request,
      endpoint: { ...selected.request.endpoint, authorized: true },
    } as unknown as ScreenReceiveOptions),
  ).toThrow();
  expect(f.options.createRtc).not.toHaveBeenCalled();
});

it.each(['epoch', 'link', 'replay', 'malformed', 'oversized'] as const)(
  'rejects %s signaling without invoking native work or replacing the selected view',
  async (kind) => {
    const f = fixture(),
      selected = f.open();
    await playing(selected);
    const signal = {
      epoch: selected.request.endpoint.epoch,
      linkId: selected.request.endpoint.linkId,
      revision: 2,
      sequence: 2,
      payload: { type: 'offer', sdp: screenSdp('offer', true) },
    };
    if (kind === 'epoch') signal.epoch = randomUUID();
    if (kind === 'link') signal.linkId = randomUUID();
    if (kind === 'replay') signal.sequence = 1;
    if (kind === 'malformed') signal.payload.sdp = 'invalid';
    if (kind === 'oversized') signal.payload.sdp += 'x'.repeat(13000);
    await expect(selected.receiver.receive(signal)).rejects.toThrow();
    expect(selected.rtc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(selected.receiver.inspect().phase).toBe('ready');
    expect(selected.request.cleanup).not.toHaveBeenCalled();
  },
);
it('retains the native slot after playback timeout and local Stop, with no replacement allocation', async () => {
  const f = fixture(),
    selected = f.open(),
    raw = deferred<void>(),
    element = new Element();
  await ready(selected);
  f.options.createElement.mockImplementationOnce(() => {
    f.elements.push(element);
    return element;
  });
  element.setSinkId.mockImplementationOnce(async (id) => {
    await raw.promise;
    element.sinkId = id;
  });
  selected.receiver.setOutput('exact-A');
  const result = expect(selected.receiver.play()).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(5000);
  await result;
  expect(selected.receiver.inspect().playback).toMatchObject({
    phase: 'error',
    pendingNative: true,
  });
  await expect(selected.receiver.play()).rejects.toMatchObject({ code: 'busy' });
  selected.receiver.stop();
  await flush();
  expect(() => f.lane.open(f.selection().request)).toThrow();
  expect(f.rtcs).toHaveLength(1);
  raw.resolve();
  await flush();
  const next = f.open();
  await playing(next);
  expect(next.receiver.inspect().phase).toBe('ready');
});
it('rejects reentrant open during native construction and cleanup, without allocating extra peers', async () => {
  const f = fixture(),
    selected = f.selection(),
    create = f.options.createRtc.getMockImplementation()!;
  f.options.createRtc.mockImplementationOnce((config) => {
    expect(() => f.lane.open(f.selection().request)).toThrow();
    return create(config);
  });
  const receiver = f.lane.open(selected.request);
  vi.mocked(selected.request.cleanup).mockImplementationOnce(async (reference) => {
    expect(Object.isFrozen(reference)).toBe(true);
    expect(() => f.lane.open(f.selection().request)).toThrow();
    expect(f.rtcs[0]!.close).toHaveBeenCalledOnce();
    expect(Object.keys(reference).sort()).toEqual(['epoch', 'linkId']);
  });
  receiver.stop();
  await flush();
  expect(f.rtcs).toHaveLength(1);
});
it('cleans up a failed lifecycle subscription before creating a native peer', async () => {
  const f = fixture(),
    selected = f.selection();
  vi.mocked(selected.request.lifecycle.onInvalidated).mockImplementationOnce(() => {
    throw new Error('Owned subscription failure');
  });
  expect(() => f.lane.open(selected.request)).toThrow();
  await flush();
  expect(selected.request.cleanup).toHaveBeenCalledOnce();
  expect(f.options.createRtc).not.toHaveBeenCalled();
  expect(f.lane.inspect().occupied).toBe(false);
});
it('handles invalidation during partial playback construction without leaking track listeners', async () => {
  const f = fixture(),
    selected = f.open();
  await negotiated(selected);
  const video = new Track(),
    audio = new Track('audio');
  const addVideo = vi.spyOn(video, 'addEventListener'),
    removeVideo = vi.spyOn(video, 'removeEventListener');
  const removeAudio = vi.spyOn(audio, 'removeEventListener');
  const addAudio = vi
    .spyOn(audio, 'addEventListener')
    .mockImplementation((name, listener, options) => {
      EventTarget.prototype.addEventListener.call(audio, name, listener, options);
      if (addAudio.mock.calls.length === 2) selected.invalidate();
    });
  selected.rtc.deliver(video);
  selected.rtc.deliver(audio);
  await flush();
  expect(selected.receiver.inspect().phase).toBe('closed');
  expect(f.options.createElement).not.toHaveBeenCalled();
  expect(removeVideo.mock.calls.length).toBe(addVideo.mock.calls.length);
  expect(removeAudio.mock.calls.length).toBe(addAudio.mock.calls.length);
  expect(selected.request.cleanup).toHaveBeenCalledOnce();
});
it.each(['rtc', 'element'] as const)(
  'does not reuse or alter a different lane’s owned %s',
  async (kind) => {
    const first = fixture(),
      current = first.open();
    await playing(current);
    const second = fixture(),
      selected = second.selection();
    if (kind === 'rtc') {
      second.options.createRtc.mockReturnValueOnce(current.rtc.boundary);
      expect(() => second.lane.open(selected.request)).toThrow();
    } else {
      const next = second.open();
      await ready(next);
      second.options.createElement.mockReturnValueOnce(first.elements[0]!);
      next.receiver.setOutput('exact-other');
      await expect(next.receiver.play()).rejects.toThrow();
    }
    expect(current.rtc.close).not.toHaveBeenCalled();
    expect(first.elements[0]).toMatchObject({ muted: false, paused: false });
    expect(current.receiver.inspect().phase).toBe('ready');
  },
);
it('observes a synchronous cleanup exception and releases only its completed raw slot', async () => {
  const f = fixture(),
    selected = f.open();
  vi.mocked(selected.request.cleanup).mockImplementationOnce(() => {
    throw undefined;
  });
  selected.receiver.stop();
  await flush();
  expect(selected.receiver.inspect().cleanup).toMatchObject({ status: 'failed', pending: false });
  expect(f.options.onError).toHaveBeenCalled();
  const next = f.open();
  await playing(next);
  expect(next.receiver.inspect().phase).toBe('ready');
});
