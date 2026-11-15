import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MonitorUp, Square, X } from 'lucide-react';
import {
  SCREEN_RESOLUTIONS,
  SCREEN_FRAME_RATES,
  SCREEN_VIDEO_BITRATES,
  screenQualityCeiling,
  type ScreenQuality,
  type ScreenSound,
  type ScreenShare,
} from '@tricord/shared';
import { useCall } from './CallProvider';
import type { ScreenControls } from './screen-call';
import './screen.css';

function useScreen(controls: ScreenControls) {
  return useSyncExternalStore(controls.subscribe, controls.inspect, controls.inspect);
}
function ScreenButton({ controls, connected }: { controls: ScreenControls; connected: boolean }) {
  const state = useScreen(controls);
  return (
    <div className="screen-launcher">
      <button
        disabled={!connected}
        aria-expanded={state.open}
        aria-controls="screen-panel"
        onClick={() => {
          if (state.open) controls.close();
          else void controls.open().catch(() => {});
        }}
      >
        <MonitorUp size={16} />
        {state.phase === 'sharing' ? `Sharing · ${state.viewers} viewers` : 'Screen sharing'}
      </button>
      {(state.prepared ||
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
export function ScreenPanel() {
  const call = useCall();
  return call?.screens ? <ConnectedScreenPanel controls={call.screens} /> : null;
}
function ConnectedScreenPanel({ controls }: { controls: ScreenControls }) {
  const call = useCall();
  const state = useScreen(controls);
  const [quality, setQuality] = useState<ScreenQuality>({
    profile: 'smooth',
    resolution: 1080,
    frameRate: 60,
    videoBitrate: 8000000,
  });
  const [watchQuality, setWatchQuality] = useState<ScreenQuality>({
    profile: 'smooth',
    resolution: 1080,
    frameRate: 60,
    videoBitrate: 4000000,
  });
  const [sound, setSound] = useState<ScreenSound>('none');
  const [error, setError] = useState('');
  const currentControls = useRef(controls);
  currentControls.current = controls;
  useEffect(() => setError(''), [controls]);
  const preview = useRef<HTMLVideoElement>(null),
    incoming = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.open && preview.current) return controls.preview(preview.current);
  }, [controls, state.open]);
  useEffect(() => {
    if (state.open && incoming.current) return controls.incoming(incoming.current);
  }, [controls, state.open]);
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
  const requested = (item: Readonly<ScreenShare>, preference: ScreenQuality): ScreenQuality => {
    const offered = screenQualityCeiling(item);
    return {
      profile: 'smooth',
      resolution: Math.min(preference.resolution!, offered.height) as ScreenQuality['resolution'],
      frameRate: Math.min(preference.frameRate!, offered.frameRate) as ScreenQuality['frameRate'],
      videoBitrate: preference.videoBitrate,
    };
  };
  const changeWatchQuality = (next: ScreenQuality) => {
    setWatchQuality(next);
    const selected = state.shares.find((item) => item.id === state.watching);
    if (selected) run(() => controls.watch(selected.id, requested(selected, next)));
  };
  if (!state.open) return null;
  const busy = ['connecting', 'preparing', 'choosing', 'publishing'].includes(state.phase);
  const phases = {
    idle: 'Join voice to share or watch',
    connecting: 'Connecting…',
    ready: 'Ready',
    preparing: 'Preparing…',
    choosing: 'Choosing a source…',
    preview: 'Preview',
    publishing: 'Starting…',
    sharing: `Sharing · ${state.viewers} viewers`,
  };
  return (
    <section
      id="screen-panel"
      className="screen-panel"
      aria-label="Screen sharing"
      data-phase={state.phase}
      data-prepared={state.prepared}
    >
      <header>
        <MonitorUp size={18} />
        <strong>Screen sharing</strong>
        <span className="screen-status" role="status">
          {phases[state.phase]}
        </span>
        <span className="grow" />
        {state.prepared && (
          <button className="screen-stop" onClick={controls.stopSource}>
            Stop sharing
          </button>
        )}
        <button aria-label="Close screen panel" onClick={controls.close}>
          <X size={17} />
        </button>
      </header>
      <div className="screen-panel-body">
        <div className="screen-options">
          <fieldset disabled={busy || state.prepared}>
            <legend>Your screen</legend>
            <div className="screen-quality">
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
              <label>
                Video cap per viewer
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
                value={sound}
                onChange={(event) => setSound(event.target.value as ScreenSound)}
              >
                <option value="none">Video only</option>
                {window.tricordDesktop ? (
                  window.tricordDesktop.platform === 'win32' && (
                    <option value="system">System sound — all applications</option>
                  )
                ) : (
                  <option value="tab">Selected browser tab sound</option>
                )}
              </select>
            </label>
          </fieldset>
          {sound === 'system' && (
            <p className="screen-help">
              System sound may include Rajcord and other applications. Use a separate playback route
              to avoid feeding the call back into your share.
            </p>
          )}
          {sound === 'tab' && (
            <p className="screen-help">
              Choose a browser tab and explicitly enable its audio in the browser picker.
            </p>
          )}
          {!state.prepared && (
            <button
              disabled={busy}
              onClick={() => run(() => controls.prepare({ ...quality, sound }))}
            >
              Prepare source
            </button>
          )}
          {state.prepared && state.phase === 'ready' && (
            <button onClick={() => run(controls.choose)}>Choose source</button>
          )}
          {state.phase === 'preview' && (
            <button className="primary" onClick={() => run(controls.publish)}>
              Start sharing
            </button>
          )}
          {busy && (
            <p role="status">
              {state.phase === 'choosing'
                ? 'Choose a source in the picker…'
                : 'Preparing screen sharing…'}
            </p>
          )}
          <p className="screen-help">
            Resolution, frame rate and bitrate are ceilings. Actual delivery depends on the source,
            hardware and network connection.
          </p>
        </div>
        <div className="screen-media" data-has-incoming={!!state.watching}>
          <video
            ref={preview}
            className="screen-preview"
            aria-label="Local screen preview"
            hidden={!['preview', 'publishing', 'sharing'].includes(state.phase)}
            muted
            playsInline
          />
          {state.label && (
            <span className="screen-source-label">{state.label} · local preview</span>
          )}
          <div ref={incoming} className="screen-incoming" />
        </div>
        <div className="screen-watch">
          <strong>Available screens</strong>
          <div className="screen-watch-quality">
            <label>
              Watch resolution
              <select
                aria-label="Watch resolution"
                value={watchQuality.resolution}
                onChange={(event) =>
                  changeWatchQuality({
                    ...watchQuality,
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
              Watch frame rate
              <select
                aria-label="Watch frame rate"
                value={watchQuality.frameRate}
                onChange={(event) =>
                  changeWatchQuality({
                    ...watchQuality,
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
            <label>
              Watch video cap
              <select
                aria-label="Watch video bitrate"
                value={watchQuality.videoBitrate ?? 4000000}
                onChange={(event) =>
                  changeWatchQuality({
                    ...watchQuality,
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
          {state.shares.length === 0 && <p>No one is sharing yet.</p>}
          {state.shares.map((item) => (
            <button
              key={item.id}
              disabled={item.id === state.ownShareId}
              aria-pressed={state.watching === item.id}
              onClick={() => run(() => controls.watch(item.id, requested(item, watchQuality)))}
            >
              <MonitorUp size={15} />
              {call?.voice.participants.find((person) => person.id === item.publisherId)?.name ??
                'Participant'}{' '}
              · {item.resolution ?? 1080}p · {item.frameRate ?? 60} fps ·{' '}
              {item.sound === 'none' ? 'Video' : 'With sound'}
            </button>
          ))}
          <label>
            <input type="checkbox" onChange={(event) => controls.mute(event.target.checked)} />
            Mute screen sound
          </label>
          <label>
            Screen volume
            <input
              aria-label="Screen volume"
              type="range"
              min="0"
              max="1"
              step=".05"
              defaultValue="1"
              onChange={(event) => controls.volume(Number(event.target.value))}
            />
          </label>
          {state.watching && (
            <>
              <p role="status">{state.playback}</p>
              <button onClick={() => run(controls.play)}>Enable screen playback</button>
              <button onClick={() => controls.stopWatching()}>Stop watching</button>
            </>
          )}
          {state.hidden && <p>Incoming screen delivery is paused while Rajcord is hidden.</p>}
        </div>
      </div>
      {(error || state.error) && (
        <p className="screen-error" role="alert">
          {error || state.error}
        </p>
      )}
    </section>
  );
}
