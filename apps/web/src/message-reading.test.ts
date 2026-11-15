import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatAck } from '@tricord/shared';
import { trackMessageReading, type ReadingPosition } from './message-reading';

type Options = Parameters<typeof trackMessageReading>[0];
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reading() {
  const page = Object.assign(new EventTarget(), {
    querySelector: vi.fn().mockReturnValue(null),
    visibilityState: 'visible',
    hasFocus: vi.fn().mockReturnValue(true),
  });
  const window = new EventTarget();
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', window);
  const position: ReadingPosition = {
    loading: false,
    loaded: true,
    readingAllowed: true,
    historyMode: false,
    panelOpen: false,
    pinned: true,
    scroll: { scrollHeight: 1000, scrollTop: 500, clientHeight: 500 } as HTMLDivElement,
  };
  const request = vi.fn().mockResolvedValue({ lastReadSeq: '12' });
  const options: Options = {
    conversationId: 'conversation',
    latestSeq: '12',
    readSeq: { current: '5' },
    lastReadRequest: { current: 0 },
    socket: null,
    request,
    position: () => position,
  };
  return { page, window, position, request, options };
}

it('acknowledges the latest focused visible cursor over HTTP and never resends an acknowledged cursor', async () => {
  const t = reading();
  dispose = trackMessageReading(t.options);
  expect(t.request).toHaveBeenCalledExactlyOnceWith('/conversations/conversation/read', 'POST', {
    seq: '12',
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(t.options.readSeq.current).toBe('12');
  expect(t.request).toHaveBeenCalledTimes(1);
});

it.each([
  ['loading', true],
  ['loaded', false],
  ['readingAllowed', false],
  ['historyMode', true],
  ['panelOpen', true],
  ['pinned', false],
  ['scroll', null],
] as const)('does not acknowledge while %s is %s', async (key, value) => {
  const t = reading();
  Object.assign(t.position, { [key]: value });
  dispose = trackMessageReading(t.options);
  await vi.advanceTimersByTimeAsync(20000);
  expect(t.request).not.toHaveBeenCalled();
});

it.each(['dialog', 'hidden', 'unfocused', 'resized', 'empty'])(
  'does not acknowledge a %s timeline',
  async (condition) => {
    const t = reading();
    if (condition === 'dialog') t.page.querySelector.mockReturnValue({});
    if (condition === 'hidden') t.page.visibilityState = 'hidden';
    if (condition === 'unfocused') t.page.hasFocus.mockReturnValue(false);
    if (condition === 'resized') Object.assign(t.position.scroll!, { scrollHeight: 2000 });
    if (condition === 'empty') Object.assign(t.position.scroll!, { clientHeight: 0 });
    dispose = trackMessageReading(t.options);
    await vi.advanceTimersByTimeAsync(20000);
    expect(t.request).not.toHaveBeenCalled();
  },
);

it.each(['12', '13', '9007199254740993'])(
  'never requests a cursor at or behind the account cursor %s',
  (seq) => {
    const t = reading();
    t.options.readSeq.current = seq;
    dispose = trackMessageReading(t.options);
    expect(t.request).not.toHaveBeenCalled();
  },
);

it('compares sequence strings beyond JavaScript integer precision', async () => {
  const t = reading();
  t.options.latestSeq = '9007199254740993';
  t.options.readSeq.current = '9007199254740992';
  t.request.mockResolvedValue({ lastReadSeq: t.options.latestSeq });
  dispose = trackMessageReading(t.options);
  await vi.advanceTimersByTimeAsync(0);
  expect(t.options.readSeq.current).toBe('9007199254740993');
});

it('retains the HTTP budget across effect restarts and retries a failure after fifteen seconds', async () => {
  const t = reading();
  t.request.mockRejectedValueOnce(new Error('Network unavailable'));
  dispose = trackMessageReading(t.options);
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.options.readSeq.current).toBe('5');
  dispose();
  dispose = trackMessageReading(t.options);
  t.window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(13999);
  expect(t.request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.request).toHaveBeenCalledTimes(2);
  expect(t.options.readSeq.current).toBe('12');
});

it('keeps one acknowledgement in flight and cancels timers and event listeners on cleanup', async () => {
  const t = reading();
  let complete!: (value: { lastReadSeq: string }) => void;
  t.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  dispose = trackMessageReading(t.options);
  await vi.advanceTimersByTimeAsync(30000);
  t.window.dispatchEvent(new Event('focus'));
  t.page.dispatchEvent(new Event('visibilitychange'));
  expect(t.request).toHaveBeenCalledTimes(1);
  dispose();
  complete({ lastReadSeq: '12' });
  await vi.advanceTimersByTimeAsync(30000);
  t.window.dispatchEvent(new Event('focus'));
  t.page.dispatchEvent(new Event('visibilitychange'));
  expect(t.request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

function socketFor(options: Options) {
  let acknowledge!: (timeout: Error | null, ack: ChatAck<{ lastReadSeq: string }>) => void;
  const socket = {
    connected: true,
    timeout: vi.fn().mockReturnThis(),
    emit: vi.fn((_event, _payload, callback) => {
      acknowledge = callback;
    }),
  };
  options.socket = socket as unknown as NonNullable<Options['socket']>;
  return {
    socket,
    ack: (timeout: Error | null, result: ChatAck<{ lastReadSeq: string }>) =>
      acknowledge(timeout, result),
  };
}

it('uses the authenticated socket acknowledgement and resumes on focus/visibility', async () => {
  const t = reading();
  const s = socketFor(t.options);
  t.page.hasFocus.mockReturnValue(false);
  dispose = trackMessageReading(t.options);
  expect(s.socket.emit).not.toHaveBeenCalled();
  t.page.hasFocus.mockReturnValue(true);
  t.window.dispatchEvent(new Event('focus'));
  expect(s.socket.timeout).toHaveBeenCalledWith(10000);
  expect(s.socket.emit).toHaveBeenCalledWith(
    'conversation:read',
    { conversationId: 'conversation', seq: '12' },
    expect.any(Function),
  );
  s.ack(null, { ok: true, data: { lastReadSeq: '12' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(t.options.readSeq.current).toBe('12');
  expect(t.request).not.toHaveBeenCalled();
});

it.each(['timeout', 'denied'])(
  'retries a %s socket acknowledgement within the existing five-second budget',
  async (failure) => {
    const t = reading();
    const s = socketFor(t.options);
    dispose = trackMessageReading(t.options);
    s.ack(failure === 'timeout' ? new Error('Timed out') : null, {
      ok: false,
      error: 'Denied',
      status: 403,
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.socket.emit).toHaveBeenCalledTimes(1);
    expect(t.options.readSeq.current).toBe('5');
    await vi.advanceTimersByTimeAsync(1);
    expect(s.socket.emit).toHaveBeenCalledTimes(2);
    s.ack(null, { ok: true, data: { lastReadSeq: '12' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.options.readSeq.current).toBe('12');
    expect(t.request).not.toHaveBeenCalled();
  },
);
