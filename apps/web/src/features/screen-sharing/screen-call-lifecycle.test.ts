import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCREEN_RENEWAL_PAGE_SIZE } from '@tricord/shared';
import type {
  ScreenLinkGrant,
  ScreenQuality,
  ScreenRenewal,
  ScreenSelectRequest,
} from '@tricord/shared';
import { ScreenCall } from './screen-call';
import { ScreenPlaybackError } from './screen-playback';
import { ScreenLifetime } from './capture-session';
import type { ScreenSocket } from './screen-socket';
import type { OwnedScreenBinding } from './screen-binding';
import type { ScreenReceiveOptions, ScreenReceiveState } from './screen-receiver';
import type { VoiceState } from '../voice/contracts';
import { screenSdp } from '../../../../api/src/screen/signaling-fixture';

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
  processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  processingApplied: null,
  noiseSuppressionEngine: null,
  processingBusy: false,
  processingError: '',
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
      const renewal: ScreenRenewal = {
        remainingMs: 45000,
        publication: null,
        links: [...grants.values()],
      };
      return renewal;
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

it('automatically reselects a failed incoming stream with its previous quality', async () => {
  const f = await fixture();
  const previous = f.openIncoming.mock.results[0]!.value;
  previous.update({ phase: 'closed', reason: 'failed' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.openIncoming).toHaveBeenCalledTimes(2);
  expect(f.call.inspect().watching).toBe(f.share.id);
  expect(
    f.command.mock.calls
      .filter(
        ([event, request]) =>
          event === 'screen:select' && (request as ScreenSelectRequest).shareId === f.share.id,
      )
      .at(-1)?.[1],
  ).toMatchObject({ ...f.quality, mode: 'add' });
  expect(f.voice.leave).not.toHaveBeenCalled();
});
it('retries a transient renewal timeout without extending authority or discarding healthy watching', async () => {
  const f = await fixture();
  f.command.mockRejectedValueOnce(Object.assign(new Error('Timed out'), { code: 'timeout' }));
  await vi.advanceTimersByTimeAsync(10100);
  expect(f.binding.release).not.toHaveBeenCalled();
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
  expect(f.call.inspect().watching).toBe(f.share.id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.binding.adoptRenewal).toHaveBeenCalledTimes(1);
  expect(f.binding.release).not.toHaveBeenCalled();
});
it('bounds consecutive unavailable renewal retries and retires the binding on exhaustion', async () => {
  const f = await fixture();
  f.command.mockRejectedValue(Object.assign(new Error('Unavailable'), { code: 'unavailable' }));
  await vi.advanceTimersByTimeAsync(12100);
  expect(f.binding.release).toHaveBeenCalledTimes(1);
  expect(f.call.inspect().watching).toBeNull();
});

function firstRenewalPage(grant: ScreenLinkGrant) {
  return {
    remainingMs: 45000,
    publication: null,
    links: Array.from({ length: SCREEN_RENEWAL_PAGE_SIZE }, (_, index) =>
      index ? { ...grant, link: { ...grant.link, id: crypto.randomUUID() } } : grant,
    ),
    nextOffset: SCREEN_RENEWAL_PAGE_SIZE,
  };
}

it('collects 200 grants before adopting either page and retries the same throttled offset', async () => {
  const f = await fixture(),
    first = firstRenewalPage(f.notice().grant);
  const other = f.addShare();
  await f.call.watchMultiple(other.id, f.quality);
  const grant = f.notice().grant;
  f.command
    .mockClear()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(Object.assign(new Error('Busy'), { code: 'throttled' }))
    .mockResolvedValueOnce({
      remainingMs: 44000,
      publication: null,
      links: Array.from({ length: 200 - first.links.length }, (_, i) =>
        i ? { ...grant, link: { ...grant.link, id: crypto.randomUUID() } } : grant,
      ),
    });
  await vi.advanceTimersByTimeAsync(10100);
  const request = f.command.mock.calls[0]![1];
  expect(f.command.mock.calls[1]).toEqual([
    'screen:renew',
    { ...request, offset: first.nextOffset },
  ]);
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
  for (const { value } of f.openIncoming.mock.results)
    expect(value.adoptRenewal).not.toHaveBeenCalled();
  expect(f.call.inspect().watchingShareIds).toEqual([f.share.id, other.id]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.command.mock.calls[2]).toEqual(f.command.mock.calls[1]);
  expect(f.binding.adoptRenewal).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      deadline: 155100,
      revision: request.revision,
    }),
  );
  for (const { value } of f.openIncoming.mock.results)
    expect(value.adoptRenewal).toHaveBeenCalledOnce();
  expect(f.call.inspect().watchingShareIds).toEqual([f.share.id, other.id]);
});

