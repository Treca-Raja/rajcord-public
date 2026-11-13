import type {
  ScreenQuality,
  ScreenSound,
  ScreenShare,
  ScreenPublishGrant,
  ScreenDirectory,
  ScreenLinkGrant,
  ScreenRenewal,
  ScreenLinkNotice,
  ScreenClosed,
  ScreenSignalNotice,
  ScreenSelectRequest,
  DesktopScreenStatus,
} from '@tricord/shared';
import { CaptureSession, ScreenLifetime } from './capture-session';
import { screenSocket, type ScreenSocket } from './screen-socket';
import type { OwnedScreenBinding } from './screen-binding';
import type { ScreenRuntimeAttachment } from './screen-runtime';
import type { VoiceController, VoiceState } from './voice-controller';
import type { WebScreenCapture } from './screen-capture';
import { ScreenPeer } from './screen-peer';
import type { ScreenReceiveHandle } from './screen-receiver';
import { publicScreenIceServers, screenIceServers } from './screen-ice';
import { screenVideoRequest } from './screen-quality';
import { screenRenewalPermit } from './screen-renewal';

export type ScreenSettings = ScreenQuality & { sound: ScreenSound };
export type ScreenCallState = Readonly<{
  phase:
    | 'idle'
    | 'connecting'
    | 'ready'
    | 'preparing'
    | 'choosing'
    | 'preview'
    | 'publishing'
    | 'sharing';
  error: string;
  shares: readonly Readonly<ScreenShare>[];
  watching: string | null;
  playback: string;
  hidden: boolean;
  label: string;
  viewers: number;
  open: boolean;
  prepared: boolean;
  ownShareId: string | null;
}>;
export type ScreenControls = Pick<
  ScreenCall,
  | 'connect'
  | 'prepare'
  | 'choose'
  | 'publish'
  | 'stopSource'
  | 'watch'
  | 'stopWatching'
  | 'play'
  | 'mute'
  | 'volume'
  | 'preview'
  | 'incoming'
  | 'subscribe'
  | 'inspect'
  | 'open'
  | 'close'
>;

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid screen response.');
  return value as Record<string, unknown>;
};
const lifetime = (value: unknown, started: number) => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 45000)
    throw new Error('Invalid screen authority deadline.');
  const deadline = started + (value as number);
  if (deadline <= Date.now()) throw new Error('Screen authority expired.');
  return deadline;
};
function share(value: unknown): ScreenShare {
  const data = record(value);
  if (
    Object.keys(data).some(
      (key) =>
        ![
          'id',
          'publisherId',
          'sourceGeneration',
          'profile',
          'videoBitrate',
          'resolution',
          'frameRate',
          'sound',
        ].includes(key),
    ) ||
    !uuid(data.id) ||
    !uuid(data.publisherId) ||
    !Number.isSafeInteger(data.sourceGeneration) ||
    (data.sourceGeneration as number) < 1 ||
    !['none', 'tab', 'system'].includes(data.sound as string)
  )
    throw new Error('Invalid screen share.');
  const quality = screenVideoRequest({
    revision: 1,
    publisher: {
      profile: data.profile,
      videoBitrate: data.videoBitrate,
      ...(data.resolution !== undefined || data.frameRate !== undefined
        ? { resolution: data.resolution, frameRate: data.frameRate }
        : {}),
    },
    viewer: { profile: 'smooth', videoBitrate: 8000000 },
  }).publisher;
  return Object.freeze({
    ...quality,
    id: data.id,
    publisherId: data.publisherId,
    sourceGeneration: data.sourceGeneration as number,
    sound: data.sound as ScreenSound,
  });
}
function publication(value: unknown, started: number) {
  const data = record(value);
  if (Object.keys(data).sort().join() !== 'remainingMs,share')
    throw new Error('Invalid publication proof.');
  const grant = { share: share(data.share), remainingMs: data.remainingMs as number };
  return { grant, deadline: lifetime(data.remainingMs, started) };
}
type Incoming = {
  id: string;
  life: ScreenLifetime;
  handle: ScreenReceiveHandle;
  selection: ScreenSelectRequest;
  cleanup: ScreenSelectRequest;
};
type Outgoing = { peer: ScreenPeer; life: ScreenLifetime; shareId: string };
const qualityOnly = (quality: ScreenQuality): ScreenQuality => ({
  profile: quality.profile,
  videoBitrate: quality.videoBitrate,
  ...(quality.resolution === undefined
    ? {}
    : { resolution: quality.resolution, frameRate: quality.frameRate }),
});

