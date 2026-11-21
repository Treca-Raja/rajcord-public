import { ipcMain, nativeTheme } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';

// Match the sidebar surface in the hosted workspace's Original and Retro themes.
const originalColor = '#1d1929';
const retroColor = '#23483c';

export function windowsChromeOptions() {
  return {
    autoHideMenuBar: true,
    accentColor: nativeTheme.shouldUseHighContrastColors ? undefined : originalColor,
  };
}

export function installWindowsChrome(
  owner: BrowserWindow,
  trustedSender: (event: IpcMainEvent) => boolean,
) {
  let color = originalColor;
  const apply = () => owner.setAccentColor(nativeTheme.shouldUseHighContrastColors ? null : color);
  const setAppearance = (event: IpcMainEvent, theme: unknown) => {
    if (!trustedSender(event) || (theme !== 'original' && theme !== 'retro')) return;
    const nextColor = theme === 'retro' ? retroColor : originalColor;
    if (color === nextColor) return;
    color = nextColor;
    apply();
  };

  owner.setMenuBarVisibility(false);
  ipcMain.on('window:appearance', setAppearance);
  nativeTheme.on('updated', apply);
  owner.once('closed', () => {
    ipcMain.removeListener('window:appearance', setAppearance);
    nativeTheme.removeListener('updated', apply);
  });
}