it('restarts a stale continuation from a fresh revision without adopting the partial renewal', async () => {
  const f = await fixture(),
    first = firstRenewalPage(f.notice().grant);
  f.command
    .mockClear()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(Object.assign(new Error('Changed'), { code: 'stale' }));
  await vi.advanceTimersByTimeAsync(10100);
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
  expect(f.binding.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  const requests = f.command.mock.calls.map(([, request]) => request);
  expect(requests[2]).not.toHaveProperty('offset');
  expect(requests[2]!.revision).toBe(requests[0]!.revision + 1);
  expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId);
  expect(f.binding.adoptRenewal).toHaveBeenCalledOnce();
  expect(f.call.inspect().watchingShareIds).toEqual([f.share.id]);
});

it('retires the binding when the caller loses authorization during a continuation', async () => {
  const f = await fixture();
  f.command
    .mockClear()
    .mockResolvedValueOnce(firstRenewalPage(f.notice().grant))
    .mockRejectedValueOnce(Object.assign(new Error('Ended'), { code: 'not_authorized' }));
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.command.mock.calls.filter(([event]) => event === 'screen:renew')).toHaveLength(2);
  expect(f.binding.release).toHaveBeenCalledOnce();
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
});

it('coalesces new viewer notices into a follow-up after an active renewal', async () => {
  const f = await fixture(),
    gate = deferred(),
    life = new ScreenLifetime(Date.now() + 45000);
  const own = { ...f.share, id: crypto.randomUUID(), publisherId: crypto.randomUUID() };
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', { lifecycle: () => life, stop: () => life.stop() });
  const publication = { share: own, remainingMs: 45000 };
  const watched = f.notice().grant;
  const outgoing = () => ({
    remainingMs: 45000,
    link: {
      ...watched.link,
      id: crypto.randomUUID(),
      shareId: own.id,
      publisherId: own.publisherId,
      viewerId: crypto.randomUUID(),
    },
  });
  const first = outgoing(),
    second = outgoing(),
    third = outgoing();
  const open = vi
    .spyOn(
      f.call as unknown as { openPublisher(link: ScreenLinkGrant['link']): Promise<void> },
      'openPublisher',
    )
    .mockResolvedValue();
  f.command
    .mockImplementationOnce(async () => {
      await gate.promise;
      return { remainingMs: 45000, publication, links: [watched, first] };
    })
    .mockResolvedValueOnce({
      remainingMs: 45000,
      publication,
      links: [watched, second, third],
    });
  const renewals = () => f.command.mock.calls.filter(([event]) => event === 'screen:renew');
  await vi.advanceTimersByTimeAsync(10100);
  expect(open).not.toHaveBeenCalled();
  f.emit('link', { ...f.notice(), revision: 2, grant: second });
  f.emit('link', { ...f.notice(), revision: 3, grant: third });
  await vi.advanceTimersByTimeAsync(200);
  expect(renewals()).toHaveLength(1);
  gate.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(renewals()).toHaveLength(2);
  expect(open.mock.calls.map(([link]) => link.id)).toEqual([
    first.link.id,
    second.link.id,
    third.link.id,
  ]);
});

