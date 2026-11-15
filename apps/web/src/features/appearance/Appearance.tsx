import { useSyncExternalStore } from 'react';
import { Palette, Check, X } from 'lucide-react';
import {
  getAppearance,
  subscribeAppearance,
  setAppearance,
  clearAppearanceError,
  type Appearance,
} from './appearance-store';

function useAppearance() {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

export function AppearanceToggle() {
  const { theme, error } = useAppearance();
  const next = theme === 'retro' ? 'original' : 'retro';
  return (
    <>
      <button
        className="appearance-toggle"
        aria-label={'Switch to ' + (next === 'retro' ? 'Retro' : 'Original') + ' theme'}
        title={'Theme: ' + (theme === 'retro' ? 'Retro' : 'Original') + ' · Click to switch'}
        onClick={() => setAppearance(getAppearance().theme === 'retro' ? 'original' : 'retro')}
      >
        <Palette />
      </button>
      {error && (
        <div className="appearance-feedback" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss theme warning" onClick={clearAppearanceError}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

export function AppearanceBrand() {
  return (
    <div className="logo" role="img" aria-label="Rajcord">
      r
    </div>
  );
}

export function AppearancePreferences() {
  const { theme, error } = useAppearance();
  return (
    <div className="account-content appearance-preferences">
      <h3>A familiar place to catch up.</h3>
      <p>Same people, same messages. Pick your colors; switching never reloads the chat.</p>
      <div className="appearance-options" role="group" aria-label="Chat theme">
        {(['original', 'retro'] as const).map((value: Appearance) => (
          <button
            type="button"
            className="appearance-option"
            aria-pressed={theme === value}
            key={value}
            onClick={() => setAppearance(value)}
          >
            <span className={'appearance-swatch appearance-swatch-' + value} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              <strong>{value === 'original' ? 'Original' : 'Retro'}</strong>
              <small>
                {value === 'original'
                  ? 'Neutral charcoal surfaces, red Rajcord mark, and soft gray channel selection.'
                  : 'Racing green, stone-gray mist, a fine matte grain. Calm daylight.'}
              </small>
            </span>
            {theme === value && <Check size={18} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <small>Saved on this device. No account data or messages are changed.</small>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
