import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ScreenAck } from '@tricord/shared';
import type { ScreenCaller, ScreenSnapshot } from './service.js';
import { registerScreen } from './transport.js';

async function withConnection(
  batch: boolean,
  run: (fixture: {
    update(snapshot: ScreenSnapshot): Promise<unknown>;
    onUnchangedPoll(handler: (knownRevision: number) => number): void;
    emit: ReturnType<typeof vi.fn>;
    caller: ScreenCaller | undefined;
  }) => Promise<void>,
  viewerCapability?: unknown,
  renewalPages?: unknown,
) {
  const io = new EventEmitter();
  const inbound = new EventEmitter();
  const emit = vi.fn();
  const directory = { epoch: 'epoch', revision: 1, shares: [] };
  let snapshot: ScreenSnapshot = { directory, links: [] };
  let unchangedPoll: ((knownRevision: number) => number) | undefined;
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
    } as unknown as Parameters<typeof registerScreen>[1],
  );
  const command = (event: string) =>
    new Promise<unknown>((resolve, reject) => {
      inbound.emit(event, {}, (ack: ScreenAck<unknown>) => {
        if (ack.ok) resolve(ack.data);
        else reject(new Error(ack.error));
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
        },
      },
      conn: { transport: { writable: true } },
      on: inbound.on.bind(inbound),
      once: inbound.once.bind(inbound),
      emit,
    });
    await command('screen:bind');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('screen:directory', directory));
    emit.mockClear();
    await run({
      emit,
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

it('sends a large snapshot as a single event when the client opted in', async () => {
  await withConnection(true, async ({ emit, update }) => {
    await update(snapshot);
    expect(emit.mock.calls).toEqual([['screen:snapshot', { ...snapshot, closed: [] }]]);
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
