import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ScreenPeer, type ScreenRtcPeer, type ScreenPeerLifecycle } from './screen-peer';
import type { ScreenAck, ScreenSignal, ScreenSound } from '@tricord/shared';
import { signal as serverSignal } from '../../api/src/screen/signaling';
import { screenSdp, screenIce } from '../../api/src/screen/signaling-fixture';
import { publicScreenIceServers } from './screen-ice';

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
  settings: MediaTrackSettings = { width: 1920, height: 1080, frameRate: 60 };
  getSettings() {
    return { ...this.settings };
  }
  applyConstraints = vi.fn(async () => {});
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(readonly kind = 'video') {
    super();
  }
  get media() {
    return this as unknown as MediaStreamTrack;
  }
}
class Sender {
  parameters: RTCRtpSendParameters = {
    transactionId: '',
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    encodings: [{ active: true }],
  };
  private transaction = 0;
  constructor(public track: MediaStreamTrack | null) {}
  getParameters = vi.fn(() =>
    structuredClone({ ...this.parameters, transactionId: String(++this.transaction) }),
  );
  setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
    this.parameters = structuredClone(parameters);
  });
}
class Rtc extends EventTarget {
  config: RTCConfiguration = {};
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState = 'new';
  callbacks = new Map<string, EventListener>();
  transceivers: { direction: string }[] = [];
  senders: Sender[] = [];
  addEventListener = vi.fn((type: string, listener: EventListener) => {
    this.callbacks.set(type, listener);
    super.addEventListener(type, listener);
  });
  removeEventListener = vi.fn((type: string, listener: EventListener) => {
    this.callbacks.delete(type);
    super.removeEventListener(type, listener);
  });
  getConfiguration = vi.fn(() => this.config);
  addTransceiver = vi.fn((_track: MediaStreamTrack, init: RTCRtpTransceiverInit) => {
    const sender = new Sender(_track);
    this.senders.push(sender);
    const transceiver = { direction: init.direction!, sender };
    this.transceivers.push(transceiver);
    return transceiver;
  });
  getTransceivers = vi.fn(() => this.transceivers);
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: 'offer',
    sdp: screenSdp('offer', false),
  }));
  createAnswer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: 'answer',
    sdp: screenSdp('answer', false),
  }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  emit(type: string, fields: object) {
    this.dispatchEvent(Object.assign(new Event(type), fields));
  }
  get boundary() {
    return this as unknown as ScreenRtcPeer;
  }
}
const peers: ScreenPeer[] = [];
const drains: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const ack = (): ScreenAck<{ delivered: true }> => ({ ok: true, data: { delivered: true } });
it('applies selected initial video ceilings before an offer can send media', () => {
  const quality = { profile: 'smooth', resolution: 720, frameRate: 60, videoBitrate: 4000000 };
  const f = fixture('publisher', 'none', (options) => {
    options.initialVideoQuality = {
      revision: 1,
      publisher: quality,
      viewer: { ...quality, frameRate: 30, videoBitrate: 2000000 },
    };
  });
  expect(f.rtc.addTransceiver).toHaveBeenCalledWith(f.video.media, {
    direction: 'sendonly',
    sendEncodings: [{ maxBitrate: 2000000, maxFramerate: 30, scaleResolutionDownBy: 1.5 }],
  });
});
it('uses only the explicitly supplied screen STUN policy and validates native readback', () => {
  const f = fixture('viewer', 'none', (options) => {
    options.iceServers = publicScreenIceServers;
  });
  expect(f.rtc.config.iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  expect(f.rtc.config.iceTransportPolicy).toBe('all');
  const create = vi.fn();
  expect(() =>
    fixture('viewer', 'none', (options) => {
      options.iceServers = [{ urls: 'turn:relay.example:3478' }];
      options.createPeer = create;
    }),
  ).toThrow('credentials');
  expect(create).not.toHaveBeenCalled();
});
function fixture(
  role: 'publisher' | 'viewer' = 'publisher',
  sound: ScreenSound = 'none',
  tweak?: (options: ConstructorParameters<typeof ScreenPeer>[0]) => void,
) {
  const rtc = new Rtc(),
    video = new Track(),
    audio = new Track('audio');
  let current: ReturnType<ScreenPeerLifecycle['inspect']> = {
    generation: {},
    deadline: Date.now() + 60000,
  };
  const listeners = new Set<() => void>();
  const sent: ScreenSignal[] = [];
  const options: ConstructorParameters<typeof ScreenPeer>[0] = {
    endpoint: { epoch: randomUUID(), linkId: randomUUID(), role, sound },
    lifecycle: {
      inspect: () => current,
      onInvalidated: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    createPeer: vi.fn((config) => {
      rtc.config = config;
      return rtc.boundary;
    }),
    send: vi.fn(async (signal) => {
      sent.push(serverSignal(signal));
      return ack();
    }),
    ...(role === 'publisher'
      ? { source: { video: video.media, audio: sound === 'none' ? null : audio.media, sound } }
      : {}),
    onTrack: vi.fn(),
    onError: vi.fn(),
  };
  rtc.createOffer.mockResolvedValue({ type: 'offer', sdp: screenSdp('offer', sound !== 'none') });
  rtc.createAnswer.mockResolvedValue({
    type: 'answer',
    sdp: screenSdp('answer', sound !== 'none'),
  });
  tweak?.(options);
  const peer = new ScreenPeer(options);
  peers.push(peer);
  const message = (payload: ScreenSignal['payload'], sequence = 1, revision = 1) => ({
    epoch: options.endpoint.epoch,
    linkId: options.endpoint.linkId,
    sequence,
    revision,
    payload,
  });
  return {
    peer,
    rtc,
    video,
    audio,
    options,
    sent,
    listeners,
    message,
    revoke: () => listeners.forEach((listener) => listener()),
    setCurrent: (value: typeof current) => {
      current = value;
    },
    current: () => current!,
  };
}
async function stable(f: ReturnType<typeof fixture>) {
  if (f.options.endpoint.role === 'publisher') {
    await f.peer.offer();
    await f.peer.receive(
      f.message({ type: 'answer', sdp: screenSdp('answer', f.options.endpoint.sound !== 'none') }),
    );
  } else
    await f.peer.receive(
      f.message({ type: 'offer', sdp: screenSdp('offer', f.options.endpoint.sound !== 'none') }),
    );
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  peers.splice(0).forEach((peer) => peer.dispose());
  drains.splice(0).forEach((drain) => drain());
  await flush();
  vi.useRealTimers();
});

it('constructs only one direct peer with borrowed send-only tracks and no negotiation', () => {
  const f = fixture('publisher', 'tab');
  expect(f.options.createPeer).toHaveBeenCalledOnce();
  expect(f.rtc.config).toMatchObject({
    iceServers: [],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 0,
  });
  expect(
    f.rtc.addTransceiver.mock.calls.map(([track, init]) => [track.kind, init.direction]),
  ).toEqual([
    ['video', 'sendonly'],
    ['audio', 'sendonly'],
  ]);
  expect(f.rtc.createOffer).not.toHaveBeenCalled();
  expect(f.options.send).not.toHaveBeenCalled();
  f.peer.dispose();
  f.peer.dispose();
  expect(f.video.stop).not.toHaveBeenCalled();
  expect(f.audio.stop).not.toHaveBeenCalled();
  expect(f.rtc.close).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(f.rtc.callbacks.size).toBe(0);
});

it.each(['none', 'tab', 'system'] as const)(
  'publisher-only offer/answer uses the existing server envelope with %s sound',
  async (sound) => {
    const f = fixture('publisher', sound);
    await stable(f);
    expect(f.peer.inspect()).toEqual({ phase: 'stable', revision: 1 });
    expect(f.sent[0]!.payload.type).toBe('offer');
    await f.peer.offer();
    expect(f.sent.at(-1)!.revision).toBe(2);
    expect(f.sent.at(-1)!.sequence).toBe(2);
    expect(f.options.onTrack).not.toHaveBeenCalled();
  },
);

it('viewer answers without publishing or creating an offer', async () => {
  const f = fixture('viewer', 'tab');
  await expect(f.peer.offer()).rejects.toThrow('publisher');
  await stable(f);
  expect(f.sent[0]!.payload.type).toBe('answer');
  expect(f.rtc.addTransceiver).not.toHaveBeenCalled();
  expect(f.rtc.createOffer).not.toHaveBeenCalled();
});

it.each(['relay', 'stun', 'pool'] as const)(
  'rejects injected %s configuration and closes partial resources',
  (mode) => {
    const rtc = new Rtc();
    expect(() =>
      fixture('viewer', 'none', (options) => {
        options.createPeer = () => {
          rtc.config =
            mode === 'relay'
              ? { iceTransportPolicy: 'relay' }
              : mode === 'stun'
                ? { iceServers: [{ urls: 'stun:invalid.example' }] }
                : { iceCandidatePoolSize: 1 };
          return rtc.boundary;
        };
      }),
    ).toThrow('configuration');
    expect(rtc.close).toHaveBeenCalledOnce();
  },
);

it.each(['missing', 'ended', 'disabled', 'microphone', 'unconsented'] as const)(
  'rejects %s source policy before allocating a peer',
  (mode) => {
    const createPeer = vi.fn();
    expect(() =>
      fixture('publisher', 'tab', (options) => {
        options.createPeer = createPeer;
        if (mode === 'missing') options.source = undefined;
        else if (mode === 'ended' || mode === 'disabled' || mode === 'microphone') {
          const video = new Track(mode === 'microphone' ? 'audio' : 'video');
          if (mode === 'ended') video.stop();
          else if (mode === 'disabled') video.enabled = false;
          options.source = { ...options.source!, video: video.media };
        } else options.source = { ...options.source!, audio: null };
      }),
    ).toThrow();
    expect(createPeer).not.toHaveBeenCalled();
  },
);

it('requires independent current lifecycle before constructing, not an authorizeLink object', () => {
  const createPeer = vi.fn();
  expect(() =>
    fixture('viewer', 'none', (options) => {
      options.createPeer = createPeer;
      options.lifecycle.inspect = () => null;
    }),
  ).toThrow('lifecycle');
  expect(createPeer).not.toHaveBeenCalled();
});

it.each(['offer', 'local', 'remote', 'answer', 'candidate', 'send'] as const)(
  'disposal logically cancels held %s work and observes late rejection',
  async (operation) => {
    const raw = deferred<never>();
    drains.push(() => raw.reject(new Error('Owned late failure')));
    const f = fixture(operation === 'answer' || operation === 'remote' ? 'viewer' : 'publisher');
    let result: Promise<void>;
    if (operation === 'offer') f.rtc.createOffer.mockImplementation(() => raw.promise);
    if (operation === 'local') f.rtc.setLocalDescription.mockImplementation(() => raw.promise);
    if (operation === 'send') vi.mocked(f.options.send).mockImplementation(() => raw.promise);
    if (operation === 'remote') f.rtc.setRemoteDescription.mockImplementation(() => raw.promise);
    if (operation === 'answer') f.rtc.createAnswer.mockImplementation(() => raw.promise);
    if (operation === 'candidate') {
      await stable(f);
      f.rtc.addIceCandidate.mockImplementation(() => raw.promise);
      result = f.peer.receive(f.message({ type: 'ice', candidate: screenIce }, 2));
    } else
      result =
        f.options.endpoint.role === 'publisher'
          ? f.peer.offer()
          : f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) }));
    const rejected = expect(result).rejects.toThrow('closed');
    await flush();
    const count = f.sent.length;
    f.peer.dispose();
    await rejected;
    raw.reject(new Error('Owned late failure'));
    await flush();
    expect(f.sent).toHaveLength(count);
    expect(f.rtc.close).toHaveBeenCalledOnce();
    expect(f.video.stop).not.toHaveBeenCalled();
  },
);

