import { EventEmitter } from 'node:events';
import { ipcMain, nativeTheme } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { installWindowsChrome, windowsChromeOptions } from './window-chrome';

const theme = vi.hoisted(() => ({ highContrast: false }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ipcMain: new EventEmitter(),
    nativeTheme: new (class extends EventEmitter {
      get shouldUseHighContrastColors() {
        return theme.highContrast;
      }
    })(),
  };
});

it('hides the menu bar and follows only trusted supported themes and Windows high contrast', () => {
  const trusted = {} as IpcMainEvent;
  const owner = Object.assign(new EventEmitter(), {
    setAccentColor: vi.fn(),
    setMenuBarVisibility: vi.fn(),
  });
  expect(windowsChromeOptions()).toEqual({ autoHideMenuBar: true, accentColor: '#1d1929' });
  installWindowsChrome(owner as unknown as BrowserWindow, (event) => event === trusted);
  expect(owner.setMenuBarVisibility).toHaveBeenCalledExactlyOnceWith(false);

  ipcMain.emit('window:appearance', {}, 'retro');
  ipcMain.emit('window:appearance', trusted, '#abcdef');
  ipcMain.emit('window:appearance', trusted, 'original');
  expect(owner.setAccentColor).not.toHaveBeenCalled();

  ipcMain.emit('window:appearance', trusted, 'retro');
  expect(owner.setAccentColor).toHaveBeenLastCalledWith('#23483c');
  theme.highContrast = true;
  nativeTheme.emit('updated');
  expect(owner.setAccentColor).toHaveBeenLastCalledWith(null);
  theme.highContrast = false;
  nativeTheme.emit('updated');
  expect(owner.setAccentColor).toHaveBeenLastCalledWith('#23483c');

  owner.emit('closed');
  expect(ipcMain.listenerCount('window:appearance')).toBe(0);
  expect(nativeTheme.listenerCount('updated')).toBe(0);
});
