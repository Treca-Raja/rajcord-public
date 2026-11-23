import { useEffect, useMemo, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft,
  Headphones,
  ChevronDown,
  ChevronUp,
  Eye,
  LayoutGrid,
  MessageSquare,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  Settings2,
  Square,
  UsersRound,
  Volume2,
  X,
} from 'lucide-react';
import {
  SCREEN_RESOLUTIONS,
  SCREEN_FRAME_RATES,
  SCREEN_VIDEO_BITRATES,
  sameScreenQuality,
  screenQualityCeiling,
  type ScreenQuality,
  type ScreenSound,
  type ScreenShare,
  type ObsEncoder,
  type ObsEncoderChoice,
  DESKTOP_SCREEN_PROTOCOL_VERSION,
  OBS_ENCODERS,
} from '@tricord/shared';
import { useCall } from '../../shared/call';
import { useAuth } from '../account';
import type { ScreenControls } from './screen-call';
import type { VoiceChannel } from '../voice/contracts';
import { StreamTile, ParticipantTile } from './ScreenCallTiles';
import { ParticipantVolume } from '../../shared/ParticipantVolume';
import './styles.css';

const encoderLabels: Record<ObsEncoder, string> = {
  nvenc: 'NVIDIA NVENC',
  amf: 'AMD AMF',
  x264: 'Software x264',
};
const defaultScreenQuality: ScreenQuality = Object.freeze({
  profile: 'smooth',
  resolution: 1080,
  frameRate: 60,
  videoBitrate: 8000000,
});

function useScreen(controls: ScreenControls) {
  return useSyncExternalStore(controls.subscribe, controls.inspect, controls.inspect);
}
function ScreenButton({ controls, connected }: { controls: ScreenControls; connected: boolean }) {
  const state = useScreen(controls);
  const busy = ['connecting', 'preparing', 'choosing', 'publishing'].includes(state.phase);
  const label =
    state.phase === 'sharing'
      ? `Sharing · ${state.viewers} ${state.viewers === 1 ? 'viewer' : 'viewers'}`
      : 'Share Your Screen';
  return (
    <div className="screen-launcher">
      <button
        disabled={!connected || busy}
        aria-label={label}
        title={label}
        aria-expanded={state.open}
        aria-controls="screen-panel"
        onClick={() => void controls.open(state.phase !== 'sharing').catch(() => {})}
      >
        <MonitorUp size={16} />
        {label}
      </button>
      <button
        className="screen-watch-launcher"
        disabled={!connected}
        aria-label="Browse shared screens"
        title="Browse shared screens"
        onClick={() => void controls.open().catch(() => {})}
      >
        <Eye size={16} />
      </button>
      {!state.open &&
        (state.prepared ||
          ['choosing', 'preview', 'publishing', 'sharing'].includes(state.phase)) && (
          <button
            className="screen-stop"
            aria-label="Stop screen sharing"
            onClick={controls.stopSource}
          >
            <Square size={13} />
            Stop
          </button>
        )}
    </div>
  );
}
export function ScreenLauncher() {
  const call = useCall();
  return call?.screens ? (
    <ScreenButton
      controls={call.screens}
      connected={call.voice.status === 'connected' || call.voice.status === 'reconnecting'}
    />
  ) : null;
}
type CallChatProps = {
  chatName?: string;
  onChatVisibleChange?: (visible: boolean) => void;
};
type PanelProps = CallChatProps & { voiceChannels?: readonly VoiceChannel[] };
const portraitViewportQuery = '(max-width: 480px), (max-width: 750px) and (orientation: portrait)';
const compactTouchQuery = '(max-width: 750px) and (pointer: coarse)';
function subscribePortrait(callback: () => void) {
  const viewport = window.matchMedia(portraitViewportQuery);
  const touch = window.matchMedia(compactTouchQuery);
  const orientation = window.screen.orientation;
  viewport.addEventListener('change', callback);
  touch.addEventListener('change', callback);
  orientation?.addEventListener('change', callback);
  return () => {
    viewport.removeEventListener('change', callback);
    touch.removeEventListener('change', callback);
    orientation?.removeEventListener('change', callback);
  };
}
function inPortrait() {
  // A soft keyboard can make a portrait device's viewport shorter than it is wide.
  return (
    window.matchMedia(portraitViewportQuery).matches ||
    (window.matchMedia(compactTouchQuery).matches &&
      window.screen.orientation?.type.startsWith('portrait') === true)
  );
}

