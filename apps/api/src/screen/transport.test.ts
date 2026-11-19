import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type {
  ScreenAck,
  ScreenDirectoryChanges,
  ScreenRenewal,
  ScreenShare,
} from '@tricord/shared';
import type { ScreenCaller, ScreenService, ScreenSnapshot } from './service.js';
import { registerScreen } from './transport.js';

async function withConnection(
  batch: boolean,
  run: (fixture: {
    update(snapshot: ScreenSnapshot): Promise<unknown>;
    renew(handler: ScreenService['renew']): Promise<unknown>;
    setWritable(writable: boolean): void;
    onUnchangedPoll(handler: (knownRevision: number) => number): void;
    emit: ReturnType<typeof vi.fn>;
    replies: ReturnType<typeof vi.fn>;
    caller: ScreenCaller | undefined;
  }) => Promise<void>,
  viewerCapability?: unknown,
  renewalPages?: unknown,
) {
  const io = new EventEmitter();
  const inbound = new EventEmitter();
  const emit = vi.fn(),
    replies = vi.fn();
  const transport = { writable: true };
  const directory = { epoch: 'epoch', revision: 1, shares: [] };
  let snapshot: ScreenSnapshot = { directory, links: [] };
  let unchangedPoll: ((knownRevision: number) => number) | undefined;
  let renew: ScreenService['renew'];
  const bind = vi.fn(async (_caller: ScreenCaller) => ({ epoch: directory.epoch }));
  const stop = registerScreen(
    io as unknown as Parameters<typeof registerScreen>[0],
    {
      onChange: () => () => {},
      bind,
      snapshot: async (
        _caller: unknown,
        _body: unknown,
        send: (item: ScreenSnapshot) => void,
        knownRevision?: number,
      ) => {
        if (knownRevision !== undefined && unchangedPoll) return unchangedPoll(knownRevision);
        send(snapshot);
        return knownRevision === undefined ? snapshot.directory : null;
      },
      disconnect: () => {},
      renew: (...args: Parameters<ScreenService['renew']>) => renew(...args),
    } as unknown as Parameters<typeof registerScreen>[1],
  );
  const command = (event: string, data = {}) =>
    new Promise<unknown>((resolve, reject) => {
      inbound.emit(event, data, (ack: ScreenAck<unknown>) => {
        replies(event, ack);
        if (ack.ok) resolve(ack.data);
        else reject(Object.assign(new Error(ack.error), { code: ack.code }));
      });
    });
  try {
    io.emit('connection', {
      id: 'socket',
      connected: true,
      data: { token: 'session', auth: { user: { id: 'viewer' } } },
      handshake: {
        auth: {
          screenSnapshotBatch: batch,
          screenMoreThanNineViewers: viewerCapability,
          screenRenewalPages: renewalPages,
          screenDirectoryChanges: batch,
        },
      },
      conn: { transport },
      on: inbound.on.bind(inbound),
      once: inbound.once.bind(inbound),
      emit,
    });
    await command('screen:bind');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('screen:directory', directory));
    emit.mockClear();
    await run({
      emit,
      replies,
      setWritable: (writable) => {
        transport.writable = writable;
      },
      renew: (handler) => {
        renew = handler;
        return command('screen:renew', { epoch: directory.epoch });
      },
      onUnchangedPoll: (handler) => {
        unchangedPoll = handler;
      },
      caller: bind.mock.calls[0]?.[0],
      update: (next) => {
        snapshot = next;
        return command('screen:directory');
      },
    });
  } finally {
    stop();
  }
}

