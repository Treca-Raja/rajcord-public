import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopCapturePickerBridge,
  DesktopPickerAck,
  DesktopPickerSnapshot,
} from '@tricord/shared' with {
  'resolution-mode': 'import',
};

async function invoke<T>(channel: string, ...args: unknown[]): Promise<DesktopPickerAck<T>> {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}
if (
  process.isMainFrame &&
  process.sandboxed &&
  process.contextIsolated &&
  location.protocol === 'file:'
) {
  const bridge = Object.freeze<DesktopCapturePickerBridge>({
    getSources: () => invoke<DesktopPickerSnapshot>('screen-picker:sources'),
    select: (choice) => invoke<{ selected: true }>('screen-picker:select', choice),
    cancel: (request) => invoke<{ cancelled: true }>('screen-picker:cancel', request),
  });
  contextBridge.exposeInMainWorld('rajcordCapturePicker', bridge);
}
