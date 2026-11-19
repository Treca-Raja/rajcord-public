import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ScreenAck } from '@tricord/shared';
import type { ScreenCaller, ScreenSnapshot } from './service.js';
import { registerScreen } from './transport.js';

async function withConnection(
  batch: boolean,
  run: (fixture: {
    update(snapshot: ScreenSnapshot): Promise<unknown>;
    emit: ReturnType<typeof vi.fn>;
    caller: ScreenCaller | undefined;
  }) => Promise<void>,
  viewerCapability?: unknown,
) {
  const io = new EventEmitter();
  const inbound = new EventEmitter();
  const emit = vi.fn();
  const directory = { epoch: 'epoch', revision: 1, shares: [] };
  let snapshot: ScreenSnapshot = { directory, links: [] };
  const bind = vi.fn(async (_caller: ScreenCaller) => ({ epoch: directory.epoch }));
  const stop = registerScreen(
    io as unknown as Parameters<typeof registerScreen>[0],
    {
      onChange: () => () => {},
      bind,
      snapshot: async (_caller: unknown, _body: unknown, send: (item: ScreenSnapshot) => void) => {
        send(snapshot);
        return snapshot.directory;
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
        auth: { screenSnapshotBatch: batch, screenMoreThanNineViewers: viewerCapability },
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
  [undefined, false],
  ['true', false],
  [true, true],
])(
  'requires an explicit publisher opt-in for more than nine viewers (%s)',
  async (value, enabled) => {
    await withConnection(
      false,
      async ({ caller }) => {
        expect(caller).toMatchObject({ supportsMoreThanNineViewers: enabled });
      },
      value,
    );
  },
);
