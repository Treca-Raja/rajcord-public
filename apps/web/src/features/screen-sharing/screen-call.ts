import { runInBackground } from '../../shared/background';
import {
  DESKTOP_SCREEN_PROTOCOL_VERSION,
  SCREEN_RENEWAL_PAGE_SIZE,
  sameScreenQuality,
} from '@tricord/shared';
import type {
  ScreenQuality,
  ScreenSound,
  ScreenShare,
  ScreenPublishGrant,
  ScreenPublishRequest,
  ScreenDirectory,
  ScreenLinkGrant,
  ScreenRenewal,
  ScreenLinkNotice,
  ScreenClosed,
  ScreenSignalNotice,
  ScreenSelectRequest,
  DesktopScreenStatus,
  DesktopScreenBridge,
  LegacyDesktopScreenBridge,
} from '@tricord/shared';
import { CaptureSession, ScreenLifetime } from './capture-session';
import { screenSocket, type ScreenSocket } from './screen-socket';
import type { OwnedScreenBinding } from './screen-binding';
import type { ScreenRuntimeAttachment } from './screen-runtime';
import type { VoiceScreenSession, VoiceState } from '../voice/contracts';
import { setScreenCaptureFormat, type WebScreenCapture } from './screen-capture';
import { ScreenPeer } from './screen-peer';
import type { ObsEncoder, ObsEncoderChoice } from '@tricord/shared';
import { ObsPeer, obsVideoSource } from './obs-peer';
import type { ScreenReceiveHandle } from './screen-receiver';
import { ScreenPlaybackError } from './screen-playback';
import { publicScreenIceServers, screenIceServers } from './screen-ice';
import { screenVideoRequest } from './screen-quality';
import { screenRenewalPermit } from './screen-renewal';
import { record, share, uuid } from './screen-share';

export type ScreenSettings = ScreenQuality & {
  sound: ScreenSound;
  encoder?: ObsEncoderChoice;
};
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
  playbackTimeout: string;
  playbackMuted: boolean;
  playbackVolume: number;
  hidden: boolean;
  label: string;
  viewers: number;
  obsEncoder?: ObsEncoder;
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
  | 'updateQuality'
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

