import { runInBackground } from '../../shared/background';
import {
  parseScreenDescription,
  parseScreenIce,
  parseScreenSignal,
  parseScreenReference,
  screenQualityCeiling,
  type ScreenAck,
  type ScreenDescription,
  type ScreenLinkRequest,
  type ScreenSignal,
  type ScreenSound,
} from '@tricord/shared';
import {
  applyScreenVideoPlan,
  sameScreenVideoSource,
  screenVideoPlan,
  screenVideoRequest,
  screenVideoSource,
  ScreenVideoQualityError,
  type ScreenVideoRequest,
  type ScreenVideoApplied,
  type ScreenVideoSender,
} from './screen-quality';
import { screenIceServers, sameScreenIceServers } from './screen-ice';
import { adoptScreenRenewal, type ScreenRenewalPermit } from './screen-renewal';
import { ScreenStatistics, type ScreenMediaSample } from './screen-statistics';
import { screenCodecContentType } from './screen-codec';
import { screenAdaptiveVideoPlan } from './screen-adaptation';
import type { ScreenContentKind } from './screen-content';

// A local revocation/deadline seam, never a bearer grant. The signaling transport must
// authenticate and freshly authorize both endpoints on the server for every delivery.
export type ScreenPeerLifecycle = {
  inspect(): Readonly<{ generation: object; deadline: number }> | null;
  onInvalidated(listener: () => void): () => void;
};
export type BorrowedScreenSource = Readonly<{
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  sound: ScreenSound;
}>;
export type ScreenRtcPeer = Pick<
  RTCPeerConnection,
  | 'addTransceiver'
  | 'getTransceivers'
  | 'getConfiguration'
  | 'addEventListener'
  | 'removeEventListener'
  | 'close'
  | 'connectionState'
> & {
  // Only the promise API is part of the injected boundary, not legacy callbacks.
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  getStats?(): Promise<RTCStatsReport>;
  setConfiguration?(configuration: RTCConfiguration): void;
};
type Task = { run(): Promise<void>; resolve(): void; reject(error: unknown): void };
type Phase = 'idle' | 'offering' | 'awaiting-answer' | 'answering' | 'stable' | 'closed';
const failure = (message: string) => new Error('Screen peer: ' + message);
const ownedPeers = new WeakSet<ScreenRtcPeer>();

const disconnectGraceMs = 3000;

