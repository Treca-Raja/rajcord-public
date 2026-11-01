import { contextBridge, ipcRenderer } from 'electron';
import type {
  NativeNotificationNotice,
  NativeNotificationResult,
  NativeNotificationTarget,
} from './notification-policy.js';
contextBridge.exposeInMainWorld(
  'tricordDesktop',
  Object.freeze({
    platform: process.platform,
    version:
      process.argv.find((value) => value.startsWith('--rajcord-version='))?.split('=')[1] ??
      'development',
    enableNotifications: () => ipcRenderer.invoke('notifications:enable'),
    notify: (notice: { conversationId: string; mention: boolean }) =>
      ipcRenderer.invoke('notifications:show', notice),
    notificationCapabilities: (): Promise<{ version: 2 }> =>
      ipcRenderer.invoke('notifications:capabilities'),
    notifyTarget: (notice: NativeNotificationNotice): Promise<NativeNotificationResult> =>
      ipcRenderer.invoke('notifications:show', notice),
    onNotificationOpen: (callback: (conversationId: string) => void) => {
      const listener = (_event: unknown, id: string) => callback(id);
      ipcRenderer.on('notifications:open', listener);
      return () => ipcRenderer.removeListener('notifications:open', listener);
    },
    onNotificationTarget: (callback: (target: NativeNotificationTarget) => void) => {
      const listener = (_event: unknown, target: NativeNotificationTarget) => callback(target);
      ipcRenderer.on('notifications:open-target', listener);
      return () => ipcRenderer.removeListener('notifications:open-target', listener);
    },
  }),
);
