import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  read: vi.fn(),
  prompt: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  listeners: {} as Record<string, () => void>,
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, once: vi.fn() },
  dialog: { showMessageBox: state.prompt },
}));
vi.mock('node:fs', () => ({ default: { readFileSync: state.read } }));
vi.mock('./update-signature.js', () => ({ verifyUpdateSignature: state.verify }));
vi.mock('electron-updater', () => ({
  NsisUpdater: function () {
    return state.create();
  },
}));
import { configureUpdates } from './updates';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
let updater: {
  on: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  allowDowngrade?: boolean;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'resourcesPath', {
    value: 'C:/Rajcord/resources',
    configurable: true,
  });
  state.listeners = {};
  state.read.mockReturnValue(
    'provider: github\nowner: Treca-Raja\nrepo: tricord-public\npublisherName: CN=Trusted\n',
  );
  state.prompt.mockResolvedValue({ response: 1 });
  state.verify.mockResolvedValue(null);
  updater = {
    on: vi.fn((name, callback) => {
      state.listeners[name] = callback;
    }),
    checkForUpdates: vi.fn(async () => {
      state.listeners['update-available']?.();
      return {};
    }),
    downloadUpdate: vi.fn(async () => ['C:/cache/update.exe']),
    quitAndInstall: vi.fn(),
  };
  state.create.mockReturnValue(updater);
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', originalPlatform);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else Reflect.deleteProperty(process, 'resourcesPath');
});
it('disables updates when the packaged publisher is missing', async () => {
  state.read.mockReturnValue('provider: github\nowner: Treca-Raja\nrepo: tricord-public');
  await configureUpdates(vi.fn()).check();
  expect(state.create).not.toHaveBeenCalled();
  expect(state.prompt).toHaveBeenCalled();
});
it('requires download and restart consent and verifies cached files again before installation', async () => {
  const prepare = vi.fn();
  const updates = configureUpdates(prepare);
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(false);
  expect(updater.allowDowngrade).toBe(false);
  state.prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await updates.check();
  expect(state.verify).toHaveBeenCalledTimes(1);
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  state.verify.mockResolvedValue('tampered');
  await updates.install();
  expect(state.verify).toHaveBeenCalledTimes(2);
  expect(prepare).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
it('prepares session cleanup before explicitly installing a verified download', async () => {
  const prepare = vi.fn();
  await configureUpdates(prepare).check();
  expect(prepare).toHaveBeenCalledOnce();
  expect(state.verify).toHaveBeenCalledTimes(2);
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
    updater.quitAndInstall.mock.invocationCallOrder[0]!,
  );
});
it('never downloads after declined consent or failed detection', async () => {
  const updates = configureUpdates(vi.fn());
  state.prompt.mockResolvedValue({ response: 0 });
  await updates.check();
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  updater.checkForUpdates.mockRejectedValue(new Error('offline'));
  await updates.check();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
it('blocks a cached download that fails signature verification', async () => {
  state.verify.mockResolvedValue('unsigned');
  await configureUpdates(vi.fn()).check();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
it('blocks cached-file replacement even if the replacement has a valid trusted signature', async () => {
  state.prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  const updates = configureUpdates(vi.fn());
  await updates.check();
  state.read.mockReturnValue('different bytes');
  await updates.install();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