export class ScreenCall {
  private state: ScreenCallState = Object.freeze({
    phase: 'idle',
    error: '',
    shares: Object.freeze([]),
    watching: null,
    playback: '',
    hidden: false,
    label: '',
    viewers: 0,
    open: false,
    prepared: false,
    ownShareId: null,
  });
  private listeners = new Set<() => void>();
  private binding?: OwnedScreenBinding;
  private socket?: ScreenSocket;
  private source?: CaptureSession;
  private settings?: ScreenSettings;
  private ownShare?: ScreenShare;
  private prepared?: { tag: string; deadline: number };
  private sourceGeneration = 0;
  private revision = 0;
  private renewalRevision = 0;
  private directoryRevision = 0;
  private generation = 0;
  private active = true;
  private connecting?: Promise<void>;
  private renewing = false;
  private publishing = false;
  private preparing = false;
  private sourceCleanup?: Promise<unknown>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private receiving?: Incoming;
  private selecting = false;
  private selectionAbort?: AbortController;
  private early: ScreenSignalNotice[] = [];
  private selectionCleanup?: ScreenSelectRequest;
  private cleanupRaw?: Promise<unknown>;
  private iceServers: RTCIceServer[] = screenIceServers(publicScreenIceServers);
  private outgoing = new Map<string, Outgoing>();
  private publisherLinks = new Map<string, ScreenLinkGrant['link']>();
  private removals: (() => void)[] = [];
  private bindingRemovals: (() => void)[] = [];
  private previewElements = new Set<HTMLVideoElement>();
  private host?: HTMLElement;
  private element?: HTMLVideoElement;
  private resume?: { shareId: string; quality: ScreenQuality; epoch: string };
  private lastVoice?: Readonly<VoiceState>;
  private volumeValue = 1;
  private muted = false;