it('revocation cancels a held offer promptly and its late success cannot touch a replacement', async () => {
  const raw = deferred<RTCSessionDescriptionInit>();
  drains.push(() => raw.resolve({ type: 'offer', sdp: screenSdp('offer', false) }));
  const old = fixture();
  old.rtc.createOffer.mockImplementation(() => raw.promise);
  const offered = old.peer.offer();
  const rejected = expect(offered).rejects.toThrow('lifecycle');
  old.revoke();
  await rejected;
  const next = fixture();
  await stable(next);
  raw.resolve({ type: 'offer', sdp: screenSdp('offer', false) });
  await flush();
  expect(old.rtc.setLocalDescription).not.toHaveBeenCalled();
  expect(old.sent).toHaveLength(0);
  expect(next.peer.inspect().phase).toBe('stable');
  expect(next.rtc.close).not.toHaveBeenCalled();
});

it('rechecks generation after every await and never extends its captured deadline', async () => {
  const f = fixture();
  const raw = deferred<RTCSessionDescriptionInit>();
  f.rtc.createOffer.mockImplementation(() => raw.promise);
  const result = f.peer.offer();
  const rejected = expect(result).rejects.toThrow('lifecycle');
  f.setCurrent({ generation: {}, deadline: Date.now() + 100000 });
  raw.resolve({ type: 'offer', sdp: screenSdp('offer', false) });
  await rejected;
  expect(f.rtc.setLocalDescription).not.toHaveBeenCalled();
  const next = fixture();
  const original = next.current();
  next.setCurrent({ ...original, deadline: Date.now() + 100000 });
  await vi.advanceTimersByTimeAsync(60000);
  expect(next.peer.inspect().phase).toBe('closed');
});

