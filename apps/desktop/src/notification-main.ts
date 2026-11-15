import { app, ipcMain, Notification, shell } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  canCoalesceNativeNotice,
  nativeNotificationResponse,
  validNativeNotice,
  validNotice,
  type NativeNotificationResult,
  type NativeNotificationTarget,
} from './notification-policy.js';

type TrustedSender = (event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>) => boolean;

/** Own notification IPC registration and its native resource lifetime for one window. */
export function installNotificationMain({
  owner,
  notificationAppId,
  trustedSender,
}: {
  owner: BrowserWindow;
  notificationAppId: string;
  trustedSender: TrustedSender;
}) {
  app.setAppUserModelId(notificationAppId);
  ipcMain.handle('notifications:capabilities', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted notification request.');
    return { version: 2 };
  });
  ipcMain.handle('notifications:enable', (event) => {
    if (!trustedSender(event) || !Notification.isSupported()) return false;
    if (process.platform !== 'win32' || app.isPackaged) return true;
    // Windows associates development toasts with a Start Menu shortcut, as documented by Electron.
    const shortcut = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Rajcord development.lnk',
    );
    try {
      if (fs.existsSync(shortcut)) {
        const existing = shell.readShortcutLink(shortcut);
        if (existing.target !== process.execPath || existing.appUserModelId !== notificationAppId)
          return false;
      }
      return shell.writeShortcutLink(shortcut, fs.existsSync(shortcut) ? 'update' : 'create', {
        target: process.execPath,
        args: '"' + path.join(__dirname, 'main.js') + '"',
        cwd: path.resolve(__dirname, '../../..'),
        appUserModelId: notificationAppId,
        description: 'Rajcord development app notification registration',
      });
    } catch {
      return false;
    }
  });
  const notices = new Set<Notification>();
  let burst:
    | {
        at: number;
        active: boolean;
        count: number;
        target: NativeNotificationTarget;
        shown: Promise<boolean>;
      }
    | undefined;
  ipcMain.handle('notifications:show', async (event, value: unknown) => {
    const modern = validNativeNotice(value);
    const requestedModern = !!value && typeof value === 'object' && 'version' in value;
    const result = (response: NativeNotificationResult) =>
      nativeNotificationResponse(requestedModern, response);
    if (!trustedSender(event) || (!modern && !validNotice(value)))
      return result({ status: 'invalid' });
    if (!Notification.isSupported()) return result({ status: 'unavailable' });
    const destination: NativeNotificationTarget = modern
      ? value.target
      : { conversationId: (value as { conversationId: string }).conversationId };
    if (modern && canCoalesceNativeNotice(burst, Date.now()) && burst) {
      const existing = burst;
      if (!(await existing.shown)) return result({ status: 'unavailable' });
      if (existing.active) {
        existing.target = destination;
        existing.count++;
        return result({ status: 'coalesced', count: existing.count });
      }
    }
    try {
      const notification = new Notification({
        title: 'Rajcord',
        body: 'New activity. Open Rajcord to read it.',
        silent: true,
      });
      while (notices.size >= 8) {
        const oldest = notices.values().next().value!;
        notices.delete(oldest);
        oldest.close();
      }
      notices.add(notification);
      const delivery = {
        at: Date.now(),
        active: true,
        count: 1,
        target: destination,
        shown: Promise.resolve(false),
      };
      const closed = () => {
        delivery.active = false;
        notices.delete(notification);
      };
      notification.on('close', closed);
      notification.on('failed', closed);
      notification.on('click', () => {
        if (owner.isDestroyed()) return;
        if (owner.isMinimized()) owner.restore();
        owner.show();
        owner.focus();
        if (modern) owner.webContents.send('notifications:open-target', delivery.target);
        else owner.webContents.send('notifications:open', delivery.target.conversationId);
        notification.close();
      });
      delivery.shown = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          closed();
          notification.close();
          resolve(false);
        }, 4000);
        notification.once('show', () => {
          clearTimeout(timer);
          resolve(true);
        });
        notification.once('failed', () => {
          clearTimeout(timer);
          resolve(false);
        });
        notification.show();
      });
      if (modern) burst = delivery;
      return result((await delivery.shown) ? { status: 'shown' } : { status: 'unavailable' });
    } catch {
      return result({ status: 'unavailable' });
    }
  });

  const dispose = () => {
    owner.removeListener('closed', dispose);
    ipcMain.removeHandler('notifications:show');
    ipcMain.removeHandler('notifications:enable');
    ipcMain.removeHandler('notifications:capabilities');
    for (const notice of notices) notice.close();
    notices.clear();
  };
  owner.once('closed', dispose);
  return dispose;
}
