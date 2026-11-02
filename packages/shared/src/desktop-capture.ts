// Picker-only DTOs. No raw desktop source ID, NativeImage, or frame identity crosses this bridge.
export const DESKTOP_CAPTURE_PROTOCOL_VERSION = 1;
export type DesktopCaptureSound = 'none' | 'system';
export type DesktopCaptureChoice = {
  requestId: string;
  handle: string;
  sound: DesktopCaptureSound;
};
export type DesktopCaptureCancel = { requestId: string };
export type DesktopPickerSnapshot = {
  version: typeof DESKTOP_CAPTURE_PROTOCOL_VERSION;
  requestId: string;
  remainingMs: number;
  sources: {
    handle: string;
    label: string;
    kind: 'screen' | 'window';
    sounds: DesktopCaptureSound[];
  }[];
};
export type DesktopCaptureCode = 'invalid' | 'not_authorized' | 'busy' | 'stale' | 'unavailable';
export type DesktopPickerAck<T> = { ok: true; data: T } | { ok: false; code: DesktopCaptureCode };
// Future local picker preload only; this is not part of the remote application's desktop bridge.
export interface DesktopCapturePickerBridge {
  getSources(): Promise<DesktopPickerAck<DesktopPickerSnapshot>>;
  select(choice: DesktopCaptureChoice): Promise<DesktopPickerAck<{ selected: true }>>;
  cancel(request: DesktopCaptureCancel): Promise<DesktopPickerAck<{ cancelled: true }>>;
}
