import { contextBridge, ipcRenderer } from 'electron';
import type { NativeScreenEvent } from '@tricord/shared' with { 'resolution-mode': 'import' };
import type {
  NativeNotificationNotice,
  NativeNotificationResult,
  NativeNotificationTarget,
} from './notification-policy.js';

if (process.platform === 'win32' && process.isMainFrame) {
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      const root = document.documentElement;
      const updateAppearance = () => ipcRenderer.send('window:appearance', root.dataset.appearance);
      new MutationObserver(updateAppearance).observe(root, {
        attributeFilter: ['data-appearance'],
      });
      updateAppearance();
    },
    { once: true },
  );
}

let microphoneResetListeners = 0;
contextBridge.exposeInMainWorld(
  'tricordDesktop',
  Object.freeze({
    screens: Object.freeze({
      capabilities: () => ipcRenderer.invoke('screen:capabilities'),
      prepare: (request: unknown) => ipcRenderer.invoke('screen:prepare', request),
      handoff: (request: unknown) => ipcRenderer.invoke('screen:handoff', request),
      cancel: (request: unknown) => ipcRenderer.invoke('screen:cancel', request),
      onStop: (listener: (tag: string, reason?: string) => void) => {
        const callback = (_event: unknown, tag: string, reason?: string) => listener(tag, reason);
        ipcRenderer.on('screen:stop', callback);
        return () => ipcRenderer.removeListener('screen:stop', callback);
      },
      onVisibility: (listener: (visible: boolean) => void) => {
        const callback = (_event: unknown, visible: boolean) => listener(visible);
        ipcRenderer.on('screen:visibility', callback);
        return () => ipcRenderer.removeListener('screen:visibility', callback);
      },
      nativeCommand: (request: unknown) => ipcRenderer.invoke('screen:native-command', request),
      onNativeEvent: (listener: (event: NativeScreenEvent) => void) => {
        const callback = (_event: unknown, event: NativeScreenEvent) => listener(event);
        ipcRenderer.on('screen:native-event', callback);
        return () => ipcRenderer.removeListener('screen:native-event', callback);
      },
    }),
    platform: process.platform,
    version:
      process.argv.find((value) => value.startsWith('--rajcord-version='))?.split('=')[1] ??
      'development',
    onMicrophonePermissionReset: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('microphone:reset', listener);
      if (++microphoneResetListeners === 1) ipcRenderer.send('microphone:reset-listener', true);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener('microphone:reset', listener);
        if (--microphoneResetListeners === 0) ipcRenderer.send('microphone:reset-listener', false);
      };
    },
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
