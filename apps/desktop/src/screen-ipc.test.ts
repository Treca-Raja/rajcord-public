import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installScreenIpc } from './screen-ipc';

function fixture() {
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
    request = { clientIntentRef: randomUUID(), epoch: randomUUID(), sound: 'none' };
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
it('scopes cancellation and handoff to the exact current intent and never exposes main grants/frame identity', async () => {
  const f = fixture(),
    a = { clientIntentRef: randomUUID(), epoch: randomUUID(), sound: 'none' };
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
  f.controls.stop();
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
  const first = { clientIntentRef: randomUUID(), epoch: randomUUID(), sound: 'none' };
  const old = f.invoke('prepare', first) as Promise<unknown>;
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
