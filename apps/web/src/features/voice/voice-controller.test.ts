import { it, expect, vi, afterEach } from 'vitest';
import { VoiceController, concreteDevices } from './voice-controller';
const controllers: VoiceController[] = [];
function setup(request = vi.fn().mockResolvedValue({ ok: true })) {
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn().mockResolvedValue([]),
    getUserMedia: vi.fn(),
  });
  vi.stubGlobal('navigator', { mediaDevices: media });
  const controller = new VoiceController(request);
  controllers.push(controller);
  return { controller, media, request };
}
afterEach(() => {
  controllers.forEach((c) => c.dispose());
  controllers.length = 0;
  vi.unstubAllGlobals();
});
it('device lists exclude automatic default and communications aliases', () => {
  const devices = ['default', 'communications', 'real-mic'].map(
    (deviceId) => ({ kind: 'audioinput', deviceId }) as MediaDeviceInfo,
  );
  expect(concreteDevices(devices, 'audioinput').map((d) => d.deviceId)).toEqual(['real-mic']);
});
it('voice requires explicit device choices and does not capture on construction', async () => {
  const { controller, media } = setup();
  await expect(controller.join('room')).rejects.toThrow('Select');
  expect(media.getUserMedia).not.toHaveBeenCalled();
});
it('manual leave cancels a pending join and revokes the late reservation', async () => {
  let resolve!: (value: unknown) => void;
  const request = vi.fn().mockImplementation((path: string) =>
    path === '/voice/join'
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve({ ok: true }),
  );
  const { controller, media } = setup(request);
  controller.update({ input: 'mic', output: 'speaker' });
  const join = controller.join('room');
  await controller.leave();
  resolve({ id: 'lease', credential: 'lease', channelId: 'room' });
  await join;
  expect(controller.state.status).toBe('idle');
  expect(request).toHaveBeenCalledWith('/voice/leave', 'POST', { leaseId: 'lease' });
  expect(media.getUserMedia).not.toHaveBeenCalled();
});
it('device removal flags both selected devices without capturing replacements', async () => {
  const { controller, media } = setup();
  controller.update({ input: 'missing-mic', output: 'missing-speaker' });
  media.dispatchEvent(new Event('devicechange'));
  await vi.waitFor(() => expect(controller.state.inputMissing).toBe(true));
  expect(controller.state.outputMissing).toBe(true);
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(controller.state.input).toBe('missing-mic');
});
it('deafen preserves the manual mute preference', async () => {
  const { controller } = setup();
  await controller.mute();
  expect(controller.state.muted).toBe(false);
  await controller.deafen();
  expect(controller.state.deafened).toBe(true);
  expect(controller.state.muted).toBe(false);
  await controller.deafen();
  expect(controller.state.deafened).toBe(false);
  expect(controller.state.muted).toBe(false);
});
