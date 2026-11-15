import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceController } from './voice-controller';
type MockTrack = {
  muted: boolean;
  stop: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  unmute: ReturnType<typeof vi.fn>;
};
type MockRoom = {
  on: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  localParticipant: {
    identity: string;
    publishTrack: ReturnType<typeof vi.fn>;
    unpublishTrack: ReturnType<typeof vi.fn>;
  };
  remoteParticipants: Map<string, unknown>;
  emit: (event: string, ...args: unknown[]) => void;
};
const sdk = vi.hoisted(() => ({
  rooms: [] as MockRoom[],
  tracks: [] as MockTrack[],
  pendingMute: undefined as Promise<void> | undefined,
}));
vi.mock('livekit-client', () => ({
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
      'SignalReconnecting',
      'Reconnected',
      'Disconnected',
    ].map((k) => [k, k]),
  ),
  Track: { Source: { Microphone: 'microphone' } },
  Room: class {
    constructor() {
      const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
      const room: MockRoom = {
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          return room;
        }),
        removeAllListeners: vi.fn(() => listeners.clear()),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        localParticipant: {
          identity: 'me',
          publishTrack: vi.fn().mockResolvedValue(undefined),
          unpublishTrack: vi.fn().mockResolvedValue(undefined),
        },
        remoteParticipants: new Map(),
        emit: (event, ...args) => listeners.get(event)?.forEach((f) => f(...args)),
      };
      sdk.rooms.push(room);
      return room;
    }
  },
  LocalAudioTrack: class {
    constructor(media: { stop: () => void }) {
      const track = {
        muted: false,
        stop: vi.fn(() => media.stop()),
        mute: vi.fn(async () => {
          await sdk.pendingMute;
          track.muted = true;
        }),
        unmute: vi.fn(async () => {
          track.muted = false;
        }),
      };
      sdk.tracks.push(track);
      return track;
    }
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function stream() {
  const media = Object.assign(new EventTarget(), { stop: vi.fn() });
  return { media, getTracks: () => [media], getAudioTracks: () => [media] };
}
let controller: VoiceController;
beforeEach(() => {
  sdk.rooms.length = 0;
  sdk.tracks.length = 0;
  sdk.pendingMute = undefined;
});
afterEach(async () => {
  await controller?.leave();
  controller?.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const capture = stream();
  const media = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn().mockResolvedValue(capture),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  });
  vi.stubGlobal('navigator', { mediaDevices: media });
  vi.stubGlobal('location', { href: 'http://localhost/', protocol: 'http:' });
  const request = vi
    .fn()
    .mockImplementation(async (path: string) =>
      path === '/voice/join'
        ? { id: 'lease', credential: 'lease', channelId: 'room' }
        : { ok: true },
    );
  controller = new VoiceController(request);
  controller.update({ input: 'mic', output: 'speaker' });
  return { media, request, capture };
}
it('late microphone permission after leave stops capture without publishing', async () => {
  const { media } = setup(),
    pending = deferred<ReturnType<typeof stream>>(),
    capture = stream();
  media.getUserMedia.mockReturnValueOnce(pending.promise);
  const joining = controller.join('room');
  await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalled());
  await controller.leave();
  pending.resolve(capture);
  await joining;
  expect(capture.media.stop).toHaveBeenCalled();
  expect(sdk.rooms[0]!.localParticipant.publishTrack).not.toHaveBeenCalled();
  expect(controller.state.status).toBe('idle');
});
it('leaving during device replacement does not publish the late replacement', async () => {
  setup();
  await controller.join('room');
  const room = sdk.rooms[0]!,
    pending = deferred<void>();
  room.localParticipant.unpublishTrack.mockReturnValueOnce(pending.promise);
  const selecting = controller.selectInput('replacement');
  await vi.waitFor(() => expect(room.localParticipant.unpublishTrack).toHaveBeenCalled());
  await controller.leave();
  expect(sdk.tracks[1]!.stop).toHaveBeenCalled();
  pending.resolve();
  await selecting;
  expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  expect(sdk.tracks[1]!.stop).toHaveBeenCalled();
  expect(controller.state.status).toBe('idle');
});
it('publication failure stops the captured microphone', async () => {
  const { media } = setup(),
    pending = deferred<ReturnType<typeof stream>>(),
    capture = stream();
  media.getUserMedia.mockReturnValueOnce(pending.promise);
  const joining = controller.join('room');
  await vi.waitFor(() => expect(sdk.rooms).toHaveLength(1));
  sdk.rooms[0]!.localParticipant.publishTrack.mockRejectedValueOnce(
    new Error('Publication failed'),
  );
  pending.resolve(capture);
  await joining;
  expect(capture.media.stop).toHaveBeenCalled();
  expect(controller.state.inputMissing).toBe(true);
});
it('unmuting while initial mute is pending wins when publication finishes', async () => {
  setup();
  const pending = deferred<void>();
  sdk.pendingMute = pending.promise;
  const joining = controller.join('room');
  await vi.waitFor(() => expect(sdk.tracks).toHaveLength(1));
  await controller.mute();
  pending.resolve();
  await joining;
  expect(controller.state.muted).toBe(false);
  expect(sdk.tracks[0]!.muted).toBe(false);
});
it('lease renewal inside a reconnect retry creates only one replacement room', async () => {
  const { request } = setup();
  await controller.join('room');
  vi.useFakeTimers();
  request.mockImplementation(async (path: string) => {
    if (path === '/voice/heartbeat' && sdk.rooms.length === 1)
      throw Object.assign(new Error('Expired'), { status: 410 });
    return { id: 'new-lease', credential: 'new-lease', channelId: 'room' };
  });
  sdk.rooms[0]!.emit('Disconnected');
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(sdk.rooms).toHaveLength(2);
  expect(controller.state.status).toBe('connected');
  await controller.leave();
  await vi.advanceTimersByTimeAsync(30000);
  expect(sdk.rooms).toHaveLength(2);
});
it('a delayed speaker switch cannot revive old audio after leaving and rejoining', async () => {
  setup();
  await controller.join('room');
  const pending = deferred<void>(),
    element = {
      dataset: {},
      muted: true,
      autoplay: false,
      srcObject: null,
      volume: 1,
      setSinkId: vi.fn().mockReturnValue(pending.promise),
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
    };
  vi.stubGlobal('document', { createElement: () => element, body: { appendChild: vi.fn() } });
  vi.stubGlobal('MediaStream', class {});
  sdk.rooms[0]!.emit(
    'TrackSubscribed',
    { kind: 'audio', sid: 'track', mediaStreamTrack: {} },
    {},
    { identity: 'friend' },
  );
  await vi.waitFor(() => expect(element.setSinkId).toHaveBeenCalled());
  await controller.leave();
  await controller.join('room');
  pending.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(element.play).not.toHaveBeenCalled();
  expect(element.muted).toBe(true);
});
it('device enumeration failure is reported without an unhandled rejection or fallback', async () => {
  const { media } = setup();
  media.enumerateDevices.mockRejectedValueOnce(new Error('Device API unavailable'));
  media.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() =>
    expect(controller.state.devicesError).toContain('Cannot check audio devices'),
  );
  expect(media.getUserMedia).not.toHaveBeenCalled();
});