const lifetime = (value: unknown, started: number) => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 45000)
    throw new Error('Invalid screen authority deadline.');
  const deadline = started + (value as number);
  if (deadline <= Date.now()) throw new Error('Screen authority expired.');
  return deadline;
};
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
  playbackTimeout: string;
};
type Outgoing = { peer: ScreenPeer; life: ScreenLifetime; shareId: string; native?: ObsPeer };
type ScreenLink = Omit<ScreenLinkGrant['link'], 'quality' | 'videoBitrate'>;
type PublisherOffer = { link: ScreenLink; deadline: number };
type WatchRecovery = { attempts: number; readyAt: number; timer?: ReturnType<typeof setTimeout> };
// The account budget refills one initial renewal every five seconds. Keep one
// burst slot in reserve for a transient failure or network timing variance.
const RENEWAL_REFILL_MS = 5000;
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
    playbackTimeout: '',
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
  private prepared?: {
    tag: string;
    deadline: number;
    desktop?: DesktopScreenBridge | LegacyDesktopScreenBridge;
    native?: DesktopScreenBridge;
  };
  private sourceGeneration = 0;
  private revision = 0;
  private renewalRevision = 0;
  private directoryRevision = 0;
  private generation = 0;
  private active = true;
  private connecting?: Promise<void>;
  private renewing?: Set<string>;
  private renewalPending = false;
  private renewalFailures = 0;
  private renewalRefilledAt = 0;
  private publishing = false;
  private changingQuality = false;
  private qualityRevision = 0;
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
  private publisherOffers = new Map<string, PublisherOffer>();
  private offeringLinkId?: string;
  private watchRecoveries = new Map<string, WatchRecovery>();
  private preferredWatch?: string;
  private removals: (() => void)[] = [];
  private bindingRemovals: (() => void)[] = [];
  private previewElements = new Set<HTMLVideoElement>();
  private host?: HTMLElement;
  private elements = new Map<string, HTMLElement>();
  private resumeInProgress?: object;
  private resume?: {
    shareIds: string[];
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
        bridge.onStop((tag, reason) => {
          if (this.prepared?.tag === tag) {
            this.stopSource();
            if (reason) this.error(new Error(reason));
          }
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
        element.setAttribute('aria-label', 'Shared screen video');
        const existingTile = this.elements.get(linkId);
        if (existingTile) {
          existingTile.querySelector('video')?.remove();
          existingTile.prepend(element);
          return;
        }
        const tile = document.createElement('div');
        tile.className = 'screen-incoming-tile';
        tile.dataset.screenShareId = incoming.shareId;
        tile.setAttribute('role', 'button');
        tile.tabIndex = 0;
        tile.setAttribute('aria-label', 'Shared screen. Activate to change the viewing layout.');
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
      updateQuality: this.updateQuality,
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
    this.update({
      ...patch,
      playbackTimeout: this.watchPlaybackTimeout(),
      watchingShareIds: Object.freeze([...this.receiving.keys()]),
    });
  }
  private watchPlaybackTimeout() {
    for (const watch of this.receiving.values()) {
      if (watch.playbackTimeout) return watch.playbackTimeout;
    }
    return '';
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
      this.renewing?.add(notice.linkId);
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
            const own = this.ownShare;
            if (outgoing && own && outgoing.shareId === own.id && signal.payload.type === 'answer')
              await outgoing.peer.updatePublisherQuality(qualityOnly(own));
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
    const desktop = window.tricordDesktop;
    const bridge = desktop?.screens;
    const prepared: NonNullable<ScreenCall['prepared']> = {
      tag,
      deadline: initial.deadline,
      desktop: bridge,
    };
    this.prepared = prepared;
    this.update({ phase: 'preparing', error: '' });
    try {
      if (!this.current(binding) || this.prepared?.tag !== tag)
        throw new Error('Screen preparation ended.');
      if (desktop && !bridge)
        throw new Error('Update Rajcord Desktop to share your screen with OBS.');
      if (bridge) {
        if (settings.sound === 'tab')
          throw new Error('Choose system sound or video only in the desktop app.');
        const capabilities = await bridge.capabilities();
        if (
          (settings.sound === 'system' && !capabilities.systemSound) ||
          (settings.sound === 'application' && !capabilities.applicationSound) ||
          (settings.sound === 'source' && (!capabilities.sourceSound || !capabilities.systemSound))
        )
          throw new Error('This desktop version cannot capture the selected source sound.');
        if (!this.current(binding) || this.prepared?.tag !== tag)
          throw new Error('Screen preparation ended.');
        const started = Date.now();
        const request = {
          clientIntentRef: tag,
          epoch: binding.binding.epoch,
          sound: settings.sound,
        };
        let result: DesktopScreenStatus;
        if (capabilities.version === 1 && !bridge.nativeCommand && !bridge.onNativeEvent) {
          result = await bridge.prepare(request);
        } else if (
          capabilities.version === DESKTOP_SCREEN_PROTOCOL_VERSION &&
          typeof bridge.nativeCommand === 'function' &&
          typeof bridge.onNativeEvent === 'function'
        ) {
          if (!capabilities.obs?.available)
            throw new Error(
              capabilities.obs?.reason ??
                'OBS screen sharing is unavailable. Reinstall Rajcord Desktop.',
            );
          prepared.native = bridge;
          result = await bridge.prepare({ ...request, encoder: settings.encoder ?? 'auto' });
        } else {
          throw new Error('Update Rajcord Desktop to share your screen with OBS.');
        }
        this.status(result, tag);
        prepared.deadline = Math.min(initial.deadline, lifetime(result.remainingMs, started));
      }
      if (!this.current(binding) || this.prepared?.tag !== tag)
        throw new Error('Screen preparation ended.');
      const captureSession = new CaptureSession({
        adapter: this.options.capture,
        deadline: prepared.deadline,
        sound: settings.sound,
        quality,
        onEnded: () => {
          if (this.source === captureSession) this.stopSource();
        },
      });
      this.source = captureSession;
      this.update({ phase: 'ready', prepared: true });
    } catch (cause) {
      if (this.prepared?.tag === tag) {
        this.stopSource();
        this.error(cause);
      }
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
          ...(prepared.native ? { native: true } : {}),
        } satisfies ScreenPublishRequest),
        started,
      );
      issued = proof.grant;
      if (this.source !== source || !this.current(binding) || this.prepared !== prepared)
        throw new Error('Screen source ended.');
      let deadline = Math.min(proof.deadline, binding!.inspect()!.deadline);
      const bridge = prepared.desktop;
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
  updateQuality = async (choice: ScreenQuality) => {
    const source = this.source;
    const binding = this.binding;
    const own = this.ownShare;
    if (!own || !source || !binding || !this.current(binding))
      throw new Error('Start screen sharing before changing stream quality.');
    if (this.changingQuality) throw new Error('Finish applying the current stream quality first.');
    const { publisher } = screenVideoRequest({ revision: 1, publisher: qualityOnly(choice) });
    if (sameScreenQuality(own, publisher)) return;
    const check = () => {
      if (!this.current(binding) || this.source !== source || this.ownShare !== own)
        throw new Error('Screen source ended.');
    };
    this.changingQuality = true;
    let previousFormat: { video: MediaStreamTrack; constraints: MediaTrackConstraints } | undefined;
    let dispatched = false;
    try {
      if (
        !this.prepared?.native &&
        publisher.resolution !== undefined &&
        publisher.frameRate !== undefined &&
        (publisher.resolution !== own.resolution || publisher.frameRate !== own.frameRate)
      ) {
        const capture = source.borrow();
        previousFormat = { video: capture.video, constraints: capture.video.getConstraints() };
        await Promise.race([
          setScreenCaptureFormat(capture.video, publisher.resolution, publisher.frameRate),
          capture.ended.then(() => {
            throw new Error('Screen source ended.');
          }),
        ]);
      }
      check();
      dispatched = true;
      const updated = share(
        await this.send<unknown>('screen:quality', {
          ...publisher,
          epoch: binding.binding.epoch,
          shareId: own.id,
          requestId: crypto.randomUUID(),
          revision: ++this.qualityRevision,
        }),
      );
      check();
      if (
        updated.id !== own.id ||
        updated.publisherId !== own.publisherId ||
        updated.sourceGeneration !== own.sourceGeneration ||
        updated.sound !== own.sound ||
        !sameScreenQuality(updated, publisher)
      )
        throw new Error('Screen publication changed.');
      this.ownShare = updated;
      this.update({
        shares: Object.freeze(
          this.state.shares.map((item) => (item.id === updated.id ? updated : item)),
        ),
      });
      await Promise.all(
        [...this.outgoing.entries()].map(async ([id, outgoing]) => {
          try {
            await outgoing.peer.updatePublisherQuality(publisher);
          } catch (cause) {
            if (this.outgoing.get(id) !== outgoing) return;
            this.closeOutgoing(id);
            this.error(cause);
          }
        }),
      );
      this.requestRenewal();
    } catch (cause) {
      if (this.source === source && this.ownShare === own) {
        if (dispatched) this.stopSource();
        else if (previousFormat) {
          try {
            await previousFormat.video.applyConstraints(previousFormat.constraints);
          } catch (restoreError) {
            if (this.source === source && this.ownShare === own) this.stopSource();
            throw new AggregateError(
              [cause, restoreError],
              'The previous screen format could not be restored.',
              { cause: restoreError },
            );
          }
        }
      }
      throw cause;
    } finally {
      this.changingQuality = false;
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
    this.publisherOffers.clear();
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
    if (prepared?.desktop)
      void prepared.desktop
        .cancel({ clientIntentRef: prepared.tag })
        .catch((cause) => this.error(cause));
    if (own && socket && epoch && this.binding) this.retireShare(socket, this.binding, own.id);
    this.update({
      phase: this.current() ? 'ready' : 'idle',
      label: '',
      viewers: 0,
      obsEncoder: undefined,
      prepared: false,
      ownShareId: null,
    });
  };
  private requestRenewal() {
    if (!this.current() || this.renewalTimer) return;
    if (this.renewing) {
      this.renewalPending = true;
      return;
    }
    // Two prompt renewals can run from a full bucket. Further notices share
    // the next admission, whose response contains every current link grant.
    const delay = Math.max(100, this.renewalRefilledAt - RENEWAL_REFILL_MS - performance.now());
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      runInBackground(this.renew());
    }, delay);
  }
  private async renewalPages(
    binding: OwnedScreenBinding,
    socket: ScreenSocket,
    revision: number,
    closedLinks: ReadonlySet<string>,
  ) {
    const request = { epoch: binding.binding.epoch, requestId: crypto.randomUUID(), revision };
    const links = new Map<string, ReturnType<ScreenCall['linkGrant']>>();
    let offset = 0,
      retries = 0,
      deadline = Infinity,
      publicationDeadline = Infinity;
    let shareId: string | undefined;
    let servers: RTCIceServer[] | undefined;
    while (this.current(binding)) {
      const started = Date.now();
      if (started >= deadline) throw new Error('Screen renewal expired.');
      let page: Record<string, unknown>;
      try {
        page = record(
          await socket.command<ScreenRenewal>(
            'screen:renew',
            offset ? { ...request, offset } : request,
          ),
        );
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        if (offset && code === 'stale')
          throw Object.assign(new Error('Screen links changed during renewal.', { cause }), {
            code: 'renewal_changed',
          });
        if (!offset || code !== 'throttled' || retries >= 2 || Date.now() + 1000 >= deadline)
          throw cause;
        retries++;
        let resume!: () => void;
        const delay = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const timer = setTimeout(resume, 1000);
        const unsubscribe = binding.onInvalidated(resume);
        await delay;
        unsubscribe();
        clearTimeout(timer);
        continue;
      }
      if (!this.current(binding)) return;
      if (!Array.isArray(page.links) || !Object.hasOwn(page, 'publication'))
        throw new Error('Invalid screen renewal.');
      const more = Object.hasOwn(page, 'nextOffset');
      if (
        (more &&
          (page.nextOffset !== offset + SCREEN_RENEWAL_PAGE_SIZE ||
            page.links.length !== SCREEN_RENEWAL_PAGE_SIZE)) ||
        (offset && (!page.links.length || page.links.length > SCREEN_RENEWAL_PAGE_SIZE))
      )
        throw new Error('Invalid screen renewal page.');
      deadline = Math.min(deadline, lifetime(page.remainingMs, started));
      const proof = page.publication === null ? null : publication(page.publication, started);
      if (offset && proof?.grant.share.id !== shareId)
        throw new Error('Screen publication changed during renewal.');
      if (proof) {
        shareId = proof.grant.share.id;
        publicationDeadline = Math.min(publicationDeadline, proof.deadline);
        proof.deadline = publicationDeadline;
      }
      if (Object.hasOwn(page, 'iceServers'))
        servers = screenIceServers(page.iceServers as RTCIceServer[]);
      for (const value of page.links) {
        const grant = this.linkGrant(value, started);
        if (links.has(grant.link.id)) throw new Error('Duplicate screen renewal link.');
        links.set(grant.link.id, grant);
      }
      if (!more) {
        const now = Date.now();
        if (
          deadline <= now ||
          (proof && proof.deadline <= now) ||
          [...links.values()].some(
            (grant) => !closedLinks.has(grant.link.id) && grant.deadline <= now,
          )
        )
          throw new Error('Screen renewal expired.');
        return { links, proof, deadline, servers };
      }
      offset += SCREEN_RENEWAL_PAGE_SIZE;
      retries = 0;
    }
  }
  private async renew() {
    if (this.renewing || !this.current()) return;
    this.renewalRefilledAt =
      Math.max(this.renewalRefilledAt, performance.now()) + RENEWAL_REFILL_MS;
    const closedLinks = new Set<string>();
    this.renewing = closedLinks;
    const binding = this.binding!,
      socket = this.socket!;
    const own = this.ownShare,
      source = this.source;
    const priorWatches = [...this.receiving.values()];
    const revision = ++this.renewalRevision;
    try {
      const pages = await this.renewalPages(binding, socket, revision, closedLinks);
      if (!pages || !this.current(binding)) return;
      if (this.source !== source || this.ownShare !== own) {
        this.requestRenewal();
        return;
      }
      const { links, proof, deadline, servers } = pages;
      if (servers) this.iceServers = servers;
      binding.adoptRenewal(screenRenewalPermit(binding.inspect()!.generation, deadline, revision));
      if (own && source) {
        if (
          !proof ||
          proof.grant.share.id !== own.id ||
          proof.grant.share.sourceGeneration !== own.sourceGeneration
        )
          throw new Error('Screen publication ended.');
        const life = source.lifecycle();
        life.renew(
          screenRenewalPermit(life.generation, Math.min(deadline, proof.deadline), revision),
        );
      }
      const newPublishers = new Map<string, PublisherOffer>();
      for (const grant of links.values()) {
        if (!this.current(binding) || this.source !== source || this.ownShare !== own) return;
        if (closedLinks.has(grant.link.id)) continue;
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
            if (existing.native)
              void existing.native.renew(peerDeadline).catch((cause) => {
                if (this.outgoing.get(grant.link.id) !== existing) return;
                this.closeOutgoing(grant.link.id);
                this.error(cause);
              });
          } else if (grant.link.id !== this.offeringLinkId) {
            newPublishers.set(grant.link.id, { link: grant.link, deadline: peerDeadline });
          }
        }
      }
      for (const id of this.outgoing.keys()) if (!links.has(id)) this.closeOutgoing(id);
      for (const incoming of priorWatches)
        if (!links.has(incoming.id) && this.receiving.get(incoming.shareId) === incoming)
          this.stopWatchingShare(incoming.shareId);
      if (this.current(binding) && this.source === source && this.ownShare === own) {
        for (const id of closedLinks) newPublishers.delete(id);
        for (const id of this.publisherOffers.keys())
          if (!newPublishers.has(id)) this.publisherOffers.delete(id);
        for (const [id, offer] of newPublishers) this.publisherOffers.set(id, offer);
        runInBackground(this.drainPublisherOffers());
      }
      this.renewalFailures = 0;
    } catch (cause) {
      if (this.current(binding)) {
        const code = (cause as { code?: string }).code;
        if (
          code === 'throttled' ||
          ((code === 'timeout' || code === 'unavailable' || code === 'renewal_changed') &&
            this.renewalFailures++ < 2)
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
      if (this.renewing === closedLinks) {
        this.renewing = undefined;
        if (this.renewalPending) {
          this.renewalPending = false;
          this.requestRenewal();
        }
      }
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
    const { id, shareId, publisherId, viewerId, selectionRevision } = link as ScreenLink;
    return {
      link: { id, shareId, publisherId, viewerId, selectionRevision },
      deadline: lifetime(data.remainingMs, started),
    };
  }
  private async drainPublisherOffers() {
    if (this.offeringLinkId) return;
    // Keep one offer in flight while renewal replaces the pending grants.
    while (this.current() && this.source && this.ownShare) {
      const offer = this.publisherOffers.values().next().value;
      if (!offer) return;
      const { link, deadline } = offer;
      this.publisherOffers.delete(link.id);
      if (deadline <= Date.now() || this.outgoing.has(link.id)) continue;
      this.offeringLinkId = link.id;
      try {
        await this.openPublisher(link, deadline, this.source, this.ownShare);
      } finally {
        this.offeringLinkId = undefined;
      }
    }
  }
  private async openPublisher(
    link: ScreenLink,
    deadline: number,
    source: CaptureSession,
    own: ScreenShare,
  ) {
    const life = new ScreenLifetime(deadline),
      socket = this.socket!,
      binding = this.binding!,
      epoch = binding.binding.epoch;
    let peer: ScreenPeer | undefined;
    let native: ObsPeer | undefined;
    try {
      const capture = source.borrow();
      const prepared = this.prepared;
      const desktop = prepared?.native;
      peer = new ScreenPeer({
        endpoint: { epoch, linkId: link.id, role: 'publisher', sound: own.sound },
        lifecycle: life,
        source: { video: capture.video, audio: capture.audio, sound: capture.sound },
        iceServers: this.iceServers,
        currentIceServers: () => this.iceServers,
        videoSource: desktop ? obsVideoSource : undefined,
        content: () => source.content().kind,
        codecPreference: desktop ? undefined : () => source.codecPreference(),
        createPeer: (config) => {
          if (!desktop) return new RTCPeerConnection(config);
          native = new ObsPeer(
            desktop,
            config,
            prepared.tag,
            link.id,
            () => life.inspect()?.deadline ?? 0,
            (obsEncoder) => {
              if (this.prepared === prepared) this.update({ obsEncoder });
            },
          );
          return native;
        },
        initialVideoQuality: {
          revision: 1,
          publisher: qualityOnly(own),
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
      this.outgoing.set(link.id, { peer, life, shareId: own.id, native });
      await peer.offer();
    } catch (cause) {
      if (!peer) {
        life.stop();
        if (this.current(binding) && this.source === source) this.error(cause);
      } else if (this.outgoing.get(link.id)?.peer === peer) {
        this.closeOutgoing(link.id);
        this.error(cause);
      }
    }
    if (this.current(binding)) this.update({ viewers: this.outgoing.size });
  }
  private closeOutgoing(id: string) {
    this.publisherOffers.delete(id);
    const owned = this.outgoing.get(id);
    if (!owned) return;
    this.outgoing.delete(id);
    owned.peer.dispose();
    owned.life.stop();
    this.update({ viewers: this.outgoing.size });
  }
  watch = (shareId: string) => {
    this.cancelWatchRecovery(shareId);
    return this.selectShare(shareId, 'replace');
  };
  watchMultiple = (shareId: string) => {
    this.cancelWatchRecovery(shareId);
    if (this.selecting)
      return Promise.reject(new Error('Finish the current screen selection first.'));
    return this.selectShare(shareId, 'add');
  };
  private async selectShare(shareId: string, mode: 'replace' | 'add', recovery?: WatchRecovery) {
    await this.connect();
    if (this.selecting) throw new Error('Finish the current screen selection first.');
    const selected = this.state.shares.find((item) => item.id === shareId);
    if (!selected || selected.id === this.ownShare?.id || this.state.hidden)
      throw new Error('That screen share is unavailable.');
    if (this.receiving.has(shareId)) {
      this.focusWatch(shareId);
      return;
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
        epoch,
        shareId,
        mode,
        requestId: crypto.randomUUID(),
        revision: ++this.revision,
      };
      // Reserved only for cancellation before a receive handle owns exact-link cleanup.
      const cancelledCleanup: ScreenSelectRequest = {
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
        playbackTimeout: '',
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
      if (!recovery) {
        this.preferredWatch = shareId;
        this.updateWatching({ watching: shareId, layout: 'focus', playback: 'Connecting…' });
      } else if (!this.state.watching || this.preferredWatch === shareId) {
        this.updateWatching({ watching: shareId, playback: 'Connecting…' });
      } else this.updateWatching({});
      let retryPlaybackOnTimeout = false;
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
            this.recoverWatching(incoming, binding);
          return;
        }
        const recovery = this.watchRecoveries.get(shareId);
        if (state.phase === 'ready' && recovery && !recovery.readyAt) recovery.readyAt = Date.now();
        const playback = state.playback;
        const previousTimeout = incoming.playbackTimeout;
        if (playback?.error?.code === 'timeout') incoming.playbackTimeout = playback.error.message;
        else if (playback?.phase === 'playing' || playback?.error) incoming.playbackTimeout = '';
        const focused = this.state.watching === shareId;
        if (focused || previousTimeout !== incoming.playbackTimeout)
          this.update({
            ...(focused
              ? { playback: playback?.error?.message ?? playback?.phase ?? state.phase }
              : {}),
            playbackTimeout: this.watchPlaybackTimeout(),
          });
        if (
          playback?.phase === 'playing' ||
          playback?.phase === 'paused' ||
          (playback?.error && playback.error.code !== 'timeout')
        )
          retryPlaybackOnTimeout = false;
        const startup = playback?.phase === 'idle';
        const retry =
          retryPlaybackOnTimeout &&
          playback?.error?.code === 'timeout' &&
          !playback.pendingNative &&
          !this.state.hidden &&
          this.current(binding);
        if (state.phase === 'ready' && (startup || retry)) {
          retryPlaybackOnTimeout = false;
          this.configurePlayback();
          retryPlaybackOnTimeout = startup;
          void handle.play().catch((cause) => {
            if (cause instanceof ScreenPlaybackError && cause.code === 'timeout') return;
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
  private recoverWatching(incoming: Incoming, binding: OwnedScreenBinding) {
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
          await this.selectShare(shareId, 'add', recovery).catch((cause: unknown) => {
            if ((cause as { code?: string } | undefined)?.code !== 'throttled') throw cause;
            if (this.watchRecoveries.get(shareId) === recovery && this.current(binding))
              this.recoverWatching(incoming, binding);
          });
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
    this.preferredWatch = shareId;
    this.updateWatching({ watching: shareId, layout: 'focus' });
  };
  zoomOutWatch = () => {
    if (this.receiving.size > 0) {
      this.preferredWatch = this.state.watching ?? undefined;
      this.update({ layout: 'grid' });
    }
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
    this.preferredWatch = undefined;
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
      const epoch = this.binding?.binding.epoch;
      if (epoch && incoming.length && !this.resumeInProgress)
        this.resume = {
          shareIds: incoming.map(({ shareId }) => shareId),
          focused: this.state.watching ?? incoming[0]!.shareId,
          layout: this.state.layout,
          epoch,
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
      for (const shareId of previous.shareIds) {
        if (this.resume !== previous || this.state.hidden) return;
        if (!this.state.shares.some((item) => item.id === shareId)) continue;
        if (this.receiving.size) await this.watchMultiple(shareId);
        else await this.watch(shareId);
      }
      if (this.receiving.has(previous.focused)) {
        this.preferredWatch = previous.focused;
        this.updateWatching({ watching: previous.focused, layout: previous.layout });
      } else if (this.receiving.size) this.update({ layout: previous.layout });
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
    this.renewalPending = false;
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
