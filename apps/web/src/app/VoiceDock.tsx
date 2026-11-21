import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Avatar } from '@tricord/ui';
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  Settings,
  Volume2,
  MonitorUp,
  Square,
} from 'lucide-react';
import { runInBackground } from '../shared/background';
import { useCall } from '../shared/call';
import { ScreenLauncher } from '../features/screen-sharing';
import type { VoiceSessionDock } from '../features/voice';

function MicrophoneToggle({ session }: { session: VoiceSessionDock | null }) {
  return (
    <button
      className="profile-control"
      aria-label={session?.muted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={session?.muted ?? false}
      title={session ? 'Toggle microphone' : 'Join voice to use microphone'}
      disabled={!session}
      onClick={() => session?.toggleMute()}
    >
      {session?.muted ? <MicOff size={17} /> : <Mic size={17} />}
    </button>
  );
}

function connectionLabel(session: VoiceSessionDock) {
  if (session.status === 'joining') return 'Joining voice…';
  if (session.status === 'reconnecting') return 'Reconnecting…';
  return 'Voice Connected';
}

const noSubscription = () => () => {};

function DeafenToggle({ session }: { session: VoiceSessionDock | null }) {
  return (
    <button
      className="profile-control"
      aria-label={session?.deafened ? 'Enable audio' : 'Deafen'}
      aria-pressed={session?.deafened ?? false}
      title={
        session ? (session.deafened ? 'Enable audio' : 'Deafen') : 'Join voice to control audio'
      }
      disabled={!session}
      onClick={() => session?.toggleDeafen()}
    >
      {session?.deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
    </button>
  );
}

export function MobileVoiceControls({
  voiceSession,
  callOpen,
  roomButton,
}: {
  voiceSession: VoiceSessionDock | null;
  callOpen: boolean;
  roomButton: RefObject<HTMLButtonElement | null>;
}) {
  const screens = useCall()?.screens;
  const phase = useSyncExternalStore(
    screens?.subscribe ?? noSubscription,
    () => screens?.inspect().phase ?? 'idle',
  );
  const sharing = phase === 'sharing';
  const [error, setError] = useState('');
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (callOpen) return;
    const trigger = returnFocus.current;
    returnFocus.current = null;
    if (trigger) (trigger.disabled ? roomButton.current : trigger)?.focus({ preventScroll: true });
  }, [callOpen, roomButton]);
  if (!voiceSession) return null;
  async function openCall(setup: boolean, trigger: HTMLButtonElement) {
    setError('');
    try {
      const opening = screens?.open(setup);
      if (screens?.inspect().open) returnFocus.current = trigger;
      await opening;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the call view.');
    }
  }
  return (
    <div
      className="mobile-call-controls"
      data-voice-status={voiceSession.status}
      role="group"
      aria-label="Current voice call"
      hidden={callOpen}
    >
      <button
        ref={roomButton}
        type="button"
        className="mobile-call-room"
        disabled={!screens}
        aria-label="Open call view"
        title={'Open call view · ' + voiceSession.channelName}
        onClick={(event) => runInBackground(openCall(false, event.currentTarget))}
      >
        <Radio size={16} aria-hidden="true" />
        <span>
          <strong>{voiceSession.channelName}</strong>
          <small>
            {sharing && voiceSession.status === 'connected'
              ? 'Sharing screen'
              : connectionLabel(voiceSession)}
          </small>
        </span>
      </button>
      <MicrophoneToggle session={voiceSession} />
      <DeafenToggle session={voiceSession} />
      {screens && (
        <button
          type="button"
          className="mobile-call-share"
          aria-label={sharing ? 'Stop screen sharing' : 'Share screen'}
          title={sharing ? 'Stop screen sharing' : 'Share screen'}
          aria-pressed={sharing}
          disabled={
            voiceSession.status === 'joining' ||
            ['connecting', 'preparing', 'choosing', 'publishing'].includes(phase)
          }
          onClick={(event) =>
            sharing ? screens.stopSource() : runInBackground(openCall(true, event.currentTarget))
          }
        >
          {sharing ? <Square size={16} /> : <MonitorUp size={17} />}
        </button>
      )}
      <button
        type="button"
        className="voice-dock-leave"
        aria-label="Leave voice"
        title="Leave voice"
        onClick={voiceSession.leave}
      >
        <PhoneOff size={16} /> Leave voice
      </button>
      {error && (
        <span className="mobile-call-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function VoiceDock({
  voiceSession,
  connected,
  displayName,
  onSettings,
}: {
  voiceSession: VoiceSessionDock | null;
  connected: boolean;
  displayName: string;
  onSettings: () => void;
}) {
  return (
    <div className="sidebar-dock">
      {voiceSession && (
        <section
          className="voice-dock"
          aria-label="Voice connection"
          data-voice-status={voiceSession.status}
        >
          <div className="voice-dock-header">
            <span className="voice-dock-icon" aria-hidden="true">
              <Radio size={20} />
            </span>
            <div className="voice-dock-label">
              <strong>{connectionLabel(voiceSession)}</strong>
              <small>{voiceSession.channelName}</small>
            </div>
            <button
              className="voice-dock-leave"
              aria-label="Leave voice"
              title="Leave voice"
              onClick={voiceSession.leave}
            >
              <PhoneOff size={17} />
            </button>
          </div>
          <div className="voice-dock-actions" role="group" aria-label="Screen sharing">
            <ScreenLauncher />
          </div>
        </section>
      )}
      <div className="profile">
        <span className="profile-avatar">
          <Avatar>{displayName.slice(0, 1)}</Avatar>
          <i className={connected ? 'online' : 'offline'} aria-hidden="true" />
        </span>
        <div className="profile-identity" data-voice-status={voiceSession?.status}>
          <strong>{displayName}</strong>
          <small
            data-connection={connected ? 'connected' : 'disconnected'}
            className={voiceSession ? 'in-voice' : ''}
          >
            {voiceSession && <Volume2 size={12} aria-hidden="true" />}
            {voiceSession
              ? voiceSession.status === 'connected'
                ? 'In voice'
                : connectionLabel(voiceSession)
              : connected
                ? 'Online'
                : 'Offline'}
          </small>
        </div>
        <div className="profile-audio-controls" role="group" aria-label="Voice controls">
          <MicrophoneToggle session={voiceSession} />
          <DeafenToggle session={voiceSession} />
        </div>
        <button
          className="profile-settings"
          aria-label="Settings"
          title="Settings"
          onClick={onSettings}
        >
          <Settings size={19} />
        </button>
      </div>
    </div>
  );
}
