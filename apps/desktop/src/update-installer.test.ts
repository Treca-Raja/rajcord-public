import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ install: vi.fn(), quit: vi.fn(), beforeQuit: vi.fn() }));
vi.mock('electron', () => ({ app: { quit: state.quit }, autoUpdater: { emit: state.beforeQuit } }));
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    NsisUpdater: class extends EventEmitter {
      autoRunAppAfterInstall = true;
      install(...args: unknown[]) {
        return state.install(...args);
      }
    },
  };
});
import { RecoverableNsisUpdater } from './update-installer';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.install.mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

it("suppresses a failed attempt's queued quit and permits a fresh successful retry", async () => {
  let active: RecoverableNsisUpdater | undefined;
  const first: RecoverableNsisUpdater = new RecoverableNsisUpdater(() => active === first);
  active = first;
  first.on('error', () => {
    active = undefined;
  });
  state.install.mockImplementationOnce(() => {
    // Match v6's launch error arriving after doInstall returns true, before
    // BaseUpdater's setImmediate quit callback executes.
    void Promise.resolve().then(() => first.emit('error', new Error('spawn failed')));
    return true;
  });
  first.quitAndInstall(false, true);
  await Promise.resolve();
  vi.runAllTimers();
  expect(state.quit).not.toHaveBeenCalled();
  expect(state.beforeQuit).not.toHaveBeenCalled();

  const retry: RecoverableNsisUpdater = new RecoverableNsisUpdater(() => active === retry);
  active = retry;
  retry.quitAndInstall(false, true);
  vi.runAllTimers();
  expect(state.quit).toHaveBeenCalledOnce();
  expect(state.beforeQuit).toHaveBeenCalledWith('before-quit-for-update');
});

it('preserves installation flags and never quits when installation is refused', () => {
  const updater = new RecoverableNsisUpdater(() => true);
  const failed = vi.fn();
  updater.on('error', failed);
  updater.autoRunAppAfterInstall = false;
  state.install.mockReturnValue(false);
  updater.quitAndInstall(false, true);
  expect(state.install).toHaveBeenLastCalledWith(false, false);
  updater.quitAndInstall(true, true);
  expect(state.install).toHaveBeenLastCalledWith(true, true);
  vi.runAllTimers();
  expect(state.quit).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(2);
});