it('a shorter lifecycle deadline and a hung negotiation stop without waiting for native work', async () => {
  const f = fixture();
  f.setCurrent({ ...f.current(), deadline: Date.now() + 5 });
  await f.peer.offer();
  await vi.advanceTimersByTimeAsync(5);
  expect(f.peer.inspect().phase).toBe('closed');
  const next = fixture();
  const raw = deferred<RTCSessionDescriptionInit>();
  drains.push(() => raw.resolve({ type: 'offer', sdp: screenSdp('offer', false) }));
  next.rtc.createOffer.mockImplementation(() => raw.promise);
  const rejected = expect(next.peer.offer()).rejects.toThrow('timeout');
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
});

it.each(['publisher', 'viewer'] as const)(
  'ignores empty gathering-complete markers without closing the %s or consuming ICE budget',
  async (role) => {
    const f = fixture(role);
    if (role === 'publisher') await f.peer.offer();
    else await f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) }));
    f.rtc.emit('icecandidate', { candidate: null });
    for (let i = 0; i < 129; i++)
      f.rtc.emit('icecandidate', { candidate: { ...screenIce, candidate: '' } });
    f.rtc.emit('icecandidate', { candidate: screenIce });
    await flush();
    expect(f.options.onError).not.toHaveBeenCalled();
    expect(f.rtc.close).not.toHaveBeenCalled();
    expect(f.sent.map((signal) => signal.payload.type)).toEqual([
      role === 'publisher' ? 'offer' : 'answer',
      'ice',
    ]);
    expect(f.sent.map((signal) => signal.sequence)).toEqual([1, 2]);
  },
);

