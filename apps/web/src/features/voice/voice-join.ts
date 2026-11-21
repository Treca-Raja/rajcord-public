import { concreteDevices, type VoiceState } from './voice-controller';

export function joinDevices(
  devices: readonly MediaDeviceInfo[],
  selected: Pick<VoiceState, 'input' | 'output'>,
): { input: string; output: string } {
  const resolve = (kind: MediaDeviceKind, id: string) => {
    const concrete = concreteDevices(devices, kind);
    if (id) {
      if (!concrete.some((device) => device.deviceId === id))
        throw new Error(
          'A selected audio device is unavailable. Choose it in Voice & audio settings.',
        );
      return id;
    }
    const alias = devices.find((device) => device.kind === kind && device.deviceId === 'default');
    const device = alias?.groupId
      ? concrete.find((device) => device.groupId === alias.groupId)
      : concrete.length === 1
        ? concrete[0]
        : undefined;
    if (!device) throw new Error('Choose your microphone and speakers in Voice & audio settings.');
    return device.deviceId;
  };
  return {
    input: resolve('audioinput', selected.input),
    output: resolve('audiooutput', selected.output),
  };
}