it('connection and reconnect recovery publish one authoritative roster with connected state', async () => {
  setup();
  const snapshots: { status: string; ids: string[] }[] = [];
  controller.onChange = () =>
    snapshots.push({
      status: controller.state.status,
      ids: controller.state.participants.map((p) => p.id),
    });
  await controller.join('room');
  expect(snapshots.filter((s) => s.status === 'connected').every((s) => s.ids.includes('me'))).toBe(
    true,
  );
  const room = sdk.rooms[0]!;
  room.emit('Reconnecting');
  room.remoteParticipants.set('new', {
    identity: 'new',
    name: 'New peer',
    isSpeaking: false,
    isMicrophoneEnabled: false,
  });
  snapshots.length = 0;
  room.emit('Reconnected');
  expect(snapshots).toEqual([{ status: 'connected', ids: ['me', 'new'] }]);
});

it('SDK peer cleanup before reconnect cannot publish a false connected roster', async () => {
  setup();
  await controller.join('room');
  const room = sdk.rooms[0]!;
  room.remoteParticipants.set('friend', {
    identity: 'friend',
    name: 'Friend',
    isSpeaking: false,
    isMicrophoneEnabled: false,
  });
  room.emit('ParticipantConnected');
  await Promise.resolve();
  const snapshots: { status: string; peers: number }[] = [];
  controller.onChange = () =>
    snapshots.push({
      status: controller.state.status,
      peers: controller.state.participants.length,
    });
  room.remoteParticipants.clear();
  room.emit('ParticipantDisconnected');
  room.emit('SignalReconnecting');
  await Promise.resolve();
  expect(snapshots.every((s) => s.status === 'reconnecting')).toBe(true);
  expect(snapshots.at(-1)?.peers).toBe(1);
});

