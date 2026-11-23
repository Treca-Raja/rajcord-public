import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installScreenIpc } from './screen-ipc';
import { obsEncoders } from './obs-screen';

const helper = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  observe: vi.fn(),
  exit: vi.fn(),
}));

vi.mock('./obs-screen', async (load) => ({
  ...(await load<typeof import('./obs-screen')>()),
  obsEncoders: vi.fn(),
  ObsScreen: class {
    start = helper.start;
    stop = helper.stop;
    stopped = helper.exit();
    observe = helper.observe;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(obsEncoders).mockResolvedValue(['x264']);
  helper.start.mockResolvedValue('WGC');
  helper.exit.mockResolvedValue({ code: 0, signal: null });
});

function fixture(
  applicationSound = false,
  obs: Parameters<typeof installScreenIpc>[0]['obs'] = {
    available: true,
    root: 'fixture',
    executable: 'fixture',
  },
) {
  type Options = Parameters<typeof installScreenIpc>[0];
  const handlers = new Map<string, (event: unknown, value?: unknown) => unknown>();
  let visible = true;
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  });
  const invalidations = new Set<() => void>();
  const frame = {},
    intent = { frame, expires: Date.now() + 45000 };
  const authority = {
    prepare: vi.fn(async () => intent),
    inspect: () => intent,
    inspectPublication: () => ({ active: true }),
    observeNativeViewers: vi.fn(),
    handoff: vi.fn(async () => ({ remainingMs: 40000 })),
    invalidate: vi.fn(() => invalidations.forEach((listener) => listener())),
    onInvalidated: (listener: () => void) => {
      invalidations.add(listener);
      return () => {
        invalidations.delete(listener);
      };
    },
  };
  const ipc = {
    handle: (name: string, handler: (event: unknown, value?: unknown) => unknown) =>
      handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  };
  const trusted = {};
  const controls = installScreenIpc({
    owner,
    authority,
    ipc,
    trusted: (event: unknown) => event === trusted,
    systemSound: true,
    applicationSound,
    obs,
    target: () => ['window', '123', 'identity', '456', '1'],
  } as unknown as Options);
  const invoke = (event: string, body?: unknown, sender: unknown = trusted) =>
    handlers.get('screen:' + event)!(sender, body);
  return {
    owner,
    authority,
    invoke,
    trusted,
    controls,
    handlers,
    frame,
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}
it('denies foreign senders and unexpected request fields before native authority allocation', async () => {
  const f = fixture(),
    request = {
      clientIntentRef: randomUUID(),
      epoch: randomUUID(),
      sound: 'none',
      encoder: 'auto',
    };
  await expect(async () => f.invoke('prepare', request, {})).rejects.toThrow('Untrusted');
  await expect(async () => f.invoke('prepare', { ...request, frame: f.frame })).rejects.toThrow(
    'Invalid',
  );
  expect(f.authority.prepare).not.toHaveBeenCalled();
  const status = await f.invoke('prepare', request);
  expect(Object.keys(status as object).sort()).toEqual(['clientIntentRef', 'ready', 'remainingMs']);
  expect(f.authority.prepare).toHaveBeenCalledWith('none', request.epoch);
  f.owner.emit('closed');
  expect(f.handlers.size).toBe(0);
});
it.each([false, true])(
  'gates application audio preparation on main capability: %s',
  async (enabled) => {
    const f = fixture(enabled);
    const request = {
      clientIntentRef: randomUUID(),
      epoch: randomUUID(),
      sound: 'application',
      encoder: 'auto',
    };
    if (enabled) {
      expect(await f.invoke('capabilities')).toMatchObject({ applicationSound: true });
      await f.invoke('prepare', request);
      expect(f.authority.prepare).toHaveBeenCalledWith('application', request.epoch);
    } else {
      await expect(async () => f.invoke('prepare', request)).rejects.toThrow(
        'Invalid screen preparation',
      );
      expect(f.authority.prepare).not.toHaveBeenCalled();
    }
    f.owner.emit('closed');
  },
);
it('advertises and prepares automatic source audio without a renderer audio selection', async () => {
  const f = fixture(true);
  expect(await f.invoke('capabilities')).toMatchObject({ sourceSound: true });
  const request = {
    clientIntentRef: randomUUID(),
    epoch: randomUUID(),
    sound: 'source',
    encoder: 'auto',
  };
  await f.invoke('prepare', request);
  expect(f.authority.prepare).toHaveBeenCalledWith('source', request.epoch);
  f.owner.emit('closed');
});
it('waits for the previous native helper to exit before handing off a replacement', async () => {
  const f = fixture(true);
  let stopped!: () => void;
  helper.exit.mockReturnValueOnce(
    new Promise<{ code: number; signal: null }>((resolve) => {
      stopped = () => resolve({ code: 0, signal: null });
    }),
  );
  async function prepare() {
    const clientIntentRef = randomUUID();
    await f.invoke('prepare', {
      clientIntentRef,
      epoch: randomUUID(),
      sound: 'application',
      encoder: 'auto',
    });
    return { clientIntentRef, shareId: randomUUID(), sourceGeneration: 1 };
  }
  const first = await prepare();
  await expect(f.invoke('handoff', first)).resolves.toMatchObject({ ready: true });
  f.invoke('cancel', { clientIntentRef: first.clientIntentRef });
  const second = f.invoke('handoff', await prepare());
  expect(helper.stop).toHaveBeenCalledTimes(1);
  expect(f.authority.handoff).toHaveBeenCalledTimes(1);
  expect(helper.start).toHaveBeenCalledTimes(1);
  stopped();
  await expect(second).resolves.toMatchObject({ ready: true });
  expect(helper.start).toHaveBeenCalledTimes(2);
  f.owner.emit('closed');
});
it('ends the authorized share when Windows Audio fails and permits a new consent', async () => {
  const f = fixture(true);
  const intent = {
    clientIntentRef: randomUUID(),
    epoch: randomUUID(),
    sound: 'application',
    encoder: 'auto',
  };
  const error =
    'Windows Audio is stopped (0x88890010). Start Windows Audio in Services, then share again.';
  helper.start.mockRejectedValueOnce(new Error(error));
  await f.invoke('prepare', intent);
  await expect(
    f.invoke('handoff', {
      clientIntentRef: intent.clientIntentRef,
      shareId: randomUUID(),
      sourceGeneration: 1,
    }),
  ).resolves.toMatchObject({ ready: false, error });
  expect(f.authority.invalidate).toHaveBeenCalledTimes(1);
  expect(helper.stop).toHaveBeenCalledTimes(1);
  await expect(
    f.invoke('prepare', { ...intent, clientIntentRef: randomUUID() }),
  ).resolves.toMatchObject({ ready: true });
  f.owner.emit('closed');
});
it('scopes cancellation and handoff to the exact current intent and never exposes main grants/frame identity', async () => {
  const f = fixture(),
    a = { clientIntentRef: randomUUID(), epoch: randomUUID(), sound: 'none', encoder: 'auto' };
  await f.invoke('prepare', a);
  f.invoke('cancel', { clientIntentRef: a.clientIntentRef });
  const b = { ...a, clientIntentRef: randomUUID(), sound: 'system' };
  await f.invoke('prepare', b);
  f.invoke('cancel', { clientIntentRef: a.clientIntentRef });
  expect(f.authority.invalidate).toHaveBeenCalledTimes(1);
  await expect(async () =>
    f.invoke('handoff', {
      clientIntentRef: a.clientIntentRef,
      shareId: randomUUID(),
      sourceGeneration: 1,
    }),
  ).rejects.toThrow('ended');
  const status = await f.invoke('handoff', {
    clientIntentRef: b.clientIntentRef,
    shareId: randomUUID(),
    sourceGeneration: 1,
  });
  expect(status).toEqual({ clientIntentRef: b.clientIntentRef, ready: true, remainingMs: 40000 });
  expect(helper.start).toHaveBeenCalledExactlyOnceWith(['window', '123', 'identity', '456', '1']);
  f.controls.stop();
  expect(helper.stop).toHaveBeenCalledTimes(1);
  expect(f.owner.webContents.send).toHaveBeenLastCalledWith('screen:stop', b.clientIntentRef);
  f.owner.emit('closed');
});
it('late preparation cannot adopt or invalidate a replacement and main visibility is content-free', async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<typeof f.authority.prepare>>) => void;
  f.authority.prepare.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const first = {
    clientIntentRef: randomUUID(),
    epoch: randomUUID(),
    sound: 'none',
    encoder: 'auto',
  };
  const old = f.invoke('prepare', first) as Promise<unknown>;
  await vi.waitFor(() => expect(f.authority.prepare).toHaveBeenCalledTimes(1));
  f.invoke('cancel', { clientIntentRef: first.clientIntentRef });
  const second = { ...first, clientIntentRef: randomUUID() };
  await f.invoke('prepare', second);
  resolve(f.authority.inspect());
  expect(await old).toMatchObject({ clientIntentRef: first.clientIntentRef, ready: false });
  expect(f.authority.invalidate).toHaveBeenCalledTimes(1);
  f.setVisible(false);
  f.owner.emit('hide');
  expect(f.owner.webContents.send).toHaveBeenLastCalledWith('screen:visibility', false);
  f.owner.emit('closed');
});