it('paces staggered viewer discovery while admitting all nine authorized links', async () => {
  const f = await fixture();
  const life = new ScreenLifetime(Date.now() + 45000);
  const own = { ...f.share, id: crypto.randomUUID() };
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', { lifecycle: () => life, stop: () => life.stop() });
  const grants: ScreenLinkGrant[] = [];
  const open = vi
    .spyOn(
      f.call as unknown as { openPublisher(link: ScreenLinkGrant['link']): Promise<void> },
      'openPublisher',
    )
    .mockResolvedValue();
  const command = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (event, request) => {
    if (event !== 'screen:renew') return command(event, request);
    return {
      remainingMs: 45000,
      publication: { share: own, remainingMs: 45000 },
      links: [f.notice().grant, ...grants],
    };
  });
  for (let n = 0; n < 9; n++) {
    const grant = {
      remainingMs: 45000,
      link: {
        ...f.notice().grant.link,
        id: crypto.randomUUID(),
        shareId: own.id,
        publisherId: own.publisherId,
        viewerId: crypto.randomUUID(),
      },
    };
    grants.push(grant);
    f.emit('link', { ...f.notice(), grant });
    await vi.advanceTimersByTimeAsync(250);
  }
  const renewals = () => f.command.mock.calls.filter(([event]) => event === 'screen:renew');
  expect(renewals()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(3000);
  expect(renewals()).toHaveLength(3);
  expect(new Set(open.mock.calls.map(([link]) => link.id))).toEqual(
    new Set(grants.map((grant) => grant.link.id)),
  );
});

it('does not reopen an outgoing link closed between renewal pages', async () => {
  const f = await fixture(),
    gate = deferred(),
    life = new ScreenLifetime(Date.now() + 45000);
  const own = { ...f.share, id: crypto.randomUUID(), publisherId: crypto.randomUUID() };
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', { lifecycle: () => life, stop: () => life.stop() });
  const publication = { share: own, remainingMs: 45000 };
  const first = { ...firstRenewalPage(f.notice().grant), publication };
  const closing = { ...first.links[1]!.link, shareId: own.id, publisherId: own.publisherId };
  first.links[1] = { link: closing, remainingMs: 45000 };
  const healthy = { ...closing, id: crypto.randomUUID() };
  const open = vi
    .spyOn(
      f.call as unknown as { openPublisher(link: ScreenLinkGrant['link']): Promise<void> },
      'openPublisher',
    )
    .mockResolvedValue();
  f.command.mockResolvedValueOnce(first as never).mockImplementationOnce(async () => {
    await gate.promise;
    return {
      publication,
      remainingMs: 45000,
      links: [{ link: healthy, remainingMs: 45000 }],
    } as never;
  });
  await vi.advanceTimersByTimeAsync(10100);
  f.emit('closed', {
    epoch: f.binding.binding.epoch,
    revision: 2,
    linkId: closing.id,
    reason: 'ended',
  });
  gate.resolve();
  await flush();
  expect(open.mock.calls.map(([link]) => link)).toEqual([healthy]);
  expect(f.binding.adoptRenewal).toHaveBeenCalledOnce();
  expect(f.call.inspect().watching).toBe(f.share.id);
  open.mockRestore();
});

it('retires a stale initial renewal without requesting another revision', async () => {
  const f = await fixture();
  f.command.mockClear().mockRejectedValueOnce(Object.assign(new Error('Stale'), { code: 'stale' }));
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.command.mock.calls.filter(([event]) => event === 'screen:renew')).toHaveLength(1);
  expect(f.binding.release).toHaveBeenCalledOnce();
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
});

it('rejects a repeated continuation offset before adopting any grants', async () => {
  const f = await fixture(),
    first = firstRenewalPage(f.notice().grant);
  f.command.mockResolvedValueOnce(first).mockResolvedValueOnce(first);
  await vi.advanceTimersByTimeAsync(10100);
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
  expect(f.binding.release).toHaveBeenCalledOnce();
  expect(f.call.inspect().error).toContain('Invalid screen renewal page');
});

it('discards an expired first page even when the last page has a live deadline', async () => {
  const f = await fixture(),
    first = firstRenewalPage(f.notice().grant);
  first.remainingMs = 100;
  const gate = deferred();
  f.command.mockResolvedValueOnce(first).mockImplementationOnce(async () => {
    await gate.promise;
    return {
      remainingMs: 45000,
      publication: null,
      links: [{ ...f.notice().grant, link: { ...f.notice().grant.link, id: crypto.randomUUID() } }],
    };
  });
  await vi.advanceTimersByTimeAsync(10200);
  gate.resolve();
  await flush();
  expect(f.binding.adoptRenewal).not.toHaveBeenCalled();
  expect(f.call.inspect().error).toContain('renewal expired');
});

