import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ScreenLinkGrant, ScreenQuality, ScreenSelectRequest } from '@tricord/shared';
import { ScreenCall } from './screen-call';
import type { ScreenSocket } from './screen-socket';
import type { OwnedScreenBinding } from './screen-binding';
import type { ScreenReceiveOptions, ScreenReceiveState } from './screen-receiver';
import type { VoiceState } from '../voice/contracts';

const wire = vi.hoisted(() => ({ current: undefined as unknown as ScreenSocket }));
vi.mock('./screen-socket', () => ({ screenSocket: () => wire.current }));
const calls: ScreenCall[] = [],
  drains: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const voiceState = (patch: Partial<VoiceState> = {}): VoiceState => ({
  status: 'connected',
  channelId: 'voice-channel',
  muted: false,
  deafened: false,
  input: 'microphone',
  output: 'headphones',
  outputVolume: 1,
  inputMissing: false,
  outputMissing: false,
  error: '',
  devices: [],
  devicesStatus: 'ready',
  devicesError: '',
  participants: [],
  ...patch,
});
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
  const otherShare = {
    ...share,
    id: crypto.randomUUID(),
    publisherId: crypto.randomUUID(),
  };
  const listeners = new Set<Parameters<ScreenSocket['subscribe']>[0]>();
  const emit = (event: Parameters<Parameters<ScreenSocket['subscribe']>[0]>[0], value: unknown) => {
    for (const listener of [...listeners]) listener(event, value);
  };
  const transport = { cleanup: async () => {}, shares: [share] };
  const grants = new Map<string, ScreenLinkGrant>();
  let grant: ScreenLinkGrant | undefined;
  const command = vi.fn(async (event: string, request: ScreenSelectRequest) => {
    if (event === 'screen:directory')
      return { epoch, revision: directoryRevision, shares: transport.shares };
    if (event === 'screen:select') {
      if (request.shareId === null) {
        await transport.cleanup();
        if (request.mode === 'remove' && request.removeShareId)
          grants.delete(request.removeShareId);
        else grants.clear();
        grant = [...grants.values()].at(-1);
        return null;
      }
      if (request.mode !== 'add') grants.clear();
      const selected = transport.shares.find((item) => item.id === request.shareId);
      if (!selected) throw new Error('Unknown fixture share.');
      grant = {
        remainingMs: 45000,
        link: {
          id: crypto.randomUUID(),
          shareId: request.shareId,
          publisherId: selected.publisherId,
          viewerId: crypto.randomUUID(),
          selectionRevision: request.revision,
          quality,
          videoBitrate: quality.videoBitrate,
        },
      };
      grants.set(selected.id, grant);
      return grant;
    }
    if (event === 'screen:renew') {
      directoryRevision++;
      emit('directory', { epoch, revision: directoryRevision, shares: transport.shares });
      if (grant) emit('link', { epoch, revision: directoryRevision, grant });
      return { remainingMs: 45000, publication: null, links: [...grants.values()] };
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
  const openIncoming = vi.fn((options: ScreenReceiveOptions) => {
    let state: ScreenReceiveState = {
      phase: 'receiving',
      hasVideo: false,
      hasAudio: false,
      playback: null,
      cleanup: { status: 'none', pending: false },
    };
    const listeners = new Set<(state: ScreenReceiveState) => void>();
    const update = (patch: Partial<ScreenReceiveState>) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    };
    return {
      stop: vi.fn(() => {
        void options
          .cleanup(
            { epoch, linkId: options.endpoint.linkId },
            'stopped',
            new AbortController().signal,
          )
          .catch(() => {});
      }),
      inspect: () => state,
      subscribe: (listener: (state: ScreenReceiveState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      update,
      ready: () =>
        update({
          phase: 'ready',
          hasVideo: true,
          hasAudio: true,
          playback: {
            phase: 'idle',
            output: null,
            outputAvailable: false,
            muted: false,
            deafened: false,
            volume: 1,
            pendingNative: false,
            closed: false,
          },
        }),
      setOutput: vi.fn(),
      setDeafened: vi.fn(),
      setMuted: vi.fn(),
      setVolume: vi.fn(),
      play: vi.fn(async () => {}),
      adoptRenewal: vi.fn(),
    };
  });
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
    addShare: () => {
      transport.shares = [...transport.shares, otherShare];
      directoryRevision++;
      emit('directory', { epoch, revision: directoryRevision, shares: transport.shares });
      return otherShare;
    },
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

it.each([18, 19])(
  'bounds combined incoming and outgoing renewal links at eighteen: %s',
  async (count) => {
    const f = await fixture();
    const grant = f.notice().grant;
    f.command.mockResolvedValueOnce({
      remainingMs: 45000,
      publication: null,
      links: [
        grant,
        ...Array.from({ length: count - 1 }, () => ({
          ...grant,
          link: { ...grant.link, id: crypto.randomUUID() },
        })),
      ],
    });
    await vi.advanceTimersByTimeAsync(10100);
    if (count === 18) {
      expect(f.call.inspect()).toMatchObject({ watching: f.share.id, error: '' });
      expect(f.binding.release).not.toHaveBeenCalled();
      expect(f.openIncoming.mock.results[0]!.value.adoptRenewal).toHaveBeenCalledTimes(1);
    } else {
      expect(f.call.inspect().error).toBe('Invalid screen renewal.');
      expect(f.binding.release).toHaveBeenCalledTimes(1);
    }
  },
);

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

it('adds and removes watched streams independently and switches focused layout locally', async () => {
  const f = await fixture(),
    other = f.addShare();
  const initialSelections = f.command.mock.calls.filter(([event]) => event === 'screen:select');
  await f.call.watchMultiple(other.id, f.quality);
  expect(f.call.inspect()).toMatchObject({
    watching: other.id,
    watchingShareIds: [f.share.id, other.id],
    layout: 'focus',
  });
  const add = f.command.mock.calls
    .filter(([event, request]) => event === 'screen:select' && request.shareId === other.id)
    .at(-1);
  expect(add?.[1]).toMatchObject({ mode: 'add', revision: 2 });
  f.call.focusWatch(f.share.id);
  expect(f.call.inspect()).toMatchObject({ watching: f.share.id, layout: 'focus' });
  f.call.zoomOutWatch();
  expect(f.call.inspect().layout).toBe('grid');
  await f.call.watchMultiple(other.id, { ...f.quality, resolution: 480 });
  const revised = f.command.mock.calls
    .filter(([event, request]) => event === 'screen:select' && request.shareId === other.id)
    .at(-1);
  expect(revised?.[1]).toMatchObject({ mode: 'add', resolution: 480 });
  f.call.focusWatch(f.share.id);
  f.call.zoomOutWatch();
  const count = f.command.mock.calls.filter(([event]) => event === 'screen:select').length;
  f.call.stopWatchingShare(other.id);
  await flush();
  expect(f.call.inspect()).toMatchObject({
    watching: f.share.id,
    watchingShareIds: [f.share.id],
    layout: 'grid',
  });
  expect(f.command.mock.calls.filter(([event]) => event === 'screen:select')).toHaveLength(
    count + 1,
  );
  expect(f.command.mock.calls.at(-1)?.[1]).toMatchObject({
    mode: 'remove',
    removeShareId: other.id,
    shareId: null,
  });
  expect(initialSelections).toHaveLength(1);
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

it.each([false, true])(
  'restores every selected stream and grid layout after hidden cleanup, unless stopped: %s',
  async (stop) => {
    const f = await fixture(),
      other = f.addShare(),
      cleanup = deferred();
    await f.call.watchMultiple(other.id, { ...f.quality, resolution: 480 });
    f.call.focusWatch(f.share.id);
    f.call.zoomOutWatch();
    f.transport.cleanup = () => cleanup.promise;
    f.visibility(false);
    f.nativeVisibility(false);
    f.visibility(true);
    f.nativeVisibility(true);
    await flush();
    expect(f.openIncoming).toHaveBeenCalledTimes(2);
    if (stop) f.call.stopWatching();
    cleanup.resolve();
    await flush();
    expect(f.call.inspect()).toMatchObject(
      stop
        ? { watching: null, watchingShareIds: [] }
        : {
            watching: f.share.id,
            watchingShareIds: [f.share.id, other.id],
            layout: 'grid',
            error: '',
          },
    );
    expect(f.openIncoming).toHaveBeenCalledTimes(stop ? 2 : 4);
    if (!stop) {
      const selection = f.command.mock.calls
        .filter(([event, request]) => event === 'screen:select' && request.shareId === other.id)
        .at(-1);
      expect(selection?.[1]).toMatchObject({ mode: 'add', resolution: 480, frameRate: 15 });
    }
  },
);

it('keeps normal call navigation separate from explicit source setup', async () => {
  const f = await fixture();
  await f.call.open();
  expect(f.call.inspect()).toMatchObject({ open: true, setupRequested: false });
  await f.call.open(true);
  expect(f.call.inspect()).toMatchObject({ open: true, setupRequested: true });
});

it('retains stream audio controls across close and reopen and applies them to every new receiver', async () => {
  const f = await fixture();
  f.call.observeVoice(voiceState());
  f.call.mute(true);
  f.call.volume(0.35);
  const first = f.openIncoming.mock.results[0]!.value;
  first.ready();
  expect(first.setMuted).toHaveBeenLastCalledWith(true);
  expect(first.setVolume).toHaveBeenLastCalledWith(0.35);
  expect(first.setOutput).toHaveBeenLastCalledWith('headphones');
  expect(first.setOutput.mock.invocationCallOrder[0]).toBeLessThan(
    first.play.mock.invocationCallOrder[0]!,
  );

  f.call.close();
  await f.call.open();
  await f.call.watch(f.share.id, f.quality);
  const other = f.addShare();
  await f.call.watchMultiple(other.id, f.quality);
  const receivers = f.openIncoming.mock.results.slice(1).map((result) => result.value);
  for (const receiver of receivers) {
    receiver.ready();
    expect(receiver.setMuted).toHaveBeenLastCalledWith(true);
    expect(receiver.setVolume).toHaveBeenLastCalledWith(0.35);
  }
  expect(f.call.inspect()).toMatchObject({ playbackMuted: true, playbackVolume: 0.35 });
  f.call.observeVoice(voiceState({ deafened: true, outputMissing: true }));
  for (const receiver of receivers) {
    expect(receiver.setDeafened).toHaveBeenLastCalledWith(true);
    expect(receiver.setOutput).toHaveBeenLastCalledWith(null);
  }
  f.call.mute(false);
  f.call.volume(0.8);
  for (const receiver of receivers) {
    expect(receiver.setMuted).toHaveBeenLastCalledWith(false);
    expect(receiver.setVolume).toHaveBeenLastCalledWith(0.8);
  }
  expect(f.call.inspect()).toMatchObject({ playbackMuted: false, playbackVolume: 0.8 });
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(first.setVolume).toHaveBeenLastCalledWith(0.35);
});

it('rejects invalid stream volume without changing the retained controls or receiver', async () => {
  const f = await fixture();
  f.call.observeVoice(voiceState());
  const receiver = f.openIncoming.mock.results[0]!.value;
  receiver.ready();
  f.call.volume(0.4);
  const writes = receiver.setVolume.mock.calls.length;
  for (const invalid of [-0.1, 1.1, NaN, Infinity])
    expect(() => f.call.volume(invalid)).toThrow('Invalid screen volume.');
  expect(f.call.inspect().playbackVolume).toBe(0.4);
  expect(receiver.setVolume).toHaveBeenCalledTimes(writes);
});

it.each(['joining', 'reconnecting', 'connected'] as const)(
  'keeps the call view open while voice is %s and closes all watches when voice becomes idle',
  async (status) => {
    const f = await fixture(),
      other = f.addShare();
    await f.call.open();
    await f.call.watchMultiple(other.id, f.quality);
    f.call.observeVoice(voiceState({ status }));
    expect(f.call.inspect().open).toBe(true);
    f.call.observeVoice(voiceState({ status: 'idle', channelId: null }));
    await flush();
    expect(f.call.inspect()).toMatchObject({ open: false, watching: null, watchingShareIds: [] });
    for (const result of f.openIncoming.mock.results)
      expect(result.value.stop).toHaveBeenCalledTimes(1);
    expect(f.voice.leave).not.toHaveBeenCalled();
  },
);

it('does not restore hidden streams when voice becomes idle while cleanup is pending', async () => {
  const f = await fixture(),
    cleanup = deferred();
  await f.call.open();
  f.call.observeVoice(voiceState());
  f.transport.cleanup = () => cleanup.promise;
  f.visibility(false);
  f.visibility(true);
  await flush();
  f.call.observeVoice(voiceState({ status: 'idle', channelId: null }));
  cleanup.resolve();
  await flush();
  expect(f.call.inspect()).toMatchObject({ open: false, watching: null, watchingShareIds: [] });
  expect(f.openIncoming).toHaveBeenCalledTimes(1);
});

it('ignores stale receiver notifications and automatic playback failures after replacement', async () => {
  const f = await fixture(),
    playback = deferred();
  f.call.observeVoice(voiceState());
  const previous = f.openIncoming.mock.results[0]!.value;
  previous.play.mockImplementationOnce(() => playback.promise);
  previous.ready();
  await f.call.watch(f.share.id, f.quality);
  const current = f.openIncoming.mock.results[1]!.value;
  current.ready();
  const before = f.call.inspect();
  previous.update({ phase: 'closed', reason: 'failed' });
  playback.reject(new Error('Previous playback failed.'));
  await flush();
  expect(f.call.inspect()).toEqual(before);
  expect(current.stop).not.toHaveBeenCalled();
});

it('surfaces automatic playback failure while the receiver is still selected', async () => {
  const f = await fixture();
  f.call.observeVoice(voiceState());
  const receiver = f.openIncoming.mock.results[0]!.value;
  receiver.play.mockRejectedValueOnce(new Error('Playback needs user interaction.'));
  receiver.ready();
  await flush();
  expect(f.call.inspect()).toMatchObject({
    watching: f.share.id,
    error: 'Playback needs user interaction.',
  });
});