it('unmute waits for publication so the SDK can signal the assigned track SID', async () => {
  const { media } = setup();
  const capture = deferred<ReturnType<typeof stream>>(),
    publication = deferred<void>();
  media.getUserMedia.mockReturnValueOnce(capture.promise);
  const joining = controller.join('room');
  await vi.waitFor(() => expect(sdk.rooms).toHaveLength(1));
  sdk.rooms[0]!.localParticipant.publishTrack.mockReturnValueOnce(publication.promise);
  capture.resolve(stream());
  await vi.waitFor(() => expect(sdk.rooms[0]!.localParticipant.publishTrack).toHaveBeenCalled());
  await controller.mute();
  expect(controller.state.muted).toBe(false);
  expect(sdk.tracks[0]!.unmute).not.toHaveBeenCalled();
  publication.resolve();
  await joining;
  expect(sdk.tracks[0]!.unmute).toHaveBeenCalledOnce();
});

it('late capture failure from an earlier join cannot mark the new microphone missing', async () => {
  const { media } = setup(),
    pending = deferred<ReturnType<typeof stream>>();
  media.getUserMedia.mockReturnValueOnce(pending.promise);
  const first = controller.join('room');
  await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalledOnce());
  await controller.leave();
  await controller.join('room');
  pending.reject(new Error('Old permission request failed'));
  await first;
  expect(controller.state.status).toBe('connected');
  expect(controller.state.inputMissing).toBe(false);
  expect(controller.state.error).toBe('');
});

it('a superseded microphone request cannot mark its successful replacement missing', async () => {
  const { media } = setup(),
    pending = deferred<ReturnType<typeof stream>>();
  media.getUserMedia.mockReturnValueOnce(pending.promise);
  const joining = controller.join('room');
  await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalledOnce());
  await controller.selectInput('replacement');
  pending.reject(new Error('Old microphone unavailable'));
  await joining;
  expect(controller.state.input).toBe('replacement');
  expect(controller.state.inputMissing).toBe(false);
  expect(controller.state.error).toBe('');
});

it('hosted leases allow the media server to provide ICE servers while local leases stay local', async () => {
  const { request } = setup();
  await controller.join('room');
  expect(sdk.rooms[0]!.connect.mock.calls[0]![2].rtcConfig.iceServers).toEqual([]);
  await controller.leave();
  request.mockResolvedValue({
    id: 'hosted',
    credential: 'hosted',
    channelId: 'room',
    useServerIceServers: true,
  });
  await controller.join('room');
  expect(sdk.rooms[1]!.connect.mock.calls[0]![2].rtcConfig).not.toHaveProperty('iceServers');
});