it('serializes recovery of simultaneously failed watched streams', async () => {
  const f = await fixture(),
    other = f.addShare();
  await f.call.watchMultiple(other.id, f.quality);
  f.openIncoming.mock.results[0]!.value.update({ phase: 'closed', reason: 'failed' });
  f.openIncoming.mock.results[1]!.value.update({ phase: 'closed', reason: 'failed' });
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.openIncoming).toHaveBeenCalledTimes(4);
  expect(new Set(f.call.inspect().watchingShareIds)).toEqual(new Set([f.share.id, other.id]));
  expect(f.call.inspect().error).toBe('');
});

it('does not send compensating cleanup for a selection explicitly rejected by admission', async () => {
  const f = await fixture(),
    other = f.addShare();
  f.command.mockClear();
  f.command.mockRejectedValueOnce(
    Object.assign(new Error('Screen authorization is busy.'), { code: 'throttled' }),
  );
  await expect(f.call.watchMultiple(other.id, f.quality)).rejects.toMatchObject({
    code: 'throttled',
  });
  await flush();
  const selections = f.command.mock.calls.filter(([event]) => event === 'screen:select');
  expect(selections).toHaveLength(1);
  expect(selections[0]![1]).toMatchObject({ shareId: other.id, mode: 'add' });
  expect(f.call.inspect().watching).toBe(f.share.id);
});
it('honors Stop triggered synchronously by a selection-state observer', async () => {
  const f = await fixture(),
    other = f.addShare();
  const unsubscribe = f.call.subscribe(() => {
    if (f.call.inspect().selectingShareId === other.id) f.call.stopWatching();
  });
  await expect(f.call.watch(other.id, f.quality)).rejects.toThrow('selection ended');
  unsubscribe();
  expect(
    f.command.mock.calls.some(
      ([event, request]) =>
        event === 'screen:select' && (request as ScreenSelectRequest).shareId === other.id,
    ),
  ).toBe(false);
  expect(f.call.inspect().watchingShareIds).toEqual([]);
});

it('does not clear a replacement renewal admission when an old request settles', async () => {
  const f = await fixture();
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  drains.push(() => resolve({}));
  f.command.mockImplementationOnce(() => pending as never);
  await vi.advanceTimersByTimeAsync(10100);
  f.binding.release();
  const replacement = {};
  Reflect.set(f.call, 'renewing', replacement);
  resolve({});
  await flush();
  expect(Reflect.get(f.call, 'renewing')).toBe(replacement);
});

it('discards queued offers on Stop and preserves an existing watch', async () => {
  const f = await fixture(),
    gate = deferred(),
    life = new ScreenLifetime(Date.now() + 45000);
  const own = { ...f.share, id: crypto.randomUUID(), publisherId: crypto.randomUUID() };
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', { lifecycle: () => life, stop: () => life.stop() });
  const publisherLink = {
    ...f.notice().grant.link,
    id: crypto.randomUUID(),
    shareId: own.id,
    publisherId: own.publisherId,
  };
  const command = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (event, request) => {
    if (event === 'screen:stop') return { stopped: true } as never;
    if (event === 'screen:renew')
      return {
        remainingMs: 45000,
        publication: { share: own, remainingMs: 45000 },
        links: [
          ...[publisherLink, { ...publisherLink, id: crypto.randomUUID() }].map((link) => ({
            link,
            remainingMs: 45000,
          })),
          f.notice().grant,
        ],
      } as never;
    return command(event, request);
  });
  const open = vi
    .spyOn(f.call as unknown as { openPublisher(): Promise<void> }, 'openPublisher')
    .mockImplementation(() => gate.promise);
  await vi.advanceTimersByTimeAsync(10100);
  expect(open).toHaveBeenCalledOnce();
  f.call.stopSource();
  gate.resolve();
  await flush();
  expect(open).toHaveBeenCalledOnce();
  expect(f.binding.release).not.toHaveBeenCalled();
  expect(f.call.inspect().watching).toBe(f.share.id);
  open.mockRestore();
});

