import type { VoiceController, VoiceState } from './voice-controller';
export type { VoiceChannel, VoiceState } from './voice-controller';
export type { ApprovedVoiceSession } from './voice-session';
export type VoiceScreenSession = Pick<VoiceController, 'bindScreens' | 'onLeaseInvalidated'>;
export type VoiceControls = Pick<
  VoiceController,
  | 'selectInput'
  | 'selectOutput'
  | 'join'
  | 'leave'
  | 'mute'
  | 'deafen'
  | 'resumeAudio'
  | 'volume'
  | 'setOutputVolume'
  | 'setProcessing'
  | 'refreshDevices'
> & { devices(): Promise<void>; joinChannel(id: string): Promise<void> };
export type VoiceDevice = Readonly<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>>;
export type VoiceSnapshot = Readonly<Omit<VoiceState, 'participants' | 'devices'>> & {
  devices: readonly VoiceDevice[];
  participants: readonly Readonly<VoiceState['participants'][number]>[];
};
