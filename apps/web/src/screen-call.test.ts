import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScreenCall } from './screen-call';
import { WebScreenCapture } from './screen-capture';
import type { OwnedScreenBinding } from './screen-binding';
import type { ScreenSocket } from './screen-socket';

const wire = vi.hoisted(() => ({ current: undefined as unknown as ScreenSocket }));
vi.mock('./screen-socket', () => ({ screenSocket: () => wire.current }));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const calls: ScreenCall[] = [],
  adapters: WebScreenCapture[] = [],
  drains: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('window', {});
  vi.stubGlobal('RTCPeerConnection', vi.fn());
});
afterEach(async () => {
  calls.splice(0).forEach((call) => call.dispose());
  adapters.splice(0).forEach((adapter) => adapter.dispose());
  drains.splice(0).forEach((drain) => drain());
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture() {
  const epoch = crypto.randomUUID(),
    channelId = crypto.randomUUID(),
    shareId = crypto.randomUUID();
  const published = deferred<unknown>(),
    stopped = deferred<unknown>();
  const generation = {},
    invalidations = new Set<() => void>();
  let active = true;
  const binding: OwnedScreenBinding = {
    binding: Object.freeze({ epoch, channelId, remainingMs: 45000 }),
    inspect: () => (active ? { generation, deadline: Date.now() + 45000 } : null),
    onInvalidated: (listener) => {
      invalidations.add(listener);
      return () => {
        invalidations.delete(listener);
      };
    },
    release: vi.fn(() => {
      if (!active) return;
      active = false;
      for (const listener of [...invalidations]) listener();
    }),
    adoptRenewal: vi.fn(),
  };
  const command = vi.fn(async (event: string) => {
    if (event === 'screen:directory') return { epoch, revision: 1, shares: [] };
    if (event === 'screen:publish') return published.promise;
    if (event === 'screen:stop') return stopped.promise;
    throw new Error('Unexpected fixture command.');
  });
  wire.current = { command, subscribe: () => () => {} } as unknown as ScreenSocket;
  const track = Object.assign(new EventTarget(), {
    kind: 'video',
    readyState: 'live',
    enabled: true,
    label: 'Owned',
    getSettings: () => ({ displaySurface: 'browser', width: 1280, height: 720, frameRate: 60 }),
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  });
  const stream = Object.assign(new EventTarget(), { getTracks: () => [track] });
  const capture = new WebScreenCapture({
    getDisplayMedia: vi.fn(async () => stream as unknown as MediaStream),
  });
  adapters.push(capture);
  const voice = { onLeaseInvalidated: () => () => {}, leave: vi.fn() };
  const call = new ScreenCall({
    attachment: { bind: async () => binding },
    voice,
    capture,
    element: () => () => {},
  } as unknown as ConstructorParameters<typeof ScreenCall>[0]);
  calls.push(call);
  const settings = {
    profile: 'smooth' as const,
    resolution: 720 as const,
    frameRate: 60 as const,
    videoBitrate: 4000000 as const,
    sound: 'none' as const,
  };
  const grant = {
    share: { ...settings, id: shareId, publisherId: crypto.randomUUID(), sourceGeneration: 1 },
    remainingMs: 45000,
  };
  drains.push(() => {
    published.resolve(grant);
    stopped.resolve({ stopped: true });
  });
  await call.prepare(settings);
  await call.choose();
  return { call, command, published, stopped, grant, track, binding, voice, settings };
}
it('stops locally while a publish is unresolved and retains publication/cleanup admission through late settlement', async () => {
  const f = await fixture();
  const work = f.call.publish().catch((error) => error as Error);
  f.call.stopSource();
  expect(f.track.readyState).toBe('ended');
  await expect(f.call.prepare(f.settings)).rejects.toThrow('operation');
  f.published.resolve(f.grant);
  expect(await work).toBeInstanceOf(Error);
  expect(f.command).toHaveBeenCalledWith('screen:stop', {
    epoch: f.binding.binding.epoch,
    shareId: f.grant.share.id,
  });
  await expect(f.call.prepare(f.settings)).rejects.toThrow('operation');
  f.stopped.resolve({ stopped: true });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await f.call.prepare(f.settings);
  expect(f.voice.leave).not.toHaveBeenCalled();
});
it('retires only the screen binding after a lost publish acknowledgement instead of renewing orphan metadata', async () => {
  const f = await fixture(),
    work = f.call.publish().catch((error) => error as Error);
  f.published.reject(new Error('No acknowledgement'));
  expect(await work).toBeInstanceOf(Error);
  expect(f.track.readyState).toBe('ended');
  expect(f.binding.release).toHaveBeenCalledTimes(1);
  expect(f.call.inspect().phase).toBe('idle');
  expect(f.voice.leave).not.toHaveBeenCalled();
  expect(RTCPeerConnection).not.toHaveBeenCalled();
});
it('rejects a bare share acknowledgement and never creates peers before a publication proof', async () => {
  const f = await fixture(),
    work = f.call.publish().catch((error) => error as Error);
  f.published.resolve(f.grant.share);
  expect(await work).toBeInstanceOf(Error);
  expect(f.binding.release).toHaveBeenCalledTimes(1);
  expect(RTCPeerConnection).not.toHaveBeenCalled();
  expect(f.voice.leave).not.toHaveBeenCalled();
  expect(Object.isFrozen(f.call.inspect())).toBe(true);
  expect(Object.isFrozen(f.call.inspect().shares)).toBe(true);
});