it('opens independent profile-only senders and isolates a viewer whose peer cannot be constructed', async () => {
  const f = await fixture();
  const quality = { profile: 'smooth' as const, videoBitrate: 8000000 as const };
  const own = {
    ...quality,
    id: crypto.randomUUID(),
    publisherId: crypto.randomUUID(),
    sound: 'none',
    sourceGeneration: 1,
  };
  const life = new ScreenLifetime(Date.now() + 45000);
  const video = Object.assign(new EventTarget(), {
    enabled: true,
    readyState: 'live',
    kind: 'video',
    getSettings: () => ({ width: 1600, height: 900, frameRate: 30 }),
  });
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', {
    lifecycle: () => life,
    stop: () => life.stop(),
    borrow: () => ({ video, audio: null, sound: 'none' }),
    content: () => ({ kind: 'detail' }),
    codecPreference: async () => null,
  });
  const addTransceiver = vi.fn((_track: MediaStreamTrack, _init: RTCRtpTransceiverInit) => ({}));
  let nativePeers = 0;
  vi.stubGlobal(
    'RTCPeerConnection',
    class extends EventTarget {
      connectionState = 'new';
      constructor(private readonly config: RTCConfiguration) {
        super();
        if (++nativePeers === 2) throw new Error('Peer construction failed');
      }
      getConfiguration = () => this.config;
      getTransceivers = () => [];
      addTransceiver = addTransceiver;
      createOffer = async () => ({ type: 'offer', sdp: screenSdp('offer', false) });
      setLocalDescription = async () => {};
      close = () => {};
    },
  );
  const command = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (event, request) => {
    if (event === 'screen:signal') return { delivered: true } as never;
    if (event !== 'screen:renew') return command(event, request);
    return {
      publication: { share: own, remainingMs: 45000 },
      remainingMs: 45000,
      links: [
        f.notice().grant,
        ...Array.from({ length: 3 }, () => ({
          remainingMs: 45000,
          link: {
            ...f.notice().grant.link,
            id: crypto.randomUUID(),
            shareId: own.id,
            publisherId: own.publisherId,
            quality,
          },
        })),
      ],
    } as never;
  });
  await vi.advanceTimersByTimeAsync(10100);
  expect(addTransceiver.mock.calls.map(([, init]) => init.sendEncodings?.[0]?.maxBitrate)).toEqual([
    8000000, 8000000,
  ]);
  expect(f.call.inspect()).toMatchObject({
    watching: f.share.id,
    viewers: 2,
    error: 'Peer construction failed',
  });
  expect(f.binding.release).not.toHaveBeenCalled();
});

it('preserves a watch selected before the renewal acknowledgement arrives', async () => {
  const f = await fixture(),
    next = f.addShare(),
    gate = deferred();
  f.command.mockImplementationOnce(async () => {
    await gate.promise;
    return { remainingMs: 45000, publication: null, links: [] };
  });
  await vi.advanceTimersByTimeAsync(10100);
  expect(f.command).toHaveBeenLastCalledWith('screen:renew', expect.anything());
  await f.call.watchMultiple(next.id, f.quality);
  gate.resolve();
  await flush();
  expect(f.call.inspect().watchingShareIds).toEqual([next.id]);
  expect(f.openIncoming.mock.results[0]!.value.stop).toHaveBeenCalledOnce();
  expect(f.openIncoming.mock.results[1]!.value.stop).not.toHaveBeenCalled();
});

it('renews an existing watch before waiting for a new publisher offer', async () => {
  const f = await fixture();
  const gate = deferred();
  const watched = f.notice().grant;
  const lifetime = f.openIncoming.mock.calls[0]![0].lifecycle;
  const life = new ScreenLifetime(Date.now() + 45000);
  const own = { ...f.share, id: crypto.randomUUID(), publisherId: crypto.randomUUID() };
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', { lifecycle: () => life, stop: () => life.stop() });
  f.command.mockResolvedValueOnce({
    remainingMs: 45000,
    publication: { share: own, remainingMs: 45000 },
    links: [
      {
        remainingMs: 45000,
        link: {
          ...watched.link,
          id: crypto.randomUUID(),
          shareId: own.id,
          publisherId: own.publisherId,
        },
      },
      watched,
    ],
  });
  const open = vi
    .spyOn(f.call as unknown as { openPublisher(): Promise<void> }, 'openPublisher')
    .mockImplementation(() => gate.promise);
  const originalDeadline = lifetime.inspect()!.deadline;
  vi.setSystemTime(originalDeadline - 1000);
  const renewal = (f.call as unknown as { renew(): Promise<void> }).renew();
  await flush();
  expect(open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1001);
  const stillWatching = lifetime.inspect();
  gate.resolve();
  await renewal;
  open.mockRestore();
  expect(stillWatching?.deadline).toBeGreaterThan(originalDeadline);
  expect(f.binding.release).not.toHaveBeenCalled();
});

