import { afterEach, expect, it, vi } from 'vitest';
import {
  appearanceStorageKey,
  clearAppearanceError,
  getAppearance,
  readAppearance,
  restoreAppearance,
  setAppearance,
  subscribeAppearance,
} from './appearance-store';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('defaults to Original and accepts only known saved themes', () => {
  expect(readAppearance({ getItem: () => null })).toBe('original');
  for (const theme of ['original', 'retro'] as const)
    expect(readAppearance({ getItem: () => theme })).toBe(theme);
  expect(() => readAppearance({ getItem: () => 'unknown' })).toThrow('invalid');
});

it('applies and persists a switch without reloading or touching any other storage key', () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { setItem });
  const dataset: Record<string, string> = {};
  vi.stubGlobal('document', { documentElement: { dataset } });
  const changed = vi.fn();
  const unsubscribe = subscribeAppearance(changed);
  setAppearance('retro');
  expect(dataset.appearance).toBe('retro');
  expect(getAppearance()).toEqual({ theme: 'retro', error: null });
  expect(setItem.mock.calls).toEqual([[appearanceStorageKey, 'retro']]);
  expect(changed).toHaveBeenCalledOnce();
  unsubscribe();
  setAppearance('original');
  expect(changed).toHaveBeenCalledOnce();
});

it('restores a saved theme and treats cleared storage as Original', () => {
  const getItem = vi.fn().mockReturnValue('retro');
  vi.stubGlobal('localStorage', { getItem });
  restoreAppearance();
  expect(getAppearance()).toEqual({ theme: 'retro', error: null });
  expect(getItem).toHaveBeenCalledWith(appearanceStorageKey);
  getItem.mockReturnValue(null);
  restoreAppearance();
  expect(getAppearance().theme).toBe('original');
});

it('keeps the chosen theme usable and explicitly warns if persistence is blocked', () => {
  vi.stubGlobal('localStorage', {
    setItem: () => {
      throw new Error('Storage blocked');
    },
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  setAppearance('retro');
  expect(getAppearance().theme).toBe('retro');
  expect(getAppearance().error).toContain('could not be saved');
  expect(warning).toHaveBeenCalledOnce();
  clearAppearanceError();
  expect(getAppearance()).toEqual({ theme: 'retro', error: null });
});

it('reports unreadable or corrupt preferences without silently changing the current theme', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const getItem of [
    () => 'invalid',
    () => {
      throw new Error('Storage blocked');
    },
  ]) {
    vi.stubGlobal('localStorage', { getItem });
    const previous = getAppearance().theme;
    restoreAppearance();
    expect(getAppearance().theme).toBe(previous);
    expect(getAppearance().error).toContain('could not be read');
  }
  expect(warning).toHaveBeenCalledTimes(2);
});
it('keeps state immediate and prevents obsolete snapshot callbacks from reverting rapid switches', () => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  setAppearance('original');
  const callbacks: (() => void)[] = [];
  const skipTransition = vi.fn();
  const startViewTransition = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    return { skipTransition, ready: Promise.resolve(), finished: Promise.resolve() };
  });
  const dataset: Record<string, string> = { appearance: 'original' };
  vi.stubGlobal('document', { documentElement: { dataset }, startViewTransition });
  setAppearance('retro');
  expect(getAppearance().theme).toBe('retro');
  setAppearance('original');
  callbacks[1]!();
  callbacks[0]!();
  expect(dataset.appearance).toBe('original');
  expect(skipTransition).toHaveBeenCalledOnce();
});
it('skips animation entirely for reduced motion', () => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  const startViewTransition = vi.fn();
  const animate = vi.fn();
  const dataset: Record<string, string> = {};
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal('document', { documentElement: { dataset, animate }, startViewTransition });
  setAppearance('retro');
  expect(dataset.appearance).toBe('retro');
  expect(startViewTransition).not.toHaveBeenCalled();
  expect(animate).not.toHaveBeenCalled();
});
it('uses one cancelable short fade when native snapshots are unsupported', () => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  setAppearance('original');
  const cancel = vi.fn();
  const animate = vi.fn((_frames: unknown, _options: unknown) => ({ cancel }));
  const dataset: Record<string, string> = {};
  vi.stubGlobal('document', { documentElement: { dataset, animate } });
  setAppearance('retro');
  expect(dataset.appearance).toBe('retro');
  expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 160 });
  setAppearance('original');
  expect(cancel).toHaveBeenCalledOnce();
  expect(dataset.appearance).toBe('original');
});
it('applies background-tab changes without starting an animation', () => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  const dataset: Record<string, string> = {};
  const animate = vi.fn();
  const startViewTransition = vi.fn();
  vi.stubGlobal('document', {
    hidden: true,
    documentElement: { dataset, animate },
    startViewTransition,
  });
  setAppearance('retro');
  expect(dataset.appearance).toBe('retro');
  expect(startViewTransition).not.toHaveBeenCalled();
  expect(animate).not.toHaveBeenCalled();
});
it('logs snapshot failures and still applies the chosen theme using the short fade', async () => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  setAppearance('original');
  const dataset: Record<string, string> = {};
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  vi.stubGlobal('document', {
    documentElement: { dataset, animate },
    startViewTransition: () => ({
      ready: Promise.reject(new Error('Snapshot unavailable')),
      finished: Promise.resolve(),
      skipTransition: vi.fn(),
    }),
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  setAppearance('retro');
  await Promise.resolve();
  expect(getAppearance().theme).toBe('retro');
  expect(dataset.appearance).toBe('retro');
  expect(animate).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledOnce();
});
