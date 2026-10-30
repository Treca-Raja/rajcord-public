import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Headphones, PhoneOff, Volume2, Plus } from 'lucide-react';
import { useAuth } from './Auth';
import {
  VoiceController,
  concreteDevices,
  type VoiceChannel,
  type VoiceState,
} from './voice-controller';
import './voice.css';
export function VoicePanel({
  onChannels,
  requestedChannel,
}: {
  onChannels?: (channels: VoiceChannel[]) => void;
  requestedChannel?: { id: string; version: number } | null;
}) {
  const { request, state: auth } = useAuth();
  const ref = useRef(request);
  ref.current = request;
  const notifyChannels = useRef(onChannels);
  notifyChannels.current = onChannels;
  const loaded = useRef(false),
    handledReference = useRef(0);
  const controllerRef = useRef<VoiceController | null>(null);
  const [voice, setVoice] = useState<VoiceState | null>(null),
    [channels, setChannels] = useState<VoiceChannel[]>([]),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [error, setError] = useState(''),
    [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new VoiceController((...args) => ref.current(...args));
    controllerRef.current = controller;
    controller.onChange = () => setVoice({ ...controller.state });
    controller.onChange();
    let live = true;
    const reload = async () => {
      try {
        const data = await ref.current<{ channels: VoiceChannel[] }>('/voice/channels');
        if (live) {
          loaded.current = true;
          setChannels(data.channels);
          notifyChannels.current?.(data.channels);
        }
      } catch (error) {
        if (live) setError((error as Error).message);
      }
    };
    void reload();
    const timer = setInterval(() => void reload(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
      controller.dispose();
      controllerRef.current = null;
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
  async function action(work: (controller: VoiceController) => Promise<unknown>) {
    const controller = controllerRef.current;
    if (!controller) return;
    setBusy(true);
    setError('');
    try {
      await work(controller);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="voice-panel">
      <div className="section-label voice-label">
        VOICE CHANNELS
        <button
          aria-label="Create voice channel"
          onClick={() =>
            void action(async () => {
              const name = window.prompt('Voice channel name');
              if (!name) return;
              await ref.current('/voice/channels', 'POST', { name });
              const data = await ref.current<{ channels: VoiceChannel[] }>('/voice/channels');
              setChannels(data.channels);
              notifyChannels.current?.(data.channels);
            })
          }
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="channels">
        {channels.map((channel) => (
          <button
            key={channel.id}
            data-voice-channel-id={channel.id}
            className={
              voice?.channelId === channel.id || requestedChannel?.id === channel.id
                ? 'selected'
                : ''
            }
            onClick={() => {
              setExpanded(true);
            }}
          >
            <Volume2 size={17} />
            <span className="truncate">{channel.name}</span>
            <small>{channel.participants.length || ''}</small>
          </button>
        ))}
      </div>
      <button className="voice-settings-toggle" onClick={() => setExpanded(!expanded)}>
        {voice?.status === 'idle' ? 'Set up voice' : (voice?.status ?? 'Voice')} · Audio controls
      </button>
      {expanded && voice && (
        <div className="voice-controls">
          <p className="voice-help">Choose your devices. You join muted.</p>
          <button
            disabled={busy}
            onClick={() => void action(async (c) => setDevices(await c.devices()))}
          >
            Find audio devices
          </button>
          <label>
            Microphone
            <select
              aria-label="Voice microphone"
              value={voice.input}
              onChange={(e) => void action((c) => c.selectInput(e.target.value))}
            >
              <option value="">Choose microphone</option>
              {concreteDevices(devices, 'audioinput').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Speakers
            <select
              aria-label="Voice speakers"
              value={voice.output}
              onChange={(e) => void action((c) => c.selectOutput(e.target.value))}
            >
              <option value="">Choose speakers</option>
              {concreteDevices(devices, 'audiooutput').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Speakers'}
                </option>
              ))}
            </select>
          </label>
          {voice.status === 'idle' ? (
            <label>
              Join channel
              <select
                aria-label="Join voice channel"
                value=""
                disabled={busy || !voice.input || !voice.output}
                onChange={(e) => void action((c) => c.join(e.target.value))}
              >
                <option value="">Choose a channel</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <p role="status" data-voice-status={voice.status}>
                {voice.status === 'connected'
                  ? 'Connected'
                  : voice.status === 'joining'
                    ? 'Joining…'
                    : 'Reconnecting…'}{' '}
                · {channels.find((c) => c.id === voice.channelId)?.name}
              </p>
              <div className="voice-buttons">
                <button
                  aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
                  aria-pressed={voice.muted}
                  onClick={() => void action((c) => c.mute())}
                >
                  {voice.muted ? <MicOff size={17} /> : <Mic size={17} />}
                </button>
                <button
                  aria-label="Deafen"
                  aria-pressed={voice.deafened}
                  onClick={() => void action((c) => c.deafen())}
                >
                  <Headphones size={17} />
                </button>
                <button aria-label="Leave voice" onClick={() => void action((c) => c.leave())}>
                  <PhoneOff size={17} />
                </button>
              </div>
              <button onClick={() => void action((c) => c.resumeAudio())}>
                Enable audio playback
              </button>
              <ul className="voice-members">
                {voice.participants.map((p) => (
                  <li key={p.id} data-speaking={p.speaking}>
                    <span>
                      {p.name}
                      {p.id === auth.user.id ? ' (you)' : ''} {p.muted ? '· muted' : ''}
                    </span>
                    {p.id !== auth.user.id && (
                      <input
                        aria-label={'Volume for ' + p.name}
                        type="range"
                        min="0"
                        max="1"
                        step=".05"
                        value={p.volume}
                        onChange={(e) =>
                          controllerRef.current?.volume(p.id, Number(e.target.value))
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {voice.error && (
            <p className="voice-error" role="alert">
              {voice.error}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="voice-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
