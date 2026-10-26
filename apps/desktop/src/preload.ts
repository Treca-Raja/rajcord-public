import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld(
  'tricordDesktop',
  Object.freeze({
    platform: process.platform,
    version: '0.1.0',
    enableNotifications: () => ipcRenderer.invoke('notifications:enable'),
    notify: (notice: { conversationId: string; mention: boolean }) =>
      ipcRenderer.invoke('notifications:show', notice),
    onNotificationOpen: (callback: (conversationId: string) => void) => {
      const listener = (_event: unknown, id: string) => callback(id);
      ipcRenderer.on('notifications:open', listener);
      return () => ipcRenderer.removeListener('notifications:open', listener);
    },
  }),
);