export function ScreenPanel({ voiceChannels = [], ...chat }: PanelProps) {
  const call = useCall();
  return call?.screens ? (
    <ConnectedScreenPanel controls={call.screens} voiceChannels={voiceChannels} {...chat} />
  ) : null;
}
function ConnectedScreenPanel({
  controls,
  voiceChannels,
  chatName,
  onChatVisibleChange,
}: CallChatProps & {
  controls: ScreenControls;
  voiceChannels: readonly VoiceChannel[];
}) {
  const call = useCall();
  const { state: auth } = useAuth();
  const state = useScreen(controls);
  const [settingsVisible, setSettingsVisible] = useState(() => !!state.setupRequested);
  const portrait = useSyncExternalStore(subscribePortrait, inPortrait);
  const [chatSelected, setChatSelected] = useState(true);
  const [participantsVisible, setParticipantsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [quality, setQuality] = useState<ScreenQuality>({
    ...defaultScreenQuality,
  });
  const [adaptiveCapture, setAdaptiveCapture] = useState(false);
  const publishQuality: ScreenQuality = adaptiveCapture
    ? { profile: quality.profile, videoBitrate: quality.videoBitrate }
    : quality;
  const [applyingQuality, setApplyingQuality] = useState(false);
  const [sound, setSound] = useState<ScreenSound>('none');
  const [encoder, setEncoder] = useState<ObsEncoderChoice>('auto');
  const desktop = window.tricordDesktop;
  const desktopScreens = desktop?.screens;
  const native = !!desktopScreens?.nativeCommand && !!desktopScreens.onNativeEvent;
  const [capabilities, setCapabilities] =
    useState<Awaited<ReturnType<NonNullable<typeof desktopScreens>['capabilities']>>>();
  const obs =
    capabilities?.version === DESKTOP_SCREEN_PROTOCOL_VERSION ? capabilities.obs : undefined;
  useEffect(() => {
    if (!desktopScreens) return;
    let active = true;
    void desktopScreens.capabilities().then(
      (capabilities) => {
        if (active) setCapabilities(capabilities);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [desktopScreens]);
  const [error, setError] = useState('');
  const currentControls = useRef(controls);
  currentControls.current = controls;
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const settingsCloseButton = useRef<HTMLButtonElement>(null);
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement | null>(null);
  const previousShareCount = useRef(state.shares.length);
  const participants = useMemo(() => call?.voice.participants ?? [], [call?.voice.participants]);
  const watchedShare = state.shares.find((item) => item.id === state.watching);
  const activeShare = watchedShare ?? state.shares.find((item) => item.id === state.ownShareId);
  const activePublisher = activeShare
    ? (participants.find((person) => person.id === activeShare.publisherId)?.name ?? 'Participant')
    : '';
  const activeChannel = voiceChannels.find((channel) => channel.id === call?.voice.channelId);
  const localVideo = ['preview', 'publishing', 'sharing'].includes(state.phase);
  const [endedStream, setEndedStream] = useState<string | null>(null);
  const lastWatched = useRef<{ id: string; name: string } | null>(null);
  const gallery = !endedStream && (state.layout === 'grid' || (!state.watching && !localVideo));
  const canShowDiscussion = state.open && portrait && !gallery && !fullscreen && !!chatName;
  const chatVisible = canShowDiscussion && chatSelected;
  const chatInteractive = chatVisible && !settingsVisible;
  const showParticipantStrip =
    !gallery && !chatVisible && (participantsVisible || canShowDiscussion);
  useLayoutEffect(() => {
    onChatVisibleChange?.(chatInteractive);
    return () => onChatVisibleChange?.(false);
  }, [chatInteractive, onChatVisibleChange]);

  const availableShares = state.shares.filter(
    (item) => !state.watchingShareIds.includes(item.id) && item.id !== state.ownShareId,
  );
  const [participantMenu, setParticipantMenu] = useState<{
    id: string;
    anchor: HTMLElement;
  } | null>(null);
  const menuParticipant = participants.find((person) => person.id === participantMenu?.id);
  useEffect(() => {
    setParticipantMenu(null);
  }, [controls, call?.voice.channelId, state.open]);
  useEffect(() => {
    if (!menuParticipant || !participantMenu?.anchor.isConnected) setParticipantMenu(null);
  }, [menuParticipant, participantMenu]);
  const media = useRef<HTMLDivElement>(null);
  const [tileWidth, setTileWidth] = useState(240);
  const galleryCount =
    state.watchingShareIds.length +
    availableShares.length +
    participants.length +
    (localVideo ? 1 : 0);

  const channelId = call?.voice.channelId;
  useLayoutEffect(() => {
    lastWatched.current = null;
    setEndedStream(null);
  }, [controls, channelId, state.open, state.hidden]);
  useEffect(() => {
    if (!state.open || state.hidden) return;
    if (state.watching) {
      if (watchedShare) lastWatched.current = { id: watchedShare.id, name: activePublisher };
      setEndedStream(null);
      return;
    }
    // A closed link can arrive before the directory removes its share.
    const previous = lastWatched.current;
    if (state.selectingShareId) lastWatched.current = null;
    else if (previous && !state.shares.some((item) => item.id === previous.id)) {
      lastWatched.current = null;
      setEndedStream(previous.name);
    }
  }, [
    controls,
    channelId,
    state.open,
    state.hidden,
    state.watching,
    state.selectingShareId,
    state.shares,
    watchedShare,
    activePublisher,
  ]);
  useLayoutEffect(() => {
    const host = media.current;
    if (!state.open || !gallery || !host) return;
    const resize = () => {
      const width = host.clientWidth,
        height = host.clientHeight;
      let best = 0;
      for (let columns = 1; columns <= Math.max(1, galleryCount); columns++) {
        const rows = Math.ceil(galleryCount / columns);
        const candidate = Math.min(
          (width - (columns - 1) * 8) / columns,
          (((height - (rows - 1) * 8) / rows) * 16) / 9,
        );
        best = Math.max(best, candidate);
      }
      setTileWidth(Math.max(Math.min(200, width), Math.floor(best)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [state.open, gallery, galleryCount]);

  useEffect(() => setError(''), [controls]);
  useEffect(() => {
    setSettingsVisible(state.open && !!state.setupRequested);
  }, [state.open, state.setupRequested]);
  useEffect(() => {
    const syncFullscreen = () =>
      setFullscreen(!!panel.current && document.fullscreenElement === panel.current);
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, [state.open]);
  useEffect(() => {
    const hadShares = previousShareCount.current > 0;
    previousShareCount.current = state.shares.length;
    if (!hadShares && state.shares.length > 0 && !state.prepared && !state.watching)
      setSettingsVisible(false);
  }, [state.prepared, state.shares.length, state.watching]);
  useLayoutEffect(() => {
    const element = panel.current;
    const parent = element?.parentElement;
    if (!state.open || !element || !parent) return;
    const original = new Map<HTMLElement, boolean>();
    const syncSiblings = () => {
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement) || child === element) continue;
        if (!original.has(child)) original.set(child, child.inert);
        child.inert = !(chatInteractive && child.classList.contains('chat-workspace'));
      }
    };
    syncSiblings();
    const observer = new MutationObserver(syncSiblings);
    observer.observe(parent, { childList: true });
    return () => {
      observer.disconnect();
      for (const [child, inert] of original) child.inert = inert;
    };
  }, [state.open, chatInteractive]);
  useEffect(() => {
    if (!state.open) return;
    const priorFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    return () => priorFocus?.focus({ preventScroll: true });
  }, [state.open]);
  useEffect(() => {
    if (!state.open) {
      settingsTrigger.current = null;
    } else if (settingsVisible) {
      settingsTrigger.current ??= settingsToggle.current;
      settingsCloseButton.current?.focus({ preventScroll: true });
    } else if (settingsTrigger.current) {
      const trigger = settingsTrigger.current;
      settingsTrigger.current = null;
      (trigger.isConnected && !trigger.disabled ? trigger : settingsToggle.current)?.focus({
        preventScroll: true,
      });
    }
  }, [state.open, settingsVisible]);

  useLayoutEffect(() => {
    const host = media.current;
    const surface = panel.current?.parentElement;
    if (!host || !surface || !state.open || gallery) return;
    const fitSource = () => {
      const video = host.querySelector<HTMLVideoElement>(
        state.watching ? '.screen-incoming-tile[data-focused="true"] video' : '.screen-preview',
      );
      if (video?.videoWidth && video.videoHeight)
        surface.style.setProperty(
          '--screen-stage-ratio',
          String(video.videoWidth / video.videoHeight),
        );
    };
    fitSource();
    host.addEventListener('loadedmetadata', fitSource, true);
    host.addEventListener('resize', fitSource, true);
    return () => {
      host.removeEventListener('loadedmetadata', fitSource, true);
      host.removeEventListener('resize', fitSource, true);
      surface.style.removeProperty('--screen-stage-ratio');
    };
  }, [gallery, state.open, state.watching]);

  const preview = useRef<HTMLVideoElement>(null);
  const incoming = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.open && preview.current) return controls.preview(preview.current);
  }, [controls, state.open]);
  useEffect(() => {
    if (state.open && incoming.current) return controls.incoming(incoming.current);
  }, [controls, state.open]);
  useEffect(() => {
    const host = incoming.current;
    if (!state.open || !host) return;
    const labelTiles = () => {
      for (const tile of host.querySelectorAll<HTMLElement>('[data-screen-share-id]')) {
        const share = state.shares.find((item) => item.id === tile.dataset.screenShareId);
        const publisher = participants.find((person) => person.id === share?.publisherId);
        const caption = publisher ? `${publisher.name}’s screen` : 'Shared screen';
        const label = tile.querySelector('.screen-incoming-label');
        if (label) label.textContent = caption;
        tile.setAttribute('aria-label', caption + '. Activate to change the viewing layout.');
      }
    };
    // A media track can arrive after its share and participant metadata.
    const observer = new MutationObserver(labelTiles);
    observer.observe(host, { childList: true });
    labelTiles();
    return () => observer.disconnect();
  }, [state.open, participants, state.shares]);
  useEffect(() => {
    const host = incoming.current;
    if (!state.open || !host) return;
    const activate = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const tile = target.closest<HTMLElement>('[data-screen-share-id]');
      const shareId = tile?.dataset.screenShareId;
      if (!shareId) return;
      if (state.layout === 'focus') controls.zoomOutWatch();
      else controls.focusWatch(shareId);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-screen-share-id]'))
        return;
      event.preventDefault();
      activate(event);
    };
    host.addEventListener('click', activate);
    host.addEventListener('keydown', keydown);
    return () => {
      host.removeEventListener('click', activate);
      host.removeEventListener('keydown', keydown);
    };
  }, [controls, state.layout, state.open]);
  const run = (work: () => Promise<unknown>) => {
    setError('');
    const failed = (cause: unknown) => {
      if (currentControls.current === controls)
        setError(cause instanceof Error ? cause.message : 'Screen action failed.');
    };
    try {
      void work().catch(failed);
    } catch (cause) {
      failed(cause);
    }
  };
  const addToMulti = async (item: Readonly<ScreenShare>) => {
    await controls.watchMultiple(item.id);
    controls.zoomOutWatch();
  };
  const toggleFullscreen = () => {
    const element = panel.current;
    if (!element) return;
    run(() =>
      document.fullscreenElement === element
        ? document.exitFullscreen()
        : element.requestFullscreen(),
    );
  };
  function openSettings(trigger: HTMLButtonElement) {
    if (settingsVisible) return;
    const own = state.shares.find((item) => item.id === state.ownShareId);
    if (own) {
      setQuality({
        profile: own.profile,
        videoBitrate: own.videoBitrate,
        resolution: own.resolution ?? quality.resolution,
        frameRate: own.frameRate ?? quality.frameRate,
      });
      setAdaptiveCapture(own.resolution === undefined);
    }
    settingsTrigger.current = trigger;
    setSettingsVisible(true);
  }
  function stopWatchingShare(shareId: string) {
    if (lastWatched.current?.id === shareId) lastWatched.current = null;
    controls.stopWatchingShare(shareId);
  }
  const renderStream = (item: Readonly<ScreenShare>) => {
    const watched = state.watchingShareIds.includes(item.id);
    const publisher =
      participants.find((person) => person.id === item.publisherId)?.name ?? 'Participant';
    return (
      <StreamTile
        key={item.id}
        share={item}
        publisher={publisher}
        videoSource={
          item.id === state.ownShareId
            ? preview.current
            : [...(incoming.current?.querySelectorAll<HTMLElement>('[data-screen-share-id]') ?? [])]
                .find((tile) => tile.dataset.screenShareId === item.id)
                ?.querySelector('video')
        }
        own={item.id === state.ownShareId}
        watching={watched}
        focused={state.watching === item.id}
        connecting={state.selectingShareId === item.id}
        busy={!!state.selectingShareId}
        watch={() => {
          setSettingsVisible(false);
          if (watched) controls.focusWatch(item.id);
          else run(() => controls.watch(item.id));
        }}
        multiple={() => {
          setSettingsVisible(false);
          if (watched) stopWatchingShare(item.id);
          else run(() => addToMulti(item));
        }}
      />
    );
  };
  const renderParticipant = (person: (typeof participants)[number]) => (
    <ParticipantTile
      key={person.id}
      person={person}
      own={person.id === auth.user.id}
      expanded={participantMenu?.id === person.id}
      open={(anchor) => setParticipantMenu({ id: person.id, anchor })}
    />
  );
  if (!state.open) return null;

  const busy = ['connecting', 'preparing', 'choosing', 'publishing'].includes(state.phase);
  const live = !!state.watching || state.phase === 'sharing';
  const publishingShare = state.shares.find((item) => item.id === state.ownShareId);
  const phases = {
    idle: 'Join voice to share or watch',
    connecting: 'Connecting…',
    ready: 'Ready',
    preparing: 'Preparing…',
    choosing: 'Choosing a source…',
    preview: 'Preview',
    publishing: 'Starting…',
    sharing: `Sharing · ${state.viewers} ${state.viewers === 1 ? 'viewer' : 'viewers'}`,
  };

  return (
    <section
      ref={panel}
      id="screen-panel"
      className="screen-panel"
      role="region"
      aria-label="Screen sharing call"
      data-layout={gallery ? 'grid' : 'focus'}
      data-portrait={portrait}
      data-members={participantsVisible || canShowDiscussion}
      data-discussion={chatVisible}
      data-phase={state.phase}
      data-prepared={state.prepared}
    >
      <header className="screen-call-header">
        <div className="screen-call-context">
          <span className="screen-call-context-icon" aria-hidden="true">
            <Volume2 size={18} />
          </span>
          <div>
            <strong>{activeChannel?.name ?? 'Voice channel'}</strong>
            <span className="screen-status" role="status">
              {state.watching && state.phase !== 'sharing'
                ? `Watching ${activePublisher}`
                : phases[state.phase]}
              {state.phase === 'sharing' &&
                state.obsEncoder &&
                ' · ' + encoderLabels[state.obsEncoder]}
              <span className="screen-people-count">
                {' '}
                · {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
              </span>
            </span>
          </div>
        </div>
        <span className="grow" />
        <div className="screen-call-indicators">
          {activeShare && (
            <span className="screen-quality-badge">
              {activeShare.resolution
                ? `${activeShare.resolution}p ${activeShare.frameRate} FPS`
                : 'Adaptive'}
            </span>
          )}
          <span className={live ? 'screen-live-badge is-live' : 'screen-live-badge'}>
            <span aria-hidden="true" />
            {live ? 'LIVE' : 'SCREEN SHARE'}
          </span>
        </div>
        {(state.prepared || state.phase === 'sharing') && (
          <button
            className="screen-stop"
            aria-label={state.phase === 'sharing' ? 'Stop screen sharing' : 'Cancel screen setup'}
            title={state.phase === 'sharing' ? 'Stop sharing' : 'Cancel screen setup'}
            onClick={controls.stopSource}
          >
            <Square size={13} />
            {state.phase === 'sharing' ? 'Stop sharing' : 'Cancel'}
          </button>
        )}
        {state.watchingShareIds.length > 0 && (
          <button
            className="screen-stop"
            onClick={() => {
              lastWatched.current = null;
              controls.stopWatching();
            }}
            title="Stop watching"
          >
            <Square size={13} /> Stop watching
          </button>
        )}
        <button
          ref={closeButton}
          className="screen-close"
          aria-label={state.watching ? 'Stop & return to channel' : 'Back to channel'}
          aria-description={
            state.watching
              ? 'Stops playback and returns to your channel. Voice and any screen you are sharing stay connected.'
              : state.phase === 'sharing'
                ? 'Your screen share and voice call stay connected.'
                : undefined
          }
          title={
            state.watching
              ? 'Stop watching and return to channel'
              : state.phase === 'sharing'
                ? 'Back to channel · keep sharing'
                : 'Back to channel'
          }
          data-watching={!!state.watching}
          onClick={controls.close}
        >
          <ArrowLeft size={18} aria-hidden="true" />{' '}
          <span>{state.watching ? 'Stop & return' : 'Back to channel'}</span>
        </button>
      </header>
      <div className="screen-call-body">
        <div
          ref={media}
          className="screen-media"
          data-layout={gallery ? 'grid' : 'focus'}
          style={{ '--screen-tile-width': tileWidth + 'px' } as React.CSSProperties}
          data-has-incoming={state.watchingShareIds.length > 0}
        >
          {!endedStream &&
            !participants.length &&
            !state.shares.length &&
            !state.watchingShareIds.length &&
            !localVideo && (
              <div className="screen-stage-empty" role="status">
                <span className="screen-stage-empty-icon" aria-hidden="true">
                  <MonitorUp size={25} />
                </span>
                <strong>
                  {state.phase === 'choosing'
                    ? 'Choose a screen to share'
                    : state.phase === 'idle'
                      ? 'Join voice to share your screen'
                      : 'Your preview will appear here'}
                </strong>
                <span>
                  {state.phase === 'ready'
                    ? 'Set your quality, then choose a screen to preview it.'
                    : state.phase === 'idle'
                      ? 'Join a voice channel to share or watch a stream.'
                      : 'Set up sharing and choose a source to see it here.'}
                </span>
              </div>
            )}
          <div className="screen-local-tile" hidden={!localVideo || !!endedStream}>
            <video
              ref={preview}
              className="screen-preview"
              aria-label="Local screen preview"
              muted
              playsInline
            />
            {(gallery || !!state.watching) && (
              <span className="screen-incoming-label">Your screen</span>
            )}
          </div>
          <div ref={incoming} className="screen-incoming" hidden={!!endedStream} />
          {gallery && (
            <div className="screen-gallery-extras">
              {availableShares.map(renderStream)}
              {participants.map(renderParticipant)}
            </div>
          )}
          {endedStream && (
            <div className="screen-stage-ended" role="status">
              <MonitorUp size={40} aria-hidden="true" />
              <strong>This stream has ended.</strong>
              <span>{endedStream}'s screen is no longer available.</span>
              <button onClick={() => setEndedStream(null)}>Close Stream</button>
            </div>
          )}
          {!!state.watchingShareIds.length && (
            <button
              className="screen-layout-toggle"
              aria-label={state.layout === 'focus' ? 'Show all streams' : 'Focus shared screen'}
              title={state.layout === 'focus' ? 'Show all streams' : 'Focus shared screen'}
              onClick={() =>
                state.layout === 'focus'
                  ? controls.zoomOutWatch()
                  : state.watching && controls.focusWatch(state.watching)
              }
            >
              {state.layout === 'focus' ? <LayoutGrid size={17} /> : <Maximize2 size={17} />}
            </button>
          )}
          {localVideo && !gallery && !state.watching && (
            <span className="screen-incoming-label">Your screen</span>
          )}
        </div>
      </div>
      <aside
        id="screen-settings"
        className="screen-settings"
        aria-label="Screen share settings"
        hidden={!settingsVisible}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing)
            return;
          event.preventDefault();
          event.stopPropagation();
          setSettingsVisible(false);
        }}
      >
        <div className="screen-settings-header">
          <span className="screen-header-icon" aria-hidden="true">
            <Settings2 size={17} />
          </span>
          <div>
            <strong>{state.prepared ? 'Stream settings' : 'Set up your stream'}</strong>
            <span>Quality, sound and viewers</span>
          </div>
          <button
            ref={settingsCloseButton}
            className="screen-settings-close"
            aria-label="Close screen settings"
            title="Close screen settings"
            onClick={() => setSettingsVisible(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="screen-settings-content">
          <div className="screen-options">
            <fieldset
              disabled={
                busy ||
                applyingQuality ||
                (state.prepared && state.phase !== 'preview' && state.phase !== 'sharing')
              }
            >
              <legend>Your screen</legend>
              {native && (
                <label>
                  Encoder
                  <select
                    aria-label="Screen encoder"
                    value={encoder}
                    disabled={state.prepared}
                    onChange={(event) => setEncoder(event.target.value as ObsEncoderChoice)}
                  >
                    <option value="auto">Automatic (Recommended)</option>
                    {OBS_ENCODERS.map((option) => (
                      <option
                        key={option}
                        value={option}
                        disabled={!obs?.encoders.includes(option)}
                      >
                        {encoderLabels[option]}
                      </option>
                    ))}
                  </select>
                  {obs?.reason && <span className="screen-help">{obs.reason}</span>}
                </label>
              )}
              {!native && (
                <label className="screen-capture-mode">
                  Capture mode
                  <select
                    aria-label="Screen capture mode"
                    disabled={state.prepared}
                    value={adaptiveCapture ? 'adaptive' : 'fixed'}
                    onChange={(event) => setAdaptiveCapture(event.target.value === 'adaptive')}
                  >
                    <option value="fixed">Fixed</option>
                    <option value="adaptive">Adaptive</option>
                  </select>
                </label>
              )}
              <div className="screen-quality">
                {!adaptiveCapture && (
                  <>
                    <label>
                      Resolution
                      <select
                        aria-label="Screen resolution"
                        value={quality.resolution}
                        onChange={(event) =>
                          setQuality({
                            ...quality,
                            resolution: Number(event.target.value) as ScreenQuality['resolution'],
                          })
                        }
                      >
                        {SCREEN_RESOLUTIONS.map((value) => (
                          <option key={value} value={value}>
                            {value}p
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Frame rate
                      <select
                        aria-label="Screen frame rate"
                        value={quality.frameRate}
                        onChange={(event) =>
                          setQuality({
                            ...quality,
                            frameRate: Number(event.target.value) as ScreenQuality['frameRate'],
                          })
                        }
                      >
                        {SCREEN_FRAME_RATES.map((value) => (
                          <option key={value} value={value}>
                            {value} fps
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label>
                  Video bitrate per viewer
                  <select
                    aria-label="Screen video bitrate"
                    value={quality.videoBitrate ?? 8000000}
                    onChange={(event) =>
                      setQuality({
                        ...quality,
                        videoBitrate: Number(event.target.value) as ScreenQuality['videoBitrate'],
                      })
                    }
                  >
                    {SCREEN_VIDEO_BITRATES.map((value) => (
                      <option key={value} value={value}>
                        {value / 1000000} Mb/s
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Source sound
                <select
                  aria-label="Screen source sound"
                  disabled={state.prepared}
                  value={sound}
                  onChange={(event) => setSound(event.target.value as ScreenSound)}
                >
                  <option value="none">Video only</option>
                  {desktop ? (
                    <option value="source" disabled={capabilities?.sourceSound === false}>
                      {native
                        ? 'Application audio or system audio excluding Rajcord'
                        : 'Application audio or system audio'}
                    </option>
                  ) : (
                    <option value="tab">Selected browser tab sound</option>
                  )}
                </select>
              </label>
            </fieldset>
            {sound === 'tab' && (
              <p className="screen-help">
                Choose a browser tab and enable its audio in the browser picker.
              </p>
            )}
            {!state.prepared && (
              <button
                className="screen-action-primary"
                disabled={busy}
                onClick={() => {
                  setSettingsVisible(true);
                  run(() =>
                    controls.prepare({
                      ...publishQuality,
                      sound,
                      ...(native ? { encoder } : {}),
                    }),
                  );
                }}
              >
                Prepare source
              </button>
            )}
            {state.prepared && state.phase === 'ready' && (
              <button
                className="screen-action-primary"
                onClick={() => {
                  setSettingsVisible(true);
                  run(controls.choose);
                }}
              >
                Choose source
              </button>
            )}
            {state.phase === 'preview' && (
              <button
                className="screen-action-primary"
                onClick={() => {
                  setSettingsVisible(false);
                  run(() => controls.publish(publishQuality));
                }}
              >
                Start sharing
              </button>
            )}
            {state.phase === 'sharing' && (
              <button
                className="screen-action-primary"
                disabled={
                  applyingQuality ||
                  !publishingShare ||
                  sameScreenQuality(publishQuality, publishingShare)
                }
                onClick={() =>
                  run(async () => {
                    setApplyingQuality(true);
                    try {
                      await controls.updateQuality(publishQuality);
                    } finally {
                      setApplyingQuality(false);
                    }
                  })
                }
              >
                {applyingQuality ? 'Applying quality…' : 'Apply stream quality'}
              </button>
            )}
            {busy && (
              <p role="status">
                {state.phase === 'choosing' ? 'Choose a source in the picker…' : 'Preparing…'}
              </p>
            )}
            <p className="screen-help">
              {adaptiveCapture
                ? 'The browser can adjust resolution and frame rate up to 1080p and 60 fps.'
                : 'Capture uses the selected resolution and frame rate.'}{' '}
              Viewers automatically adapt to their connection up to your selected quality.
            </p>
          </div>
          <div className="screen-settings-divider" />
          <div className="screen-watch">
            <div className="screen-watch-heading">
              <strong>Available screens</strong>
              <span>Choose a stream to watch</span>
            </div>
            <div className="screen-share-list" role="group" aria-label="Available screen shares">
              {state.shares.length === 0 && <p>No one is sharing yet.</p>}
              {state.shares.map((item) => {
                const ownShare = item.id === state.ownShareId;
                const publisher =
                  participants.find((person) => person.id === item.publisherId)?.name ??
                  'Participant';
                const watched = state.watchingShareIds.includes(item.id);
                const ceiling = screenQualityCeiling(item);
                return (
                  <div key={item.id} className="screen-share-item">
                    <MonitorUp size={16} aria-hidden="true" />
                    <span className="screen-share-details">
                      <strong>{ownShare ? 'Your screen' : publisher}</strong>
                      <small>
                        {ceiling.height}p · {ceiling.frameRate} fps ·{' '}
                        {item.sound === 'none' ? 'Video' : 'With sound'}
                      </small>
                    </span>
                    <button
                      className="screen-share-action"
                      disabled={ownShare || !!state.selectingShareId}
                      aria-pressed={state.watching === item.id}
                      onClick={() => {
                        setSettingsVisible(false);
                        if (watched) controls.focusWatch(item.id);
                        else run(() => controls.watch(item.id));
                      }}
                    >
                      {state.selectingShareId === item.id
                        ? 'Connecting…'
                        : state.watching === item.id
                          ? 'Watching'
                          : 'Watch Stream'}
                    </button>
                    {!ownShare && (
                      <button
                        className="screen-share-multi"
                        aria-label={
                          watched
                            ? `Remove ${publisher} from multi-view`
                            : `Watch ${publisher} with multiple streams`
                        }
                        aria-pressed={watched}
                        title={watched ? 'Remove from multi-view' : 'Watch multiple streams'}
                        disabled={!!state.selectingShareId}
                        onClick={() => {
                          setSettingsVisible(false);
                          if (watched) stopWatchingShare(item.id);
                          else run(() => addToMulti(item));
                        }}
                      >
                        <LayoutGrid size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="screen-watch-controls">
              <label className="screen-mute-control">
                <input
                  type="checkbox"
                  checked={state.playbackMuted}
                  onChange={(event) => controls.mute(event.target.checked)}
                />
                Mute stream audio
              </label>
              <label className="screen-volume-control">
                Stream volume
                <input
                  aria-label="Screen volume"
                  type="range"
                  min="0"
                  max="1"
                  step=".05"
                  value={state.playbackVolume}
                  onChange={(event) => controls.volume(Number(event.target.value))}
                />
              </label>
              {state.watchingShareIds.length > 0 && (
                <>
                  <p role="status">{state.playback}</p>
                  <button onClick={() => run(controls.play)}>Enable playback</button>
                </>
              )}
              {state.hidden && <p>Incoming screen delivery is paused while Rajcord is hidden.</p>}
            </div>
          </div>
        </div>
      </aside>
      <footer className="screen-call-footer">
        <button
          hidden={gallery || canShowDiscussion}
          className="screen-members-toggle"
          aria-label={participantsVisible ? 'Hide members' : 'Show members'}
          aria-expanded={participantsVisible}
          aria-controls="screen-participants"
          title={participantsVisible ? 'Hide Members' : 'Show Members'}
          onClick={() => setParticipantsVisible((visible) => !visible)}
        >
          {participantsVisible ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          <UsersRound size={17} />
          <span>In this call · {participants.length}</span>
        </button>
        {canShowDiscussion && (
          <div className="screen-mobile-views" role="group" aria-label="In-call view">
            <button
              type="button"
              aria-label="People in this call"
              aria-pressed={!chatVisible}
              onClick={() => setChatSelected(false)}
            >
              <UsersRound size={16} /> People · {participants.length}
            </button>
            <button
              type="button"
              aria-label="Chat in this call"
              aria-pressed={chatVisible}
              onClick={() => setChatSelected(true)}
            >
              <MessageSquare size={16} /> <span>Chat · {chatName}</span>
            </button>
          </div>
        )}
        <div
          id="screen-participants"
          className="screen-participant-strip"
          role="group"
          aria-label="Call participants"
          hidden={!showParticipantStrip}
        >
          {showParticipantStrip && (
            <div className="screen-participant-tiles">
              {state.shares
                .filter(
                  (share) =>
                    !portrait || (share.id !== activeShare?.id && share.id !== state.ownShareId),
                )
                .map(renderStream)}
              {participants.map(renderParticipant)}
              {participants.length === 0 && state.shares.length === 0 && (
                <p className="screen-participant-empty">Waiting for people to join the call.</p>
              )}
            </div>
          )}
        </div>
        <div className="screen-call-toolbar">
          <div className="screen-call-control-group">
            {call && (
              <>
                <button
                  className={call.voice.muted ? 'is-muted' : ''}
                  aria-label={call.voice.muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-pressed={call.voice.muted}
                  title={call.voice.muted ? 'Unmute microphone' : 'Mute microphone'}
                  onClick={() => run(() => call.controls.mute())}
                >
                  {call.voice.muted ? <MicOff size={19} /> : <Mic size={19} />}
                </button>
                <button
                  className={call.voice.deafened ? 'is-muted' : ''}
                  aria-label={call.voice.deafened ? 'Enable audio' : 'Deafen'}
                  aria-pressed={call.voice.deafened}
                  title={call.voice.deafened ? 'Enable audio' : 'Deafen'}
                  onClick={() => run(() => call.controls.deafen())}
                >
                  <Headphones size={19} />
                </button>
              </>
            )}
            <span className="screen-toolbar-divider" />
            {state.phase !== 'sharing' && (
              <button
                aria-label="Share Your Screen"
                title="Share Your Screen"
                disabled={busy}
                onClick={(event) => openSettings(event.currentTarget)}
              >
                <MonitorUp size={19} />
              </button>
            )}
            <button
              ref={settingsToggle}
              className={settingsVisible ? 'is-active' : ''}
              aria-label={settingsVisible ? 'Close stream settings' : 'Open stream settings'}
              aria-pressed={settingsVisible}
              aria-expanded={settingsVisible}
              aria-controls="screen-settings"
              title={settingsVisible ? 'Close stream settings' : 'Open stream settings'}
              onClick={(event) => {
                if (settingsVisible) setSettingsVisible(false);
                else openSettings(event.currentTarget);
              }}
            >
              <Settings2 size={19} />
            </button>
          </div>
          <div className="screen-call-toolbar-status">
            <span className={call?.voice.status === 'connected' ? 'is-connected' : ''} />
            {call?.voice.status === 'connected'
              ? 'Voice connected'
              : call?.voice.status === 'reconnecting'
                ? 'Reconnecting…'
                : call?.voice.status === 'joining'
                  ? 'Joining…'
                  : 'Voice disconnected'}
          </div>
          <button
            className="screen-leave-control"
            aria-label="Leave voice"
            title="Leave voice"
            onClick={() => {
              if (call) run(() => call.controls.leave());
            }}
          >
            <PhoneOff size={17} /> Leave voice
          </button>
          <button
            className="screen-fullscreen-control"
            aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
            title={fullscreen ? 'Exit Full Screen' : 'Full Screen'}
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
          </button>
        </div>
      </footer>
      {participantMenu && menuParticipant && (
        <ParticipantVolume
          key={menuParticipant.id}
          anchor={participantMenu.anchor}
          participant={menuParticipant}
          close={() => setParticipantMenu(null)}
          volume={(value) => call?.controls.volume(menuParticipant.id, value)}
        />
      )}
      {(error || state.error || state.playbackTimeout) && (
        <p className="screen-error" role="alert">
          {error || state.error || state.playbackTimeout}
        </p>
      )}
    </section>
  );
}
