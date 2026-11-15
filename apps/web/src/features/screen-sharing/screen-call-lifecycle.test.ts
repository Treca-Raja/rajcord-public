import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScreenLinkGrant, ScreenQuality, ScreenSelectRequest } from '@tricord/shared';
import { ScreenCall } from './screen-call';
import type { ScreenSocket } from './screen-socket';
import type { OwnedScreenBinding } from './screen-binding';
import type { ScreenReceiveOptions } from './screen-receiver';

const wire = vi.hoisted(() => ({ current: undefined as unknown as ScreenSocket }));
vi.mock('./screen-socket', () => ({ screenSocket: () => wire.current }));
const calls: ScreenCall[] = [],
  drains: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred() {
  let resolve!: () => void, reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  drains.push(resolve);
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('window', {});
});
afterEach(async () => {
  calls.splice(0).forEach((call) => call.dispose());
  drains.splice(0).forEach((drain) => drain());
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture() {
  const epoch = crypto.randomUUID(),
    generation = {},
    invalidations = new Set<() => void>();
  let active = true,
    directoryRevision = 1;
  const binding: OwnedScreenBinding = {
    binding: { epoch, channelId: crypto.randomUUID(), remainingMs: 45000 },
    inspect: () => (active ? { generation, deadline: Date.now() + 45000 } : null),
    onInvalidated: (listener) => {
      invalidations.add(listener);
      return () => {
        invalidations.delete(listener);
      };
    },
    release: vi.fn(() => {
      active = false;
      for (const listener of [...invalidations]) listener();
    }),
    adoptRenewal: vi.fn(),
  };
  const quality: ScreenQuality = {
    profile: 'smooth',
    resolution: 720,
    frameRate: 15,
    videoBitrate: 2000000,
  };
  const share = {
    ...quality,
    id: crypto.randomUUID(),
    publisherId: crypto.randomUUID(),
    sourceGeneration: 1,
    sound: 'none' as const,
  };
  const listeners = new Set<Parameters<ScreenSocket['subscribe']>[0]>();
  const emit = (event: Parameters<Parameters<ScreenSocket['subscribe']>[0]>[0], value: unknown) => {
    for (const listener of [...listeners]) listener(event, value);
  };
  const transport = { cleanup: async () => {}, shares: [share] };
  let grant: ScreenLinkGrant | undefined;
  const command = vi.fn(async (event: string, request: ScreenSelectRequest) => {
    if (event === 'screen:directory')
      return { epoch, revision: directoryRevision, shares: transport.shares };
    if (event === 'screen:select') {
      if (request.shareId === null) {
        await transport.cleanup();
        grant = undefined;
        return null;
      }
      grant = {
        remainingMs: 45000,
        link: {
          id: crypto.randomUUID(),
          shareId: request.shareId,
          publisherId: share.publisherId,
          viewerId: crypto.randomUUID(),
          selectionRevision: request.revision,
          quality,
          videoBitrate: quality.videoBitrate,
        },
      };
      return grant;
    }
    if (event === 'screen:renew') {
      directoryRevision++;
      emit('directory', { epoch, revision: directoryRevision, shares: transport.shares });
      if (grant) emit('link', { epoch, revision: directoryRevision, grant });
      return { remainingMs: 45000, publication: null, links: grant ? [grant] : [] };
    }
    throw new Error('Unexpected fixture command.');
  });
  wire.current = {
    command,
    subscribe: (listener: Parameters<ScreenSocket['subscribe']>[0]) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as ScreenSocket;
  const openIncoming = vi.fn((options: ScreenReceiveOptions) => ({
    stop: vi.fn(() => {
      void options
        .cleanup(
          { epoch, linkId: options.endpoint.linkId },
          'stopped',
          new AbortController().signal,
        )
        .catch(() => {});
    }),
    subscribe: () => () => {},
    adoptRenewal: vi.fn(),
  }));
  const voice = { onLeaseInvalidated: () => () => {}, leave: vi.fn() };
  let nativeVisibility!: (visible: boolean) => void;
  Object.assign(window, {
    tricordDesktop: {
      screens: {
        onStop: () => () => {},
        onVisibility: (listener: (visible: boolean) => void) => {
          nativeVisibility = listener;
          return () => {};
        },
      },
    },
  });
  const call = new ScreenCall({
    attachment: { bind: async () => binding, openIncoming },
    voice,
    capture: {},
    element: () => () => {},
  } as unknown as ConstructorParameters<typeof ScreenCall>[0]);
  calls.push(call);
  await call.watch(share.id, quality);
  const visibility = (visible: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: !visible });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return {
    call,
    binding,
    quality,
    share,
    command,
    transport,
    openIncoming,
    emit,
    visibility,
    nativeVisibility: (visible: boolean) => nativeVisibility(visible),
    voice,
    notice: () => ({ epoch, revision: directoryRevision, grant: grant! }),
  };
}

it('ignores adopted link notices while timed renewals continue without a feedback loop', async () => {
  const f = await fixture();
  f.emit('link', f.notice());
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.command.mock.calls.filter(([event]) => event === 'screen:renew')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.command.mock.calls.filter(([event]) => event === 'screen:renew')).toHaveLength(2);
  expect(f.binding.adoptRenewal).toHaveBeenCalledTimes(2);
  expect(f.openIncoming.mock.results[0]!.value.adoptRenewal).toHaveBeenCalledTimes(2);
  expect(f.call.inspect().error).toBe('');
});

it('preserves watch quality across duplicate hidden and visible notifications', async () => {
  const f = await fixture();
  f.nativeVisibility(false);
  f.visibility(false);
  await flush();
  f.nativeVisibility(true);
  f.visibility(true);
  await flush();
  expect(f.call.inspect()).toMatchObject({ watching: f.share.id, hidden: false, error: '' });
  expect(f.openIncoming).toHaveBeenCalledTimes(2);
  const selections = f.command.mock.calls.filter(
    ([event, request]) => event === 'screen:select' && request.shareId,
  );
  expect(selections).toHaveLength(2);
  expect(selections[1]![1]).toMatchObject({ ...f.quality, revision: 3 });
});

it('waits for the exact hidden selection cleanup before a quick restore resumes', async () => {
  const f = await fixture(),
    cleanup = deferred();
  f.transport.cleanup = () => cleanup.promise;
  f.visibility(false);
  f.visibility(true);
  await flush();
  expect(f.openIncoming).toHaveBeenCalledTimes(1);
  expect(f.call.inspect().error).toBe('');
  cleanup.resolve();
  await flush();
  expect(f.openIncoming).toHaveBeenCalledTimes(2);
  expect(f.call.inspect()).toMatchObject({ watching: f.share.id, hidden: false, error: '' });
  expect(f.voice.leave).not.toHaveBeenCalled();
});

it.each(['stop', 'close', 'binding', 'source', 'hidden', 'dispose'] as const)(
  'does not revive watching after %s while restore awaits cleanup',
  async (change) => {
    const f = await fixture(),
      cleanup = deferred();
    f.transport.cleanup = () => cleanup.promise;
    f.visibility(false);
    f.visibility(true);
    await flush();
    if (change === 'stop') f.call.stopWatching();
    if (change === 'close') f.call.close();
    if (change === 'binding') f.binding.release();
    if (change === 'source') {
      f.transport.shares = [];
      f.emit('directory', { epoch: f.binding.binding.epoch, revision: 2, shares: [] });
    }
    if (change === 'hidden') f.visibility(false);
    if (change === 'dispose') f.call.dispose();
    cleanup.resolve();
    await flush();
    expect(f.openIncoming).toHaveBeenCalledTimes(1);
    expect(f.call.inspect().watching).toBeNull();
  },
);

it('retains one resume intent through repeated quick hide/restore transitions', async () => {
  const f = await fixture(),
    cleanup = deferred();
  f.transport.cleanup = () => cleanup.promise;
  f.visibility(false);
  f.visibility(true);
  await flush();
  f.visibility(false);
  f.visibility(true);
  cleanup.resolve();
  await flush();
  expect(f.openIncoming).toHaveBeenCalledTimes(2);
  expect(f.call.inspect()).toMatchObject({ watching: f.share.id, error: '' });
});

it('surfaces failed hidden-selection cleanup without opening a replacement receiver', async () => {
  const f = await fixture(),
    cleanup = deferred();
  f.transport.cleanup = () => cleanup.promise;
  f.visibility(false);
  f.visibility(true);
  cleanup.reject(new Error('Cleanup rejected.'));
  await flush();
  expect(f.openIncoming).toHaveBeenCalledTimes(1);
  expect(f.call.inspect()).toMatchObject({ watching: null, error: 'Cleanup rejected.' });
});
