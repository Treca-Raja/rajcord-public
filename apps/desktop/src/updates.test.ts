import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
const state = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  prompt: vi.fn(),
  openPath: vi.fn(),
  quit: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  quitGuards: [] as (() => boolean)[],
  listeners: {} as Record<string, () => void>,
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    once: vi.fn(),
    getAppPath: () => 'C:/Rajcord/app.asar',
    quit: state.quit,
  },
  dialog: { showMessageBox: state.prompt },
  shell: { openPath: state.openPath },
}));
vi.mock('node:fs', () => ({ default: { readFileSync: state.read, writeFileSync: state.write } }));
vi.mock('./manifest-update-feed.js', () => ({ configureManifestUpdateFeed: vi.fn() }));
vi.mock('./update-signature.js', () => ({ verifyUpdateSignature: state.verify }));
vi.mock('./update-installer.js', () => ({
  RecoverableNsisUpdater: function (mayQuit: () => boolean) {
    state.quitGuards.push(mayQuit);
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
  state.quitGuards = [];
  state.read.mockReturnValue(
    'provider: github\nowner: Treca-Raja\nrepo: rajcord-public\npublisherName: CN=Trusted\n',
  );
  state.prompt.mockResolvedValue({ response: 1 });
  state.openPath.mockResolvedValue('');
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
  state.read.mockReturnValue('provider: github\nowner: Treca-Raja\nrepo: rajcord-public');
  await configureUpdates(vi.fn()).check();
  expect(state.create).not.toHaveBeenCalled();
  expect(state.prompt).toHaveBeenCalled();
});
it('checks for updates after startup and prompts for consent on a later scheduled check', async () => {
  updater.checkForUpdates.mockResolvedValueOnce(null);
  state.prompt.mockResolvedValue({ response: 0 });
  configureUpdates(vi.fn());

  await vi.advanceTimersByTimeAsync(29_999);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(state.prompt).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 30_000);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(state.prompt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ title: 'Rajcord update', buttons: ['Later', 'Download'] }),
  );
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});

const manifestInstaller = 'C:/cache/Rajcord-Setup-0.1.2-x64.exe';

function setupManifestDownload() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const bytes = 'verified installer';
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  state.read
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('Missing app-update.yml'), { code: 'ENOENT' });
    })
    .mockReturnValueOnce(JSON.stringify({ rajcordUpdatePublicKey: key }))
    .mockReturnValue(bytes);
  updater.checkForUpdates.mockImplementation(async () => {
    state.listeners['update-available']?.();
    return { updateInfo: { version: '0.1.2', files: [{ sha512 }] } };
  });
  updater.downloadUpdate.mockResolvedValue([manifestInstaller]);
}

it('downloads and opens a verified manifest update after one explicit confirmation', async () => {
  setupManifestDownload();
  const prepare = vi.fn();
  const progress = vi.fn();
  await configureUpdates(prepare, vi.fn(), progress).check();

  expect(state.prompt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ buttons: ['Later', 'Download and install'] }),
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(state.write).toHaveBeenCalledExactlyOnceWith(
    manifestInstaller + ':Zone.Identifier',
    '[ZoneTransfer]\r\nZoneId=3\r\n',
  );
  expect(state.openPath).toHaveBeenCalledExactlyOnceWith(manifestInstaller);
  expect(state.quit).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(progress.mock.calls).toEqual([[2], [-1]]);
});

it('rejects incorrect downloaded bytes or a renamed cached installer', async () => {
  setupManifestDownload();
  updater.downloadUpdate
    .mockImplementationOnce(async () => {
      state.read.mockReturnValue('altered download');
      return [manifestInstaller];
    })
    .mockResolvedValueOnce(['C:/cache/replacement.cmd']);
  const prepare = vi.fn();
  const updates = configureUpdates(prepare);
  await updates.check();
  state.read.mockReturnValue('verified installer');
  await updates.check();
  expect(prepare).not.toHaveBeenCalled();
  expect(state.openPath).not.toHaveBeenCalled();
});

it('rejects an installer changed during shutdown preparation', async () => {
  setupManifestDownload();
  const failed = vi.fn();
  await configureUpdates(async () => {
    state.read.mockReturnValue('changed installer');
  }, failed).check();
  expect(state.openPath).not.toHaveBeenCalled();
  expect(state.quit).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledOnce();
});

it('keeps Rajcord open when Windows declines to launch the installer', async () => {
  setupManifestDownload();
  state.openPath.mockResolvedValue('Operation blocked');
  const failed = vi.fn();
  await configureUpdates(vi.fn(), failed).check();
  expect(state.openPath).toHaveBeenCalledOnce();
  expect(state.quit).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledOnce();
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

it('allows retrying the verified update after session preparation fails', async () => {
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(new Error('cleanup failed'))
    .mockResolvedValue(undefined);
  const failed = vi.fn();
  const updates = configureUpdates(prepare, failed);
  await updates.check();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledOnce();
  expect(state.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: 'Rajcord could not prepare to install the update. Please try again.',
    }),
  );

  await updates.install();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  expect(state.verify).toHaveBeenCalledTimes(3);
});

it('releases the operation guard when the restart dialog fails', async () => {
  state.prompt
    .mockResolvedValueOnce({ response: 1 })
    .mockRejectedValueOnce(new Error('dialog failed'));
  const prepare = vi.fn();
  const updates = configureUpdates(prepare);
  await updates.check();
  expect(prepare).not.toHaveBeenCalled();
  await updates.install();
  expect(prepare).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).toHaveBeenCalledOnce();
});

it('reports a synchronous installer failure and rechecks before retrying with a fresh updater', async () => {
  const failed = vi.fn();
  updater.quitAndInstall.mockImplementationOnce(() => {
    throw new Error('launch failed');
  });
  const updates = configureUpdates(vi.fn(), failed);
  await updates.check();
  expect(failed).toHaveBeenCalledOnce();
  expect(state.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: 'The update installer failed. Check for updates and try again.',
    }),
  );

  const replacement = { ...updater, quitAndInstall: vi.fn() };
  state.create.mockReturnValueOnce(replacement);
  await updates.check();
  expect(state.create).toHaveBeenCalledTimes(2);
  expect(replacement.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(replacement.downloadUpdate).toHaveBeenCalledTimes(2);
  expect(replacement.quitAndInstall).toHaveBeenCalledWith(false, true);
});

it('reports installer error events after quitAndInstall returns and permits a fresh checked retry', async () => {
  const failed = vi.fn();
  const updates = configureUpdates(vi.fn(), failed);
  await updates.check();
  const previousQuitAllowed = state.quitGuards[0]!;
  expect(previousQuitAllowed()).toBe(true);
  const previousError = state.listeners['error']!;
  previousError();
  expect(previousQuitAllowed()).toBe(false);
  expect(failed).toHaveBeenCalledOnce();
  expect(state.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({
      message: 'The update installer failed. Check for updates and try again.',
    }),
  );

  const replacement = { ...updater, quitAndInstall: vi.fn() };
  state.create.mockReturnValueOnce(replacement);
  await updates.check();
  expect(state.quitGuards[1]!()).toBe(true);
  expect(previousQuitAllowed()).toBe(false);
  expect(state.create).toHaveBeenCalledTimes(2);
  expect(replacement.quitAndInstall).toHaveBeenCalledOnce();
  previousError();
  expect(failed).toHaveBeenCalledOnce();
});