it('still rejects malformed nonempty local candidates', async () => {
  const f = fixture();
  await f.peer.offer();
  f.rtc.emit('icecandidate', { candidate: { ...screenIce, candidate: ' ' } });
  await flush();
  expect(f.options.onError).toHaveBeenCalledWith(
    expect.objectContaining({
      errors: [expect.objectContaining({ message: 'Invalid screen signaling envelope.' })],
    }),
  );
  expect(f.rtc.close).toHaveBeenCalledOnce();
  expect(f.sent).toHaveLength(1);
});

it('serializes early ICE after offer delivery and viewer ICE after answer delivery', async () => {
  for (const role of ['publisher', 'viewer'] as const) {
    const f = fixture(role);
    const delivery = deferred<ScreenAck<{ delivered: true }>>();
    drains.push(() => delivery.resolve(ack()));
    vi.mocked(f.options.send).mockImplementationOnce(async (value) => {
      f.sent.push(serverSignal(value));
      return delivery.promise;
    });
    f.rtc.setLocalDescription.mockImplementation(async (value) => {
      f.rtc.localDescription = value;
      f.rtc.emit('icecandidate', { candidate: screenIce });
    });
    const result =
      role === 'publisher'
        ? f.peer.offer()
        : f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) }));
    await flush();
    expect(f.sent.map((signal) => signal.payload.type)).toEqual([
      role === 'publisher' ? 'offer' : 'answer',
    ]);
    delivery.resolve(ack());
    await result;
    await flush();
    expect(f.sent.map((signal) => signal.sequence)).toEqual([1, 2]);
    expect(f.sent[1]!.payload.type).toBe('ice');
  }
});

it.each(['local', 'remote'] as const)(
  'bounds %s early publisher candidate bursts at 32',
  async (direction) => {
    const raw = deferred<void>();
    drains.push(() => raw.resolve());
    const f = fixture(direction === 'local' ? 'publisher' : 'viewer');
    f.rtc.setLocalDescription.mockImplementation(() => raw.promise);
    const result =
      direction === 'local'
        ? f.peer.offer()
        : f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) }));
    const observed = result.catch((error) => error);
    await flush();
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 33; i++) {
      if (direction === 'local') f.rtc.emit('icecandidate', { candidate: screenIce });
      else
        pending.push(
          f.peer
            .receive(f.message({ type: 'ice', candidate: screenIce }, i + 2))
            .catch((error) => error),
        );
    }
    expect(f.peer.inspect().phase).toBe('closed');
    await observed;
    await Promise.all(pending);
  },
);

it('bounds 128 remote candidates and pending work while RTC delivery is stalled', async () => {
  const f = fixture();
  await stable(f);
  const raw = deferred<void>();
  drains.push(() => raw.resolve());
  f.rtc.addIceCandidate.mockImplementation(() => raw.promise);
  const results = Array.from({ length: 129 }, (_, i) =>
    f.peer.receive(f.message({ type: 'ice', candidate: screenIce }, i + 2)).catch((error) => error),
  );
  expect(f.peer.inspect().phase).toBe('closed');
  await Promise.all(results);
  expect(f.rtc.addIceCandidate).toHaveBeenCalledTimes(1);
});

it.each([
  'invalid-type',
  'oversize',
  'wrong-ufrag',
  'wrong-mid',
  'replay',
  'revision',
  'cross-link',
  'cross-epoch',
  'viewer-offer',
] as const)('rejects %s signaling before touching RTC', async (mutation) => {
  const f = fixture();
  await f.peer.offer();
  const value = f.message({ type: 'answer', sdp: screenSdp('answer', false) });
  if (mutation === 'invalid-type')
    value.payload = {
      type: 'ice',
      candidate: {
        ...screenIce,
        candidate: screenIce.candidate.replace('typ host', 'typ invalid'),
      },
    };
  else if (mutation === 'oversize') value.payload = { type: 'answer', sdp: 'x'.repeat(12289) };
  else if (mutation === 'cross-link') value.linkId = randomUUID();
  else if (mutation === 'cross-epoch') value.epoch = randomUUID();
  else if (mutation === 'revision') value.revision = 2;
  else if (mutation === 'viewer-offer')
    value.payload = { type: 'offer', sdp: screenSdp('offer', false) };
  else {
    await f.peer.receive(value);
    value.payload = {
      type: 'ice',
      candidate:
        mutation === 'wrong-ufrag'
          ? { ...screenIce, usernameFragment: 'wrong' }
          : mutation === 'wrong-mid'
            ? { ...screenIce, sdpMid: '1' }
            : screenIce,
    };
    if (mutation !== 'replay') value.sequence = 2;
  }
  const count = f.rtc.setRemoteDescription.mock.calls.length;
  await expect(f.peer.receive(value)).rejects.toThrow();
  expect(f.rtc.setRemoteDescription).toHaveBeenCalledTimes(count);
  expect(f.rtc.addIceCandidate).not.toHaveBeenCalled();
});

