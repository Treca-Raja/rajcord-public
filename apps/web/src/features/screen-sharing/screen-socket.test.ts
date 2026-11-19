import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ScreenSocket } from './screen-socket';
const wire = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: wire.io }));
const sockets: ScreenSocket[] = [],
  drains: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const pending: { resolve(value: unknown): void; reject(cause: unknown): void }[] = [];
  const raw = Object.assign(new EventEmitter(), {
    connected: true,
    timeout: () => raw,
    disconnect: () => {
      raw.connected = false;
    },
    emitWithAck: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    ),
  });
  wire.io.mockReturnValue(raw);
  const socket = new ScreenSocket('owned-test-csrf');
  sockets.push(socket);
  drains.push(() =>
    pending.forEach((item) => item.resolve({ ok: true, data: { delivered: true } })),
  );
  return { socket, raw, pending };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  drains.splice(0).forEach((run) => run());
  await flush();
  await Promise.all(sockets.splice(0).map((socket) => socket.retire()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
it('serializes commands across peers and snapshots queued bodies', async () => {
  const f = fixture(),
    body = { revision: 1 };
  const first = f.socket.command('screen:signal', {}),
    next = f.socket.command('screen:renew', body);
  body.revision = 99;
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(1);
  f.pending[0]!.resolve({ ok: true, data: 'first' });
  await first;
  await flush();
  expect(f.raw.emitWithAck).toHaveBeenLastCalledWith('screen:renew', { revision: 1 });
  f.pending[1]!.resolve({ ok: true, data: 'next' });
  expect(await next).toBe('next');
});
it('opts into paged renewal acknowledgements on the application socket', () => {
  fixture();
  expect(wire.io).toHaveBeenLastCalledWith(
    expect.objectContaining({ auth: expect.objectContaining({ screenRenewalPages: true }) }),
  );
});
it('unpacks a bounded snapshot batch in the same lifecycle order as individual events', () => {
  const f = fixture(),
    events: unknown[] = [];
  f.socket.subscribe((event, value) => events.push({ event, value }));
  const directory = { epoch: 'owned-epoch', revision: 3, shares: [] },
    grant = { link: { id: 'new' } };
  f.raw.emit('screen:snapshot', { directory, links: [grant], closed: ['old'] });
  expect(events).toEqual([
    {
      event: 'closed',
      value: { epoch: directory.epoch, revision: 3, linkId: 'old', reason: 'ended' },
    },
    { event: 'directory', value: directory },
    { event: 'link', value: { epoch: directory.epoch, revision: 3, grant } },
  ]);
});
it('cancels queued commands and retains active raw admission after logical cancellation', async () => {
  const f = fixture(),
    firstAbort = new AbortController(),
    queuedAbort = new AbortController();
  const first = f.socket.command('screen:signal', {}, firstAbort.signal).catch((cause) => cause);
  const queued = f.socket.command('screen:signal', {}, queuedAbort.signal).catch((cause) => cause);
  queuedAbort.abort();
  firstAbort.abort();
  expect(await first).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  const next = f.socket.command('screen:renew', {});
  await flush();
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(1);
  f.pending[0]!.resolve({ ok: true, data: {} });
  await flush();
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(2);
  f.pending[1]!.resolve({ ok: true, data: {} });
  await next;
});
it('bounds the queue and expires waiting work without emitting it later', async () => {
  const f = fixture();
  const first = f.socket.command('screen:signal', {});
  const queued = Array.from({ length: 127 }, () =>
    f.socket.command('screen:signal', {}).catch((cause) => cause),
  );
  await expect(f.socket.command('screen:signal', {})).rejects.toThrow('busy');
  await vi.advanceTimersByTimeAsync(4000);
  expect((await Promise.all(queued)).every((item) => item instanceof Error)).toBe(true);
  f.pending[0]!.resolve({ ok: true, data: {} });
  await first;
  await flush();
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(1);
});
it('reserves admission for renewal at saturation and preserves the order of waiting signals', async () => {
  const f = fixture();
  const active = f.socket.command('screen:signal', { sequence: 0 });
  const signals = Array.from({ length: 127 }, (_, i) =>
    f.socket.command('screen:signal', { sequence: i + 1 }).catch((cause) => cause),
  );
  await expect(f.socket.command('screen:signal', {})).rejects.toThrow('busy');
  const renewal = f.socket.command('screen:renew', { revision: 3 });
  await expect(f.socket.command('screen:renew', {})).rejects.toThrow('busy');
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(1);
  f.pending[0]!.resolve({ ok: true });
  await active;
  await flush();
  expect(f.raw.emitWithAck).toHaveBeenLastCalledWith('screen:renew', { revision: 3 });
  f.pending[1]!.resolve({ ok: true });
  await renewal;
  await flush();
  expect(f.raw.emitWithAck).toHaveBeenLastCalledWith('screen:signal', { sequence: 1 });
  const retired = f.socket.retire();
  f.pending[2]!.resolve({ ok: true });
  await retired;
  expect((await Promise.all(signals)).every((item) => item instanceof Error)).toBe(true);
});
it('retries explicit selection throttles in order while allowing renewal to proceed', async () => {
  const f = fixture();
  const body = { revision: 1, requestId: 'selection' };
  const selection = f.socket.command('screen:select', body);
  const cleanup = f.socket.command('screen:select', { revision: 2 });
  const renew = f.socket.command('screen:renew', {});
  f.pending[0]!.resolve({ ok: false, code: 'throttled', retryAfterMs: 1200 });
  await flush();
  expect(f.raw.emitWithAck.mock.calls).toEqual([
    ['screen:select', body],
    ['screen:renew', {}],
  ]);
  f.pending[1]!.resolve({ ok: true });
  await renew;
  await vi.advanceTimersByTimeAsync(1199);
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(251);
  expect(f.raw.emitWithAck).toHaveBeenLastCalledWith('screen:select', body);
  f.pending[2]!.resolve({ ok: true, data: 'selected' });
  await expect(selection).resolves.toBe('selected');
  await vi.advanceTimersByTimeAsync(250);
  expect(f.raw.emitWithAck).toHaveBeenLastCalledWith('screen:select', { revision: 2 });
  f.pending[3]!.resolve({ ok: true });
  await cleanup;
});
it('cancels selection backoff on Stop and never replays an ambiguous timeout', async () => {
  const f = fixture(),
    abort = new AbortController();
  const selection = f.socket.command('screen:select', { revision: 1 }, abort.signal);
  const cancelled = expect(selection).rejects.toThrow('cancelled');
  f.pending[0]!.resolve({ ok: false, code: 'throttled' });
  await flush();
  abort.abort();
  await cancelled;
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(1);
  const next = f.socket.command('screen:select', { revision: 2 });
  f.pending[1]!.reject(new Error('operation has timed out'));
  await expect(next).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(2);
});
it('retires queued work immediately and waits for the active raw acknowledgement', async () => {
  const f = fixture();
  const first = f.socket.command('screen:signal', {}).catch((cause) => cause);
  const queued = f.socket.command('screen:renew', {}).catch((cause) => cause);
  let retired = false;
  const work = f.socket.retire().then(() => {
    retired = true;
  });
  expect(await queued).toBeInstanceOf(Error);
  await flush();
  expect(retired).toBe(false);
  f.pending[0]!.resolve({ ok: true, data: {} });
  await work;
  expect(await first).toBeInstanceOf(Error);
  expect(f.raw.emitWithAck).toHaveBeenCalledTimes(1);
});