export class ScreenPeer {
  private readonly peer: ScreenRtcPeer;
  private readonly reference: ScreenLinkRequest;
  private readonly source?: BorrowedScreenSource;
  private readonly generation: object;
  private readonly now: () => number;
  private deadline: number;
  private renewalRevision = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private negotiation?: ReturnType<typeof setTimeout>;
  private closed?: Error;
  private phase: Phase = 'idle';
  private revision = 0;
  private sent = 0;
  private received = 0;
  private local?: ScreenDescription;
  private remote?: ScreenDescription;
  private previousUfrags = new Set<string>();
  private localCount = 0;
  private remoteCount = 0;
  private earlyLocal = 0;
  private earlyRemote = 0;
  private answerQueued = false;
  private tasks: Task[] = [];
  private pumping = false;
  private cancellations = new Set<(error: Error) => void>();
  private cleanups: (() => void)[] = [];
  private tracks = new Set<MediaStreamTrack>();
  private abort = new AbortController();
  private videoSender?: ScreenVideoSender;
  private qualityRequested?: ScreenVideoRequest;
  private qualityApplied?: ScreenVideoApplied;
  private qualityPending = 0;
  private readonly statistics = new ScreenStatistics();
  private mediaSample: ScreenMediaSample | null = null;
  private statisticsError = false;
  private monitoring?: ReturnType<typeof setTimeout>;
  private recovery?: ReturnType<typeof setTimeout>;
  private recoveryInGrace = false;
  private recoveryStarted = 0;
  private recoveryAttempts = 0;
  private connectedSince = 0;
  private initialRequest?: ScreenVideoRequest;
  private videoTransceiver?: RTCRtpTransceiver;
  private preferredCodec: string | null = null;
  private codecPreferenceError = false;
  private stableWaiters = new Set<() => void>();
  private statisticsPending = false;
  private statisticsTimeout?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      endpoint: ScreenLinkRequest & { role: 'publisher' | 'viewer'; sound: ScreenSound };
      lifecycle: ScreenPeerLifecycle;
      createPeer(configuration: RTCConfiguration): ScreenRtcPeer;
      send(signal: ScreenSignal, signalAbort: AbortSignal): Promise<ScreenAck<{ delivered: true }>>;
      source?: BorrowedScreenSource;
      onTrack(track: MediaStreamTrack): void;
      onError(error: Error): void;
      now?: () => number;
      iceServers?: readonly RTCIceServer[];
      currentIceServers?: () => readonly RTCIceServer[];
      initialVideoQuality?: unknown;
      videoBudget?: () => number;
      content?: () => ScreenContentKind;
      codecPreference?: () => Promise<string | null>;
    },
  ) {
    options = this.options = {
      ...options,
      endpoint: Object.freeze({ ...options.endpoint }),
      lifecycle: {
        inspect: options.lifecycle.inspect.bind(options.lifecycle),
        onInvalidated: options.lifecycle.onInvalidated.bind(options.lifecycle),
      },
    };
    this.now = options.now ?? Date.now;
    this.reference = Object.freeze(
      parseScreenReference({ epoch: options.endpoint.epoch, linkId: options.endpoint.linkId }),
    );
    if (
      !['publisher', 'viewer'].includes(options.endpoint.role) ||
      !['none', 'tab', 'system', 'application', 'source'].includes(options.endpoint.sound)
    )
      throw failure('invalid endpoint.');
    const current = options.lifecycle.inspect();
    if (
      !current ||
      typeof current.generation !== 'object' ||
      !current.generation ||
      !Number.isSafeInteger(current.deadline) ||
      current.deadline <= this.now()
    )
      throw failure('lifecycle unavailable.');
    this.generation = current.generation;
    this.deadline = current.deadline;
    if (options.endpoint.role === 'publisher') {
      const source = options.source;
      if (
        !source ||
        source.sound !== options.endpoint.sound ||
        source.video.kind !== 'video' ||
        (source.audio?.kind ?? 'audio') !== 'audio' ||
        (source.sound === 'none' ? !!source.audio : !source.audio) ||
        source.audio === source.video
      )
        throw failure('invalid consented source.');
      this.source = Object.freeze({
        video: source.video,
        audio: source.audio,
        sound: source.sound,
      });
      this.sourceTracks().forEach((track) => {
        if (track.readyState !== 'live' || !track.enabled) throw failure('source ended.');
      });
    } else if (options.source) throw failure('viewer cannot send capture.');
    let initialVideo =
      options.initialVideoQuality === undefined
        ? undefined
        : this.source
          ? screenVideoPlan(options.initialVideoQuality, this.source.video.getSettings())
          : (() => {
              throw failure('only a publisher can set initial video quality.');
            })();
    this.initialRequest = initialVideo?.request;
    if (initialVideo) initialVideo = this.videoPlan(initialVideo.request);
    if (
      !options.content &&
      this.source &&
      this.initialRequest &&
      'contentHint' in this.source.video
    )
      this.source.video.contentHint =
        screenQualityCeiling(this.initialRequest.publisher).frameRate > 30 ? 'motion' : 'detail';
    const iceServers = screenIceServers(options.iceServers);
    this.peer = options.createPeer({
      iceServers: structuredClone(iceServers),
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    });
    if (ownedPeers.has(this.peer)) throw failure('peer instance already belongs to an endpoint.');
    ownedPeers.add(this.peer);
    try {
      const config = this.peer.getConfiguration();
      if (
        !sameScreenIceServers(config.iceServers ?? [], iceServers) ||
        config.iceTransportPolicy === 'relay' ||
        config.iceCandidatePoolSize
      )
        throw failure('unexpected ICE/relay configuration.');
      if (this.peer.connectionState !== 'new' || this.peer.getTransceivers().length)
        throw failure('a fresh empty peer is required.');
      this.listen(this.peer, 'icecandidate', (event) =>
        this.candidate(event as RTCPeerConnectionIceEvent),
      );
      this.listen(this.peer, 'track', (event) => this.track((event as RTCTrackEvent).track));
      this.listen(this.peer, 'connectionstatechange', () => {
        if (this.closed) return;
        try {
          this.check();
          this.connectionChanged();
        } catch (error) {
          this.close(this.error(error));
        }
      });
      for (const track of this.sourceTracks()) {
        this.listen(track, 'ended', () => this.close(failure('source ended.')));
        const transceiver = this.peer.addTransceiver(track, {
          direction: 'sendonly',
          ...(track === this.source?.video && initialVideo
            ? { sendEncodings: [initialVideo.encoding] }
            : {}),
        });
        if (track === this.source?.video) {
          this.videoSender = transceiver?.sender;
          this.videoTransceiver = transceiver;
        }
      }
      const unsubscribe = options.lifecycle.onInvalidated(() =>
        this.close(failure('lifecycle ended.')),
      );
      if (this.closed) {
        unsubscribe();
        throw this.closed;
      }
      this.cleanups.push(unsubscribe);
      this.check();
    } catch (error) {
      this.close(this.error(error));
      throw error;
    }
  }
  private sourceTracks() {
    return this.source
      ? [this.source.video, ...(this.source.audio ? [this.source.audio] : [])]
      : [];
  }
  setVideoQuality(value: unknown): Promise<ScreenVideoApplied> {
    try {
      this.check();
    } catch (error) {
      this.close(this.error(error));
      return Promise.reject(error);
    }
    let request: ScreenVideoRequest;
    try {
      request = screenVideoRequest(value);
      if (
        this.options.endpoint.role !== 'publisher' ||
        this.phase !== 'stable' ||
        !this.videoSender ||
        !this.source
      )
        throw new ScreenVideoQualityError(
          'unsupported',
          'Video limits require a negotiated publisher endpoint.',
        );
      if (request.revision <= (this.qualityRequested?.revision ?? 0))
        throw new ScreenVideoQualityError('stale', 'Stale video limit revision.');
      if (this.qualityPending >= 2)
        throw new ScreenVideoQualityError('busy', 'Finish the pending video limit updates first.');
      screenVideoPlan(request, this.source.video.getSettings());
    } catch (error) {
      return Promise.reject(error);
    }
    const sender = this.videoSender!,
      track = this.source!.video;
    this.qualityRequested = request;
    this.qualityPending++;
    let applied: ScreenVideoApplied;
    const target = () => {
      this.check();
      if (this.videoSender !== sender || sender.track !== track || this.source?.video !== track)
        throw new ScreenVideoQualityError('stale', 'Video sender source changed.');
    };
    return this.enqueue(async () => {
      target();
      const plan = this.videoPlan(request);
      const verify = () => {
        target();
        if (!sameScreenVideoSource(plan.source, screenVideoSource(track.getSettings())))
          throw new ScreenVideoQualityError('stale', 'Video source settings changed.');
      };
      applied = await applyScreenVideoPlan(sender, plan, (raw) => this.wait(raw), verify);
      verify();
      this.qualityApplied = applied;
    })
      .then(() => {
        try {
          target();
          return applied;
        } catch (error) {
          this.close(this.error(error));
          throw error;
        }
      })
      .finally(() => {
        this.qualityPending--;
      });
  }
  inspectVideoQuality() {
    if (!this.closed) {
      try {
        this.check();
        if (
          (this.source && this.videoSender && this.videoSender.track !== this.source.video) ||
          (this.qualityApplied && !this.source)
        )
          throw new ScreenVideoQualityError('stale', 'Video sender source changed.');
        if (
          this.qualityApplied &&
          this.source &&
          !sameScreenVideoSource(
            this.qualityApplied.plan.source,
            screenVideoSource(this.source.video.getSettings()),
          )
        )
          this.qualityApplied = undefined;
      } catch (error) {
        this.close(this.error(error));
      }
    }
    return Object.freeze({
      requested: this.qualityRequested ?? null,
      applied: this.qualityApplied ?? null,
      pending: this.closed ? 0 : this.qualityPending,
      closed: !!this.closed,
    });
  }
  private error(error: unknown) {
    return error instanceof Error ? error : new Error('Screen peer failed.', { cause: error });
  }
  private listen(
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
    event: string,
    listener: EventListener,
  ) {
    this.cleanups.push(() => target.removeEventListener(event, listener));
    target.addEventListener(event, listener);
  }
  private check() {
    if (this.closed) throw this.closed;
    const current = this.options.lifecycle.inspect();
    if (this.closed) throw this.closed;
    if (
      !current ||
      current.generation !== this.generation ||
      !Number.isSafeInteger(current.deadline)
    )
      throw failure('lifecycle ended.');
    this.deadline = Math.min(this.deadline, current.deadline);
    if (this.deadline <= this.now()) throw failure('deadline expired.');
    if (this.sourceTracks().some((track) => track.readyState !== 'live' || !track.enabled))
      throw failure('source ended.');
    clearTimeout(this.expiry);
    this.expiry = setTimeout(
      () => {
        try {
          this.check();
        } catch (error) {
          this.close(this.error(error));
        }
      },
      Math.min(2147483647, Math.max(1, this.deadline - this.now())),
    );
  }
  private wait<T>(raw: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => reject(error);
      this.cancellations.add(cancel);
      raw.then(
        (value) => {
          this.cancellations.delete(cancel);
          try {
            this.check();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          this.cancellations.delete(cancel);
          reject(error);
        },
      );
      if (this.closed) {
        this.cancellations.delete(cancel);
        reject(this.closed);
      }
    });
  }
  private enqueue(run: Task['run']): Promise<void> {
    try {
      this.check();
    } catch (error) {
      this.close(this.error(error));
      return Promise.reject(error);
    }
    if (this.tasks.length >= 128) {
      const error = failure('pending signaling limit.');
      this.close(error);
      return Promise.reject(error);
    }
    const result = new Promise<void>((resolve, reject) =>
      this.tasks.push({ run, resolve, reject }),
    );
    runInBackground(this.pump());
    return result;
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.tasks.length) {
        const task = this.tasks.shift()!;
        try {
          this.check();
          await task.run();
          this.check();
          task.resolve();
        } catch (error) {
          task.reject(error);
          this.close(this.error(error));
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private begin() {
    this.qualityApplied = undefined;
    this.previousUfrags = new Set(this.local?.ufrags);
    this.local = this.remote = undefined;
    this.localCount = this.remoteCount = this.earlyLocal = this.earlyRemote = 0;
    this.answerQueued = false;
    clearTimeout(this.negotiation);
    this.negotiation = setTimeout(() => this.close(failure('negotiation timeout.')), 10000);
  }
  private described(sdp: string, type: 'offer' | 'answer') {
    const result = parseScreenDescription(sdp, type);
    const kinds = this.options.endpoint.sound === 'none' ? ['m=video'] : ['m=video', 'm=audio'];
    if (result.kinds.join() !== kinds.join() || (type === 'offer' && result.candidates > 32))
      throw failure('unexpected media.');
    return result;
  }
  private async send(payload: ScreenSignal['payload'], revision: number) {
    this.check();
    const signal = parseScreenSignal({
      ...this.reference,
      revision,
      sequence: ++this.sent,
      payload,
    });
    const ack = await this.wait(this.options.send(signal, this.abort.signal));
    if (!ack?.ok || ack.data?.delivered !== true) throw failure('signaling delivery rejected.');
  }
  offer(iceRestart = false): Promise<void> {
    if (
      this.options.endpoint.role !== 'publisher' ||
      !['idle', 'stable'].includes(this.phase) ||
      this.pumping ||
      this.tasks.length
    )
      return Promise.reject(failure('publisher negotiation is busy or unavailable.'));
    this.phase = 'offering';
    const revision = ++this.revision;
    this.begin();
    return this.enqueue(async () => {
      const request = this.qualityRequested ?? this.initialRequest;
      if (
        request &&
        this.videoSender &&
        (request.publisher.resolution !== undefined || request.viewer.resolution !== undefined)
      ) {
        await applyScreenVideoPlan(
          this.videoSender,
          this.videoPlan(request),
          (raw) => this.wait(raw),
          () => this.check(),
        );
      }
      if (revision === 1 && this.options.codecPreference) {
        const preferred = await this.wait(this.options.codecPreference());
        this.check();
        if (
          preferred &&
          this.videoTransceiver?.setCodecPreferences &&
          typeof RTCRtpSender !== 'undefined'
        ) {
          const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
          const first = codecs.filter(
            (codec) => screenCodecContentType(codec).toLowerCase() === preferred.toLowerCase(),
          );
          if (first.length) {
            try {
              this.videoTransceiver.setCodecPreferences([
                ...first,
                ...codecs.filter((codec) => !first.includes(codec)),
              ]);
              this.preferredCodec = preferred;
            } catch {
              this.codecPreferenceError = true;
              this.videoTransceiver.setCodecPreferences([]);
            }
          }
        }
      }
      if (iceRestart) this.refreshIceServers();
      const offer = await this.wait(
        this.peer.createOffer(iceRestart ? { iceRestart: true } : undefined),
      );
      if (offer.type !== 'offer' || !offer.sdp) throw failure('invalid local offer.');
      this.local = this.described(offer.sdp, 'offer');
      this.localCount += this.local.candidates;
      this.earlyLocal += this.local.candidates;
      if (this.localCount > 128 || this.earlyLocal > 32) throw failure('candidate limit.');
      await this.wait(this.peer.setLocalDescription(offer));
      await this.send({ type: 'offer', sdp: offer.sdp }, revision);
      this.phase = 'awaiting-answer';
    });
  }
  receive(value: unknown): Promise<void> {
    try {
      this.check();
    } catch (error) {
      this.close(this.error(error));
      return Promise.reject(error);
    }
    let signal: ScreenSignal;
    try {
      signal = parseScreenSignal(value);
      if (
        signal.epoch !== this.reference.epoch ||
        signal.linkId !== this.reference.linkId ||
        signal.sequence <= this.received
      )
        throw failure('stale endpoint or sequence.');
      const payload = signal.payload;
      if (payload.type === 'offer') {
        if (
          this.options.endpoint.role !== 'viewer' ||
          !['idle', 'stable'].includes(this.phase) ||
          signal.revision !== this.revision + 1
        )
          throw failure('unexpected offer revision.');
        const description = this.described(payload.sdp, 'offer');
        this.begin();
        this.phase = 'answering';
        this.revision = signal.revision;
        this.remote = description;
        this.remoteCount = this.earlyRemote = description.candidates;
      } else {
        if (signal.revision !== this.revision || !this.revision)
          throw failure('stale negotiation.');
        if (payload.type === 'answer') {
          if (
            this.options.endpoint.role !== 'publisher' ||
            !['offering', 'awaiting-answer'].includes(this.phase) ||
            this.answerQueued
          )
            throw failure('unexpected answer.');
          this.remote = this.described(payload.sdp, 'answer');
          this.remoteCount = this.remote.candidates;
          this.answerQueued = true;
        } else {
          const candidate = payload.candidate;
          if (
            !this.remote ||
            this.remote.mids[candidate.sdpMLineIndex] !== candidate.sdpMid ||
            this.remote.ufrags[candidate.sdpMLineIndex] !== candidate.usernameFragment
          )
            throw failure('candidate description mismatch.');
          if (
            ++this.remoteCount > 128 ||
            (this.options.endpoint.role === 'viewer' &&
              this.phase !== 'stable' &&
              ++this.earlyRemote > 32)
          ) {
            const error = failure('candidate limit.');
            this.close(error);
            throw error;
          }
        }
      }
      this.received = signal.sequence;
    } catch (error) {
      return Promise.reject(error);
    }
    const payload = signal.payload;
    return this.enqueue(async () => {
      if (payload.type === 'ice') {
        await this.wait(this.peer.addIceCandidate(payload.candidate));
        return;
      }
      if (payload.type === 'answer') {
        const remote = this.described(payload.sdp, 'answer');
        if (
          remote.mids.join() !== this.local?.mids.join() ||
          remote.kinds.join() !== this.local?.kinds.join()
        )
          throw failure('answer mismatch.');
        await this.wait(this.peer.setRemoteDescription(payload));
      } else {
        const remote = this.described(payload.sdp, 'offer');
        this.refreshIceServers();
        await this.wait(this.peer.setRemoteDescription(payload));
        this.peer.getTransceivers().forEach((transceiver) => {
          transceiver.direction = 'recvonly';
        });
        const answer = await this.wait(this.peer.createAnswer());
        if (answer.type !== 'answer' || !answer.sdp) throw failure('invalid local answer.');
        const local = this.described(answer.sdp, 'answer');
        if (local.mids.join() !== remote.mids.join() || local.kinds.join() !== remote.kinds.join())
          throw failure('answer mismatch.');
        this.local = local;
        this.localCount += local.candidates;
        if (this.localCount > 128) throw failure('candidate limit.');
        await this.wait(this.peer.setLocalDescription(answer));
        await this.send({ type: 'answer', sdp: answer.sdp }, signal.revision);
      }
      this.phase = 'stable';
      clearTimeout(this.negotiation);
      for (const resolve of this.stableWaiters) resolve();
      this.stableWaiters.clear();
      this.scheduleMonitoring();
    });
  }
  private connectionChanged() {
    const state = this.peer.connectionState;
    if (state === 'closed') throw failure('connection ended.');
    if (state === 'connected') {
      clearTimeout(this.recovery);
      this.recovery = undefined;
      this.recoveryInGrace = false;
      this.recoveryStarted = 0;
      this.connectedSince = this.now();
      return;
    }
    if (state !== 'failed' && state !== 'disconnected') return;
    if (this.connectedSince && this.now() - this.connectedSince >= 30000) this.recoveryAttempts = 0;
    this.connectedSince = 0;
    if (!this.recoveryStarted) this.recoveryStarted = this.now();
    if (state === 'failed' && this.recoveryInGrace) {
      clearTimeout(this.recovery);
      this.recovery = undefined;
    }
    this.scheduleRecovery(state === 'failed' ? 0 : disconnectGraceMs);
  }
  private refreshIceServers() {
    if (!this.options.currentIceServers) return;
    this.check();
    const servers = screenIceServers(this.options.currentIceServers());
    const configuration = this.peer.getConfiguration();
    if (sameScreenIceServers(configuration.iceServers ?? [], servers)) return;
    if (!this.peer.setConfiguration) throw failure('ICE configuration refresh unavailable.');
    this.peer.setConfiguration({ ...configuration, iceServers: structuredClone(servers) });
    if (!sameScreenIceServers(this.peer.getConfiguration().iceServers ?? [], servers))
      throw failure('ICE configuration refresh was not confirmed.');
  }
  private scheduleRecovery(delay: number) {
    if (this.recovery || this.closed) return;
    this.recoveryInGrace = delay === disconnectGraceMs;
    this.recovery = setTimeout(() => {
      this.recovery = undefined;
      this.recoveryInGrace = false;
      try {
        this.check();
        if (this.peer.connectionState === 'connected') return;
        if (this.now() - this.recoveryStarted >= 20000)
          throw failure('connection recovery timed out.');
        if (
          this.options.endpoint.role === 'publisher' &&
          this.phase === 'stable' &&
          !this.pumping &&
          !this.tasks.length
        ) {
          if (this.recoveryAttempts >= 2) throw failure('connection recovery exhausted.');
          this.recoveryAttempts++;
          void this.offer(true).catch((cause) => this.close(this.error(cause)));
          this.scheduleRecovery(8000);
        } else this.scheduleRecovery(1000);
      } catch (cause) {
        this.close(this.error(cause));
      }
    }, delay);
  }
  private videoPlan(request: ScreenVideoRequest) {
    const plan = screenVideoPlan(request, this.source!.video.getSettings());
    const budget = this.options.videoBudget?.() ?? plan.encoding.maxBitrate;
    if (!Number.isFinite(budget) || budget <= 0) throw failure('invalid video budget.');
    return screenAdaptiveVideoPlan(
      plan,
      budget,
      this.options.content?.() ?? (plan.ceiling.frameRate > 30 ? 'motion' : 'detail'),
    );
  }
  async refreshVideoLimits(): Promise<void> {
    const request = this.qualityRequested ?? this.initialRequest;
    if (!request || !this.source || !this.videoSender || this.phase === 'idle') return;
    this.check();
    if (this.phase !== 'stable') {
      let ready!: () => void;
      const stable = new Promise<void>((resolve) => {
        ready = resolve;
        this.stableWaiters.add(resolve);
      });
      try {
        await this.wait(stable);
      } finally {
        this.stableWaiters.delete(ready);
      }
    }
    return this.enqueue(async () => {
      this.check();
      const current = this.videoPlan(this.qualityRequested ?? request);
      const track = this.source!.video;
      const verify = () => {
        this.check();
        if (this.videoSender!.track !== track) throw failure('video sender source changed.');
      };
      const result = await applyScreenVideoPlan(
        this.videoSender!,
        current,
        (raw) => this.wait(raw),
        verify,
      );
      verify();
      this.qualityApplied = sameScreenVideoSource(
        current.source,
        screenVideoSource(track.getSettings()),
      )
        ? result
        : undefined;
    });
  }
  private scheduleMonitoring() {
    if (this.closed || this.monitoring || (!this.peer.getStats && !this.source)) return;
    this.monitoring = setTimeout(() => {
      this.monitoring = undefined;
      runInBackground(this.monitorMedia());
    }, 2000);
  }
  private async monitorMedia() {
    try {
      this.check();
      await this.maintainVideoLimits();
      this.scheduleMonitoring();
      if (!this.peer.getStats) return;
      if (this.statisticsPending) return;
      let report: RTCStatsReport;
      try {
        const raw = this.peer.getStats!();
        this.statisticsPending = true;
        void raw.then(
          () => {
            this.statisticsPending = false;
          },
          () => {
            this.statisticsPending = false;
          },
        );
        report = await Promise.race([
          this.wait(raw),
          new Promise<never>((_, reject) => {
            this.statisticsTimeout = setTimeout(
              () => reject(failure('statistics timed out.')),
              5000,
            );
          }),
        ]);
      } catch {
        // A rejected operation is settled; a timed-out operation retains admission until it settles.
        if (this.closed) return;
        this.statisticsError = true;
        this.mediaSample = null;
        // Diagnostic failure is visible in inspection, but must not terminate healthy media.
        return;
      } finally {
        clearTimeout(this.statisticsTimeout);
      }
      this.check();
      this.statisticsError = false;
      this.mediaSample = this.statistics.sample(report, this.source ? 'outbound' : 'inbound');
    } catch (cause) {
      if (!this.closed) this.close(this.error(cause));
    } finally {
      this.scheduleMonitoring();
    }
  }
  private async maintainVideoLimits() {
    const request = this.qualityRequested ?? this.initialRequest;
    if (
      !request ||
      !this.source ||
      !this.videoSender ||
      this.phase !== 'stable' ||
      this.qualityPending ||
      this.pumping ||
      this.tasks.length
    )
      return;
    const plan = this.videoPlan(request);
    const applied = this.qualityApplied;
    if (
      applied &&
      applied.plan.content === plan.content &&
      sameScreenVideoSource(applied.plan.source, plan.source) &&
      Object.entries(plan.encoding).every(
        ([key, value]) => applied.plan.encoding[key as keyof typeof plan.encoding] === value,
      )
    )
      return;
    await this.refreshVideoLimits();
  }
  inspectMedia() {
    return Object.freeze({
      sample: this.closed ? null : this.mediaSample,
      statistics: this.closed
        ? 'closed'
        : !this.peer.getStats
          ? 'unsupported'
          : this.statisticsError
            ? 'error'
            : this.mediaSample
              ? 'available'
              : 'pending',
      recoveryAttempts: this.recoveryAttempts,
      preferredCodec: this.preferredCodec,
      codecPreferenceError: this.codecPreferenceError,
    });
  }
  private candidate(event: RTCPeerConnectionIceEvent) {
    // Empty candidates mark the end of gathering, rather than a candidate to relay.
    if (!event.candidate || event.candidate.candidate === '' || this.closed) return;
    try {
      this.check();
      const c = event.candidate;
      const candidate = parseScreenIce({
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      });
      const revision = this.revision;
      if (!revision) throw failure('candidate without negotiation.');
      if (
        this.local
          ? this.local.mids[candidate.sdpMLineIndex] !== candidate.sdpMid ||
            this.local.ufrags[candidate.sdpMLineIndex] !== candidate.usernameFragment
          : this.previousUfrags.has(candidate.usernameFragment)
      )
        return;
      if (
        ++this.localCount > 128 ||
        (this.options.endpoint.role === 'publisher' &&
          this.phase !== 'stable' &&
          ++this.earlyLocal > 32)
      )
        throw failure('candidate limit.');
      void this.enqueue(async () => {
        if (revision !== this.revision) return;
        if (
          !this.local ||
          this.local.mids[candidate.sdpMLineIndex] !== candidate.sdpMid ||
          this.local.ufrags[candidate.sdpMLineIndex] !== candidate.usernameFragment
        )
          return;
        await this.send({ type: 'ice', candidate }, revision);
      }).catch((error) => {
        if (!this.closed) this.close(this.error(error));
      });
    } catch (error) {
      this.close(this.error(error));
    }
  }
  private track(track: MediaStreamTrack) {
    const borrowed = this.sourceTracks().includes(track);
    if (this.closed) {
      if (!borrowed) this.cleanup([() => track.stop()]);
      return;
    }
    try {
      this.check();
      if (
        this.options.endpoint.role !== 'viewer' ||
        !this.remote ||
        !this.revision ||
        !['video', 'audio'].includes(track.kind) ||
        (track.kind === 'audio' && this.options.endpoint.sound === 'none') ||
        track.readyState !== 'live' ||
        [...this.tracks].some((old) => old !== track && old.kind === track.kind)
      )
        throw failure('unexpected incoming track.');
      if (this.tracks.has(track)) return;
      this.tracks.add(track);
      this.listen(track, 'ended', () => this.close(failure('incoming source ended.')));
      this.options.onTrack(track);
    } catch (error) {
      if (!borrowed) this.tracks.add(track);
      this.close(this.error(error));
    }
  }
  inspect() {
    if (!this.closed) {
      try {
        this.check();
      } catch (error) {
        this.close(this.error(error));
      }
    }
    return Object.freeze({ phase: this.phase, revision: this.revision });
  }
  adoptRenewal(permit: ScreenRenewalPermit) {
    this.check();
    adoptScreenRenewal(permit, this.generation, this.deadline, this.renewalRevision, this.now());
    const current = this.options.lifecycle.inspect();
    if (!current || current.generation !== this.generation || current.deadline < permit.deadline)
      throw failure('renewal lifecycle mismatch.');
    this.deadline = permit.deadline;
    this.renewalRevision = permit.revision;
    this.check();
  }
  private report(error: Error) {
    try {
      this.options.onError(error);
    } catch (cause) {
      queueMicrotask(() => {
        throw cause;
      });
    }
  }
  private cleanup(work: (() => void)[], error?: Error) {
    const errors: unknown[] = error ? [error] : [];
    for (const run of work) {
      try {
        run();
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length) this.report(new AggregateError(errors, 'Screen peer ended.'));
  }
  private close(error?: Error) {
    if (this.closed) return;
    this.closed = error ?? failure('closed.');
    this.qualityApplied = undefined;
    this.phase = 'closed';
    clearTimeout(this.expiry);
    clearTimeout(this.negotiation);
    clearTimeout(this.monitoring);
    clearTimeout(this.recovery);
    clearTimeout(this.statisticsTimeout);
    this.stableWaiters.clear();
    for (const task of this.tasks.splice(0)) task.reject(this.closed);
    for (const cancel of this.cancellations) cancel(this.closed);
    this.cancellations.clear();
    const tracks = [...this.tracks];
    this.tracks.clear();
    this.cleanup(
      [
        () => this.abort.abort(),
        ...this.cleanups.splice(0).reverse(),
        () => this.peer.close(),
        ...tracks.map((track) => () => track.stop()),
      ],
      error,
    );
  }
  dispose() {
    this.close();
  }
}