it.each(['nvenc', 'amf', 'x264'] as const)(
  'offers initialized OBS %s and rejects unavailable explicit choices',
  async (encoder) => {
    vi.mocked(obsEncoders).mockResolvedValueOnce([encoder]);
    const f = fixture(true, { available: true, root: 'fixture', executable: 'fixture' });
    const request = {
      clientIntentRef: randomUUID(),
      epoch: randomUUID(),
      sound: 'none',
    };
    await expect(f.invoke('capabilities')).resolves.toMatchObject({
      obs: { available: true, encoders: [encoder] },
    });
    await expect(
      f.invoke('prepare', { ...request, encoder: encoder === 'amf' ? 'nvenc' : 'amf' }),
    ).resolves.toMatchObject({ ready: false, error: expect.stringContaining('Choose Automatic') });
    expect(f.authority.prepare).not.toHaveBeenCalled();
    await expect(f.invoke('prepare', { ...request, encoder })).resolves.toMatchObject({
      ready: true,
    });
    f.owner.emit('closed');
  },
);

it('offers OBS automatic selection with software as its only initialized encoder', async () => {
  vi.mocked(obsEncoders).mockResolvedValueOnce(['x264']);
  const f = fixture(true, { available: true, root: 'fixture', executable: 'fixture' });
  const request = {
    clientIntentRef: randomUUID(),
    epoch: randomUUID(),
    sound: 'none',
    encoder: 'auto',
  };
  await expect(async () => f.invoke('prepare', { ...request, encoder: 'qsv' })).rejects.toThrow(
    'Invalid screen preparation',
  );
  await expect(f.invoke('prepare', request)).resolves.toMatchObject({ ready: true });
  f.owner.emit('closed');
});

it('reports a missing OBS bundle and rejects requests from the retired desktop publishing flow', async () => {
  const reason = 'Reinstall Rajcord Desktop to restore OBS screen sharing.';
  const f = fixture(false, { available: false, reason });
  const old = { clientIntentRef: randomUUID(), epoch: randomUUID(), sound: 'none' };
  const request = { ...old, encoder: 'auto' };
  await expect(f.invoke('capabilities')).resolves.toMatchObject({
    version: 2,
    obs: { available: false, reason },
  });
  await expect(f.invoke('prepare', old)).rejects.toThrow('Invalid screen request');
  await expect(f.invoke('prepare', { ...request, sender: 'gstreamer' })).rejects.toThrow(
    'Invalid screen request',
  );
  await expect(f.invoke('prepare', request)).resolves.toMatchObject({
    ready: false,
    error: reason,
  });
  expect(f.authority.prepare).not.toHaveBeenCalled();
  expect(helper.start).not.toHaveBeenCalled();
});