it('keeps renewing media throughout a slow offer queue and drops closed queued links', async () => {
  const f = await fixture();
  const watched = f.notice().grant;
  const watchLife = f.openIncoming.mock.calls[0]![0].lifecycle;
  const life = new ScreenLifetime(Date.now() + 45000);
  const own = { ...f.share, id: crypto.randomUUID(), publisherId: crypto.randomUUID() };
  Reflect.set(f.call, 'ownShare', own);
  Reflect.set(f.call, 'source', { lifecycle: () => life, stop: () => life.stop() });
  const pending = Array.from({ length: 13 }, () => ({
    remainingMs: 45000,
    link: {
      ...watched.link,
      id: crypto.randomUUID(),
      shareId: own.id,
      publisherId: own.publisherId,
      viewerId: crypto.randomUUID(),
    },
  }));
  const closed = pending[1]!;
  const command = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (event, request) =>
    event === 'screen:renew'
      ? {
          remainingMs: 45000,
          publication: { share: own, remainingMs: 45000 },
          links: [watched, ...pending],
        }
      : command(event, request),
  );
  const outgoing = Reflect.get(f.call, 'outgoing');
  const open = vi
    .spyOn(
      f.call as unknown as {
        openPublisher(link: ScreenLinkGrant['link'], deadline: number): Promise<void>;
      },
      'openPublisher',
    )
    .mockImplementation(async (link, deadline) => {
      outgoing.set(link.id, {
        peer: { adoptRenewal: vi.fn(), dispose: vi.fn() },
        life: new ScreenLifetime(deadline),
        shareId: own.id,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 4000));
    });
  const renewal = (f.call as unknown as { renew(): Promise<void> }).renew();
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledOnce();
  pending.splice(1, 1);
  f.emit('closed', {
    epoch: f.binding.binding.epoch,
    revision: 2,
    linkId: closed.link.id,
    reason: 'ended',
  });
  await vi.advanceTimersByTimeAsync(46000);
  const duringOffers = watchLife.inspect();
  const checkedAt = Date.now();
  const renewals = f.command.mock.calls.filter(([event]) => event === 'screen:renew').length;
  await vi.advanceTimersByTimeAsync(2000);
  await renewal;
  expect(renewals).toBeGreaterThan(1);
  expect(duringOffers?.deadline).toBeGreaterThan(checkedAt);
  expect(f.binding.release).not.toHaveBeenCalled();
  expect(open.mock.calls.map(([link]) => link.id)).toEqual(pending.map(({ link }) => link.id));
});

it.each(['stop', 'hide', 'binding', 'source', 'dispose'] as const)(
  'cancels incoming recovery on %s',
  async (action) => {
    const f = await fixture();
    f.openIncoming.mock.results[0]!.value.update({ phase: 'closed', reason: 'failed' });
    if (action === 'stop') f.call.stopWatching();
    else if (action === 'hide') f.visibility(false);
    else if (action === 'binding') f.binding.release();
    else if (action === 'dispose') f.call.dispose();
    else {
      f.transport.shares = [];
      f.emit('directory', { epoch: f.binding.binding.epoch, revision: 2, shares: [] });
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.openIncoming).toHaveBeenCalledTimes(1);
  },
);

