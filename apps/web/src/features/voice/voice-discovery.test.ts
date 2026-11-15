import { afterEach, expect, it, vi } from 'vitest';
import { VoiceController } from './voice-controller';

const controllers: VoiceController[] = [];
function device(kind: MediaDeviceKind, deviceId: string, label = deviceId): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) };
}
const inventory = [device('audioinput', 'mic'), device('audiooutput', 'speaker')];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function probe() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}
function setup() {
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn().mockResolvedValue(inventory),
    getUserMedia: vi.fn(),
  });
  vi.stubGlobal('navigator', { mediaDevices: media });
  const request = vi.fn().mockResolvedValue({ ok: true });
  const controller = new VoiceController(request);
  controllers.push(controller);
  return { controller, media, request };
}
afterEach(() => {
  controllers.forEach((controller) => controller.dispose());
  controllers.length = 0;
  vi.unstubAllGlobals();
});

it('passively discovers concrete devices without capture, selection or joining', async () => {
  const { controller, media, request } = setup();
  media.enumerateDevices.mockResolvedValue([
    ...inventory,
    device('audioinput', 'default'),
    device('audiooutput', 'communications'),
    device('videoinput', 'camera'),
  ]);
  const refresh = controller.refreshDevices();
  expect(controller.state.devicesStatus).toBe('loading');
  await refresh;
  expect(controller.state.devices).toEqual(inventory);
  expect(controller.state.devicesStatus).toBe('ready');
  expect(controller.state.input).toBe('');
  expect(controller.state.output).toBe('');
  expect(controller.state.status).toBe('idle');
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { devices: [] },
  { devices: [device('audioinput', 'mic', '')] },
  { devices: [device('audioinput', '', '')] },
])(
  'explains hidden, empty or unlabeled devices without requesting permission: %j',
  async ({ devices }) => {
    const { controller, media } = setup();
    media.enumerateDevices.mockResolvedValue(devices);
    await controller.refreshDevices();
    expect(controller.state.devicesStatus).toBe('permission-needed');
    expect(controller.state.devicesError).toContain('Allow microphone access');
    expect(media.getUserMedia).not.toHaveBeenCalled();
  },
);

it('explains a missing device kind when the visible devices are labeled', async () => {
  const { controller, media } = setup();
  media.enumerateDevices.mockResolvedValue([inventory[0]]);
  await controller.refreshDevices();
  expect(controller.state.devicesError).toContain('No speakers');
  expect(controller.state.devicesStatus).toBe('ready');
});

it('requests microphone-only permission explicitly and stops every temporary track', async () => {
  const { controller, media } = setup();
  const capture = probe();
  media.getUserMedia.mockResolvedValue(capture.stream);
  media.enumerateDevices.mockImplementation(async () => {
    capture.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
    return inventory;
  });
  await controller.devices();
  expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
  expect(controller.state.devicesStatus).toBe('ready');
  expect(controller.state.input).toBe('');
});

it('stops temporary tracks even when enumeration fails and a passive retry recovers', async () => {
  const { controller, media } = setup();
  const capture = probe();
  media.getUserMedia.mockResolvedValue(capture.stream);
  media.enumerateDevices.mockRejectedValueOnce(new Error('Device API unavailable'));
  await controller.devices();
  capture.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
  expect(controller.state.devicesStatus).toBe('error');
  expect(controller.state.devicesError).toContain('Device API unavailable');
  await controller.refreshDevices();
  expect(controller.state.devicesStatus).toBe('ready');
  expect(controller.state.devicesError).toBe('');
  expect(media.getUserMedia).toHaveBeenCalledOnce();
});

it('denied permission stays actionable and explicit retry can recover', async () => {
  const { controller, media, request } = setup();
  media.getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
  await controller.devices();
  expect(controller.state.devicesStatus).toBe('permission-needed');
  expect(controller.state.devicesError).toContain('privacy settings');
  expect(media.enumerateDevices).not.toHaveBeenCalled();
  const capture = probe();
  media.getUserMedia.mockResolvedValue(capture.stream);
  await controller.devices();
  expect(controller.state.devicesStatus).toBe('ready');
  expect(request).not.toHaveBeenCalled();
});

it('unavailable media APIs report a retryable error without looping', async () => {
  const { controller } = setup();
  vi.stubGlobal('navigator', {});
  await controller.devices();
  expect(controller.state.devicesStatus).toBe('error');
  expect(controller.state.devicesError).toContain('localhost or HTTPS');
});

it('coalesces overlapping passive refreshes and consent requests into one probe', async () => {
  const { controller, media } = setup();
  const pendingProbe = deferred<MediaStream>();
  const pendingInventory = deferred<MediaDeviceInfo[]>();
  const capture = probe();
  media.getUserMedia.mockReturnValue(pendingProbe.promise);
  media.enumerateDevices.mockReturnValue(pendingInventory.promise);
  const first = controller.devices();
  expect(controller.devices()).toBe(first);
  expect(controller.refreshDevices()).toBe(first);
  pendingProbe.resolve(capture.stream);
  await vi.waitFor(() => expect(media.enumerateDevices).toHaveBeenCalledOnce());
  expect(controller.devices()).toBe(first);
  pendingInventory.resolve(inventory);
  await first;
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(media.enumerateDevices).toHaveBeenCalledOnce();
});

