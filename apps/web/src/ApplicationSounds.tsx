import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApplicationSoundPlayer,
  defaultSoundPreferences,
  parseSoundPreferences,
  soundPreferenceKey,
  type SoundPreferences,
} from './application-sounds';

type Sounds = {
  player: ApplicationSoundPlayer;
  preferences: SoundPreferences;
  change: (preferences: SoundPreferences) => void;
  error: string;
  clearError: () => void;
};
const Context = createContext<Sounds | null>(null);
export function useApplicationSounds() {
  const value = useContext(Context);
  if (!value) throw new Error('Application sounds require an approved account.');
  return value;
}
export function ApplicationSounds({ userId, children }: { userId: string; children: ReactNode }) {
  const key = soundPreferenceKey(userId);
  const [initial] = useState(() => {
    try {
      return { preferences: parseSoundPreferences(localStorage.getItem(key)), error: '' };
    } catch {
      return {
        preferences: { ...defaultSoundPreferences },
        error: 'Sound settings could not be loaded. Sounds start off.',
      };
    }
  });
  const [preferences, setPreferences] = useState(initial.preferences);
  const [error, setError] = useState(initial.error);
  const [player] = useState(() => new ApplicationSoundPlayer(userId, setError));
  const latest = useRef(preferences);
  latest.current = preferences;
  useEffect(() => {
    player.configure(latest.current);
    return () => player.dispose();
  }, [player]);
  function change(next: SoundPreferences) {
    setError('');
    player.configure(next);
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setError('Your sound preference could not be saved for the next visit.');
    }
  }
  return (
    <Context.Provider
      value={{ player, preferences, change, error, clearError: () => setError('') }}
    >
      {children}
    </Context.Provider>
  );
}
export function SoundControls() {
  const { player, preferences, change, error, clearError } = useApplicationSounds();
  return (
    <details className="sound-settings">
      <summary>Voice sounds</summary>
      <button
        aria-pressed={preferences.enabled}
        onClick={() => change({ ...preferences, enabled: !preferences.enabled })}
      >
        {preferences.enabled ? 'Disable sounds' : 'Enable sounds'}
      </button>
      <label>
        Sound volume
        <input
          aria-label="Application sound volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={preferences.volume}
          onChange={(e) => change({ ...preferences, volume: Number(e.target.value) })}
        />
        <output>{Math.round(preferences.volume * 100)}%</output>
      </label>
      <button
        disabled={!preferences.enabled || !preferences.volume}
        onClick={() => {
          clearError();
          void player.preview();
        }}
      >
        Preview sound
      </button>
      <small>
        Join/leave cues for your voice channel. Uses speakers selected in Audio controls; deafen
        silences them. Message alerts and popups are in Settings → Notifications.
      </small>
      {error && <small role="status">{error}</small>}
    </details>
  );
}
