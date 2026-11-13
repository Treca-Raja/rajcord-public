// Test-only entry served by the isolated browser integration server, never by the app.
import { io, type Socket } from 'socket.io-client';
import type {
  AuthState,
  ScreenAck,
  ScreenBinding,
  ScreenLinkGrant,
  ScreenLinkNotice,
  ScreenClosed,
  ScreenRenewal,
  ScreenPublishGrant,
  ScreenSignal,
  ScreenSignalNotice,
} from '@tricord/shared';
import { ScreenPeer, type ScreenPeerLifecycle } from './screen-peer';
import { createScreenReceiveLane, type ScreenReceiveHandle } from './screen-receiver';
import type { ScreenPlaybackElement } from './screen-playback';
import { selectionFixture } from '../../api/src/screen/selection-fixture';

class FixtureOutput extends EventTarget implements ScreenPlaybackElement {
  srcObject: HTMLVideoElement['srcObject'] = null;
  muted = true;
  volume = 1;
  paused = true;
  sinkId = '';
  pause() {
    this.paused = true;
  }
  async play() {
    this.paused = false;
  }
  async setSinkId(id: string) {
    this.sinkId = id;
  }
}
function heldCleanup(stage: 'before-send' | 'after-ack') {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { stage, promise, release };
}

type SyntheticAudioData = {
  close(): void;
  numberOfFrames: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
};
type GeneratedAudioTrack = MediaStreamTrack & { writable: WritableStream<SyntheticAudioData> };
type EncodedFrame = { data: ArrayBuffer; timestamp: number };
type EncodedEndpoint = {
  createEncodedStreams(): {
    readable: ReadableStream<EncodedFrame>;
    writable: WritableStream<EncodedFrame>;
  };
};
type TestDecoder = {
  configure(config: { codec: 'opus'; sampleRate: number; numberOfChannels: number }): void;
  decode(chunk: unknown): void;
  close(): void;
  state: string;
  decodeQueueSize: number;
};