function outputFixture(resume = vi.fn().mockResolvedValue(undefined)) {
  const derived = { stop: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const destination = { stream: { getTracks: () => [derived] } };
  const context = {
    state: 'running',
    resume,
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    createMediaStreamDestination: vi.fn(() => destination),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  const element = {
    dataset: {},
    muted: true,
    autoplay: false,
    srcObject: null,
    volume: 1,
    setSinkId: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn(),
  };
  const feeder = {
    ...element,
    dataset: {},
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    setSinkId: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('document', {
    createElement: vi.fn().mockReturnValueOnce(element).mockReturnValue(feeder),
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal('MediaStream', class {});
  const subscribe = () =>
    sdk.rooms
      .at(-1)!
      .emit(
        'TrackSubscribed',
        { kind: 'audio', sid: 'remote', mediaStreamTrack: {} },
        {},
        { identity: 'friend' },
      );
  return { context, source, gain, derived, destination, element, feeder, subscribe };
}

it('boosts only received voice, preserves participant attenuation and exact speaker routing', async () => {
  const { media } = setup();
  const f = outputFixture();
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalledOnce());
  expect(controller.state.outputVolume).toBe(1);
  expect(f.context.createGain).not.toHaveBeenCalled();
  controller.volume('friend', 0.25);
  await controller.setOutputVolume(0.5);
  expect(f.element.volume).toBe(0.125);
  expect(f.context.createGain).not.toHaveBeenCalled();
  await controller.setOutputVolume(2);
  expect(f.gain.gain.value).toBe(2);
  expect(f.element.volume).toBe(0.25);
  expect(f.element.srcObject).toBe(f.destination.stream);
  expect(f.source.connect).toHaveBeenCalledWith(f.gain);
  expect(f.gain.connect).toHaveBeenCalledWith(f.destination);
  expect(f.feeder.muted).toBe(true);
  expect(f.feeder.volume).toBe(0);
  expect(f.feeder.setSinkId).toHaveBeenCalledWith('speaker');
  expect(f.element.setSinkId.mock.calls.every(([id]) => id === 'speaker')).toBe(true);
  expect(f.element.setSinkId.mock.invocationCallOrder.at(-1)).toBeLessThan(
    f.element.play.mock.invocationCallOrder.at(-1)!,
  );
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(sdk.tracks).toHaveLength(1);
  const plays = f.element.play.mock.calls.length;
  await controller.setOutputVolume(1.5);
  expect(f.gain.gain.value).toBe(1.5);
  expect(f.element.play).toHaveBeenCalledTimes(plays);
  await controller.setOutputVolume(0);
  expect(f.gain.gain.value).toBe(0);
  await controller.deafen();
  await controller.setOutputVolume(2);
  expect(f.element.muted).toBe(true);
  expect(controller.state.muted).toBe(true);
  await controller.leave();
  expect(f.derived.stop).toHaveBeenCalledOnce();
  expect(f.feeder.srcObject).toBeNull();
  expect(f.feeder.pause).toHaveBeenCalled();
  expect(f.source.disconnect).toHaveBeenCalledOnce();
  expect(f.gain.disconnect).toHaveBeenCalledOnce();
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(f.element.srcObject).toBeNull();
});

it('applies the master level to later subscriptions and releases graphs on unsubscribe', async () => {
  setup();
  const f = outputFixture();
  await controller.setOutputVolume(2);
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalled());
  expect(f.gain.gain.value).toBe(2);
  sdk.rooms[0]!.emit('TrackUnsubscribed', { sid: 'remote' });
  expect(f.derived.stop).toHaveBeenCalledOnce();
  expect(f.element.srcObject).toBeNull();
  expect(f.element.muted).toBe(true);
  await controller.leave();
  expect(f.derived.stop).toHaveBeenCalledOnce();
});

it('rejects invalid master and participant levels without changing current volumes', async () => {
  setup();
  for (const value of [-1, 2.01, NaN, Infinity])
    await expect(controller.setOutputVolume(value)).rejects.toThrow('0% and 200%');
  for (const value of [-1, 1.01, NaN, Infinity])
    expect(() => controller.volume('friend', value)).toThrow('0% and 100%');
  expect(controller.state.outputVolume).toBe(1);
});

it('failed amplification stays paused with a visible error and allows an explicit retry', async () => {
  setup();
  const f = outputFixture(vi.fn().mockRejectedValueOnce(new Error('Audio blocked')));
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalledOnce());
  f.context.state = 'suspended';
  await controller.setOutputVolume(2);
  expect(controller.state.error).toContain('Audio blocked');
  expect(f.element.muted).toBe(true);
  expect(f.element.play).toHaveBeenCalledOnce();
  f.context.state = 'running';
  await controller.resumeAudio();
  expect(f.element.muted).toBe(false);
  expect(f.gain.gain.value).toBe(2);
});

it('a late amplification permission cannot revive audio after leaving', async () => {
  setup();
  const pending = deferred<void>();
  const f = outputFixture(vi.fn().mockReturnValue(pending.promise));
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalledOnce());
  f.context.state = 'suspended';
  const setting = controller.setOutputVolume(2);
  await controller.leave();
  pending.resolve();
  await setting;
  expect(f.element.play).toHaveBeenCalledOnce();
  expect(f.context.createGain).not.toHaveBeenCalled();
  expect(f.element.muted).toBe(true);
});

it('unsupported amplification surfaces an error without capturing or changing devices', async () => {
  const { media } = setup();
  vi.stubGlobal('AudioContext', undefined);
  await controller.setOutputVolume(2);
  expect(controller.state.error).toContain('amplification is unavailable');
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(controller.state.input).toBe('mic');
  expect(controller.state.output).toBe('speaker');
});

it('missing speakers stay silent while the boosted master changes, with no default fallback', async () => {
  const { media } = setup();
  const f = outputFixture();
  await controller.join('room');
  await controller.setOutputVolume(2);
  f.subscribe();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalledOnce());
  media.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() => expect(controller.state.outputMissing).toBe(true));
  await controller.setOutputVolume(1.5);
  await controller.resumeAudio();
  expect(f.element.muted).toBe(true);
  expect(f.element.play).toHaveBeenCalledOnce();
  expect(f.element.setSinkId.mock.calls.every(([id]) => id === 'speaker')).toBe(true);
});

