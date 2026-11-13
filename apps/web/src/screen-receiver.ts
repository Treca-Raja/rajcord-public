import { parseScreenReference, type ScreenLinkRequest, type ScreenSound } from '@tricord/shared';
import { ScreenPeer, type ScreenPeerLifecycle, type ScreenRtcPeer } from './screen-peer';
import { screenIceServers } from './screen-ice';
import { adoptScreenRenewal, type ScreenRenewalPermit } from './screen-renewal';
import {
  ScreenPlaybackOwner,
  type ScreenPlaybackElement,
  type ScreenPlaybackState,
} from './screen-playback';

export type ScreenReceiveEnd =
  | 'stopped'
  | 'hidden'
  | 'disposed'
  | 'expired'
  | 'lifecycle-lost'
  | 'track-ended'
  | 'tracks-timeout'
  | 'failed';
export class ScreenReceiveError extends Error {
  constructor(
    readonly code: 'invalid' | 'busy' | 'closed' | 'not-ready' | 'failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
type Endpoint = ScreenLinkRequest & { role: 'viewer'; sound: ScreenSound };
type PeerOptions = ConstructorParameters<typeof ScreenPeer>[0];
export type ScreenReceiveOptions = {
  // Already verified by the caller's authorization boundary; references are not grants.
  iceServers?: readonly RTCIceServer[];
  endpoint: Endpoint;
  lifecycle: ScreenPeerLifecycle;
  send: PeerOptions['send'];
  // Must conditionally clean up this exact old selection, never a replacement.
  cleanup(
    reference: Readonly<ScreenLinkRequest>,
    reason: ScreenReceiveEnd,
    signal: AbortSignal,
  ): Promise<void>;
};
export type ScreenReceiveState = Readonly<{
  phase: 'receiving' | 'ready' | 'closed' | 'paused-hidden';
  reason?: ScreenReceiveEnd;
  hasVideo: boolean;
  hasAudio: boolean;
  playback: ScreenPlaybackState | null;
  cleanup: Readonly<{
    status: 'none' | 'pending' | 'succeeded' | 'failed' | 'timed-out';
    pending: boolean;
    late?: 'succeeded' | 'failed';
  }>;
}>;
type Slot = 'rtc' | 'playback' | 'signal' | 'cleanup';
type LaneOptions = {
  iceServers?: readonly RTCIceServer[];
  createRtc(configuration: RTCConfiguration): ScreenRtcPeer;
  createElement(): ScreenPlaybackElement;
  createStream(tracks: readonly MediaStreamTrack[]): MediaStream;
  onError(error: Error): void;
  now?: () => number;
  trackTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  playbackTimeoutMs?: number;
};
const error = (code: ScreenReceiveError['code'], message: string, cause?: unknown) =>
  new ScreenReceiveError(code, message, cause === undefined ? undefined : { cause });
const rawPeers = new WeakSet<ScreenRtcPeer>(),
  rawElements = new WeakSet<ScreenPlaybackElement>();
function timeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw error('invalid', 'Invalid receiver timeout.');
  return value;
}

// Reuse one lane across incoming-link/session replacements. Disposing a wrapper does
// not acknowledge settlement of its raw native/transport work or free its admission.
class ReceiveLane {
  private active?: ReceiveLink;
  private opening = false;
  private ending = false;
  private disposed = false;
  private slots = new Set<Slot>();
  readonly now: () => number;
  readonly trackTimeout: number;
  readonly cleanupTimeout: number;
  readonly playbackTimeout: number;
  readonly iceServers: readonly RTCIceServer[];
  constructor(private readonly options: LaneOptions) {
    this.options = { ...options };
    this.iceServers = screenIceServers(options.iceServers);
    this.now = options.now ?? Date.now;
    this.trackTimeout = timeout(options.trackTimeoutMs ?? 10000);
    this.cleanupTimeout = timeout(options.cleanupTimeoutMs ?? 5000);
    this.playbackTimeout = timeout(options.playbackTimeoutMs ?? 5000);
  }
  open(options: ScreenReceiveOptions): ScreenReceiveHandle {
    if (this.disposed) throw error('closed', 'Receive lane was disposed.');
    if (this.active || this.opening || this.ending || this.slots.size)
      throw error('busy', 'Finish the owned receiver and outstanding raw work first.');
    const endpoint = options.endpoint;
    if (
      !endpoint ||
      endpoint.role !== 'viewer' ||
      !['none', 'tab', 'system'].includes(endpoint.sound) ||
      Object.keys(endpoint).some((key) => !['epoch', 'linkId', 'role', 'sound'].includes(key))
    )
      throw error('invalid', 'Expected a fixed viewer endpoint.');
    const reference = parseScreenReference({ epoch: endpoint.epoch, linkId: endpoint.linkId });
    const fixed = {
      ...options,
      iceServers: screenIceServers(options.iceServers ?? this.iceServers),
      endpoint: Object.freeze({ ...reference, role: 'viewer' as const, sound: endpoint.sound }),
      lifecycle: {
        inspect: options.lifecycle.inspect.bind(options.lifecycle),
        onInvalidated: options.lifecycle.onInvalidated.bind(options.lifecycle),
      },
    };
    this.opening = true;
    try {
      const link = new ReceiveLink(this, fixed);
      this.active = link;
      try {
        link.start();
        return link;
      } catch (cause) {
        link.fail(cause);
        throw cause;
      }
    } finally {
      this.opening = false;
    }
  }
  inspect() {
    this.active?.inspect();
    return Object.freeze({
      occupied: !!this.active,
      disposed: this.disposed,
      pending: Object.freeze(
        Object.fromEntries(
          (['rtc', 'playback', 'signal', 'cleanup'] as const).map((slot) => [
            slot,
            this.slots.has(slot),
          ]),
        ),
      ),
    });
  }
  /** Internal child boundary: one raw operation of each kind, never a queue. */
  run<T>(slot: Slot, invoke: () => Promise<T>): Promise<T> {
    if (this.slots.has(slot))
      return Promise.reject(error('busy', 'Outstanding receiver operation.'));
    this.slots.add(slot);
    try {
      return Promise.resolve(invoke()).then(
        (value) => {
          this.slots.delete(slot);
          return value;
        },
        (cause: unknown) => {
          this.slots.delete(slot);
          throw cause;
        },
      );
    } catch (cause) {
      this.slots.delete(slot);
      return Promise.reject(cause);
    }
  }
  createRtc(configuration: RTCConfiguration): ScreenRtcPeer {
    const raw = this.options.createRtc(configuration);
    if (rawPeers.has(raw)) throw error('invalid', 'Receiver requires a fresh native peer.');
    rawPeers.add(raw);
    return {
      get connectionState() {
        return raw.connectionState;
      },
      getConfiguration: raw.getConfiguration.bind(raw),
      getTransceivers: raw.getTransceivers.bind(raw),
      addTransceiver: raw.addTransceiver.bind(raw),
      addEventListener: raw.addEventListener.bind(raw),
      removeEventListener: raw.removeEventListener.bind(raw),
      close: raw.close.bind(raw),
      createOffer: (...args) => this.run('rtc', () => raw.createOffer(...args)),
      createAnswer: (...args) => this.run('rtc', () => raw.createAnswer(...args)),
      setLocalDescription: (...args) => this.run('rtc', () => raw.setLocalDescription(...args)),
      setRemoteDescription: (...args) => this.run('rtc', () => raw.setRemoteDescription(...args)),
      addIceCandidate: (...args) => this.run('rtc', () => raw.addIceCandidate(...args)),
    };
  }
  createElement(): ScreenPlaybackElement {
    const raw = this.options.createElement();
    if (rawElements.has(raw) || !raw.paused || raw.srcObject !== null)
      throw error('invalid', 'Receiver requires a fresh paused empty element.');
    rawElements.add(raw);
    return {
      get srcObject() {
        return raw.srcObject;
      },
      set srcObject(value) {
        raw.srcObject = value;
      },
      get muted() {
        return raw.muted;
      },
      set muted(value) {
        raw.muted = value;
      },
      get volume() {
        return raw.volume;
      },
      set volume(value) {
        raw.volume = value;
      },
      get paused() {
        return raw.paused;
      },
      get sinkId() {
        return raw.sinkId;
      },
      pause: raw.pause.bind(raw),
      play: () => this.run('playback', () => raw.play()),
      ...(typeof raw.setSinkId === 'function'
        ? { setSinkId: (id: string) => this.run('playback', () => raw.setSinkId!(id)) }
        : {}),
      addEventListener: raw.addEventListener.bind(raw),
      removeEventListener: raw.removeEventListener.bind(raw),
    };
  }
  createStream(tracks: readonly MediaStreamTrack[]) {
    return this.options.createStream(tracks);
  }
  report(cause: unknown) {
    try {
      this.options.onError(
        cause instanceof Error ? cause : error('failed', 'Receiver failed.', cause),
      );
    } catch (failure) {
      queueMicrotask(() => {
        throw failure;
      });
    }
  }
  retire(link: ReceiveLink, local: () => void, cleanup: () => void) {
    this.ending = true;
    try {
      local();
      if (this.active === link) this.active = undefined;
      cleanup();
    } finally {
      this.ending = false;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.dispose();
  }
}

class ReceiveLink {
  private peer?: ScreenPeer;
  private playback?: ScreenPlaybackOwner;
  private closed = false;
  private generation?: object;
  private deadline = 0;
  private renewalRevision = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private trackTimer?: ReturnType<typeof setTimeout>;
  private cleanups: (() => void)[] = [];
  private lifecycleListeners = new Set<() => void>();
  private listeners = new Set<(state: ScreenReceiveState) => void>();
  private video?: MediaStreamTrack;
  private audio?: MediaStreamTrack;
  private state: ScreenReceiveState = Object.freeze({
    phase: 'receiving',
    hasVideo: false,
    hasAudio: false,
    playback: null,
    cleanup: Object.freeze({ status: 'none', pending: false }),
  });
  private readonly lifecycle: ScreenPeerLifecycle;
  constructor(
    private readonly lane: ReceiveLane,
    private readonly options: ScreenReceiveOptions,
  ) {
    this.lifecycle = {
      inspect: () => this.current(),
      onInvalidated: (listener) => {
        this.lifecycleListeners.add(listener);
        return () => {
          this.lifecycleListeners.delete(listener);
        };
      },
    };
  }
  start() {
    // The lane must own this link before an injected inspection can dispose it.
    const current = this.options.lifecycle.inspect();
    if (this.closed) throw error('closed', 'Receive link ended during inspection.');
    if (
      !current ||
      typeof current.generation !== 'object' ||
      !current.generation ||
      !Number.isSafeInteger(current.deadline) ||
      current.deadline <= this.lane.now()
    )
      throw error('invalid', 'Verified receive lifecycle is unavailable.');
    this.generation = current.generation;
    this.deadline = current.deadline;
    const remove = this.options.lifecycle.onInvalidated(() => this.end('lifecycle-lost'));
    if (this.closed) remove();
    else this.cleanups.push(remove);
    this.check();
    this.trackTimer = setTimeout(() => this.end('tracks-timeout'), this.lane.trackTimeout);
    const peer = new ScreenPeer({
      iceServers: this.options.iceServers,
      endpoint: this.options.endpoint,
      lifecycle: this.lifecycle,
      now: this.lane.now,
      createPeer: (config) => this.lane.createRtc(config),
      send: (signal, abort) => {
        this.check();
        return this.lane.run('signal', () => this.options.send(signal, abort));
      },
      onTrack: (track) => this.track(track),
      onError: (cause) => {
        if (!this.closed) this.fail(cause);
        else this.lane.report(cause);
      },
    });
    if (this.closed) peer.dispose();
    else this.peer = peer;
    this.check();
  }
  private current(): ReturnType<ScreenPeerLifecycle['inspect']> {
    if (this.closed || !this.generation) return null;
    let current: ReturnType<ScreenPeerLifecycle['inspect']>;
    try {
      current = this.options.lifecycle.inspect();
    } catch (cause) {
      this.fail(cause);
      return null;
    }
    if (this.closed) return null;
    if (
      !current ||
      current.generation !== this.generation ||
      !Number.isSafeInteger(current.deadline)
    ) {
      this.end('lifecycle-lost');
      return null;
    }
    this.deadline = Math.min(this.deadline, current.deadline);
    if (this.deadline <= this.lane.now()) {
      this.end('expired');
      return null;
    }
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        this.current();
      },
      Math.min(2147483647, Math.max(1, this.deadline - this.lane.now())),
    );
    return Object.freeze({ generation: this.generation, deadline: this.deadline });
  }
  private check() {
    if (!this.current()) throw error('closed', 'Receive link has ended.');
  }
  adoptRenewal(permit: ScreenRenewalPermit) {
    this.check();
    adoptScreenRenewal(
      permit,
      this.generation!,
      this.deadline,
      this.renewalRevision,
      this.lane.now(),
    );
    const current = this.options.lifecycle.inspect();
    if (!current || current.generation !== this.generation || current.deadline < permit.deadline)
      throw error('closed', 'Receive renewal lifecycle mismatch.');
    this.deadline = permit.deadline;
    this.renewalRevision = permit.revision;
    try {
      this.peer?.adoptRenewal(permit);
      this.playback?.adoptRenewal(permit);
      this.check();
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }
  private update(patch: Partial<ScreenReceiveState>) {
    this.state = Object.freeze({ ...this.state, ...patch });
    const state = this.state;
    for (const listener of [...this.listeners]) {
      if (this.state !== state) break;
      try {
        listener(state);
      } catch (cause) {
        this.lane.report(cause);
      }
    }
  }
  private track(track: MediaStreamTrack) {
    if (this.closed) return;
    this.check();
    if (
      !['video', 'audio'].includes(track.kind) ||
      track.readyState !== 'live' ||
      (track.kind === 'audio' && this.options.endpoint.sound === 'none')
    )
      throw error('invalid', 'Unexpected incoming track.');
    const old = track.kind === 'video' ? this.video : this.audio;
    if (old && old !== track) throw error('invalid', 'Duplicate incoming track kind.');
    if (old) return;
    if (track.kind === 'video') this.video = track;
    else this.audio = track;
    this.update({ hasVideo: !!this.video, hasAudio: !!this.audio });
    this.check();
    if (!this.video || (this.options.endpoint.sound !== 'none' && !this.audio)) return;
    clearTimeout(this.trackTimer);
    const playback = new ScreenPlaybackOwner({
      lifecycle: this.lifecycle,
      video: this.video,
      audio: this.audio ?? null,
      createElement: () => this.lane.createElement(),
      createStream: (tracks) => this.lane.createStream(tracks),
      onStopIncoming: (reason) => this.end(reason),
      onError: (cause) => this.lane.report(cause),
      now: this.lane.now,
      operationTimeoutMs: this.lane.playbackTimeout,
    });
    if (this.closed) {
      playback.dispose();
      return;
    }
    this.playback = playback;
    this.cleanups.push(
      playback.subscribe((state) => {
        if (!this.closed) this.update({ playback: state });
      }),
    );
    this.update({ phase: 'ready', playback: playback.inspect() });
  }
  inspect(): ScreenReceiveState {
    if (!this.closed && this.current() && this.playback) {
      const playback = this.playback.inspect();
      if (this.state.playback !== playback) this.update({ playback });
    }
    return this.state;
  }
  subscribe(listener: (state: ScreenReceiveState) => void) {
    this.check();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private controls() {
    this.check();
    if (!this.playback) throw error('not-ready', 'Wait for all negotiated incoming tracks.');
    return this.playback;
  }
  setOutput(id: string | null) {
    this.controls().setOutput(id);
  }
  outputLost(id: string) {
    this.controls().outputLost(id);
  }
  setMuted(value: boolean) {
    this.controls().setMuted(value);
  }
  setDeafened(value: boolean) {
    this.controls().setDeafened(value);
  }
  setVolume(value: number) {
    this.controls().setVolume(value);
  }
  play(request?: { signal?: AbortSignal }) {
    try {
      return this.controls().play(request);
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  receive(signal: unknown): Promise<void> {
    try {
      this.check();
      if (!this.peer) throw error('not-ready', 'Receiving peer is not ready.');
      return this.peer.receive(signal);
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  fail(cause: unknown) {
    this.end('failed');
    this.lane.report(cause);
  }
  private end(reason: ScreenReceiveEnd) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiry);
    clearTimeout(this.trackTimer);
    const failures: unknown[] = [];
    const clean = (work: () => void) => {
      try {
        work();
      } catch (cause) {
        failures.push(cause);
      }
    };
    this.lane.retire(
      this,
      () => {
        clean(() => this.playback?.dispose());
        clean(() => this.peer?.dispose());
        for (const listener of [...this.lifecycleListeners]) clean(listener);
        this.lifecycleListeners.clear();
        for (const cleanup of this.cleanups.splice(0)) clean(cleanup);
      },
      () => {
        this.update({
          phase: reason === 'hidden' ? 'paused-hidden' : 'closed',
          reason,
          playback: this.playback?.inspect() ?? null,
        });
        this.startCleanup(reason);
      },
    );
    this.listeners.clear();
    if (failures.length)
      this.lane.report(new AggregateError(failures, 'Receive link cleanup failed.'));
  }
  private startCleanup(reason: ScreenReceiveEnd) {
    const abort = new AbortController();
    this.update({ cleanup: Object.freeze({ status: 'pending', pending: true }) });
    const timer = setTimeout(() => {
      this.update({ cleanup: Object.freeze({ status: 'timed-out', pending: true }) });
      abort.abort();
      this.lane.report(
        error('failed', 'Selection cleanup timed out; raw work remains outstanding.'),
      );
    }, this.lane.cleanupTimeout);
    const finish = (status: 'succeeded' | 'failed', cause?: unknown) => {
      clearTimeout(timer);
      const timedOut = this.state.cleanup.status === 'timed-out';
      this.update({
        cleanup: Object.freeze({
          status: timedOut ? 'timed-out' : status,
          pending: false,
          ...(timedOut ? { late: status } : {}),
        }),
      });
      this.listeners.clear();
      if (status === 'failed')
        this.lane.report(error('failed', 'Selection cleanup failed.', cause));
    };
    const reference = Object.freeze({
      epoch: this.options.endpoint.epoch,
      linkId: this.options.endpoint.linkId,
    });
    void this.lane
      .run('cleanup', () => this.options.cleanup(reference, reason, abort.signal))
      .then(
        () => finish('succeeded'),
        (cause: unknown) => finish('failed', cause),
      );
  }
  stop() {
    this.end('stopped');
  }
  hide() {
    this.end('hidden');
  }
  dispose() {
    this.end('disposed');
  }
}
export type ScreenReceiveHandle = Pick<
  ReceiveLink,
  | 'inspect'
  | 'subscribe'
  | 'receive'
  | 'setOutput'
  | 'outputLost'
  | 'setMuted'
  | 'setDeafened'
  | 'setVolume'
  | 'play'
  | 'stop'
  | 'hide'
  | 'dispose'
  | 'adoptRenewal'
>;
export type ScreenReceiveLane = Readonly<Pick<ReceiveLane, 'open' | 'inspect' | 'dispose'>>;
export function createScreenReceiveLane(options: LaneOptions): ScreenReceiveLane {
  const lane = new ReceiveLane(options);
  return Object.freeze({
    open: lane.open.bind(lane),
    inspect: lane.inspect.bind(lane),
    dispose: lane.dispose.bind(lane),
  });
}
