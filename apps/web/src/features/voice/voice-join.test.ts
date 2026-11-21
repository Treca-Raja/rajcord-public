import { expect, it } from 'vitest';
import { joinDevices } from './voice-join';
const device = (kind: MediaDeviceKind, deviceId: string, groupId: string) =>
  ({ kind, deviceId, groupId }) as MediaDeviceInfo;
const devices = [
  device('audioinput', 'default', 'mic-group'),
  device('audioinput', 'mic', 'mic-group'),
  device('audioinput', 'other-mic', 'other-group'),
  device('audiooutput', 'default', 'speaker-group'),
  device('audiooutput', 'speaker', 'speaker-group'),
];
it('resolves system defaults to concrete devices and respects saved choices', () => {
  expect(joinDevices(devices, { input: '', output: '' })).toEqual({
    input: 'mic',
    output: 'speaker',
  });
  expect(joinDevices(devices, { input: 'other-mic', output: 'speaker' })).toEqual({
    input: 'other-mic',
    output: 'speaker',
  });
});
it('does not substitute a default for a missing saved device', () => {
  expect(() => joinDevices(devices, { input: 'removed', output: 'speaker' })).toThrow(
    'unavailable',
  );
});
it('accepts a unique concrete device but refuses ambiguous choices and empty catalogs', () => {
  expect(
    joinDevices(
      devices.filter((d) => !['default', 'other-mic'].includes(d.deviceId)),
      { input: '', output: '' },
    ),
  ).toEqual({ input: 'mic', output: 'speaker' });
  expect(() =>
    joinDevices(
      devices.filter((d) => d.deviceId !== 'default'),
      { input: '', output: '' },
    ),
  ).toThrow('Choose');
  expect(() => joinDevices([], { input: '', output: '' })).toThrow('Choose');
});