it('viewer exposes only current consented tracks and stops remote tracks on disposal', async () => {
  const f = fixture('viewer', 'tab');
  await stable(f);
  const video = new Track(),
    audio = new Track('audio');
  f.rtc.emit('track', { track: video.media });
  f.rtc.emit('track', { track: audio.media });
  expect(f.options.onTrack).toHaveBeenCalledTimes(2);
  const late = f.rtc.callbacks.get('track')!;
  f.peer.dispose();
  expect(video.stop).toHaveBeenCalledOnce();
  expect(audio.stop).toHaveBeenCalledOnce();
  const obsolete = new Track();
  late(Object.assign(new Event('track'), { track: obsolete.media }));
  expect(obsolete.stop).toHaveBeenCalledOnce();
  expect(f.options.onTrack).toHaveBeenCalledTimes(2);
});

it('unexpected audio or track delivery before negotiation fails closed', async () => {
  const f = fixture('viewer');
  const track = new Track('audio');
  f.rtc.emit('track', { track: track.media });
  expect(f.peer.inspect().phase).toBe('closed');
  expect(track.stop).toHaveBeenCalledOnce();
  expect(f.options.onTrack).not.toHaveBeenCalled();
});

it('closing one publisher endpoint does not stop another endpoint borrowing the same source', async () => {
  const first = fixture('publisher', 'tab');
  const next = fixture('publisher', 'tab', (options) => {
    options.source = first.options.source;
  });
  await stable(first);
  await stable(next);
  first.peer.dispose();
  expect(first.video.stop).not.toHaveBeenCalled();
  expect(first.audio.stop).not.toHaveBeenCalled();
  expect(next.peer.inspect().phase).toBe('stable');
  first.video.dispatchEvent(new Event('ended'));
  expect(next.peer.inspect().phase).toBe('closed');
});

it('cleanup failures still remove subscriptions, close the peer and stop all owned remote tracks', async () => {
  const f = fixture('viewer', 'tab');
  await stable(f);
  const video = new Track(),
    audio = new Track('audio');
  f.rtc.emit('track', { track: video.media });
  f.rtc.emit('track', { track: audio.media });
  video.stop.mockImplementation(() => {
    throw new Error('Owned track cleanup failure');
  });
  f.rtc.close.mockImplementation(() => {
    throw new Error('Owned peer cleanup failure');
  });
  f.peer.dispose();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(f.rtc.callbacks.size).toBe(0);
  expect(f.options.onError).toHaveBeenCalledOnce();
});

it('a rejected server delivery closes the peer without stopping borrowed capture', async () => {
  const f = fixture();
  vi.mocked(f.options.send).mockResolvedValue({
    ok: false,
    code: 'not_authorized',
    error: 'Owned denial',
  });
  await expect(f.peer.offer()).rejects.toThrow('delivery');
  expect(f.peer.inspect().phase).toBe('closed');
  expect(f.video.stop).not.toHaveBeenCalled();
});

it('two synthetic endpoints exchange video/source-sound descriptions and ICE in wire order', async () => {
  const publisher = fixture('publisher', 'tab');
  const viewer = fixture('viewer', 'tab', (options) => {
    options.endpoint.linkId = publisher.options.endpoint.linkId;
  });
  const delivery: Promise<void>[] = [];
  const bridge = (from: typeof publisher, to: typeof viewer) => {
    vi.mocked(from.options.send).mockImplementation(async (signal) => {
      from.sent.push(serverSignal(signal));
      const received = to.peer.receive({ ...signal, epoch: to.options.endpoint.epoch });
      delivery.push(received);
      void received.catch(() => {});
      return ack();
    });
  };
  // The adapter copies trusted transport functions, so configure their spy implementation.
  bridge(publisher, viewer);
  bridge(viewer, publisher);
  await publisher.peer.offer();
  await flush();
  await Promise.all(delivery);
  expect(publisher.peer.inspect().phase).toBe('stable');
  expect(viewer.peer.inspect().phase).toBe('stable');
  publisher.rtc.emit('icecandidate', { candidate: screenIce });
  viewer.rtc.emit('icecandidate', { candidate: screenIce });
  await flush();
  await Promise.all(delivery);
  expect(publisher.rtc.addIceCandidate).toHaveBeenCalledOnce();
  expect(viewer.rtc.addIceCandidate).toHaveBeenCalledOnce();
  expect(publisher.sent.map((signal) => signal.payload.type)).toEqual(['offer', 'ice']);
  expect(viewer.sent.map((signal) => signal.payload.type)).toEqual(['answer', 'ice']);
});

it('copies endpoint/source policy so caller mutation cannot change the established endpoint', async () => {
  const f = fixture();
  const initial = { ...f.options.endpoint };
  f.options.endpoint.role = 'viewer';
  f.options.endpoint.sound = 'system';
  f.options.endpoint.epoch = randomUUID();
  f.options.source = undefined;
  await f.peer.offer();
  expect(f.sent[0]!.epoch).toBe(initial.epoch);
  expect(f.sent[0]!.payload.type).toBe('offer');
  f.peer.dispose();
  expect(f.video.stop).not.toHaveBeenCalled();
});

