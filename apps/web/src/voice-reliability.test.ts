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
  await vi.waitFor(() => expect(controller.state.error).toContain('Cannot check audio devices'));
  expect(media.getUserMedia).not.toHaveBeenCalled();
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
