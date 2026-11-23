import { SCREEN_RENEWAL_PAGE_SIZE } from './screen.js';

// A native authorization poll replaces the whole set atomically. Keep it within one
// existing renewal page and a bounded HTTP body, including worst-case answer hashes.
export const NATIVE_VIEWER_GRANT_BATCH_SIZE = SCREEN_RENEWAL_PAGE_SIZE;
export const NATIVE_VIEWER_GRANT_RESPONSE_BYTES = 32 * 1024;
export const NATIVE_VIEWER_GRANT_VERSION = 2;

// References are not bearer credentials: every operation also checks the current session/lease.
export type CaptureAuthorization = { id: string; remainingMs: number };
export type NativeViewerSnapshot = {
  viewers: { id: string; remainingMs: number; answerHash: string | null }[];
  iceServers: import('./screen.js').ScreenIceServer[];
};
export type CaptureSoundChoice = 'none' | 'system' | 'application' | 'source';
export type CapturePreparationRequest = {
  requestId: string;
  epoch: string;
  sound: CaptureSoundChoice;
};
export type CaptureAuthorityOperation =
  | 'prepare'
  | 'check'
  | 'consume'
  | 'cancel'
  | 'handoff'
  | 'publication-check'
  | 'publication-cancel';