it('synchronous subscription-time invalidation removes its returned subscription and closes exactly once', () => {
  const rtc = new Rtc(),
    unsubscribe = vi.fn();
  expect(() =>
    fixture('viewer', 'none', (options) => {
      options.createPeer = (config) => {
        rtc.config = config;
        return rtc.boundary;
      };
      options.lifecycle.onInvalidated = (listener) => {
        listener();
        return unsubscribe;
      };
    }),
  ).toThrow('lifecycle');
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(rtc.close).toHaveBeenCalledOnce();
  expect(rtc.callbacks.size).toBe(0);
});

it('partial transceiver construction failure closes listeners/peer without stopping capture', () => {
  const rtc = new Rtc(),
    video = new Track();
  rtc.addTransceiver.mockImplementation(() => {
    throw new Error('Owned transceiver failure');
  });
  expect(() =>
    fixture('publisher', 'none', (options) => {
      options.source = { video: video.media, audio: null, sound: 'none' };
      options.createPeer = (config) => {
        rtc.config = config;
        return rtc.boundary;
      };
    }),
  ).toThrow('transceiver');
  expect(rtc.callbacks.size).toBe(0);
  expect(rtc.close).toHaveBeenCalledOnce();
  expect(video.stop).not.toHaveBeenCalled();
});

it('rejects a local relay-bearing description and remote answer with different mids', async () => {
  const f = fixture();
  f.rtc.createOffer.mockResolvedValue({
    type: 'offer',
    sdp: screenSdp('offer', false).replace(
      'a=mid:0',
      'a=mid:0\r\na=' + screenIce.candidate.replace('typ host', 'typ invalid'),
    ),
  });
  await expect(f.peer.offer()).rejects.toThrow();
  expect(f.sent).toHaveLength(0);
  const next = fixture();
  await next.peer.offer();
  await expect(
    next.peer.receive(
      next.message({
        type: 'answer',
        sdp: screenSdp('answer', false)
          .replaceAll('BUNDLE 0', 'BUNDLE 1')
          .replace('a=mid:0', 'a=mid:1'),
      }),
    ),
  ).rejects.toThrow('answer mismatch');
  expect(next.rtc.setRemoteDescription).not.toHaveBeenCalled();
});

it('queues remote ICE behind a held remote description and rejects concurrent renegotiation', async () => {
  const f = fixture('viewer');
  const raw = deferred<void>();
  drains.push(() => raw.resolve());
  f.rtc.setRemoteDescription.mockImplementation(() => raw.promise);
  const offer = f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) }));
  const candidate = f.peer.receive(f.message({ type: 'ice', candidate: screenIce }, 2));
  await expect(
    f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) }, 3, 2)),
  ).rejects.toThrow('revision');
  expect(f.rtc.addIceCandidate).not.toHaveBeenCalled();
  raw.resolve();
  await offer;
  await candidate;
  expect(f.rtc.addIceCandidate).toHaveBeenCalledOnce();
});

it('failed lifecycle inspection closes the owned endpoint on delivery before touching RTC', async () => {
  const f = fixture('viewer');
  f.setCurrent(null);
  await expect(
    f.peer.receive(f.message({ type: 'offer', sdp: screenSdp('offer', false) })),
  ).rejects.toThrow('lifecycle');
  expect(f.rtc.close).toHaveBeenCalledOnce();
  expect(f.rtc.setRemoteDescription).not.toHaveBeenCalled();
});

it('a factory cannot transfer another endpoint peer, even after its disposal', () => {
  const first = fixture('viewer');
  const reuse = () =>
    fixture('viewer', 'none', (options) => {
      options.createPeer = () => first.rtc.boundary;
    });
  expect(reuse).toThrow('already belongs');
  expect(first.rtc.close).not.toHaveBeenCalled();
  first.peer.dispose();
  expect(reuse).toThrow('already belongs');
  expect(first.rtc.close).toHaveBeenCalledOnce();
});

it('rejects a preconfigured peer carrying tracks before registering listeners', () => {
  const rtc = new Rtc();
  rtc.transceivers.push({ direction: 'sendrecv' });
  expect(() =>
    fixture('viewer', 'none', (options) => {
      options.createPeer = (config) => {
        rtc.config = config;
        return rtc.boundary;
      };
    }),
  ).toThrow('fresh empty');
  expect(rtc.close).toHaveBeenCalledOnce();
  expect(rtc.callbacks.size).toBe(0);
});

it('late old-ufrag gathering cannot consume the new revision budget or close its negotiation', async () => {
  const f = fixture();
  await stable(f);
  const raw = deferred<RTCSessionDescriptionInit>();
  drains.push(() => raw.resolve({ type: 'offer', sdp: screenSdp('offer', false, 'next') }));
  f.rtc.createOffer.mockImplementation(() => raw.promise);
  const offer = f.peer.offer();
  for (let i = 0; i < 129; i++) f.rtc.emit('icecandidate', { candidate: screenIce });
  expect(f.peer.inspect()).toEqual({ phase: 'offering', revision: 2 });
  raw.resolve({ type: 'offer', sdp: screenSdp('offer', false, 'next') });
  await offer;
  f.rtc.emit('icecandidate', {
    candidate: {
      ...screenIce,
      candidate: screenIce.candidate.replace('ufrag test', 'ufrag next'),
      usernameFragment: 'next',
    },
  });
  await flush();
  expect(f.sent.map((signal) => [signal.payload.type, signal.revision])).toEqual([
    ['offer', 1],
    ['offer', 2],
    ['ice', 2],
  ]);
});

