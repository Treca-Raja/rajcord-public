import { useSyncExternalStore } from 'react';
import waveform from '../../assets/rajcord.svg';
import { Check } from 'lucide-react';
import {
  getAppearance,
  subscribeAppearance,
  setAppearance,
  type Appearance,
} from './appearance-store';

function useAppearance() {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

export function AppearanceBrand() {
  return <img src={waveform} width={32} height={32} alt="" />;
}

export function AppearancePreferences() {
  const { theme, error } = useAppearance();
  return (
    <div className="account-content appearance-preferences">
      <h3>Appearance</h3>
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
                  ? 'Midnight violet with citron highlights.'
                  : 'Racing green navigation with a light conversation area.'}
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