it('consent during a passive scan supersedes its stale results without losing the probe', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaDeviceInfo[]>();
  const capture = probe();
  media.enumerateDevices.mockReturnValueOnce(pending.promise);
  media.getUserMedia.mockResolvedValue(capture.stream);
  const refresh = controller.refreshDevices();
  expect(controller.devices()).toBe(refresh);
  pending.resolve([]);
  await refresh;
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(controller.state.devices).toEqual(inventory);
  expect(controller.state.devicesStatus).toBe('ready');
});

it('coalesces hot-plug bursts and prevents stale inventory from marking valid selections missing', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaDeviceInfo[]>();
  controller.update({ input: 'mic', output: 'speaker', muted: false, deafened: true });
  media.enumerateDevices.mockReturnValueOnce(pending.promise);
  const refresh = controller.refreshDevices();
  for (let i = 0; i < 30; i++) media.dispatchEvent(new Event('devicechange'));
  const latest = [...inventory, device('audioinput', 'usb')];
  media.enumerateDevices.mockResolvedValue(latest);
  pending.resolve([]);
  await refresh;
  expect(media.enumerateDevices).toHaveBeenCalledTimes(2);
  expect(controller.state.devices).toEqual([inventory[0], latest[2], inventory[1]]);
  expect(controller.state.inputMissing).toBe(false);
  expect(controller.state.outputMissing).toBe(false);
  expect(controller.state.input).toBe('mic');
  expect(controller.state.output).toBe('speaker');
  expect(controller.state.muted).toBe(false);
  expect(controller.state.deafened).toBe(true);
  expect(media.getUserMedia).not.toHaveBeenCalled();
});

it('ignores a superseded scan failure when a device event requests fresh inventory', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaDeviceInfo[]>();
  media.enumerateDevices.mockReturnValueOnce(pending.promise);
  const refresh = controller.refreshDevices();
  media.dispatchEvent(new Event('devicechange'));
  pending.reject(new Error('Obsolete failure'));
  await refresh;
  expect(controller.state.devicesStatus).toBe('ready');
  expect(controller.state.devicesError).toBe('');
});

it('failed enumeration retains inventory and selections rather than assuming device loss', async () => {
  const { controller, media } = setup();
  await controller.refreshDevices();
  controller.update({ input: 'mic', output: 'speaker' });
  media.enumerateDevices.mockRejectedValueOnce(new Error('Temporary failure'));
  await controller.refreshDevices();
  expect(controller.state.devices).toEqual(inventory);
  expect(controller.state.inputMissing).toBe(false);
  expect(controller.state.outputMissing).toBe(false);
  expect(controller.state.devicesError).toContain('Temporary failure');
});

it('a removed device stays missing after replug until explicitly selected again', async () => {
  const { controller, media } = setup();
  controller.update({ input: 'mic', output: 'speaker' });
  media.enumerateDevices.mockResolvedValueOnce([inventory[1]]);
  await controller.refreshDevices();
  expect(controller.state.inputMissing).toBe(true);
  await expect(controller.join('room')).rejects.toThrow('available microphone');
  await controller.refreshDevices();
  expect(controller.state.inputMissing).toBe(true);
  await controller.selectInput('mic');
  expect(controller.state.inputMissing).toBe(false);
  expect(media.getUserMedia).not.toHaveBeenCalled();
});

it('disposal stops a late consent probe, removes the listener and prevents further scans', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaStream>();
  const capture = probe();
  media.getUserMedia.mockReturnValue(pending.promise);
  const remove = vi.spyOn(media, 'removeEventListener');
  const discovery = controller.devices();
  controller.dispose();
  const state = controller.state;
  const changed = vi.fn();
  controller.onChange = changed;
  pending.resolve(capture.stream);
  await discovery;
  await controller.refreshDevices();
  media.dispatchEvent(new Event('devicechange'));
  expect(remove).toHaveBeenCalledWith('devicechange', expect.any(Function));
  capture.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
  expect(media.enumerateDevices).not.toHaveBeenCalled();
  expect(controller.state).toBe(state);
  expect(changed).not.toHaveBeenCalled();
});

it('late inventory after logout/disposal cannot restore devices or notify the UI', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaDeviceInfo[]>();
  media.enumerateDevices.mockReturnValue(pending.promise);
  const refresh = controller.refreshDevices();
  controller.dispose();
  const changed = vi.fn();
  controller.onChange = changed;
  pending.resolve(inventory);
  await refresh;
  expect(controller.state.devices).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
});

it('device changes during consent still use one probe and enumerate only the latest inventory', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaStream>();
  const capture = probe();
  media.getUserMedia.mockReturnValue(pending.promise);
  const discovery = controller.devices();
  media.dispatchEvent(new Event('devicechange'));
  media.dispatchEvent(new Event('devicechange'));
  pending.resolve(capture.stream);
  await discovery;
  capture.tracks.forEach((track) => expect(track.stop).toHaveBeenCalledOnce());
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(media.enumerateDevices).toHaveBeenCalledOnce();
  expect(controller.state.devices).toEqual(inventory);
});

it('a denied late probe after disposal cannot report an obsolete permission failure', async () => {
  const { controller, media } = setup();
  const pending = deferred<MediaStream>();
  media.getUserMedia.mockReturnValue(pending.promise);
  const discovery = controller.devices();
  controller.dispose();
  const changed = vi.fn();
  controller.onChange = changed;
  pending.reject(new DOMException('Denied', 'NotAllowedError'));
  await discovery;
  expect(controller.state.devicesError).toBe('');
  expect(changed).not.toHaveBeenCalled();
});