it('viewer fixes every offered transceiver to recvonly before creating its answer', async () => {
  const f = fixture('viewer', 'tab');
  f.rtc.setRemoteDescription.mockImplementation(async () => {
    f.rtc.transceivers.push({ direction: 'sendrecv' }, { direction: 'sendrecv' });
  });
  f.rtc.createAnswer.mockImplementation(async () => {
    expect(f.rtc.transceivers.map((transceiver) => transceiver.direction)).toEqual([
      'recvonly',
      'recvonly',
    ]);
    return { type: 'answer', sdp: screenSdp('answer', true) };
  });
  await stable(f);
});

it('inspection observes a clock jump or generation loss before delayed timers can run', () => {
  let now = 10;
  const f = fixture('viewer', 'none', (options) => {
    options.now = () => now;
  });
  now = f.current().deadline;
  expect(f.peer.inspect().phase).toBe('closed');
  expect(f.rtc.close).toHaveBeenCalledOnce();
  const next = fixture('viewer');
  next.setCurrent({ generation: {}, deadline: next.current().deadline });
  expect(next.peer.inspect().phase).toBe('closed');
  expect(next.rtc.close).toHaveBeenCalledOnce();
});

const videoRequest = (revision = 1, pub = 8000000, view = 4000000, profile = 'smooth') => ({
  revision,
  publisher: { profile: 'smooth', videoBitrate: pub },
  viewer: { profile, videoBitrate: view },
});

it('updates only negotiated video and exposes immutable requested/observed ceilings', async () => {
  const f = fixture('publisher', 'tab');
  await expect(f.peer.setVideoQuality(videoRequest())).rejects.toMatchObject({
    code: 'unsupported',
  });
  await stable(f);
  const applied = await f.peer.setVideoQuality(videoRequest(1, 8000000, 4000000, 'low'));
  expect(applied.encoding).toEqual({
    maxBitrate: 4000000,
    maxFramerate: 15,
    scaleResolutionDownBy: 2.25,
  });
  expect(f.peer.inspectVideoQuality()).toMatchObject({
    requested: { revision: 1 },
    applied,
    pending: 0,
    closed: false,
  });
  expect(Object.isFrozen(f.peer.inspectVideoQuality())).toBe(true);
  expect(f.rtc.senders[1]!.setParameters).not.toHaveBeenCalled();
  expect(f.video.applyConstraints).not.toHaveBeenCalled();
  expect(f.audio.applyConstraints).not.toHaveBeenCalled();
  expect(f.video.getSettings()).toEqual({ width: 1920, height: 1080, frameRate: 60 });
});

it('serializes a bounded pair using fresh native transactions and copied requests', async () => {
  const f = fixture();
  await stable(f);
  const sender = f.rtc.senders[0]!,
    raw = deferred<void>();
  drains.push(() => raw.resolve());
  const original = sender.setParameters.getMockImplementation()!;
  sender.setParameters.mockImplementationOnce(async (parameters) => {
    await raw.promise;
    await original(parameters);
  });
  const first = f.peer.setVideoQuality(videoRequest(1));
  const request = videoRequest(2, 2000000, 8000000);
  const second = f.peer.setVideoQuality(request);
  request.publisher.videoBitrate = 20000000;
  await expect(f.peer.setVideoQuality(videoRequest(3))).rejects.toMatchObject({ code: 'busy' });
  await expect(f.peer.setVideoQuality(videoRequest(1))).rejects.toMatchObject({ code: 'stale' });
  expect(sender.setParameters).toHaveBeenCalledTimes(1);
  expect(sender.getParameters).toHaveBeenCalledTimes(1);
  expect(f.peer.inspectVideoQuality()).toMatchObject({
    requested: { revision: 2, publisher: { videoBitrate: 2000000 } },
    applied: null,
    pending: 2,
  });
  raw.resolve();
  expect((await first).plan.request.revision).toBe(1);
  expect((await second).plan.request.revision).toBe(2);
  expect(sender.setParameters.mock.calls.map(([parameters]) => parameters.transactionId)).toEqual([
    '1',
    '3',
  ]);
  expect(f.peer.inspectVideoQuality()).toMatchObject({
    applied: { plan: { request: { revision: 2 } }, encoding: { maxBitrate: 2000000 } },
    pending: 0,
  });
});

it.each(['resolve', 'reject'] as const)(
  'Stop cancels logical updates before ignored native %s and protects a replacement',
  async (late) => {
    const old = fixture();
    await stable(old);
    const raw = deferred<void>();
    drains.push(() => raw.resolve());
    old.rtc.senders[0]!.setParameters.mockImplementationOnce(() => raw.promise);
    const first = expect(old.peer.setVideoQuality(videoRequest(1))).rejects.toThrow();
    const queued = expect(old.peer.setVideoQuality(videoRequest(2))).rejects.toThrow();
    old.peer.dispose();
    await first;
    await queued;
    expect(old.peer.inspectVideoQuality()).toMatchObject({
      applied: null,
      pending: 0,
      closed: true,
    });
    const next = fixture();
    await stable(next);
    await next.peer.setVideoQuality(videoRequest(1, 2000000));
    if (late === 'resolve') raw.resolve();
    else raw.reject(new Error('Owned late native failure'));
    await flush();
    expect(old.rtc.senders[0]!.setParameters).toHaveBeenCalledTimes(1);
    expect(next.peer.inspectVideoQuality()).toMatchObject({
      applied: { encoding: { maxBitrate: 2000000 } },
      closed: false,
    });
    expect(old.video.stop).not.toHaveBeenCalled();
  },
);

