// References are not bearer credentials: every operation also checks the current session/lease.
export type CaptureAuthorization = { id: string; remainingMs: number };
export type CaptureSoundChoice = 'none' | 'system';
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
