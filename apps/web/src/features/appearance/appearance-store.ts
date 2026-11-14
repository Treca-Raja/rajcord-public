export type Appearance = 'original' | 'retro';
export const appearanceStorageKey = 'rajcord-appearance';
type AppearanceState = { theme: Appearance; error: string | null };
const hot: { appearance?: AppearanceState } | undefined = import.meta.hot?.data;
let state: AppearanceState = hot?.appearance ?? { theme: 'original', error: null };
const listeners = new Set<() => void>();
let transition: ViewTransition | null = null;
let fade: Animation | undefined;
let visualVersion = 0;

export function readAppearance(storage: Pick<Storage, 'getItem'>): Appearance {
  const saved = storage.getItem(appearanceStorageKey);
  if (saved === null || saved === 'original') return 'original';
  if (saved === 'retro') return 'retro';
  throw new Error('The saved appearance preference is invalid.');
}

function update(theme: Appearance, error: string | null, animate = false) {
  const changed = theme !== state.theme;
  state = { theme, error };
  const version = ++visualVersion;
  transition?.skipTransition();
  transition = null;
  fade?.cancel();
  fade = undefined;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const apply = () => {
      if (version === visualVersion) root.dataset.appearance = theme;
    };
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fallback = () => {
      apply();
      if (!reduce && !document.hidden && root.animate)
        fade = root.animate([{ opacity: 0.88 }, { opacity: 1 }], {
          duration: 160,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
    };
    if (animate && changed && !reduce && !document.hidden) {
      if (document.startViewTransition) {
        try {
          const current = document.startViewTransition(apply);
          transition = current;
          void current.ready.catch(() => {
            if (version !== visualVersion) return;
            console.warn('Theme snapshot animation was unavailable; using a short fade.');
            fallback();
          });
          void current.finished.then(
            () => {
              if (transition === current) transition = null;
            },
            () => {
              if (version !== visualVersion) return;
              console.warn(
                'Theme animation could not finish; the selected theme is still applied.',
              );
              apply();
            },
          );
        } catch {
          console.warn('Theme snapshot animation could not start; using a short fade.');
          fallback();
        }
      } else fallback();
    } else apply();
  }
  for (const listener of listeners) listener();
}

export function restoreAppearance(animate = false) {
  try {
    update(readAppearance(localStorage), null, animate);
  } catch {
    console.warn('Rajcord could not read the saved appearance preference.');
    update(state.theme, 'Your saved theme could not be read. Choose a theme to save it again.');
  }
}

export function setAppearance(theme: Appearance) {
  let error: string | null = null;
  try {
    localStorage.setItem(appearanceStorageKey, theme);
  } catch {
    console.warn('Rajcord could not save the appearance preference.');
    error = 'This theme is applied, but could not be saved on this device.';
  }
  update(theme, error, true);
}

export function clearAppearanceError() {
  update(state.theme, null);
}

export const getAppearance = () => state;
export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storageChanged(event: StorageEvent) {
  if (event.key === appearanceStorageKey || event.key === null) restoreAppearance(true);
}
if (typeof window !== 'undefined') {
  restoreAppearance();
  window.addEventListener('storage', storageChanged);
}
if (import.meta.hot)
  import.meta.hot.dispose((data: { appearance?: AppearanceState }) => {
    data.appearance = state;
    visualVersion++;
    transition?.skipTransition();
    fade?.cancel();
    document.documentElement.dataset.appearance = state.theme;
    window.removeEventListener('storage', storageChanged);
  });