  constructor(
    private readonly options: {
      attachment: ScreenRuntimeAttachment;
      voice: VoiceController;
      capture: WebScreenCapture;
      element(listener: (element: HTMLVideoElement) => void): () => void;
    },
  ) {
    const visibility = () => this.visibility(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    this.removals.push(() => document.removeEventListener('visibilitychange', visibility));
    const bridge = window.tricordDesktop?.screens;
    if (bridge) {
      this.removals.push(
        bridge.onStop((tag) => {
          if (this.prepared?.tag === tag) this.stopSource();
        }),
      );
      this.removals.push(bridge.onVisibility((visible) => this.visibility(visible)));
    }
    this.removals.push(options.voice.onLeaseInvalidated(() => this.disconnect()));
    this.removals.push(
      options.element((element) => {
        this.element?.remove();
        this.element = element;
        this.host?.appendChild(element);
      }),
    );
  }
  inspect = () => this.state;
  controls(): ScreenControls {
    return Object.freeze({
      inspect: this.inspect,
      subscribe: this.subscribe,
      connect: this.connect,
      prepare: this.prepare,
      choose: this.choose,
      publish: this.publish,
      stopSource: this.stopSource,
      watch: this.watch,
      stopWatching: this.stopWatching,
      play: this.play,
      mute: this.mute,
      volume: this.volume,
      preview: this.preview,
      incoming: this.incoming,
      open: this.open,
      close: this.close,
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ScreenCallState>) {
    if (!this.active) return;
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of [...this.listeners]) listener();
  }
  private error(cause: unknown) {
    this.update({ error: cause instanceof Error ? cause.message : 'Screen sharing failed.' });
  }
  private current(binding = this.binding) {
    return this.active && !!binding && this.binding === binding && !!binding.inspect();
  }
  private send<T>(
    event: Parameters<ScreenSocket['command']>[0],
    body: unknown,
    signal?: AbortSignal,
  ) {
    if (!this.current() || !this.socket)
      return Promise.reject(new Error('Reconnect screen controls first.'));
    return this.socket.command<T>(event, body, signal);
  }
  connect = (): Promise<void> => {
    if (!this.active) return Promise.reject(new Error('Screen call ended.'));
    if (this.current()) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.update({ phase: 'connecting', error: '' });
    const raw = (async () => {
      const binding = await this.options.attachment.bind();
      if (!this.active || generation !== this.generation) {
        binding.release();
        throw new Error('Screen call ended.');
      }
      this.iceServers = screenIceServers(binding.binding.iceServers ?? publicScreenIceServers);
      this.binding = binding;
      this.socket = screenSocket(binding);
      this.bindingRemovals.push(
        binding.onInvalidated(() => {
          if (this.binding === binding) this.disconnect();
        }),
      );
      this.bindingRemovals.push(
        this.socket.subscribe((event, data) => {
          if (!this.current(binding)) return;
          try {
            this.event(event, data);
          } catch (cause) {
            this.disconnect();
            this.error(cause);
          }
        }),
      );
      this.interval = setInterval(() => this.requestRenewal(), 10000);
      const directory = await this.send<ScreenDirectory>('screen:directory', {
        epoch: binding.binding.epoch,
      });
      if (!this.current(binding)) throw new Error('Screen connection ended.');
      this.directory(directory);
      this.update({ phase: 'ready' });
    })();
    this.connecting = raw;
    void raw
      .catch((cause) => {
        if (generation === this.generation) {
          this.disconnect();
          this.error(cause);
        }
      })
      .finally(() => {
        if (this.connecting === raw) this.connecting = undefined;
      });
    return raw;
  };
  private directory(value: unknown) {
    const data = record(value);
    if (
      data.epoch !== this.binding?.binding.epoch ||
      !Number.isSafeInteger(data.revision) ||
      !Array.isArray(data.shares) ||
      data.shares.length > 10
    )
      throw new Error('Invalid screen directory.');
    if ((data.revision as number) < this.directoryRevision) return;
    const shares = Object.freeze(data.shares.map(share));
    this.directoryRevision = data.revision as number;
    this.update({ shares });
    if (this.state.watching && !shares.some((item) => item.id === this.state.watching))
      this.stopWatching();
  }
  private event(event: string, value: unknown) {
    if (event === 'disconnect') {
      this.disconnect();
      this.update({ error: 'Screen connection lost. Reconnect to share or watch again.' });
      return;
    }
    if (event === 'directory') {
      this.directory(value);
      return;
    }
    if (event === 'link') {
      const notice = value as ScreenLinkNotice;
      if (notice.epoch !== this.binding?.binding.epoch || notice.revision < this.directoryRevision)
        return;
      this.requestRenewal();
      return;
    }
    if (event === 'closed') {
      const notice = value as ScreenClosed;
      if (notice.epoch !== this.binding?.binding.epoch || notice.revision < this.directoryRevision)
        return;
      if (notice.linkId === null) {
        this.disconnect();
        return;
      }
      this.closeOutgoing(notice.linkId);
      if (this.receiving?.id === notice.linkId) this.stopWatching();
      return;
    }
    if (event === 'signal') {
      const signal = value as ScreenSignalNotice;
      if (signal.epoch !== this.binding?.binding.epoch) return;
      const target =
        this.outgoing.get(signal.linkId)?.peer ??
        (this.receiving?.id === signal.linkId ? this.receiving.handle : undefined);
      if (target)
        void target
          .receive(signal)
          .then(async () => {
            const outgoing = this.outgoing.get(signal.linkId);
            if (outgoing && signal.payload.type === 'answer' && this.ownShare) {
              const link = this.publisherLinks.get(signal.linkId);
              if (link)
                await outgoing.peer.setVideoQuality({
                  revision: 1,
                  publisher: qualityOnly(this.ownShare),
                  viewer: qualityOnly(link.quality),
                });
            }
          })
          .catch((cause) => {
            this.closeOutgoing(signal.linkId);
            this.error(cause);
          });
      else if (this.selecting && this.early.length < 32) this.early.push(signal);
    }
  }
  prepare = async (settings: ScreenSettings) => {
    if (this.source || this.prepared || this.publishing || this.preparing || this.sourceCleanup)
      throw new Error('Finish the current screen source operation first.');
    const quality = screenVideoRequest({
      revision: 1,
      publisher: qualityOnly(settings),
      viewer: qualityOnly(settings),
    }).publisher;
    // Only quality fields enter quality validation; source sound is a separate consent.
    this.settings = Object.freeze({ ...quality, sound: settings.sound });
    this.preparing = true;
    try {
      await this.connect();
    } catch (cause) {
      this.preparing = false;
      throw cause;
    }
    const binding = this.binding;
    const tag = crypto.randomUUID();
    const initial = binding && this.current(binding) ? binding.inspect() : null;
    if (!binding || !initial) {
      this.preparing = false;
      throw new Error('Screen connection ended.');
    }
    this.prepared = { tag, deadline: initial.deadline };
    this.update({ phase: 'preparing', error: '' });
    try {
      const bridge = window.tricordDesktop?.screens;
      if (window.tricordDesktop && !bridge)
        throw new Error('Update the desktop app to enable screen capture.');
      if (bridge) {
        if (settings.sound === 'tab')
          throw new Error('Choose system sound or video only in the desktop app.');
        const capabilities = await bridge.capabilities();
        if (
          capabilities.version !== 1 ||
          (settings.sound === 'system' && !capabilities.systemSound)
        )
          throw new Error('This desktop version cannot capture the selected source sound.');
        if (!this.current(binding) || this.prepared?.tag !== tag)
          throw new Error('Screen preparation ended.');
        const started = Date.now();
        const result = await bridge.prepare({
          clientIntentRef: tag,
          epoch: binding.binding.epoch,
          sound: settings.sound,
        });
        this.status(result, tag);
        this.prepared!.deadline = Math.min(initial.deadline, lifetime(result.remainingMs, started));
      }
      if (!this.current(binding) || this.prepared?.tag !== tag)
        throw new Error('Screen preparation ended.');
      const captureSession = new CaptureSession({
        adapter: this.options.capture,
        deadline: this.prepared.deadline,
        sound: settings.sound,
        quality,
        onEnded: () => {
          if (this.source === captureSession) this.stopSource();
        },
      });
      this.source = captureSession;
      this.update({ phase: 'ready', prepared: true });
    } catch (cause) {
      this.stopSource();
      this.error(cause);
      throw cause;
    } finally {
      this.preparing = false;
    }
  };
  private status(result: DesktopScreenStatus, tag: string) {
    if (!result || result.clientIntentRef !== tag || !result.ready || this.prepared?.tag !== tag)
      throw new Error(result?.error || 'Desktop screen authority ended.');
  }
  choose = (): Promise<void> => {
    const source = this.source;
    if (!source || this.state.phase !== 'ready')
      return Promise.reject(new Error('Prepare screen sharing first.'));
    this.update({ phase: 'choosing', error: '' });
    const raw = source.choose();
    return raw
      .then(() => {
        if (this.source !== source || !this.current()) {
          source.stop();
          throw new Error('Screen source ended.');
        }
        this.update({ phase: 'preview', label: source.borrow().localLabel });
        this.renderPreview();
      })
      .catch((cause) => {
        if (this.source === source) {
          this.stopSource();
          this.error(cause);
        }
        throw cause;
      });
  };
  publish = async () => {
    const source = this.source,
      binding = this.binding,
      settings = this.settings,
      prepared = this.prepared;
    if (
      !source ||
      !settings ||
      !prepared ||
      !this.current(binding) ||
      this.state.phase !== 'preview'
    )
      throw new Error('Choose a source to preview first.');
    if (this.publishing) throw new Error('Screen publication is busy.');
    this.publishing = true;
    const generation = ++this.sourceGeneration,
      key = source.previewKey,
      started = Date.now();
    this.update({ phase: 'publishing', error: '' });
    let issued: ScreenPublishGrant | undefined;
    try {
      const proof = publication(
        await this.send<unknown>('screen:publish', {
          epoch: binding!.binding.epoch,
          requestId: crypto.randomUUID(),
          sourceGeneration: generation,
          ...settings,
        }),
        started,
      );
      issued = proof.grant;
      if (this.source !== source || !this.current(binding) || this.prepared !== prepared)
        throw new Error('Screen source ended.');
      let deadline = Math.min(proof.deadline, binding!.inspect()!.deadline);
      const bridge = window.tricordDesktop?.screens;
      if (bridge) {
        const began = Date.now();
        const status = await bridge.handoff({
          clientIntentRef: prepared.tag,
          shareId: issued.share.id,
          sourceGeneration: generation,
        });
        this.status(status, prepared.tag);
        deadline = Math.min(deadline, lifetime(status.remainingMs, began));
      }
      if (this.source !== source || !this.current(binding)) throw new Error('Screen source ended.');
      source.commitPublication(key, issued, deadline, generation);
      this.ownShare = issued.share;
      this.update({ phase: 'sharing', error: '', ownShareId: issued.share.id });
      this.requestRenewal();
    } catch (cause) {
      source.stop();
      if (issued && this.current(binding))
        this.retireShare(this.socket!, binding!, issued.share.id);
      else if (this.current(binding)) this.disconnect();
      this.error(cause);
      throw cause;
    } finally {
      this.publishing = false;
    }
  };
  private retireShare(socket: ScreenSocket, binding: OwnedScreenBinding, shareId: string) {
    const raw = socket.command('screen:stop', { epoch: binding.binding.epoch, shareId });
    this.sourceCleanup = raw;
    void raw
      .catch((cause) => {
        if (this.binding === binding) {
          this.disconnect();
          this.error(cause);
        }
      })
      .finally(() => {
        if (this.sourceCleanup === raw) this.sourceCleanup = undefined;
      });
  }
  stopSource = () => {
    const source = this.source,
      own = this.ownShare,
      prepared = this.prepared,
      socket = this.socket,
      epoch = this.binding?.binding.epoch;
    this.source = undefined;
    this.ownShare = undefined;
    this.prepared = undefined;
    try {
      source?.stop();
    } catch (cause) {
      this.error(cause);
    }
    for (const id of [...this.outgoing.keys()]) this.closeOutgoing(id);
    for (const element of this.previewElements) {
      element.pause();
      element.srcObject = null;
    }
    if (prepared && window.tricordDesktop?.screens)
      void window.tricordDesktop.screens
        .cancel({ clientIntentRef: prepared.tag })
        .catch((cause) => this.error(cause));
    if (own && socket && epoch && this.binding) this.retireShare(socket, this.binding, own.id);
    this.update({
      phase: this.current() ? 'ready' : 'idle',
      label: '',
      viewers: 0,
      prepared: false,
      ownShareId: null,
    });
  };
  private requestRenewal() {
    if (!this.current() || this.renewalTimer) return;
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      void this.renew();
    }, 100);
  }
  private async renew() {
    if (this.renewing || !this.current()) return;
    this.renewing = true;
    const binding = this.binding!,
      socket = this.socket!,
      epoch = binding.binding.epoch;
    const started = Date.now(),
      revision = ++this.renewalRevision;
    try {
      const data = record(
        await socket.command<ScreenRenewal>('screen:renew', {
          epoch,
          requestId: crypto.randomUUID(),
          revision,
        }),
      );
      if (!this.current(binding)) return;
      const deadline = lifetime(data.remainingMs, started);
      if (Object.hasOwn(data, 'iceServers'))
        this.iceServers = screenIceServers(data.iceServers as RTCIceServer[]);
      if (
        !Array.isArray(data.links) ||
        data.links.length > 10 ||
        !Object.hasOwn(data, 'publication')
      )
        throw new Error('Invalid screen renewal.');
      binding.adoptRenewal(screenRenewalPermit(binding.inspect()!.generation, deadline, revision));
      const own = this.ownShare,
        source = this.source;
      if (own && source) {
        const proof = publication(data.publication, started);
        if (
          proof.grant.share.id !== own.id ||
          proof.grant.share.sourceGeneration !== own.sourceGeneration
        )
          throw new Error('Screen publication ended.');
        const life = source.lifecycle();
        life.renew(
          screenRenewalPermit(life.generation, Math.min(deadline, proof.deadline), revision),
        );
      }
      const live = new Set<string>();
      for (const value of data.links) {
        const grant = this.linkGrant(value, started);
        live.add(grant.link.id);
        if (this.receiving?.id === grant.link.id) {
          const incoming = this.receiving,
            permit = screenRenewalPermit(
              incoming.life.generation,
              Math.min(deadline, grant.deadline),
              revision,
            );
          incoming.life.renew(permit);
          incoming.handle.adoptRenewal(permit);
        } else if (
          own &&
          source &&
          grant.link.shareId === own.id &&
          grant.link.publisherId === own.publisherId
        ) {
          const existing = this.outgoing.get(grant.link.id);
          const peerDeadline = Math.min(
            deadline,
            grant.deadline,
            source.lifecycle().inspect()!.deadline,
          );
          if (existing) {
            const permit = screenRenewalPermit(existing.life.generation, peerDeadline, revision);
            existing.life.renew(permit);
            existing.peer.adoptRenewal(permit);
          } else this.openPublisher(grant.link, peerDeadline, source, own);
        }
      }
      for (const id of this.outgoing.keys()) if (!live.has(id)) this.closeOutgoing(id);
      if (this.receiving && !live.has(this.receiving.id)) this.stopWatching();
    } catch (cause) {
      if (this.current(binding)) {
        if ((cause as { code?: string }).code === 'throttled') {
          this.renewalTimer = setTimeout(() => {
            this.renewalTimer = undefined;
            void this.renew();
          }, 5000);
          this.error(cause);
        } else {
          this.disconnect();
          this.error(cause);
        }
      }
    } finally {
      this.renewing = false;
    }
  }
  private linkGrant(value: unknown, started: number) {
    const data = record(value),
      link = record(data.link);
    if (
      Object.keys(data).sort().join() !== 'link,remainingMs' ||
      Object.keys(link).some(
        (key) =>
          ![
            'id',
            'shareId',
            'publisherId',
            'viewerId',
            'selectionRevision',
            'quality',
            'videoBitrate',
          ].includes(key),
      ) ||
      !['id', 'shareId', 'publisherId', 'viewerId'].every((key) => uuid(link[key])) ||
      !Number.isSafeInteger(link.selectionRevision) ||
      (link.selectionRevision as number) < 1
    )
      throw new Error('Invalid screen link.');
    screenVideoRequest({ revision: 1, publisher: link.quality, viewer: link.quality });
    return { link: link as ScreenLinkGrant['link'], deadline: lifetime(data.remainingMs, started) };
  }
  private openPublisher(
    link: ScreenLinkGrant['link'],
    deadline: number,
    source: CaptureSession,
    own: ScreenShare,
  ) {
    if (this.outgoing.size >= 9) throw new Error('Screen viewer capacity exceeded.');
    const life = new ScreenLifetime(deadline),
      socket = this.socket!,
      epoch = this.binding!.binding.epoch;
    const capture = source.borrow();
    let peer: ScreenPeer;
    try {
      peer = new ScreenPeer({
        endpoint: { epoch, linkId: link.id, role: 'publisher', sound: own.sound },
        lifecycle: life,
        source: { video: capture.video, audio: capture.audio, sound: capture.sound },
        iceServers: this.iceServers,
        createPeer: (config) => new RTCPeerConnection(config),
        initialVideoQuality: {
          revision: 1,
          publisher: qualityOnly(own),
          viewer: qualityOnly(link.quality),
        },
        send: async (signal, abort) => ({
          ok: true,
          data: await socket.command('screen:signal', signal, abort),
        }),
        onTrack: () => {},
        onError: (cause) => {
          this.closeOutgoing(link.id);
          this.error(cause);
        },
      });
    } catch (cause) {
      life.stop();
      throw cause;
    }
    this.publisherLinks.set(link.id, link);
    this.outgoing.set(link.id, { peer, life, shareId: own.id });
    void peer.offer().catch((cause) => {
      this.closeOutgoing(link.id);
      this.error(cause);
    });
    this.update({ viewers: this.outgoing.size });
  }
  private closeOutgoing(id: string) {
    const owned = this.outgoing.get(id);
    if (!owned) return;
    this.outgoing.delete(id);
    this.publisherLinks.delete(id);
    owned.peer.dispose();
    owned.life.stop();
    this.update({ viewers: this.outgoing.size });
  }
  watch = async (shareId: string, quality: ScreenQuality) => {
    await this.connect();
    if (this.selecting || this.cleanupRaw)
      throw new Error('Finish the current screen selection first.');
    const selected = this.state.shares.find((item) => item.id === shareId);
    if (!selected || selected.id === this.ownShare?.id || this.state.hidden)
      throw new Error('That screen share is unavailable.');
    this.stopWatching(false);
    const binding = this.binding!,
      socket = this.socket!,
      epoch = binding.binding.epoch;
    this.selecting = true;
    const abort = new AbortController();
    this.selectionAbort = abort;
    if (this.cleanupRaw) {
      try {
        await this.cleanupRaw;
      } catch (cause) {
        this.selecting = false;
        throw cause;
      }
      if (abort.signal.aborted || !this.current(binding)) {
        this.selecting = false;
        throw new Error('Screen selection ended.');
      }
    }
    const selection: ScreenSelectRequest = {
      ...quality,
      epoch,
      shareId,
      requestId: crypto.randomUUID(),
      revision: ++this.revision,
    };
    const cleanup: ScreenSelectRequest = {
      ...quality,
      epoch,
      shareId: null,
      requestId: crypto.randomUUID(),
      revision: ++this.revision,
    };
    this.selectionCleanup = cleanup;
    this.selecting = true;
    this.early = [];
    const started = Date.now();
    this.update({ watching: shareId, playback: 'Connecting…', error: '' });
    try {
      const result = this.linkGrant(
        await socket.command('screen:select', selection, abort.signal),
        started,
      );
      if (
        abort.signal.aborted ||
        !this.current(binding) ||
        this.state.hidden ||
        this.selectionCleanup !== cleanup
      )
        throw new Error('Screen selection ended.');
      if (result.link.shareId !== shareId || result.link.selectionRevision !== selection.revision)
        throw new Error('Screen selection changed.');
      const life = new ScreenLifetime(Math.min(result.deadline, binding.inspect()!.deadline));
      const handle = this.options.attachment.openIncoming({
        iceServers: this.iceServers,
        endpoint: { epoch, linkId: result.link.id, role: 'viewer', sound: selected.sound },
        lifecycle: life,
        send: async (signal, signalAbort) => ({
          ok: true,
          data: await socket.command('screen:signal', signal, signalAbort),
        }),
        cleanup: async () => {
          await this.cleanupSelection(socket, cleanup);
        },
      });
      const incoming: Incoming = { id: result.link.id, life, handle, selection, cleanup };
      this.receiving = incoming;
      handle.subscribe((state) => {
        if (this.receiving !== incoming) return;
        if (state.phase === 'closed' || state.phase === 'paused-hidden') {
          this.stopWatching();
          if (state.reason === 'failed' || state.reason === 'tracks-timeout')
            this.error(new Error('Screen connection failed. Select the screen again to retry.'));
          return;
        }
        this.update({
          playback: state.playback?.error?.message ?? state.playback?.phase ?? state.phase,
        });
        if (state.phase === 'ready' && state.playback?.phase === 'idle') {
          this.configurePlayback();
          void handle.play().catch((cause) => this.error(cause));
        }
      });
      for (const signal of this.early.splice(0))
        if (signal.linkId === incoming.id) await handle.receive(signal);
    } catch (cause) {
      if (this.selectionCleanup === cleanup) this.stopWatching();
      this.error(cause);
      throw cause;
    } finally {
      this.selecting = false;
    }
  };
  private cleanupSelection(socket: ScreenSocket, request: ScreenSelectRequest) {
    if (this.cleanupRaw) return this.cleanupRaw;
    const raw = socket.command('screen:select', request);
    this.cleanupRaw = raw;
    void raw
      .finally(() => {
        if (this.cleanupRaw === raw) this.cleanupRaw = undefined;
      })
      .catch((cause) => this.error(cause));
    return raw;
  }
  stopWatching = (forget = true) => {
    if (forget) this.resume = undefined;
    const incoming = this.receiving,
      cleanup = this.selectionCleanup,
      socket = this.socket;
    this.receiving = undefined;
    this.selectionCleanup = undefined;
    this.selectionAbort?.abort();
    this.early = [];
    if (incoming) {
      incoming.handle.stop();
      incoming.life.stop();
    } else if (cleanup && socket)
      void this.cleanupSelection(socket, cleanup).catch((cause) => this.error(cause));
    this.element?.remove();
    this.element = undefined;
    this.update({ watching: null, playback: '' });
  };
  private visibility(visible: boolean) {
    this.update({ hidden: !visible });
    if (!visible) {
      const selected = this.receiving?.selection;
      this.resume = selected?.shareId
        ? { shareId: selected.shareId, quality: qualityOnly(selected), epoch: selected.epoch }
        : undefined;
      this.stopWatching(false);
    } else if (this.resume) {
      const previous = this.resume;
      this.resume = undefined;
      const selected = this.state.shares.find((item) => item.id === previous.shareId);
      if (selected && previous.epoch === this.binding?.binding.epoch)
        void this.watch(selected.id, previous.quality).catch((cause) => this.error(cause));
    }
  }
  observeVoice(voice: VoiceState) {
    const changed =
      !this.lastVoice ||
      this.lastVoice.output !== voice.output ||
      this.lastVoice.outputMissing !== voice.outputMissing ||
      this.lastVoice.deafened !== voice.deafened;
    this.lastVoice = voice;
    if (changed) this.configurePlayback();
  }
  private configurePlayback() {
    const incoming = this.receiving,
      voice = this.lastVoice;
    if (!incoming || !voice || incoming.handle.inspect().phase !== 'ready') return;
    incoming.handle.setOutput(voice.outputMissing ? null : voice.output || null);
    incoming.handle.setDeafened(voice.deafened);
    incoming.handle.setMuted(this.muted);
    incoming.handle.setVolume(this.volumeValue);
  }
  play = () => {
    this.configurePlayback();
    return this.receiving?.handle.play() ?? Promise.reject(new Error('Select a screen first.'));
  };
  open = () => {
    this.update({ open: true });
    return this.connect();
  };
  close = () => {
    this.stopWatching();
    this.update({ open: false });
  };
  mute = (value: boolean) => {
    this.muted = value;
    this.configurePlayback();
  };
  volume = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error('Invalid screen volume.');
    this.volumeValue = value;
    this.configurePlayback();
  };
  preview = (element: HTMLVideoElement) => {
    this.previewElements.add(element);
    element.muted = true;
    element.playsInline = true;
    this.renderPreview();
    return () => {
      this.previewElements.delete(element);
      element.pause();
      element.srcObject = null;
    };
  };
  private renderPreview() {
    if (!this.source) return;
    const capture = this.source.borrow();
    for (const element of this.previewElements) {
      element.srcObject = capture.stream;
      void element.play().catch((cause) => this.error(cause));
    }
  }
  incoming = (host: HTMLElement) => {
    this.host = host;
    if (this.element) host.appendChild(this.element);
    return () => {
      if (this.host === host) {
        this.host = undefined;
        this.element?.remove();
      }
    };
  };
  private disconnect() {
    this.generation++;
    clearInterval(this.interval);
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    const binding = this.binding;
    this.binding = undefined;
    this.bindingRemovals.splice(0).forEach((remove) => remove());
    this.stopSource();
    this.stopWatching();
    this.socket = undefined;
    binding?.release();
    this.directoryRevision = 0;
    this.renewalRevision = 0;
    this.sourceGeneration = 0;
    this.update({ phase: 'idle', shares: Object.freeze([]) });
  }
  dispose() {
    if (!this.active) return;
    this.disconnect();
    this.active = false;
    this.removals.splice(0).forEach((remove) => remove());
    this.listeners.clear();
  }
}