it.each(['generation', 'deadline', 'track', 'settings'] as const)(
  '%s loss during a native update cannot claim new limits',
  async (loss) => {
    const f = fixture();
    await stable(f);
    const raw = deferred<void>();
    drains.push(() => raw.resolve());
    f.rtc.senders[0]!.setParameters.mockImplementationOnce(() => raw.promise);
    const result = expect(f.peer.setVideoQuality(videoRequest())).rejects.toThrow();
    if (loss === 'generation') f.setCurrent({ generation: {}, deadline: f.current().deadline });
    else if (loss === 'deadline') await vi.advanceTimersByTimeAsync(60000);
    else if (loss === 'track') f.rtc.senders[0]!.track = new Track().media;
    else f.video.settings.width = 3840;
    raw.resolve();
    await result;
    expect(f.peer.inspectVideoQuality()).toMatchObject({ applied: null, closed: true });
    expect(f.video.stop).not.toHaveBeenCalled();
  },
);

it.each(['get', 'set', 'readback'] as const)(
  'native %s failure closes only its peer and clears applied state',
  async (mode) => {
    const f = fixture('publisher', 'tab'),
      other = fixture('publisher', 'tab', (options) => {
        options.source = f.options.source;
      });
    await stable(f);
    await stable(other);
    await f.peer.setVideoQuality(videoRequest());
    const sender = f.rtc.senders[0]!;
    if (mode === 'get')
      sender.getParameters.mockImplementationOnce(() => {
        throw new Error('Owned native get failed');
      });
    else if (mode === 'set')
      sender.setParameters.mockRejectedValueOnce(new Error('Owned native set failed'));
    else
      sender.setParameters.mockImplementationOnce(async () => {
        sender.parameters.encodings = [
          { maxBitrate: 20000000, maxFramerate: 60, scaleResolutionDownBy: 1 },
        ];
      });
    await expect(f.peer.setVideoQuality(videoRequest(2, 2000000))).rejects.toThrow();
    expect(f.peer.inspectVideoQuality()).toMatchObject({
      requested: { revision: 2 },
      applied: null,
      closed: true,
    });
    expect(other.peer.inspect().phase).toBe('stable');
    expect(other.rtc.senders[0]!.setParameters).not.toHaveBeenCalled();
    expect(f.video.stop).not.toHaveBeenCalled();
    expect(f.audio.stop).not.toHaveBeenCalled();
  },
);

it('unqualified choices and unknown source settings consume no revisions or native work', async () => {
  const f = fixture();
  await stable(f);
  await expect(
    f.peer.setVideoQuality(videoRequest(1, 8000000, 4000000, 'auto')),
  ).rejects.toMatchObject({ code: 'unqualified' });
  f.video.settings = { width: 1920, height: 1080 };
  await expect(f.peer.setVideoQuality(videoRequest())).rejects.toMatchObject({
    code: 'unqualified',
  });
  expect(f.peer.inspectVideoQuality()).toMatchObject({
    requested: null,
    applied: null,
    pending: 0,
    closed: false,
  });
  expect(f.rtc.senders[0]!.getParameters).not.toHaveBeenCalled();
  f.video.settings.frameRate = 60;
  await f.peer.setVideoQuality(videoRequest());
});

it('a viewer cannot update parameters and renegotiation invalidates old readback claims', async () => {
  const viewer = fixture('viewer');
  await stable(viewer);
  await expect(viewer.peer.setVideoQuality(videoRequest())).rejects.toMatchObject({
    code: 'unsupported',
  });
  const f = fixture();
  await stable(f);
  await f.peer.setVideoQuality(videoRequest());
  await f.peer.offer();
  expect(f.peer.inspectVideoQuality().applied).toBeNull();
  await expect(f.peer.setVideoQuality(videoRequest(2))).rejects.toMatchObject({
    code: 'unsupported',
  });
  await f.peer.receive(f.message({ type: 'answer', sdp: screenSdp('answer', false) }, 2, 2));
  await f.peer.setVideoQuality(videoRequest(2));
  expect(f.peer.inspectVideoQuality().applied?.plan.request.revision).toBe(2);
});

it('inspection invalidates readback after external source resize without changing capture', async () => {
  const f = fixture();
  await stable(f);
  await f.peer.setVideoQuality(videoRequest());
  f.video.settings.height = 2160;
  expect(f.peer.inspectVideoQuality()).toMatchObject({ applied: null, closed: true });
  expect(f.video.applyConstraints).not.toHaveBeenCalled();
});