export function createScreenPeerFixture(
  role: 'publisher' | 'viewer',
  size = { width: 320, height: 180 },
  receiveMode: 'peer' | 'lane' = 'peer',
) {
  let auth: AuthState, socket: Socket, leaseId: string, binding: ScreenBinding;
  let bindingDeadline = 0,
    grantDeadline = 0,
    linkId: string | undefined;
  let current: ReturnType<ScreenPeerLifecycle['inspect']> = null;
  const listeners = new Set<() => void>();
  const native = new Set<Promise<unknown>>(),
    wire = new Set<Promise<unknown>>(),
    operations = new Set<Promise<unknown>>();
  const incoming: MediaStreamTrack[] = [],
    sourceTracks: MediaStreamTrack[] = [];
  let peer: ScreenPeer | undefined, rtc: RTCPeerConnection | undefined;
  let receiver: ScreenReceiveHandle | undefined;
  let plan: ReturnType<typeof selectionFixture>,
    selected: ReturnType<ReturnType<typeof selectionFixture>['select']>;
  let selectedShare: string | undefined,
    renewalRevision = 0,
    incomingStart = 0;
  const peers: RTCPeerConnection[] = [],
    receivers: ScreenReceiveHandle[] = [],
    outputs: FixtureOutput[] = [];
  let cleanupHold: ReturnType<typeof heldCleanup> | undefined;
  let draw: ReturnType<typeof setInterval> | undefined,
    audioTimer: ReturnType<typeof setInterval> | undefined;
  let audioWriter: WritableStreamDefaultWriter<SyntheticAudioData> | undefined;
  let disposing = false;
  const writes = new Set<Promise<unknown>>();
  let decodedRms = 0,
    decoder: TestDecoder | undefined;
  const pipes = new Set<Promise<unknown>>();
  let pipeAbort = new AbortController();
  const nativeCleanups: (() => void)[] = [];
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.width = 320;
  video.height = 180;
  document.body.appendChild(video);
  let frameCallback = 0;
  const lane =
    role === 'viewer' && receiveMode === 'lane'
      ? createScreenReceiveLane({
          createRtc: (configuration) => createNative(configuration),
          createElement: () => {
            const element = new FixtureOutput();
            outputs.push(element);
            return element;
          },
          createStream: (tracks) => new MediaStream([...tracks]),
          onError: (error) => f.peerErrors.push(errorMessages(error)),
        })
      : undefined;
  const f = {
    role,
    errors: [] as string[],
    peerErrors: [] as string[],
    signalTypes: [] as string[],
    signalCount: 0,
    wireSettled: 0,
    lastAck: null as ScreenAck<{ delivered: true }> | null,
    linkNotice: null as ScreenLinkNotice | null,
    ignoreClosed: false,
    physicalCalls: 0,
    frames: 0,
    operationResult: '',
    sourceDisposed: false,
    cleanupLog: [] as {
      revision: number;
      reason: string;
      localClosed: boolean;
      incomingEnded: boolean;
      outputDetached: boolean;
      aborted: boolean;
      reply?: string;
      transport?: 'connected' | 'disconnected';
    }[],
    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch('/api' + path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth ? { 'X-CSRF-Token': auth.csrfToken } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data: unknown = await response.json();
      if (!response.ok)
        throw Object.assign(new Error('Fixture HTTP ' + response.status + ': ' + path), {
          status: response.status,
        });
      return data as T;
    },
    async connect(credentials: { username: string; password: string }) {
      auth = await f.request<AuthState>('/auth/login', 'POST', { ...credentials, remember: false });
      const verified = await f.request<AuthState>('/auth/me');
      if (
        verified.user.status !== 'approved' ||
        verified.user.id !== auth.user.id ||
        verified.csrfToken !== auth.csrfToken
      )
        throw new Error('Fixture session mismatch.');
      const channels = await f.request<{ channels: { id: string }[] }>('/voice/channels');
      const lease = await f.request<{ id: string }>('/voice/join', 'POST', {
        channelId: channels.channels[0]!.id,
      });
      leaseId = lease.id;
      socket = io({
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        auth: { csrfToken: auth.csrfToken },
      });
      socket.on('screen:link', (notice: ScreenLinkNotice) => {
        if (notice.epoch === binding?.epoch) f.linkNotice = notice;
      });
      socket.on('screen:closed', (notice: ScreenClosed) => {
        if (
          !f.ignoreClosed &&
          notice.epoch === binding?.epoch &&
          (notice.linkId === null || notice.linkId === linkId)
        )
          invalidate();
      });
      socket.on('disconnect', invalidate);
      socket.on('screen:signal', (notice: ScreenSignalNotice) => {
        f.signalCount++;
        const target = lane ? receiver : peer;
        if (!target) {
          f.errors.push('Signal before peer construction.');
          return;
        }
        observe(target.receive(notice), operations).catch((error) => {
          if (!['closed', 'paused-hidden'].includes(target.inspect().phase))
            f.errors.push(String(error));
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        socket.connect();
      });
      const started = Date.now();
      binding = await command<ScreenBinding>('screen:bind', {
        version: 2,
        leaseId,
        requestId: crypto.randomUUID(),
      });
      bindingDeadline = started + binding.remainingMs;
      const ownedSocket = socket;
      plan = selectionFixture(binding.epoch, async (request) => {
        let ack: ScreenAck<ScreenLinkGrant | null>;
        try {
          ack = await observe(
            ownedSocket.timeout(4000).emitWithAck('screen:select', request),
            wire,
          );
        } catch (error) {
          throw Object.assign(
            new Error('Fixture selection received no acknowledgement.', { cause: error }),
            {
              transport: ownedSocket.connected ? 'connected' : 'disconnected',
            },
          );
        }
        if (!ack.ok)
          throw Object.assign(new Error('Fixture screen:select rejected: ' + ack.code), {
            code: ack.code,
          });
        return ack.data;
      });
      return {
        userId: auth.user.id,
        channelId: binding.channelId,
        remainingMs: binding.remainingMs,
      };
    },
    async rejectWrongCsrf() {
      const rejected = io({
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        auth: { csrfToken: 'owned-invalid-csrf' },
      });
      try {
        return await new Promise<boolean>((resolve, reject) => {
          rejected.once('connect', () => reject(new Error('Invalid CSRF accepted.')));
          rejected.once('connect_error', () => resolve(true));
          rejected.connect();
        });
      } finally {
        rejected.removeAllListeners();
        rejected.disconnect();
      }
    },
    async publish() {
      return command<ScreenPublishGrant>('screen:publish', {
        epoch: binding.epoch,
        requestId: crypto.randomUUID(),
        sourceGeneration: 1,
        profile: 'smooth',
        videoBitrate: 8000000,
        sound: 'tab',
      }).then((grant) => grant.share);
    },
    async select(shareId: string) {
      const started = Date.now();
      selected = plan.select(shareId);
      selectedShare = shareId;
      const grant = (await selected.operation.run())!;
      if (grant.link.viewerId !== auth.user.id || grant.link.shareId !== shareId)
        throw new Error('Fixture selection mismatch.');
      linkId = grant.link.id;
      grantDeadline = Math.min(bindingDeadline, started + grant.remainingMs);
      return { linkId, remainingMs: grantDeadline - Date.now() };
    },
    async reselect() {
      if (!selectedShare) throw new Error('No fixture selection to replace.');
      return f.select(selectedShare);
    },
    async refreshPublisherGrant() {
      const expected = f.linkNotice?.grant.link;
      if (!expected || expected.publisherId !== auth.user.id)
        throw new Error('Missing publisher link notice.');
      // A notice is not a capability: explicitly renew through the authenticated server.
      const started = Date.now();
      const renewal = await command<ScreenRenewal>('screen:renew', {
        epoch: binding.epoch,
        requestId: crypto.randomUUID(),
        revision: ++renewalRevision,
      });
      const grant = renewal.links.find((grant) => grant.link.id === expected.id);
      if (!grant || grant.link.publisherId !== auth.user.id)
        throw new Error('Publisher link unavailable.');
      linkId = grant.link.id;
      grantDeadline = Math.min(
        bindingDeadline,
        started + renewal.remainingMs,
        started + grant.remainingMs,
      );
      return { linkId, remainingMs: grantDeadline - Date.now() };
    },
    async prepare() {
      if (
        !linkId ||
        grantDeadline <= Date.now() ||
        (peer && peer.inspect().phase !== 'closed') ||
        (receiver && !['closed', 'paused-hidden'].includes(receiver.inspect().phase))
      )
        throw new Error('Fixture peer preparation unavailable.');
      if (rtc) {
        if (rtc.connectionState !== 'closed') throw new Error('Old native peer remains open.');
        pipeAbort.abort();
        await Promise.allSettled([...pipes]);
        if (decoder && decoder.state !== 'closed') decoder.close();
        nativeCleanups.splice(0).forEach((cleanup) => cleanup());
        pipeAbort = new AbortController();
        decodedRms = 0;
        f.frames = 0;
      }
      incomingStart = incoming.length;
      let source: { video: MediaStreamTrack; audio: MediaStreamTrack; sound: 'tab' } | undefined;
      if (role === 'publisher' && !sourceTracks.length) {
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const paint = canvas.getContext('2d')!;
        let step = 0;
        const render = () => {
          paint.fillStyle = step % 2 ? '#123456' : '#c45d12';
          paint.fillRect(0, 0, size.width, size.height);
          paint.fillStyle = '#fff';
          paint.fillRect((step++ * 13) % (size.width - 40), 20, 40, 40);
        };
        render();
        draw = setInterval(render, 50);
        const stream = canvas.captureStream(20);
        sourceTracks.push(...stream.getTracks());
        const Generator = Reflect.get(window, 'MediaStreamTrackGenerator') as
          (new (options: { kind: 'audio' }) => GeneratedAudioTrack) | undefined;
        const Audio = Reflect.get(window, 'AudioData') as
          | (new (options: {
              format: 'f32';
              sampleRate: number;
              numberOfFrames: number;
              numberOfChannels: number;
              timestamp: number;
              data: Float32Array;
            }) => SyntheticAudioData)
          | undefined;
        if (!Generator || !Audio) throw new Error('Owned PCM track generation unavailable.');
        const generated = new Generator({ kind: 'audio' });
        sourceTracks.push(generated);
        audioWriter = generated.writable.getWriter();
        let sample = 0,
          writing = false;
        const write = () => {
          if (writing || disposing) return;
          writing = true;
          const data = new Float32Array(960);
          for (let i = 0; i < data.length; i++)
            data[i] = 0.1 * Math.sin((2 * Math.PI * 440 * (sample + i)) / 48000);
          const frame = new Audio({
            format: 'f32',
            sampleRate: 48000,
            numberOfFrames: data.length,
            numberOfChannels: 1,
            timestamp: Math.round((sample * 1000000) / 48000),
            data,
          });
          sample += data.length;
          const pending = audioWriter!.write(frame).finally(() => {
            frame.close();
            writing = false;
          });
          void observe(pending, writes).catch((error) => {
            if (!disposing)
              f.errors.push(error instanceof Error ? error.name : 'PCM write failed.');
          });
        };
        write();
        audioTimer = setInterval(write, 20);
        source = {
          video: stream.getVideoTracks()[0]!,
          audio: generated,
          sound: 'tab',
        };
      }
      if (role === 'publisher')
        source = { video: sourceTracks[0]!, audio: sourceTracks[1]!, sound: 'tab' };
      current = Object.freeze({ generation: {}, deadline: grantDeadline });
      const lifecycle: ScreenPeerLifecycle = {
        inspect: () => current,
        onInvalidated: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      const send = (signal: ScreenSignal) =>
        observe(
          (async () => {
            f.signalTypes.push(signal.payload.type);
            const ack: ScreenAck<{ delivered: true }> = await socket
              .timeout(4000)
              .emitWithAck('screen:signal', signal);
            f.lastAck = ack;
            return ack;
          })().finally(() => {
            f.wireSettled++;
          }),
          wire,
        );
      if (lane) {
        const ownedSelection = selected,
          cleanup = ownedSelection.reserveCleanup();
        if (!cleanup) throw new Error('Obsolete fixture selection.');
        const ownedEpoch = binding.epoch,
          ownedLink = linkId,
          index = peers.length,
          start = incoming.length;
        receiver = lane.open({
          endpoint: { epoch: ownedEpoch, linkId: ownedLink, role: 'viewer', sound: 'tab' },
          lifecycle,
          send,
          cleanup: (reference, reason, signal) =>
            observe(
              (async () => {
                if (reference.epoch !== ownedEpoch || reference.linkId !== ownedLink)
                  throw new Error('Cleanup reference changed.');
                const record: (typeof f.cleanupLog)[number] = {
                  revision: cleanup.request.revision,
                  reason,
                  localClosed: peers[index]?.connectionState === 'closed',
                  incomingEnded: incoming
                    .slice(start)
                    .every((track) => track.readyState === 'ended'),
                  outputDetached: outputs.every(
                    (output) => output.muted && output.paused && output.srcObject === null,
                  ),
                  aborted: signal.aborted,
                };
                f.cleanupLog.push(record);
                const abort = () => {
                  record.aborted = true;
                };
                signal.addEventListener('abort', abort, { once: true });
                const hold = cleanupHold;
                try {
                  if (hold?.stage === 'before-send') await hold.promise;
                  try {
                    const result = await cleanup.run();
                    if (result !== null) throw new Error('Unselect returned a link.');
                    record.reply = 'unselected';
                  } catch (error) {
                    const outcome = error as {
                      code?: string;
                      transport?: 'connected' | 'disconnected';
                    };
                    if (outcome.code) record.reply = outcome.code;
                    else record.transport = outcome.transport;
                    throw error;
                  }
                  if (hold?.stage === 'after-ack') await hold.promise;
                } finally {
                  signal.removeEventListener('abort', abort);
                }
              })(),
              operations,
            ),
        });
        receivers.push(receiver);
      } else {
        const ownedAbort = pipeAbort;
        peer = new ScreenPeer({
          endpoint: { epoch: binding.epoch, linkId, role, sound: 'tab' },
          lifecycle,
          createPeer: createNative,
          source,
          send,
          onTrack: inspectTrack,
          onError: (error) => {
            f.peerErrors.push(errorMessages(error));
            ownedAbort.abort();
            if (ownedAbort === pipeAbort) detachReceiver();
          },
        });
      }
      return {
        remainingMs: grantDeadline - Date.now(),
        silent: silent(),
      };
    },
    async offer() {
      if (!peer) throw new Error('Missing peer.');
      await observe(peer.offer(), operations);
    },
    async setVideoQuality(request: unknown) {
      if (!peer) throw new Error('Missing peer.');
      return observe(peer.setVideoQuality(request), operations);
    },
    videoQuality() {
      return peer?.inspectVideoQuality();
    },
    parameterSnapshot() {
      if (!rtc) throw new Error('Missing native peer.');
      return rtc
        .getSenders()
        .filter((sender) => sender.track)
        .map((sender) => {
          const { width, height, frameRate } = sender.track!.getSettings();
          return {
            kind: sender.track!.kind,
            source: { width, height, frameRate },
            encodings: sender.getParameters().encodings,
          };
        });
    },
    startOffer() {
      f.operationResult = '';
      void f.offer().then(
        () => {
          f.operationResult = 'resolved';
        },
        () => {
          f.operationResult = 'rejected';
        },
      );
    },
    holdCleanup(stage: 'before-send' | 'after-ack') {
      if (cleanupHold) throw new Error('Cleanup is already held.');
      cleanupHold = heldCleanup(stage);
    },
    releaseCleanup() {
      cleanupHold?.release();
      cleanupHold = undefined;
    },
    hideReceiver() {
      if (!receiver) throw new Error('Missing receiving lane handle.');
      receiver.hide();
    },
    async playReceiver() {
      if (!receiver) throw new Error('Missing receiving lane handle.');
      receiver.setOutput('owned-fake-output');
      receiver.setVolume(0.25);
      await observe(receiver.play(), operations);
      receiver.setMuted(true);
    },
    async selectionStatus() {
      const result = await command<ScreenRenewal>('screen:renew', {
        epoch: binding.epoch,
        requestId: crypto.randomUUID(),
        revision: ++renewalRevision,
      });
      return result.links.map((grant) => grant.link.id);
    },
    snapshot() {
      return {
        phase: peer?.inspect().phase ?? rtc?.signalingState,
        receiver: receiver?.inspect(),
        lane: lane?.inspect(),
        receiverHistory: receivers.map((owned) => owned.inspect()),
        nativeCount: peers.length,
        outputs: outputs.map((output) => ({
          muted: output.muted,
          paused: output.paused,
          detached: output.srcObject === null,
          kinds:
            output.srcObject instanceof MediaStream
              ? output.srcObject
                  .getTracks()
                  .map((track) => track.kind)
                  .sort()
              : [],
        })),
        connection: rtc?.connectionState,
        gathering: rtc?.iceGatheringState,
        frames: f.frames,
        width: video.videoWidth,
        height: video.videoHeight,
        rms: decodedRms,
        sourceLive:
          sourceTracks.length === 2 && sourceTracks.every((track) => track.readyState === 'live'),
        incomingEnded:
          incoming.length - incomingStart === 2 &&
          incoming.slice(incomingStart).every((track) => track.readyState === 'ended'),
        senders: rtc
          ?.getSenders()
          .filter((sender) => sender.track)
          .map((sender) => sender.track!.kind),
        physicalCalls: f.physicalCalls,
        errors: [...f.errors],
        peerErrors: [...f.peerErrors],
        silent: silent(),
        listenerCount: listeners.size,
        deadline: grantDeadline,
        pending: native.size + wire.size + operations.size,
        incoming: incoming.slice(incomingStart).map((track) => ({
          kind: track.kind,
          muted: track.muted,
          state: track.readyState,
        })),
        videoPaused: video.paused,
        videoReady: video.readyState,
      };
    },
    async route() {
      if (!rtc) throw new Error('Missing native peer.');
      const stats = await rtc.getStats();
      const transport = [...stats.values()].find(
        (row) => row.type === 'transport' && row.selectedCandidatePairId,
      );
      const pair = transport && stats.get(transport.selectedCandidatePairId);
      const local = pair && stats.get(pair.localCandidateId),
        remote = pair && stats.get(pair.remoteCandidateId);
      if (!pair || !local || !remote) throw new Error('Selected candidate pair unavailable.');
      return {
        state: pair.state,
        local: local.candidateType,
        remote: remote.candidateType,
        protocol: local.protocol,
        video: [...stats.values()]
          .filter((row) => row.type === 'inbound-rtp' && row.kind === 'video')
          .reduce((sum, row) => sum + (row.framesDecoded ?? 0), 0),
        audio: [...stats.values()]
          .filter((row) => row.type === 'inbound-rtp' && row.kind === 'audio')
          .reduce((sum, row) => sum + (row.packetsReceived ?? 0), 0),
        audioCodec: [...stats.values()]
          .filter((row) => row.type === 'inbound-rtp' && row.kind === 'audio')
          .map((row) => stats.get(row.codecId)?.mimeType)[0],
        audioEnergy: [...stats.values()]
          .filter((row) => row.type === 'inbound-rtp' && row.kind === 'audio')
          .reduce((sum, row) => sum + (row.totalAudioEnergy ?? 0), 0),
        outboundAudioBytes: [...stats.values()]
          .filter((row) => row.type === 'outbound-rtp' && row.kind === 'audio')
          .reduce((sum, row) => sum + (row.bytesSent ?? 0), 0),
        sourceAudioEnergy: [...stats.values()]
          .filter((row) => row.type === 'media-source' && row.kind === 'audio')
          .reduce((sum, row) => sum + (row.totalAudioEnergy ?? 0), 0),
      };
    },
    stopPeer() {
      receiver?.stop();
      peer?.dispose();
      detachReceiver();
      pipeAbort.abort();
    },
    async logout() {
      await f.request('/auth/logout', 'POST');
    },
    async leave() {
      await f.request('/voice/leave', 'POST', { leaseId });
    },
    async drain() {
      while (native.size || wire.size || operations.size)
        await Promise.allSettled([...native, ...wire, ...operations]);
    },
    async dispose() {
      const failures: unknown[] = [];
      const clean = (work: () => void) => {
        try {
          work();
        } catch (error) {
          failures.push(error);
        }
      };
      disposing = true;
      clean(f.releaseCleanup);
      clean(() => lane?.dispose());
      clean(() => peer?.dispose());
      clean(() => {
        if (rtc && rtc.connectionState !== 'closed') rtc.close();
      });
      clean(detachReceiver);
      current = null;
      if (draw) clearInterval(draw);
      if (audioTimer) clearInterval(audioTimer);
      sourceTracks.forEach((track) => clean(() => track.stop()));
      clean(() => pipeAbort.abort());
      await Promise.allSettled([...pipes]);
      clean(() => {
        if (decoder && decoder.state !== 'closed') decoder.close();
      });
      try {
        await audioWriter?.abort();
      } catch (error) {
        failures.push(error);
      }
      await Promise.allSettled([...writes]);
      clean(() => audioWriter?.releaseLock());
      f.sourceDisposed = true;
      try {
        if (leaseId) await f.leave();
      } catch (error) {
        if (![401, 403].includes((error as { status?: number }).status ?? 0)) failures.push(error);
      } finally {
        clean(() => socket?.removeAllListeners());
        clean(() => socket?.disconnect());
        try {
          await f.drain();
        } catch (error) {
          failures.push(error);
        }
        listeners.clear();
        nativeCleanups.splice(0).forEach(clean);
        clean(() => window.removeEventListener('unhandledrejection', unhandled));
        clean(() => video.remove());
      }
      if (failures.length)
        throw new AggregateError(failures, 'Owned media fixture cleanup failed.');
      return {
        peersClosed: peers.every((owned) => owned.connectionState === 'closed'),
        tracksEnded: [...sourceTracks, ...incoming].every((track) => track.readyState === 'ended'),
        silent: silent(),
        pending:
          native.size +
          wire.size +
          operations.size +
          pipes.size +
          writes.size +
          (lane ? Object.values(lane.inspect().pending).filter(Boolean).length : 0),
        listeners: listeners.size,
      };
    },
  };
  function inspectTrack(track: MediaStreamTrack) {
    incoming.push(track);
    if (track.kind === 'video') {
      video.srcObject = new MediaStream([track]);
      const rendered = () => {
        f.frames++;
        frameCallback = video.requestVideoFrameCallback(rendered);
      };
      frameCallback = video.requestVideoFrameCallback(rendered);
      void observe(video.play(), operations).catch((error) => f.errors.push(String(error)));
    }
  }
  function createNative(configuration: RTCConfiguration) {
    const owner = new RTCPeerConnection({
      ...configuration,
      ...{ encodedInsertableStreams: true },
    });
    rtc = owner;
    peers.push(owner);
    const abort = pipeAbort,
      addTransceiver = owner.addTransceiver.bind(owner),
      close = owner.close.bind(owner);
    Object.defineProperty(owner, 'addTransceiver', {
      value: (track: MediaStreamTrack, init: RTCRtpTransceiverInit) => {
        const transceiver = addTransceiver(track, init);
        encoded(transceiver.sender, false, abort);
        return transceiver;
      },
    });
    const received = (event: RTCTrackEvent) => {
      encoded(event.receiver, event.track.kind === 'audio', abort);
      if (lane && owner === rtc && !abort.signal.aborted) inspectTrack(event.track);
    };
    owner.addEventListener('track', received);
    nativeCleanups.push(() => owner.removeEventListener('track', received));
    Object.defineProperty(owner, 'close', {
      value: () => {
        close();
        abort.abort();
        owner.removeEventListener('track', received);
        if (owner === rtc) detachReceiver();
      },
    });
    for (const name of [
      'createOffer',
      'createAnswer',
      'setLocalDescription',
      'setRemoteDescription',
      'addIceCandidate',
    ]) {
      const method = Reflect.get(owner, name) as (...args: unknown[]) => unknown;
      Object.defineProperty(owner, name, {
        value: (...args: unknown[]) => {
          const result = Reflect.apply(method, owner, args) as unknown;
          return result instanceof Promise ? observe(result, native) : result;
        },
      });
    }
    return owner;
  }
  function observe<T>(promise: Promise<T>, set: Set<Promise<unknown>>): Promise<T> {
    set.add(promise);
    void promise.then(
      () => set.delete(promise),
      () => set.delete(promise),
    );
    return promise;
  }
  function encoded(
    endpoint: RTCRtpSender | RTCRtpReceiver,
    inspectAudio: boolean,
    abort: AbortController,
  ) {
    if (disposing || abort.signal.aborted) return;
    let ownedDecoder: TestDecoder | undefined;
    const transform = endpoint as unknown as EncodedEndpoint;
    if (typeof transform.createEncodedStreams !== 'function')
      throw new Error('Owned encoded inspection unavailable.');
    const { readable, writable } = transform.createEncodedStreams();
    const Chunk = Reflect.get(window, 'EncodedAudioChunk') as new (options: {
      type: 'key';
      timestamp: number;
      data: ArrayBuffer;
    }) => unknown;
    if (inspectAudio) {
      const Decoder = Reflect.get(window, 'AudioDecoder') as new (callbacks: {
        output(data: SyntheticAudioData): void;
        error(error: Error): void;
      }) => TestDecoder;
      if (!Decoder || !Chunk) throw new Error('Owned Opus inspection unavailable.');
      ownedDecoder = new Decoder({
        output(data) {
          try {
            if (disposing || abort.signal.aborted || abort !== pipeAbort) return;
            const samples = new Float32Array(data.numberOfFrames);
            data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
            decodedRms = Math.sqrt(
              samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
            );
          } finally {
            data.close();
          }
        },
        error(error) {
          f.errors.push('Owned Opus decode: ' + error.name);
        },
      });
      ownedDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      decoder = ownedDecoder;
    }
    const pipe = readable
      .pipeThrough(
        new TransformStream<EncodedFrame, EncodedFrame>({
          transform(frame, controller) {
            if (inspectAudio && ownedDecoder?.state === 'configured') {
              if (ownedDecoder.decodeQueueSize >= 8)
                throw new Error('Owned decoder budget exceeded.');
              ownedDecoder.decode(
                new Chunk({
                  type: 'key',
                  timestamp: Math.round((frame.timestamp * 1000000) / 48000),
                  data: frame.data,
                }),
              );
            }
            controller.enqueue(frame);
          },
        }),
      )
      .pipeTo(writable, { signal: abort.signal });
    void observe(pipe, pipes).catch((error) => {
      if (!abort.signal.aborted)
        f.errors.push(error instanceof Error ? error.name : 'Encoded inspection failed.');
    });
  }
  async function command<T>(event: string, data: unknown): Promise<T> {
    const result: ScreenAck<T> = await observe(socket.timeout(4000).emitWithAck(event, data), wire);
    if (!result.ok) throw new Error('Fixture ' + event + ' rejected: ' + result.code);
    return result.data;
  }
  function errorMessages(error: unknown): string {
    if (error instanceof AggregateError) return error.errors.map(errorMessages).join('; ');
    return error instanceof Error && error.message.startsWith('Screen peer:')
      ? error.message
      : error instanceof Error
        ? error.name
        : 'Unknown error';
  }
  function invalidate() {
    current = null;
    for (const listener of [...listeners]) listener();
  }
  function detachReceiver() {
    video.cancelVideoFrameCallback(frameCallback);
    video.pause();
    video.srcObject = null;
  }
  function silent() {
    return (
      video.muted &&
      (!video.srcObject || (video.srcObject as MediaStream).getAudioTracks().length === 0)
    );
  }
  const forbidden = () => {
    f.physicalCalls++;
    throw new Error('Physical capture/enumeration/output forbidden.');
  };
  navigator.mediaDevices.getUserMedia = forbidden;
  navigator.mediaDevices.getDisplayMedia = forbidden;
  navigator.mediaDevices.enumerateDevices = forbidden;
  Reflect.set(window, 'AudioContext', forbidden);
  Reflect.set(window, 'Audio', forbidden);
  const unhandled = (event: PromiseRejectionEvent) => {
    f.errors.push(String(event.reason));
  };
  window.addEventListener('unhandledrejection', unhandled);
  return f;
}
declare global {
  interface Window {
    createScreenPeerFixture: typeof createScreenPeerFixture;
    screenPeerFixture: ReturnType<typeof createScreenPeerFixture>;
    screenPeerFixtureReady: boolean;
  }
}
window.createScreenPeerFixture = createScreenPeerFixture;
window.screenPeerFixtureReady = true;
