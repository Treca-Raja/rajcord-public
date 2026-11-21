// Picker-only DTOs. Raw IDs, NativeImage, and frame identity stay in main; bounded local previews
// may cross this bridge as data URLs for the isolated source picker only.
export const DESKTOP_CAPTURE_PROTOCOL_VERSION = 1;
export type DesktopCaptureSound = 'none' | 'system' | 'application' | 'source';
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
  sound?: DesktopCaptureSound;
  sources: {
    handle: string;
    label: string;
    kind: 'screen' | 'window';
    sounds: DesktopCaptureSound[];
    previewDataUrl?: string;
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
export type DesktopScreenPreparation = {
  clientIntentRef: string;
  epoch: string;
  sound: DesktopCaptureSound;
};
export type DesktopScreenStatus = {
  clientIntentRef: string;
  ready: boolean;
  remainingMs: number;
  error?: string;
};
export interface DesktopScreenBridge {
  capabilities(): Promise<{
    version: 1;
    systemSound: boolean;
    applicationSound?: boolean;
    sourceSound?: boolean;
  }>;
  prepare(request: DesktopScreenPreparation): Promise<DesktopScreenStatus>;
  handoff(request: {
    clientIntentRef: string;
    shareId: string;
    sourceGeneration: number;
  }): Promise<DesktopScreenStatus>;
  cancel(request: { clientIntentRef: string }): Promise<void>;
  onStop(listener: (clientIntentRef: string) => void): () => void;
  onVisibility(listener: (visible: boolean) => void): () => void;
}