it('bounds automatic reselection and leaves other watched streams and focus intact', async () => {
  const f = await fixture(),
    other = f.addShare();
  await f.call.watchMultiple(other.id, f.quality);
  const initial = f.openIncoming.mock.results[0]!.value;
  initial.update({ phase: 'closed', reason: 'failed' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.call.inspect()).toMatchObject({
    watching: other.id,
    watchingShareIds: [other.id, f.share.id],
  });
  f.openIncoming.mock.results[2]!.value.update({ phase: 'closed', reason: 'failed' });
  await vi.advanceTimersByTimeAsync(1000);
  f.openIncoming.mock.results[3]!.value.update({ phase: 'closed', reason: 'failed' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.openIncoming).toHaveBeenCalledTimes(4);
  expect(f.call.inspect().error).toContain('recovery failed');
  expect(f.call.inspect().watching).toBe(other.id);
});

it.each([1, 2])(
  'handles %s throttled recovery selections within the retry budget',
  async (failures) => {
    const f = await fixture();
    const command = f.command.getMockImplementation()!;
    let attempts = 0;
    f.command.mockImplementation(async (event, request) => {
      if (event === 'screen:select' && request.shareId === f.share.id && ++attempts <= failures)
        throw Object.assign(new Error('Screen authorization is busy.'), { code: 'throttled' });
      return command(event, request);
    });
    f.openIncoming.mock.results[0]!.value.update({ phase: 'closed', reason: 'failed' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(attempts).toBe(2);
    if (failures === 1) {
      expect(f.call.inspect()).toMatchObject({ watching: f.share.id, error: '' });
    } else {
      expect(f.call.inspect().watching).toBeNull();
      expect(f.call.inspect().error).toContain('recovery failed');
    }
  },
);

it.each(['before retry', 'during selection'] as const)(
  'keeps the user’s latest view when they change it %s',
  async (timing) => {
    const f = await fixture();
    const other = f.addShare();
    await f.call.watchMultiple(other.id, f.quality);
    const gate = deferred();
    const command = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (event, request) => {
      if (event === 'screen:select' && request.shareId === other.id) await gate.promise;
      return command(event, request);
    });
    f.openIncoming.mock.results[1]!.value.update({ phase: 'closed', reason: 'failed' });
    if (timing === 'during selection') {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.call.inspect().selectingShareId).toBe(other.id);
    }
    f.call.focusWatch(f.share.id);
    f.call.zoomOutWatch();
    const views: (string | null)[] = [];
    const unsubscribe = f.call.subscribe(() => views.push(f.call.inspect().watching));
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    unsubscribe();
    expect(f.call.inspect()).toMatchObject({
      watching: f.share.id,
      layout: 'grid',
      watchingShareIds: [f.share.id, other.id],
    });
    expect(views).not.toContain(other.id);
  },
);

it.each([18, 38, 64])(
  'renews combined incoming and outgoing links without a fixed room-count cap: %s',
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
    expect(f.call.inspect()).toMatchObject({ watching: f.share.id, error: '' });
    expect(f.binding.release).not.toHaveBeenCalled();
    expect(f.openIncoming.mock.results[0]!.value.adoptRenewal).toHaveBeenCalledTimes(1);
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

it.each(['recovered', 'timed out again', 'stopped'] as const)(
  'bounds automatic playback startup retry when the watch is %s',
  async (outcome) => {
    const f = await fixture();
    f.call.observeVoice(voiceState());
    const receiver = f.openIncoming.mock.results[0]!.value;
    const firstPlay = deferred();
    const timeout = new ScreenPlaybackError('timeout', 'Playback operation timed out.');
    receiver.play.mockImplementationOnce(() => firstPlay.promise);
    receiver.ready();
    const playback = receiver.inspect().playback!;
    const failed = { ...playback, phase: 'error', error: timeout } as const;
    receiver.update({ playback: { ...failed, pendingNative: true } });
    firstPlay.reject(timeout);
    await flush();
    expect(receiver.play).toHaveBeenCalledTimes(1);
    expect(f.call.inspect().playback).toBe(timeout.message);
    expect(f.call.inspect().playbackTimeout).toBe(timeout.message);

    if (outcome === 'stopped') {
      f.call.stopWatching();
      receiver.update({ playback: { ...failed, pendingNative: false } });
      expect(receiver.play).toHaveBeenCalledTimes(1);
      expect(f.call.inspect().playbackTimeout).toBe('');
      return;
    }
    receiver.play.mockImplementationOnce(async () => {
      receiver.update({ playback: { ...playback, phase: 'routing', pendingNative: true } });
      expect(f.call.inspect().playbackTimeout).toBe(timeout.message);
      if (outcome === 'timed out again') {
        receiver.update({ playback: { ...failed, pendingNative: false } });
        throw timeout;
      }
      receiver.update({ playback: { ...playback, phase: 'playing' } });
    });
    receiver.update({ playback: { ...failed, pendingNative: false } });
    await flush();
    expect(receiver.play).toHaveBeenCalledTimes(2);
    expect(receiver.setOutput).toHaveBeenLastCalledWith('headphones');
    expect(f.call.inspect().error).toBe('');
    expect(f.call.inspect().playbackTimeout).toBe(outcome === 'recovered' ? '' : timeout.message);
    if (outcome === 'recovered') expect(f.call.inspect().playback).toBe('playing');
  },
);

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
