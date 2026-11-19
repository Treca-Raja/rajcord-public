import { runInBackground } from '../../shared/background';
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
import type { VoiceScreenSession, VoiceState } from '../voice/contracts';
import { setScreenCaptureFormat, type WebScreenCapture } from './screen-capture';
import { ScreenPeer } from './screen-peer';
import type { ScreenReceiveHandle } from './screen-receiver';
import { publicScreenIceServers, screenIceServers } from './screen-ice';
import { screenVideoRequest } from './screen-quality';
import { screenVideoBudget } from './screen-adaptation';
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
  watchingShareIds: readonly string[];
  selectingShareId: string | null;
  layout: 'focus' | 'grid';
  playback: string;
  playbackMuted: boolean;
  playbackVolume: number;
  hidden: boolean;
  label: string;
  viewers: number;
  open: boolean;
  setupRequested: boolean;
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
  | 'watchMultiple'
  | 'stopWatchingShare'
  | 'focusWatch'
  | 'zoomOutWatch'
  | 'stopWatching'
  | 'play'
  | 'mute'
  | 'volume'
  | 'preview'
  | 'incoming'
  | 'subscribe'
  | 'inspect'
  | 'inspectMedia'
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
    !['none', 'tab', 'system', 'application', 'source'].includes(data.sound as string)
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
  shareId: string;
  life: ScreenLifetime;
  handle: ScreenReceiveHandle;
  selection: ScreenSelectRequest;
};
type Outgoing = { peer: ScreenPeer; life: ScreenLifetime; shareId: string };
type WatchRecovery = { attempts: number; readyAt: number; timer?: ReturnType<typeof setTimeout> };
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
    watchingShareIds: Object.freeze([]),
    selectingShareId: null,
    layout: 'focus',
    playback: '',
    playbackMuted: false,
    playbackVolume: 1,
    hidden: false,
    label: '',
    viewers: 0,
    open: false,
    setupRequested: false,
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
  private renewing?: object;
  private renewalFailures = 0;
  private publishing = false;
  private preparing = false;
  private sourceCleanup?: Promise<unknown>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private receiving = new Map<string, Incoming>();
  private selecting = false;
  private selectionFinished: Promise<void> = Promise.resolve();
  private watchRecoveryTail: Promise<void> = Promise.resolve();
  private selectionAbort?: AbortController;
  private selectionShareId?: string;
  private early: ScreenSignalNotice[] = [];
  private selectionCleanup?: ScreenSelectRequest;
  private cleanupRaw?: Promise<unknown>;
  private cleanupTail: Promise<void> = Promise.resolve();
  private iceServers: RTCIceServer[] = screenIceServers(publicScreenIceServers);
  private outgoing = new Map<string, Outgoing>();
  private watchRecoveries = new Map<string, WatchRecovery>();
  private publisherLinks = new Map<string, ScreenLinkGrant['link']>();
  private removals: (() => void)[] = [];
  private bindingRemovals: (() => void)[] = [];
  private previewElements = new Set<HTMLVideoElement>();
  private host?: HTMLElement;
  private elements = new Map<string, HTMLElement>();
  private resumeInProgress?: object;
  private resume?: {
    selections: { shareId: string; quality: ScreenQuality }[];
    focused: string;
    layout: 'focus' | 'grid';
    epoch: string;
  };
  private lastVoice?: Readonly<VoiceState>;
  private volumeValue = 1;
  private muted = false;

  constructor(
    private readonly options: {
      attachment: ScreenRuntimeAttachment;
      voice: VoiceScreenSession;
      capture: WebScreenCapture;
      element(listener: (element: HTMLVideoElement, linkId: string) => void): () => void;
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
      options.element((element, linkId) => {
        const incoming = [...this.receiving.values()].find((item) => item.id === linkId);
        if (!incoming) {
          element.remove();
          return;
        }
        const tile = document.createElement('div');
        tile.className = 'screen-incoming-tile';
        tile.dataset.screenShareId = incoming.shareId;
        tile.setAttribute('role', 'button');
        tile.tabIndex = 0;
        tile.setAttribute('aria-label', 'Shared screen. Activate to change the viewing layout.');
        element.setAttribute('aria-label', 'Shared screen video');
        const label = document.createElement('span');
        label.className = 'screen-incoming-label';
        label.textContent = 'Shared screen';
        tile.append(element, label);
        this.elements.set(linkId, tile);
        this.host?.appendChild(tile);
        this.syncIncomingLayout();
      }),
    );
  }
  inspect = () => this.state;
  inspectMedia = () =>
    Object.freeze({
      outgoing: Object.freeze([...this.outgoing.values()].map(({ peer }) => peer.inspectMedia())),
      content: this.source?.content() ?? null,
      codec: this.source?.codec() ?? null,
      incoming: Object.freeze(
        [...this.receiving.values()].map(({ handle }) => handle.inspectMedia()),
      ),
    });
  controls(): ScreenControls {
    return Object.freeze({
      inspect: this.inspect,
      inspectMedia: this.inspectMedia,
      subscribe: this.subscribe,
      connect: this.connect,
      prepare: this.prepare,
      choose: this.choose,
      publish: this.publish,
      stopSource: this.stopSource,
      watch: this.watch,
      watchMultiple: this.watchMultiple,
      stopWatchingShare: this.stopWatchingShare,
      focusWatch: this.focusWatch,
      zoomOutWatch: this.zoomOutWatch,
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
    this.syncIncomingLayout();
    for (const listener of [...this.listeners]) listener();
  }
  private syncIncomingLayout() {
    if (!this.host) return;
    this.host.dataset.layout = this.state.layout;
    this.host.dataset.focusedShare = this.state.watching ?? '';
    for (const tile of this.elements.values())
      tile.dataset.focused = String(tile.dataset.screenShareId === this.state.watching);
  }
  private updateWatching(
    patch: Partial<Pick<ScreenCallState, 'watching' | 'layout' | 'playback'>>,
  ) {
    this.update({ ...patch, watchingShareIds: Object.freeze([...this.receiving.keys()]) });
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
      !Array.isArray(data.shares)
    )
      throw new Error('Invalid screen directory.');
    if ((data.revision as number) < this.directoryRevision) return;
    const shares = Object.freeze(data.shares.map(share));
    this.directoryRevision = data.revision as number;
    this.update({ shares });
    for (const id of this.receiving.keys())
      if (!shares.some((item) => item.id === id)) this.stopWatchingShare(id);
    for (const id of this.watchRecoveries.keys())
      if (!shares.some((item) => item.id === id)) this.cancelWatchRecovery(id);
    if (this.selectionShareId && !shares.some((item) => item.id === this.selectionShareId))
      this.stopWatchingShare(this.selectionShareId);
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
      const link = notice.grant.link;
      // Viewers adopt their select acknowledgement; only new outgoing links need discovery.
      if (link.shareId === this.ownShare?.id && !this.outgoing.has(link.id)) this.requestRenewal();
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
      const incoming = [...this.receiving.values()].find((item) => item.id === notice.linkId);
      if (incoming) this.stopWatchingShare(incoming.shareId);
      return;
    }
    if (event === 'signal') {
      const signal = value as ScreenSignalNotice;
      if (signal.epoch !== this.binding?.binding.epoch) return;
      const incoming = [...this.receiving.values()].find((item) => item.id === signal.linkId);
      const ownedOutgoing = this.outgoing.get(signal.linkId);
      const binding = this.binding;
      const currentTarget = () =>
        this.current(binding) &&
        (ownedOutgoing
          ? this.outgoing.get(signal.linkId) === ownedOutgoing
          : !!incoming && this.receiving.get(incoming.shareId) === incoming);
      const target = ownedOutgoing?.peer ?? incoming?.handle;
      if (target)
        void target
          .receive(signal)
          .then(async () => {
            if (!currentTarget()) return;
            const outgoing = this.outgoing.get(signal.linkId);
            if (outgoing && signal.payload.type === 'answer' && this.ownShare) {
              const link = this.publisherLinks.get(signal.linkId);
              if (link)
                await outgoing.peer.setVideoQuality({
                  revision: (outgoing.peer.inspectVideoQuality().requested?.revision ?? 0) + 1,
                  publisher: qualityOnly(this.ownShare),
                  viewer: qualityOnly(link.quality),
                });
            }
          })
          .catch((cause) => {
            if (!currentTarget()) return;
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
          (settings.sound === 'system' && !capabilities.systemSound) ||
          (settings.sound === 'application' && !capabilities.applicationSound) ||
          (settings.sound === 'source' && (!capabilities.sourceSound || !capabilities.systemSound))
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
  publish = async (qualityOverride?: ScreenQuality) => {
    const source = this.source,
      binding = this.binding,
      preparedSettings = this.settings,
      requestedQuality = qualityOverride
        ? screenVideoRequest({
            revision: 1,
            publisher: qualityOnly(qualityOverride),
            viewer: qualityOnly(qualityOverride),
          }).publisher
        : null,
      settings =
        requestedQuality && preparedSettings
          ? Object.freeze({ ...preparedSettings, ...requestedQuality })
          : preparedSettings,
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
    this.settings = settings;
    this.publishing = true;
    const generation = ++this.sourceGeneration,
      key = source.previewKey,
      started = Date.now();
    this.update({ phase: 'publishing', error: '' });
    let issued: ScreenPublishGrant | undefined;
    let publishDispatched = false;
    try {
      if (
        settings.resolution &&
        settings.frameRate &&
        (settings.resolution !== preparedSettings?.resolution ||
          settings.frameRate !== preparedSettings?.frameRate)
      ) {
        const capture = source.borrow();
        await Promise.race([
          setScreenCaptureFormat(capture.video, settings.resolution, settings.frameRate),
          capture.ended.then(() => {
            throw new Error('Screen source ended.');
          }),
        ]);
        if (this.source !== source || !this.current(binding) || this.prepared !== prepared)
          throw new Error('Screen source ended.');
      }
      publishDispatched = true;
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
      source.commitPublication(key, issued, deadline, generation, settings);
      this.ownShare = issued.share;
      this.update({ phase: 'sharing', error: '', ownShareId: issued.share.id });
      this.requestRenewal();
    } catch (cause) {
      source.stop();
      if (issued && this.current(binding))
        this.retireShare(this.socket!, binding!, issued.share.id);
      else if (publishDispatched && this.current(binding)) this.disconnect();
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
      runInBackground(this.renew());
    }, 100);
  }
  private async renew() {
    if (this.renewing || !this.current()) return;
    const operation = {};
    this.renewing = operation;
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
      if (!Array.isArray(data.links) || !Object.hasOwn(data, 'publication'))
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
        if (!this.current(binding) || this.source !== source || this.ownShare !== own) return;
        const grant = this.linkGrant(value, started);
        live.add(grant.link.id);
        const incoming = [...this.receiving.values()].find((item) => item.id === grant.link.id);
        if (incoming) {
          const permit = screenRenewalPermit(
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
          } else {
            await this.openPublisher(grant.link, peerDeadline, source, own);
            if (!this.current(binding) || this.source !== source || this.ownShare !== own) return;
          }
        }
      }
      for (const id of this.outgoing.keys()) if (!live.has(id)) this.closeOutgoing(id);
      for (const incoming of this.receiving.values())
        if (!live.has(incoming.id)) this.stopWatchingShare(incoming.shareId);
      this.renewalFailures = 0;
    } catch (cause) {
      if (this.current(binding)) {
        const code = (cause as { code?: string }).code;
        if (
          code === 'throttled' ||
          ((code === 'timeout' || code === 'unavailable') && this.renewalFailures++ < 2)
        ) {
          this.renewalTimer = setTimeout(
            () => {
              this.renewalTimer = undefined;
              runInBackground(this.renew());
            },
            code === 'throttled' ? 5000 : 1000,
          );
          this.error(cause);
        } else {
          this.disconnect();
          this.error(cause);
        }
      }
    } finally {
      if (this.renewing === operation) this.renewing = undefined;
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
  private async openPublisher(
    link: ScreenLinkGrant['link'],
    deadline: number,
    source: CaptureSession,
    own: ScreenShare,
  ) {
    const life = new ScreenLifetime(deadline),
      socket = this.socket!,
      binding = this.binding!,
      epoch = binding.binding.epoch;
    const capture = source.borrow();
    this.publisherLinks.set(link.id, link);
    let peer: ScreenPeer | undefined;
    try {
      peer = new ScreenPeer({
        endpoint: { epoch, linkId: link.id, role: 'publisher', sound: own.sound },
        lifecycle: life,
        source: { video: capture.video, audio: capture.audio, sound: capture.sound },
        iceServers: this.iceServers,
        currentIceServers: () => this.iceServers,
        content: () => source.content().kind,
        codecPreference: () => source.codecPreference(),
        createPeer: (config) => new RTCPeerConnection(config),
        initialVideoQuality: {
          revision: 1,
          publisher: qualityOnly(own),
          viewer: qualityOnly(link.quality),
        },
        videoBudget: () => {
          if (own.resolution !== undefined || link.quality.resolution !== undefined)
            return Math.min(own.videoBitrate!, link.quality.videoBitrate!);
          const links = [...this.publisherLinks.values()];
          const index = links.findIndex((item) => item.id === link.id);
          if (index < 0) throw new Error('Screen viewer budget retired.');
          return screenVideoBudget(
            links.map((item) => Math.min(own.videoBitrate!, item.quality.videoBitrate!)),
            own.videoBitrate!,
          )[index]!;
        },
        send: async (signal, abort) => ({
          ok: true,
          data: await socket.command('screen:signal', signal, abort),
        }),
        onTrack: () => {},
        onError: (cause) => {
          if (peer && this.outgoing.get(link.id)?.peer === peer) {
            this.closeOutgoing(link.id);
            this.error(cause);
          }
        },
      });
    } catch (cause) {
      this.publisherLinks.delete(link.id);
      life.stop();
      throw cause;
    }
    this.outgoing.set(link.id, { peer, life, shareId: own.id });
    try {
      await Promise.all(
        [...this.outgoing.values()]
          .filter((item) => item.peer !== peer && own.resolution === undefined)
          .map((item) => item.peer.refreshVideoLimits()),
      );
      if (
        this.outgoing.get(link.id)?.peer !== peer ||
        this.source !== source ||
        this.ownShare !== own
      )
        return;
      await peer.offer();
    } catch (cause) {
      if (this.outgoing.get(link.id)?.peer === peer) {
        this.closeOutgoing(link.id);
        this.error(cause);
      }
    }
    if (this.current(binding)) this.update({ viewers: this.outgoing.size });
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
  watch = (shareId: string, quality: ScreenQuality) => {
    this.cancelWatchRecovery(shareId);
    return this.selectShare(shareId, quality, 'replace');
  };
  watchMultiple = (shareId: string, quality: ScreenQuality) => {
    this.cancelWatchRecovery(shareId);
    if (this.selecting)
      return Promise.reject(new Error('Finish the current screen selection first.'));
    const existing = this.receiving.get(shareId);
    if (existing) {
      if (
        JSON.stringify(qualityOnly(existing.selection)) === JSON.stringify(qualityOnly(quality))
      ) {
        this.focusWatch(shareId);
        return Promise.resolve();
      }
      this.stopWatchingShare(shareId);
    }
    return this.selectShare(shareId, quality, 'add');
  };
  private async selectShare(
    shareId: string,
    quality: ScreenQuality,
    mode: 'replace' | 'add',
    recovery?: WatchRecovery,
  ) {
    await this.connect();
    if (this.selecting) throw new Error('Finish the current screen selection first.');
    const selected = this.state.shares.find((item) => item.id === shareId);
    if (!selected || selected.id === this.ownShare?.id || this.state.hidden)
      throw new Error('That screen share is unavailable.');
    if (this.receiving.has(shareId)) {
      if (mode === 'replace' && this.receiving.size > 1) {
        // Re-selecting the focused stream as the primary view is a local layout action.
        this.focusWatch(shareId);
        return;
      }
      if (mode === 'add') {
        this.focusWatch(shareId);
        return;
      }
    }
    if (mode === 'replace') this.stopWatching(false);
    const binding = this.binding!,
      socket = this.socket!,
      epoch = binding.binding.epoch;
    this.selecting = true;
    let finishSelection!: () => void;
    this.selectionFinished = new Promise<void>((resolve) => {
      finishSelection = resolve;
    });
    const abort = new AbortController();
    this.selectionAbort = abort;
    this.selectionShareId = shareId;
    try {
      this.update({ selectingShareId: shareId, error: '' });
      if (this.cleanupRaw) await this.cleanupRaw;
      if (
        abort.signal.aborted ||
        !this.current(binding) ||
        (recovery && this.watchRecoveries.get(shareId) !== recovery)
      )
        throw new Error('Screen selection ended.');
      const selection: ScreenSelectRequest = {
        ...quality,
        epoch,
        shareId,
        mode,
        requestId: crypto.randomUUID(),
        revision: ++this.revision,
      };
      // Reserved only for cancellation before a receive handle owns exact-link cleanup.
      const cancelledCleanup: ScreenSelectRequest = {
        ...quality,
        epoch,
        shareId: null,
        mode: 'remove',
        removeShareId: shareId,
        requestId: crypto.randomUUID(),
        revision: this.revision + 1,
      };
      this.selectionCleanup = cancelledCleanup;
      this.early = [];
      const started = Date.now();
      const result = this.linkGrant(
        await socket.command('screen:select', selection, abort.signal),
        started,
      );
      if (
        abort.signal.aborted ||
        !this.current(binding) ||
        this.state.hidden ||
        (recovery && this.watchRecoveries.get(shareId) !== recovery) ||
        this.selectionCleanup !== cancelledCleanup
      )
        throw new Error('Screen selection ended.');
      if (result.link.shareId !== shareId || result.link.selectionRevision !== selection.revision)
        throw new Error('Screen selection changed.');
      const life = new ScreenLifetime(Math.min(result.deadline, binding.inspect()!.deadline));
      const incoming: Incoming = {
        id: result.link.id,
        shareId,
        life,
        handle: undefined as unknown as ScreenReceiveHandle,
        selection,
      };
      const handle = this.options.attachment.openIncoming({
        iceServers: this.iceServers,
        currentIceServers: () => this.iceServers,
        endpoint: { epoch, linkId: result.link.id, role: 'viewer', sound: selected.sound },
        lifecycle: life,
        send: async (signal, signalAbort) => ({
          ok: true,
          data: await socket.command('screen:signal', signal, signalAbort),
        }),
        cleanup: async () => {
          await this.cleanupSelection(socket, {
            ...qualityOnly(selection),
            epoch,
            shareId: null,
            mode: 'remove',
            removeShareId: shareId,
            requestId: crypto.randomUUID(),
            revision: ++this.revision,
          });
        },
      });
      incoming.handle = handle;
      this.receiving.set(shareId, incoming);
      this.selectionCleanup = undefined;
      this.selectionShareId = undefined;
      this.updateWatching({ watching: shareId, layout: 'focus', playback: 'Connecting…' });
      handle.subscribe((state) => {
        if (this.receiving.get(shareId) !== incoming) return;
        if (state.phase === 'closed' || state.phase === 'paused-hidden') {
          this.receiving.delete(shareId);
          incoming.life.stop();
          this.elements.get(incoming.id)?.remove();
          this.elements.delete(incoming.id);
          const focused = this.state.watching === shareId;
          this.updateWatching({
            ...(focused ? { watching: this.receiving.keys().next().value ?? null } : {}),
            playback: focused ? '' : this.state.playback,
          });
          if (state.reason === 'failed' || state.reason === 'tracks-timeout')
            this.recoverWatching(incoming, binding, focused);
          return;
        }
        const recovery = this.watchRecoveries.get(shareId);
        if (state.phase === 'ready' && recovery && !recovery.readyAt) recovery.readyAt = Date.now();
        if (this.state.watching === shareId)
          this.update({
            playback: state.playback?.error?.message ?? state.playback?.phase ?? state.phase,
          });
        if (state.phase === 'ready' && state.playback?.phase === 'idle') {
          this.configurePlayback();
          void handle.play().catch((cause) => {
            if (this.receiving.get(shareId) === incoming) this.error(cause);
          });
        }
      });
      for (const signal of this.early.splice(0))
        if (signal.linkId === incoming.id) await handle.receive(signal);
    } catch (cause) {
      if (this.selectionCleanup) {
        const cleanup = this.selectionCleanup;
        this.selectionCleanup = undefined;
        if (this.current(binding) && (cause as { code?: string } | undefined)?.code !== 'throttled')
          void this.cleanupSelection(socket, { ...cleanup, revision: ++this.revision }).catch(
            (error) => this.error(error),
          );
      }
      this.selectionShareId = undefined;
      if (!abort.signal.aborted) this.error(cause);
      throw cause;
    } finally {
      if (this.selectionAbort === abort) this.selectionAbort = undefined;
      this.selecting = false;
      finishSelection();
      if (this.state.selectingShareId === shareId) this.update({ selectingShareId: null });
    }
  }
  private cancelWatchRecovery(shareId: string) {
    clearTimeout(this.watchRecoveries.get(shareId)?.timer);
    this.watchRecoveries.delete(shareId);
  }
  private recoverWatching(incoming: Incoming, binding: OwnedScreenBinding, focused: boolean) {
    const shareId = incoming.shareId;
    const recovery = this.watchRecoveries.get(shareId) ?? { attempts: 0, readyAt: 0 };
    if (recovery.readyAt && Date.now() - recovery.readyAt >= 30000) recovery.attempts = 0;
    recovery.readyAt = 0;
    if (recovery.attempts >= 2 || this.state.hidden || !this.current(binding)) {
      this.error(new Error('Screen connection recovery failed. Select the screen again to retry.'));
      return;
    }
    this.watchRecoveries.set(shareId, recovery);
    recovery.timer = setTimeout(() => {
      recovery.timer = undefined;
      const task = this.watchRecoveryTail.then(async () => {
        try {
          while (this.selecting) await this.selectionFinished;
          await this.cleanupRaw;
          if (
            this.watchRecoveries.get(shareId) !== recovery ||
            !this.current(binding) ||
            this.state.hidden ||
            this.receiving.has(shareId) ||
            !this.state.shares.some((item) => item.id === shareId)
          )
            return;
          recovery.attempts++;
          const previousFocus = this.state.watching,
            previousLayout = this.state.layout;
          await this.selectShare(shareId, qualityOnly(incoming.selection), 'add', recovery);
          if (this.watchRecoveries.get(shareId) !== recovery) return;
          if (!focused && previousFocus && this.receiving.has(previousFocus))
            this.updateWatching({ watching: previousFocus, layout: previousLayout });
          else this.update({ layout: previousLayout });
        } catch (cause) {
          if (this.watchRecoveries.get(shareId) === recovery && this.current(binding))
            this.error(cause);
        }
      });
      this.watchRecoveryTail = task;
      runInBackground(task);
    }, 1000);
  }
  private cleanupSelection(socket: ScreenSocket, request: ScreenSelectRequest) {
    const raw = this.cleanupTail.then(async () => {
      await socket.command('screen:select', request);
    });
    this.cleanupTail = raw.catch((cause) => this.error(cause));
    this.cleanupRaw = raw;
    void raw
      .finally(() => {
        if (this.cleanupRaw === raw) this.cleanupRaw = undefined;
      })
      .catch((cause) => this.error(cause));
    return raw;
  }
  focusWatch = (shareId: string) => {
    if (!this.receiving.has(shareId)) return;
    this.updateWatching({ watching: shareId, layout: 'focus' });
  };
  zoomOutWatch = () => {
    if (this.receiving.size > 0) this.update({ layout: 'grid' });
  };
  stopWatchingShare = (shareId: string) => {
    this.cancelWatchRecovery(shareId);
    const incoming = this.receiving.get(shareId);
    if (incoming) {
      this.receiving.delete(shareId);
      this.elements.get(incoming.id)?.remove();
      this.elements.delete(incoming.id);
      incoming.handle.stop();
      incoming.life.stop();
    }
    if (this.selectionShareId === shareId) {
      this.selectionAbort?.abort();
      const pending = this.selectionCleanup,
        socket = this.socket;
      this.selectionCleanup = undefined;
      this.selectionShareId = undefined;
      this.update({ selectingShareId: null });
      if (pending && socket) {
        const cleanup = { ...pending, revision: ++this.revision };
        void this.cleanupSelection(socket, cleanup).catch((cause) => this.error(cause));
      }
    }
    if (this.state.watching === shareId) {
      this.updateWatching({
        watching: this.receiving.keys().next().value ?? null,
        playback: '',
      });
    } else this.updateWatching({});
  };
  stopWatching = (forget = true) => {
    for (const shareId of this.watchRecoveries.keys()) this.cancelWatchRecovery(shareId);
    if (forget) this.resume = undefined;
    const pending = this.selectionCleanup,
      socket = this.socket;
    this.selectionAbort?.abort();
    this.selectionCleanup = undefined;
    this.selectionShareId = undefined;
    this.update({ selectingShareId: null });
    this.early = [];
    if (pending && socket) {
      const cleanup = { ...pending, revision: ++this.revision };
      void this.cleanupSelection(socket, cleanup).catch((cause) => this.error(cause));
    }
    const incoming = [...this.receiving.values()];
    this.receiving.clear();
    for (const item of incoming) {
      this.elements.get(item.id)?.remove();
      this.elements.delete(item.id);
      item.handle.stop();
      item.life.stop();
    }
    this.updateWatching({ watching: null, layout: 'focus', playback: '' });
  };
  private visibility(visible: boolean) {
    if (this.state.hidden === !visible) return;
    this.update({ hidden: !visible });
    if (!visible) {
      const incoming = [...this.receiving.values()];
      if (incoming.length && !this.resumeInProgress)
        this.resume = {
          selections: incoming.map(({ selection, shareId }) => ({
            shareId,
            quality: qualityOnly(selection),
          })),
          focused: this.state.watching ?? incoming[0]!.shareId,
          layout: this.state.layout,
          epoch: incoming[0]!.selection.epoch,
        };
      this.stopWatching(false);
    } else if (this.resume) {
      runInBackground(this.resumeWatching(this.resume));
    }
  }
  private async resumeWatching(previous: NonNullable<ScreenCall['resume']>) {
    if (this.resumeInProgress === previous) return;
    this.resumeInProgress = previous;
    const binding = this.binding;
    let retry = false;
    try {
      await this.cleanupRaw;
      if (this.resume !== previous || this.state.hidden || !this.current(binding)) return;
      if (previous.epoch !== binding?.binding.epoch) return;
      for (const previousSelection of previous.selections) {
        if (this.resume !== previous || this.state.hidden) return;
        if (!this.state.shares.some((item) => item.id === previousSelection.shareId)) continue;
        if (this.receiving.size)
          await this.watchMultiple(previousSelection.shareId, previousSelection.quality);
        else await this.watch(previousSelection.shareId, previousSelection.quality);
      }
      if (this.receiving.has(previous.focused))
        this.updateWatching({ watching: previous.focused, layout: previous.layout });
      else if (this.receiving.size) this.update({ layout: previous.layout });
      if (this.resume === previous) this.resume = undefined;
    } catch (cause) {
      retry = cause instanceof Error && cause.message === 'Screen selection ended.';
      if (this.current(binding)) this.error(cause);
    } finally {
      if (this.resumeInProgress === previous) this.resumeInProgress = undefined;
      if (retry && this.resume === previous && !this.state.hidden && this.current(binding))
        queueMicrotask(() => runInBackground(this.resumeWatching(previous)));
    }
  }
  observeVoice(voice: VoiceState) {
    const changed =
      !this.lastVoice ||
      this.lastVoice.output !== voice.output ||
      this.lastVoice.outputMissing !== voice.outputMissing ||
      this.lastVoice.deafened !== voice.deafened;
    this.lastVoice = voice;
    if (voice.status === 'idle' && this.state.open) this.close();
    if (changed) this.configurePlayback();
  }
  private configurePlayback() {
    const voice = this.lastVoice;
    if (!voice) return;
    for (const incoming of this.receiving.values()) {
      if (incoming.handle.inspect().phase !== 'ready') continue;
      incoming.handle.setOutput(voice.outputMissing ? null : voice.output || null);
      incoming.handle.setDeafened(voice.deafened);
      incoming.handle.setMuted(this.muted);
      incoming.handle.setVolume(this.volumeValue);
    }
  }
  play = () => {
    this.configurePlayback();
    if (!this.receiving.size) return Promise.reject(new Error('Select a screen first.'));
    return Promise.all([...this.receiving.values()].map(({ handle }) => handle.play())).then(
      () => undefined,
    );
  };
  open = (setupRequested = false) => {
    this.update({ open: true, setupRequested });
    return this.connect();
  };
  close = () => {
    this.stopWatching();
    this.update({ open: false });
  };
  mute = (value: boolean) => {
    this.muted = value;
    this.update({ playbackMuted: value });
    this.configurePlayback();
  };
  volume = (value: number) => {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error('Invalid screen volume.');
    this.volumeValue = value;
    this.update({ playbackVolume: value });
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
    this.syncIncomingLayout();
    for (const tile of this.elements.values()) host.appendChild(tile);
    return () => {
      if (this.host === host) {
        this.host = undefined;
        for (const tile of this.elements.values()) tile.remove();
      }
    };
  };
  private disconnect() {
    this.generation++;
    this.renewing = undefined;
    this.renewalFailures = 0;
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