it('returning to 100% recovers raw playback when amplification is unsupported', async () => {
  setup();
  const f = outputFixture();
  vi.stubGlobal('AudioContext', undefined);
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalledOnce());
  await controller.setOutputVolume(2);
  expect(f.element.muted).toBe(true);
  await controller.setOutputVolume(1);
  expect(f.element.muted).toBe(false);
  expect(f.element.volume).toBe(1);
  expect(controller.state.error).toBe('');
});

it('leaving during silent source routing cannot start the feeder or processed playback later', async () => {
  setup();
  const f = outputFixture();
  const pending = deferred<void>();
  f.feeder.setSinkId.mockReturnValue(pending.promise);
  await controller.setOutputVolume(2);
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.feeder.setSinkId).toHaveBeenCalled());
  await controller.leave();
  pending.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.feeder.play).not.toHaveBeenCalled();
  expect(f.element.play).not.toHaveBeenCalled();
  expect(f.derived.stop).toHaveBeenCalledOnce();
  expect(f.feeder.srcObject).toBeNull();
});

it('gain graph failures release derived media and leave output silent with an error', async () => {
  setup();
  const f = outputFixture();
  f.source.connect.mockImplementationOnce(() => {
    throw new Error('Graph failed');
  });
  await controller.setOutputVolume(2);
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(controller.state.error).toContain('Graph failed'));
  expect(f.element.muted).toBe(true);
  expect(f.element.play).not.toHaveBeenCalled();
  expect(f.derived.stop).toHaveBeenCalledOnce();
  expect(f.feeder.srcObject).toBeNull();
});

it('participant volume changes during amplification setup are preserved when playback starts', async () => {
  setup();
  const f = outputFixture();
  const pending = deferred<void>();
  f.feeder.setSinkId.mockReturnValue(pending.promise);
  await controller.setOutputVolume(2);
  await controller.join('room');
  f.subscribe();
  await vi.waitFor(() => expect(f.feeder.setSinkId).toHaveBeenCalled());
  controller.volume('friend', 0.25);
  pending.resolve();
  await vi.waitFor(() => expect(f.element.play).toHaveBeenCalled());
  expect(f.element.volume).toBe(0.25);
});
