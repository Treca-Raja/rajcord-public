import { createContext, useContext } from 'react';
import type { VoiceControls, VoiceDevice, VoiceSnapshot } from '../features/voice/contracts';
import type { ScreenControls } from '../features/screen-sharing/contracts';
export type { VoiceControls, VoiceDevice } from '../features/voice/contracts';
export type Call = Readonly<{
  voice: VoiceSnapshot;
  devices: readonly VoiceDevice[];
  controls: VoiceControls;
  subscribeVoice(listener: (voice: VoiceSnapshot) => void): () => void;
  screens?: ScreenControls;
}>;
export const CallContext = createContext<Call | null>(null);

export function useCall() {
  return useContext(CallContext);
}