it('carries an unchanged membership revision into the next scheduled poll', async () => {
  vi.useFakeTimers();
  try {
    await withConnection(true, async ({ onUnchangedPoll, emit }) => {
      const poll = vi.fn(() => 2);
      onUnchangedPoll(poll);
      await vi.advanceTimersByTimeAsync(2000);
      expect(poll.mock.calls).toEqual([[1], [2]]);
      expect(emit).not.toHaveBeenCalled();
    });
  } finally {
    vi.useRealTimers();
  }
});
it('spends consecutive snapshot windows on different connections when the aggregate budget fills', async () => {
  vi.useFakeTimers();
  const io = new EventEmitter(),
    visited: string[] = [];
  const stop = registerScreen(
    io as unknown as Parameters<typeof registerScreen>[0],
    {
      onChange: () => () => {},
      bind: async (caller: ScreenCaller) => ({ epoch: caller.transportId }),
      snapshot: async (caller: ScreenCaller) => {
        visited.push(caller.transportId);
        return 1;
      },
      disconnect: () => {},
    } as unknown as Parameters<typeof registerScreen>[1],
  );
  try {
    for (let i = 0; i < 60; i++) {
      const id = String(i),
        inbound = new EventEmitter();
      io.emit('connection', {
        id,
        connected: true,
        data: { token: id, auth: { user: { id } } },
        handshake: { auth: {} },
        conn: { transport: { writable: true } },
        on: inbound.on.bind(inbound),
        once: inbound.once.bind(inbound),
        emit: vi.fn(),
      });
      await new Promise<void>((resolve, reject) =>
        inbound.emit('screen:bind', {}, (ack: ScreenAck<unknown>) =>
          ack.ok ? resolve() : reject(new Error(ack.error)),
        ),
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    visited.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(new Set(visited).size).toBe(30);
    await vi.advanceTimersByTimeAsync(1000);
    expect(new Set(visited).size).toBe(60);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

const snapshot: ScreenSnapshot = {
  directory: { epoch: 'epoch', revision: 2, shares: [] },
  links: Array.from({ length: 34 }, (_, index) => ({
    remainingMs: 45000,
    link: {
      id: `link-${index}`,
      shareId: 'share',
      publisherId: 'publisher',
      viewerId: `viewer-${index}`,
      selectionRevision: 1,
      quality: { profile: 'smooth', videoBitrate: 4000000 },
      videoBitrate: 4000000,
    },
  })),
};

it.each([false, true])(
  'closes a departed legacy viewer before acknowledging the replacement (output full: %s)',
  async (outputFull) => {
    await withConnection(false, async ({ emit, replies, renew, setWritable, update }) => {
      const links = snapshot.links.slice(0, 9);
      const send = (links: ScreenRenewal['links'], revision: number) =>
        renew(async (_caller, _body, deliver) => {
          const renewal = { remainingMs: 45000, publication: null, links };
          deliver?.(renewal, { revision, outgoing: new Set(links.map(({ link }) => link.id)) });
          return renewal;
        });
      await send(links, 1);
      const departed = links[0]!.link.id;
      const replacement = snapshot.links[9]!;
      const replaced = [...links.slice(1), replacement];
      if (outputFull) {
        setWritable(false);
        await update({ ...snapshot, links: snapshot.links.slice(0, 28) });
        emit.mockClear();
        await expect(send(replaced, 3)).rejects.toMatchObject({ code: 'throttled' });
        expect(emit).not.toHaveBeenCalled();
        setWritable(true);
      }
      await expect(send(replaced, 3)).resolves.toMatchObject({ links: replaced });
      expect(emit.mock.calls).toEqual([
        ['screen:closed', { epoch: 'epoch', revision: 3, linkId: departed, reason: 'ended' }],
      ]);
      expect(emit.mock.invocationCallOrder[0]).toBeLessThan(
        replies.mock.invocationCallOrder.at(-1)!,
      );
    });
  },
);

it('sends a large snapshot as a single event when the client opted in', async () => {
  await withConnection(true, async ({ emit, update }) => {
    await update(snapshot);
    expect(emit.mock.calls).toEqual([['screen:snapshot', { ...snapshot, closed: [] }]]);
  });
});
it('resumes individual delivery when a batch with many new links exceeds 64 KiB', async () => {
  await withConnection(true, async ({ emit, update }) => {
    const links = Array.from({ length: 240 }, (_, index) => ({
      ...snapshot.links[0]!,
      link: {
        ...snapshot.links[0]!.link,
        id: index.toString().padStart(36, '0'),
        shareId: 's'.repeat(36),
        publisherId: 'p'.repeat(36),
        viewerId: 'v'.repeat(36),
      },
    }));
    const large = { ...snapshot, links };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(65536);
    await update(large);
    expect(emit.mock.calls.length).toBe(32);
    for (let i = 0; i < 7; i++) await update(large);
    const delivered = emit.mock.calls.flatMap(([event, data]) =>
      event === 'screen:snapshot'
        ? data.links.map((grant: (typeof links)[number]) => grant.link.id)
        : event === 'screen:link'
          ? [data.grant.link.id]
          : [],
    );
    expect(delivered).toEqual(links.map((grant) => grant.link.id));
    expect(
      emit.mock.calls.every(([, data]) => Buffer.byteLength(JSON.stringify(data)) + 64 <= 65536),
    ).toBe(true);
  });
});
it('acknowledges a large directory and supersedes unsent pages from freshly authorized membership', async () => {
  await withConnection(true, async ({ emit, update }) => {
    const shares: ScreenShare[] = Array.from({ length: 590 }, (_, i) => ({
      id: String(i).padStart(36, '0'),
      publisherId: 'p'.repeat(36),
      sourceGeneration: 1,
      profile: 'smooth',
      videoBitrate: 8000000,
      resolution: 1080,
      frameRate: 60,
      sound: 'none',
    }));
    const directory = { ...snapshot.directory, shares };
    expect(await update({ directory, links: [] })).toEqual({
      epoch: directory.epoch,
      revision: 2,
      streamed: true,
    });
    const pages = () =>
      emit.mock.calls
        .filter(([event]) => event === 'screen:directoryChanges')
        .map(([, data]) => data as ScreenDirectoryChanges);
    expect(pages().length).toBeGreaterThan(0);
    expect(pages().at(-1)?.complete).toBe(false);
    const replacement = { ...directory, revision: 3, shares: shares.slice(1, 450) };
    await update({ directory: replacement, links: [] });
    await update({ directory: replacement, links: [] });
    const seen = new Set<string>();
    for (const page of pages()) {
      expect(Buffer.byteLength(JSON.stringify(page)) + 64).toBeLessThanOrEqual(65536);
      for (const id of page.removed) seen.delete(id);
      for (const share of page.added) seen.add(share.id);
    }
    expect(
      pages()
        .filter((page) => page.complete)
        .map((page) => page.revision),
    ).toEqual([3]);
    expect([...seen]).toEqual(replacement.shares.map((item) => item.id));
  });
});

it('resumes a partial snapshot using only individual events for an older client', async () => {
  await withConnection(false, async ({ emit, update }) => {
    await update(snapshot);
    expect(emit).toHaveBeenCalledTimes(32);
    expect(emit).toHaveBeenNthCalledWith(1, 'screen:directory', snapshot.directory);
    await update(snapshot);
    await update(snapshot);
    expect(emit.mock.calls).toEqual([
      ['screen:directory', snapshot.directory],
      ...snapshot.links.map((grant) => [
        'screen:link',
        { epoch: snapshot.directory.epoch, revision: snapshot.directory.revision, grant },
      ]),
    ]);
  });
});

it.each([
  [undefined, undefined],
  ['true', 'true'],
  [true, undefined],
  [undefined, true],
  [true, true],
])(
  'negotiates larger audiences (%s) independently of renewal pages (%s)',
  async (audience, pages) => {
    await withConnection(
      false,
      async ({ caller }) => {
        expect(caller).toMatchObject({
          supportsMoreThanNineViewers: audience === true,
          renewalPages: pages === true,
        });
      },
      audience,
      pages,
    );
  },
);
