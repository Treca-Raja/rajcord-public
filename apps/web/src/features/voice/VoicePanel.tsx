import { runInBackground } from '../../shared/background';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Mic, MicOff, Headphones, PhoneOff, Volume2, Plus, Settings } from 'lucide-react';
import { useAuth } from '../account';
import { useCall, type VoiceControls } from '../../shared/call';
import { concreteDevices, type VoiceChannel } from './voice-controller';
import { defaultProcessing, rawProcessing, processingKeys } from './voice-processing';
import './styles.css';
export type VoiceSessionDock = {
  status: 'connected' | 'joining' | 'reconnecting';
  channelName: string;
  muted: boolean;
  deafened: boolean;
  toggleMute: () => void;
  toggleDeafen: () => void;
  leave: () => void;
};

import { NavigationSectionHeader } from '../../shared/NavigationSection';
import { ScreenLauncher } from '../screen-sharing';
import { ParticipantVolume } from '../../shared/ParticipantVolume';
import { createPortal } from 'react-dom';
export function VoicePanel({
  showDirectory = true,
  directoryTools,
  onChannels,
  onSession,
  requestedChannel,
}: {
  showDirectory?: boolean;
  directoryTools?: ReactNode;
  onChannels?: (channels: VoiceChannel[]) => void;
  onSession?: (session: VoiceSessionDock | null) => void;
  requestedChannel?: { id: string; version: number } | null;
}) {
  const { request, state: auth, openSettings, voiceSettingsHost } = useAuth();
  const ref = useRef(request);
  ref.current = request;
  const notifyChannels = useRef(onChannels);
  notifyChannels.current = onChannels;
  const loaded = useRef(false),
    handledReference = useRef(0);
  const call = useCall();
  const controlsRef = useRef(call?.controls);
  controlsRef.current = call?.controls;
  const voice = call?.voice;
  const [expanded, setExpanded] = useState(true);
  const [channels, setChannels] = useState<VoiceChannel[]>([]),
    [error, setError] = useState(''),
    [channelError, setChannelError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const reload = async () => {
      try {
        const data = await ref.current<{ channels: VoiceChannel[] }>('/voice/channels');
        if (live) {
          loaded.current = true;
          setChannels(data.channels);
          setChannelError('');
          notifyChannels.current?.(data.channels);
        }
      } catch (error) {
        if (live) setChannelError((error as Error).message);
      }
    };
    runInBackground(reload());
    const timer = setInterval(() => runInBackground(reload()), 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (
      !requestedChannel ||
      !loaded.current ||
      handledReference.current === requestedChannel.version
    )
      return;
    handledReference.current = requestedChannel.version;
    if (!channels.some((channel) => channel.id === requestedChannel.id)) {
      setError('That voice channel is no longer available.');
      return;
    }
    setExpanded(true);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(
        '.voice-panel [data-voice-channel-id="' + requestedChannel.id + '"]',
      );
      target?.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      target?.focus({ preventScroll: true });
    });
  }, [requestedChannel, channels]);
  const action = useCallback(async (work: (controller: VoiceControls) => Promise<unknown>) => {
    const controller = controlsRef.current;
    if (!controller) return;
    setBusy(true);
    setError('');
    try {
      await work(controller);
    } catch (error) {
      if (controlsRef.current === controller) setError((error as Error).message);
    } finally {
      if (controlsRef.current === controller) setBusy(false);
    }
  }, []);
  const toggleMute = useCallback(() => {
    runInBackground(action((controller) => controller.mute()));
  }, [action]);
  const toggleDeafen = useCallback(() => {
    runInBackground(action((controller) => controller.deafen()));
  }, [action]);
  const leave = useCallback(() => {
    runInBackground(action((controller) => controller.leave()));
  }, [action]);
  const notifySession = useRef(onSession);
  notifySession.current = onSession;
  const voiceStatus = voice?.status;
  const voiceChannelId = voice?.channelId;
  const muted = voice?.muted;
  const deafened = voice?.deafened;
  const channelName =
    channels.find((channel) => channel.id === voiceChannelId)?.name ?? 'Voice channel';
  const session = useMemo<VoiceSessionDock | null>(() => {
    if (!voiceStatus || voiceStatus === 'idle') return null;
    return {
      status:
        voiceStatus === 'connected'
          ? 'connected'
          : voiceStatus === 'joining'
            ? 'joining'
            : 'reconnecting',
      channelName,
      muted: muted ?? true,
      deafened: deafened ?? false,
      toggleMute,
      toggleDeafen,
      leave,
    };
  }, [voiceStatus, channelName, muted, deafened, toggleMute, toggleDeafen, leave]);
  useEffect(() => {
    notifySession.current?.(session);
  }, [session]);
  useEffect(() => () => notifySession.current?.(null), []);
  useEffect(() => {
    setBusy(false);
    setError('');
  }, [call?.controls]);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [participantAnchor, setParticipantAnchor] = useState<HTMLElement | null>(null);
  const participant = voice?.participants.find((person) => person.id === participantId);
  useLayoutEffect(() => {
    setParticipantId(null);
    setParticipantAnchor(null);
  }, [call?.controls, voice?.channelId]);
  useLayoutEffect(() => {
    if (!participant || !participantAnchor?.isConnected) {
      setParticipantId(null);
      setParticipantAnchor(null);
    }
  }, [participant, participantAnchor]);
  if (!showDirectory)
    return voiceSettingsHost ? createPortal(<VoiceSettings />, voiceSettingsHost) : null;
  return (
    <section className="voice-panel">
      <NavigationSectionHeader
        label="Voice"
        controls="navigation-voice"
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      >
        <button
          aria-label="Create voice channel"
          onClick={() =>
            runInBackground(
              action(async () => {
                const name = window.prompt('Voice channel name');
                if (!name) return;
                await ref.current('/voice/channels', 'POST', { name });
                const data = await ref.current<{ channels: VoiceChannel[] }>('/voice/channels');
                setChannels(data.channels);
                notifyChannels.current?.(data.channels);
              }),
            )
          }
        >
          <Plus size={15} />
        </button>
      </NavigationSectionHeader>
      <div id="navigation-voice" hidden={!expanded}>
        <div className="channels">
          {channels.map((channel) => (
            <div key={channel.id}>
              <button
                data-voice-channel-id={channel.id}
                className={voice?.channelId === channel.id ? 'selected' : ''}
                disabled={busy || !voice}
                onClick={() =>
                  runInBackground(
                    action(async (controller) => {
                      await controller.joinChannel(channel.id);
                      if (controlsRef.current === controller) await call?.screens?.open();
                    }),
                  )
                }
              >
                <Volume2 size={17} />
                <span className="truncate">{channel.name}</span>
                <small>
                  {voice?.channelId === channel.id && busy
                    ? 'Joining…'
                    : channel.participants.length || ''}
                </small>
              </button>
              <ul className="voice-members">
                {(voice?.channelId === channel.id ? voice.participants : channel.participants).map(
                  (person) => {
                    const active = voice?.participants.find((item) => item.id === person.id);
                    const adjustable = !!active && person.id !== auth.user.id;
                    return (
                      <li key={person.id} data-speaking={active?.speaking}>
                        <button
                          className="voice-member"
                          disabled={!adjustable}
                          aria-haspopup={adjustable ? 'dialog' : undefined}
                          aria-expanded={adjustable ? participantId === person.id : undefined}
                          onClick={(event) => {
                            setParticipantAnchor(event.currentTarget);
                            setParticipantId(person.id);
                          }}
                          onContextMenu={(event) => {
                            if (!adjustable) return;
                            event.preventDefault();
                            setParticipantAnchor(event.currentTarget);
                            setParticipantId(person.id);
                          }}
                        >
                          <span className="voice-member-avatar" aria-hidden="true">
                            {person.name.slice(0, 1)}
                          </span>
                          <span className="truncate">
                            {person.name}
                            {person.id === auth.user.id ? ' (you)' : ''}
                          </span>
                          {active?.muted && <MicOff size={14} aria-label="Muted" />}
                        </button>
                      </li>
                    );
                  },
                )}
              </ul>
            </div>
          ))}
        </div>
        {directoryTools}
      </div>
      {!onSession && voice && voice.status !== 'idle' && (
        <div className="voice-connection">
          <div className="voice-connection-heading">
            <span role="status" data-voice-status={voice.status}>
              <strong>
                {voice.status === 'connected'
                  ? 'Voice Connected'
                  : voice.status === 'joining'
                    ? 'Joining…'
                    : 'Reconnecting…'}
              </strong>
              <small>{channels.find((channel) => channel.id === voice.channelId)?.name}</small>
            </span>
            <button
              aria-label="Voice & audio settings"
              title="Voice & audio settings"
              onClick={() => openSettings('voice')}
            >
              <Settings size={17} />
            </button>
            <button
              aria-label="Leave voice"
              title="Leave voice"
              onClick={() => runInBackground(action((controller) => controller.leave()))}
            >
              <PhoneOff size={18} />
            </button>
          </div>
          <div className="voice-buttons">
            <button
              aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={voice.muted}
              onClick={() => runInBackground(action((controller) => controller.mute()))}
            >
              {voice.muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              aria-label="Deafen"
              aria-pressed={voice.deafened}
              onClick={() => runInBackground(action((controller) => controller.deafen()))}
            >
              <Headphones size={18} />
            </button>
          </div>
          <ScreenLauncher />
        </div>
      )}
      {channelError && (
        <p className="voice-error" role="alert">
          {channelError}
        </p>
      )}
      {voice?.error && (
        <p className="voice-error" role="alert">
          {voice.error}{' '}
          <button onClick={() => openSettings('voice')}>Voice & audio settings</button>
        </p>
      )}
      {participant && participantAnchor && participant.id !== auth.user.id && (
        <ParticipantVolume
          key={participant.id}
          anchor={participantAnchor}
          participant={participant}
          close={() => setParticipantId(null)}
          volume={(value) => call?.controls.volume(participant.id, value)}
        />
      )}
      {voiceSettingsHost && createPortal(<VoiceSettings />, voiceSettingsHost)}
      {error && (
        <p className="voice-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function VoiceSettings() {
  const call = useCall();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef(call?.controls);
  const autoControls = call?.controls;
  useEffect(() => {
    if (autoControls) runInBackground(autoControls.refreshDevices());
  }, [autoControls]);
  current.current = call?.controls;
  if (!call) return <p role="status">Voice is initializing…</p>;
  const { voice, controls, devices } = call;
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      if (current.current === controls) setError((cause as Error).message);
    } finally {
      if (current.current === controls) setBusy(false);
    }
  };
  return (
    <div className="voice-preferences">
      <h3>Voice & audio</h3>
      <p>You join muted. Device choices are saved on this device.</p>
      <p
        className="voice-help"
        role={voice.devicesStatus === 'error' ? 'alert' : 'status'}
        data-audio-devices-status={voice.devicesStatus}
      >
        {voice.devicesStatus === 'loading'
          ? 'Checking audio devices…'
          : voice.devicesError || 'Audio devices update automatically.'}
      </p>
      {voice.devicesStatus === 'permission-needed' && (
        <button disabled={busy} onClick={() => runInBackground(run(controls.devices))}>
          Allow microphone access
        </button>
      )}
      <button disabled={busy} onClick={() => runInBackground(run(controls.devices))}>
        Find audio devices
      </button>
      {(['audioinput', 'audiooutput'] as const).map((kind) => {
        const input = kind === 'audioinput';
        const selected = input
          ? voice.inputMissing
            ? ''
            : voice.input
          : voice.outputMissing
            ? ''
            : voice.output;
        const available = concreteDevices(devices, kind);
        return (
          <label key={kind}>
            {input ? 'Microphone' : 'Speakers'}
            <select
              aria-label={input ? 'Voice microphone' : 'Voice speakers'}
              value={selected}
              disabled={busy}
              onChange={(event) =>
                runInBackground(
                  run(() =>
                    input
                      ? controls.selectInput(event.target.value)
                      : controls.selectOutput(event.target.value),
                  ),
                )
              }
            >
              <option value="">{input ? 'Choose microphone' : 'Choose speakers'}</option>
              {selected && !available.some((device) => device.deviceId === selected) && (
                <option value={selected}>
                  Saved device · find audio devices to check availability
                </option>
              )}
              {available.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || (input ? 'Microphone' : 'Speakers')}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <button
        disabled={busy || voice.devicesStatus === 'loading'}
        onClick={() => runInBackground(run(controls.refreshDevices))}
      >
        Refresh audio devices
      </button>
      <label className="voice-output-volume">
        Voice output <output>{Math.round(voice.outputVolume * 100)}%</output>
        <input
          aria-label="Voice output volume"
          aria-valuetext={Math.round(voice.outputVolume * 100) + '%'}
          type="range"
          min="0"
          max="2"
          step=".05"
          value={voice.outputVolume}
          onChange={(event) =>
            runInBackground(run(() => controls.setOutputVolume(Number(event.target.value))))
          }
        />
      </label>
      <fieldset
        className="voice-processing"
        disabled={busy || voice.processingBusy || voice.status === 'reconnecting'}
      >
        <legend>Microphone processing</legend>
        <p>
          Standard processing is recommended for voice chat. These settings affect your microphone,
          not shared app or system audio.
        </p>
        <div className="voice-processing-presets">
          <button
            type="button"
            aria-pressed={processingKeys.every((key) => voice.processing[key])}
            onClick={() => runInBackground(run(() => controls.setProcessing(defaultProcessing)))}
          >
            Standard
          </button>
          <button
            type="button"
            aria-pressed={processingKeys.every((key) => !voice.processing[key])}
            onClick={() => runInBackground(run(() => controls.setProcessing(rawProcessing)))}
          >
            Raw microphone
          </button>
        </div>
        {(
          [
            [
              'echoCancellation',
              'Echo cancellation',
              'Reduces speaker audio picked up by your microphone.',
            ],
            ['noiseSuppression', 'Noise suppression', 'Reduces steady background noise.'],
            ['autoGainControl', 'Automatic gain', 'Helps keep your speaking volume consistent.'],
          ] as const
        ).map(([key, label, description]) => (
          <label className="voice-processing-option" key={key}>
            <input
              type="checkbox"
              checked={voice.processing[key]}
              onChange={(event) => {
                const enabled = event.target.checked;
                runInBackground(
                  run(() => controls.setProcessing({ ...voice.processing, [key]: enabled })),
                );
              }}
            />
            <span>
              {label}
              <small>{description}</small>
            </span>
            {voice.processingApplied && (
              <small>
                Applied:{' '}
                {voice.processingApplied[key] === undefined
                  ? 'Not reported'
                  : voice.processingApplied[key]
                    ? 'On'
                    : 'Off'}
              </small>
            )}
          </label>
        ))}
        <p role="status">
          {voice.status === 'reconnecting'
            ? 'Wait for voice to reconnect before changing microphone processing.'
            : voice.processingBusy
              ? 'Applying microphone processing…'
              : voice.processingApplied
                ? processingKeys.every(
                    (key) => voice.processingApplied?.[key] === voice.processing[key],
                  )
                  ? 'The microphone reports the requested settings.'
                  : 'The microphone did not apply or report every requested setting.'
                : 'Settings apply when your microphone starts. Changing them in a call restarts the selected microphone and preserves mute.'}
        </p>
        <p>
          Raw microphone disables these three controls. Use it with a hardware-processed microphone
          or a headset when you want unprocessed sound.
        </p>
        {voice.processingError && (
          <p role="alert" className="voice-error">
            {voice.processingError}
          </p>
        )}
      </fieldset>
      {voice.status !== 'idle' && (
        <button onClick={() => runInBackground(run(controls.resumeAudio))}>
          Enable audio playback
        </button>
      )}
      {(error || voice.error) && (
        <p role="alert" className="voice-error">
          {error || voice.error}
        </p>
      )}
    </div>
  );
}
