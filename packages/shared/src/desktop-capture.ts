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
export const DESKTOP_SCREEN_PROTOCOL_VERSION = 2;
export const OBS_ENCODERS = ['nvenc', 'amf', 'x264'] as const;
export type ObsEncoder = (typeof OBS_ENCODERS)[number];
export type ObsEncoderChoice = 'auto' | ObsEncoder;
export type DesktopScreenPreparation = {
  clientIntentRef: string;
  epoch: string;
  sound: DesktopCaptureSound;
  encoder: ObsEncoderChoice;
};
export type NativeScreenVideo = { width: number; height: number; fps: number; bitrate: number };
export type NativeScreenOperation =
  | {
      op: 'open' | 'restart';
      video: NativeScreenVideo;
      deadline: number;
    }
  | { op: 'local' | 'answer'; sdp: string }
  | { op: 'ice'; candidate: import('./screen.js').ScreenIce }
  | { op: 'quality'; video: NativeScreenVideo }
  | { op: 'lease'; deadline: number }
  | { op: 'close' };
export type NativeScreenCommand = { tag: string; linkId: string } & NativeScreenOperation;
export type NativeScreenEvent = { tag: string; linkId: string } & (
  | { encoder: ObsEncoder }
  | { state: 'connecting' | 'connected' | 'disconnected' | 'failed' }
  | { ice: string; index: number }
);
export type DesktopScreenStatus = {
  clientIntentRef: string;
  ready: boolean;
  remainingMs: number;
  error?: string;
};
export interface DesktopScreenBridge {
  readonly renewsNativeViewerGrants?: true;
  capabilities(): Promise<{
    version: typeof DESKTOP_SCREEN_PROTOCOL_VERSION;
    systemSound: boolean;
    applicationSound?: boolean;
    sourceSound?: boolean;
    obs: { available: boolean; encoders: ObsEncoder[]; reason?: string };
  }>;
  prepare(request: DesktopScreenPreparation): Promise<DesktopScreenStatus>;
  handoff(request: {
    clientIntentRef: string;
    shareId: string;
    sourceGeneration: number;
  }): Promise<DesktopScreenStatus>;
  cancel(request: { clientIntentRef: string }): Promise<void>;
  onStop(listener: (clientIntentRef: string, reason?: string) => void): () => void;
  onVisibility(listener: (visible: boolean) => void): () => void;
  nativeCommand(request: NativeScreenCommand): Promise<string>;
  onNativeEvent(listener: (event: NativeScreenEvent) => void): () => void;
}

export interface LegacyDesktopScreenBridge extends Omit<
  DesktopScreenBridge,
  'capabilities' | 'prepare' | 'nativeCommand' | 'onNativeEvent'
> {
  capabilities(): Promise<{
    version: 1;
    systemSound: boolean;
    applicationSound?: boolean;
    sourceSound?: boolean;
  }>;
  prepare(request: Omit<DesktopScreenPreparation, 'encoder'>): Promise<DesktopScreenStatus>;
  nativeCommand?: never;
  onNativeEvent?: never;
}
