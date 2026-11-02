import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebFrameMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServerCaptureAuthority, type CaptureAuthorityTransport } from './capture-authority.js';
import {
  createSessionCaptureAuthority,
  sessionCaptureTransport,
} from './capture-authority-http.js';

const sources: { dispose(): Promise<void> }[] = [];
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.dispose()));
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
function fixture() {
  const context = {
    mainFrame: {} as WebFrameMain,
    url: 'http://127.0.0.1:3001/app',
    navigation: 1,
    alive: true,
  };
  const id = randomUUID();
  const transport = vi.fn<CaptureAuthorityTransport>(async (operation) =>
    operation === 'cancel' ? { cancelled: true } : { id, remainingMs: 10000 },
  );
  const onError = vi.fn();
  const authority = new ServerCaptureAuthority({ context: () => context, transport, onError });
  sources.push(authority);
  return { authority, transport, context, id, onError };
}
it('binds only main context, conservatively subtracts full RTT and consumes once before reauthorization', async () => {
  const f = fixture();
  f.transport.mockImplementationOnce(async () => {
    vi.setSystemTime(100500);
    return { id: f.id, remainingMs: 10000 };
  });
  const intent = await f.authority.prepare('none');
  expect(intent.expires).toBe(110000);
  expect(intent.frame).toBe(f.context.mainFrame);
  expect(Object.isFrozen(intent)).toBe(true);
  expect(await f.authority.verify(intent)).toBe(true);
  expect(await f.authority.verify(intent)).toBe(false);
  expect(f.transport.mock.calls.map((call) => call[0])).toEqual(['prepare', 'consume']);
});
it.each(['navigation', 'frame', 'url', 'expiry'] as const)(
  'invalidates on %s and emits before any remote cleanup',
  async (change) => {
    const f = fixture(),
      intent = await f.authority.prepare('none'),
      invalidated = vi.fn();
    f.authority.onInvalidated(invalidated);
    if (change === 'navigation') f.context.navigation++;
    if (change === 'frame') f.context.mainFrame = {} as WebFrameMain;
    if (change === 'url') f.context.url += '?changed';
    if (change === 'expiry') vi.setSystemTime(intent.expires + 1);
    expect(f.authority.inspect()).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(await f.authority.verify(intent)).toBe(false);
    await flush();
  },
);
it('rejects stale prepare completion and keeps a single ignored-abort operation reserved until settlement', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const pending = f.authority.prepare('none');
  await flush();
  f.authority.invalidate();
  await expect(f.authority.prepare('none')).rejects.toThrow(/busy/);
  resolve({ id: f.id, remainingMs: 10000 });
  await expect(pending).rejects.toThrow(/ended/);
  await flush();
  expect(f.authority.inspect()).toBeNull();
  expect(f.transport.mock.calls.some((call) => call[0] === 'cancel')).toBe(true);
});
it('rejects delayed consume completion after logout and does not revive the intent', async () => {
  const f = fixture(),
    intent = await f.authority.prepare('none');
  let resolve!: (value: unknown) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const verify = f.authority.verify(intent);
  await flush();
  f.authority.invalidate();
  resolve({ id: f.id, remainingMs: 10000 });
  expect(await verify).toBe(false);
  expect(f.authority.inspect()).toBeNull();
});
it('rejects a late response after network timeout even when the transport ignores abort', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const pending = f.authority.prepare('none');
  await flush();
  const rejected = expect(pending).rejects.toThrow(/ended/);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.transport.mock.calls[0]![2].aborted).toBe(true);
  resolve({ id: f.id, remainingMs: 10000 });
  await rejected;
  await flush();
  expect(f.authority.inspect()).toBeNull();
});
it('watches revocation without extending deadlines and fails closed on outages', async () => {
  const f = fixture(),
    intent = await f.authority.prepare('none');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.authority.inspect()?.expires).toBe(intent.expires);
  f.transport.mockRejectedValueOnce(new Error('Synthetic authority outage'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.authority.inspect()).toBeNull();
  expect(f.onError).toHaveBeenCalledWith('authority_unavailable');
});
it('queues at most one final verification behind a slow check, without overlapping HTTP work', async () => {
  const f = fixture(),
    intent = await f.authority.prepare('none');
  let resolve!: (value: unknown) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  const verify = f.authority.verify(intent);
  expect(await f.authority.verify(intent)).toBe(false);
  expect(f.transport).toHaveBeenCalledTimes(2);
  resolve({ id: f.id, remainingMs: 9000 });
  expect(await verify).toBe(true);
  expect(f.transport.mock.calls.map((call) => call[0])).toEqual(['prepare', 'check', 'consume']);
});
it('invalidates at the logical deadline while an ignored-abort check still owns the native slot', async () => {
  const f = fixture(),
    intent = await f.authority.prepare('none');
  let resolve!: (value: unknown) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  let verified: boolean | undefined;
  const verification = f.authority.verify(intent).then((value) => {
    verified = value;
  });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.transport.mock.calls[1]![2].aborted).toBe(true);
    expect(f.authority.inspect()).toBeNull();
    expect(verified).toBe(false);
    await expect(f.authority.prepare('none')).rejects.toThrow(/busy/);
    expect(f.transport).toHaveBeenCalledTimes(2);
  } finally {
    resolve({ id: f.id, remainingMs: 4000 });
    await verification;
    await flush();
  }
});
it('settles local disposal and prepare without waiting for ignored native abort', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.transport.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  let ended = false,
    disposed = false;
  const pending = f.authority.prepare('none').catch(() => {
    ended = true;
  });
  await flush();
  const disposal = f.authority.dispose().then(() => {
    disposed = true;
  });
  try {
    await flush();
    expect(ended).toBe(true);
    expect(disposed).toBe(true);
    expect(f.authority.inspect()).toBeNull();
  } finally {
    resolve({ id: f.id, remainingMs: 10000 });
    await Promise.all([pending, disposal]);
    await flush();
  }
});
it.each([
  { status: 503, type: 'application/json' },
  { status: 200, type: 'text/html' },
  { status: 200, type: 'application/jsonp' },
])('cancels the rejected response body for $status/$type', async ({ status, type }) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const response = new Response(body, { status, headers: { 'content-type': type } });
  const transport = sessionCaptureTransport(
    { fetch: vi.fn(async () => response) } as never,
    'https://fixture.example',
  );
  try {
    await expect(
      transport(
        'prepare',
        { requestId: randomUUID(), sound: 'none' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    if (!response.bodyUsed) await body.cancel();
  }
});
it.each(
  (['prepare', 'consume', 'check'] as const).flatMap((operation) =>
    (['timeout', 'invalidate', 'dispose'] as const).flatMap((interruption) =>
      (['resolve', 'reject'] as const).map((late) => ({ operation, interruption, late })),
    ),
  ),
)(
  'fences $operation on $interruption before late $late',
  async ({ operation, interruption, late }) => {
    const f = fixture();
    const intent = operation === 'prepare' ? undefined : await f.authority.prepare('none');
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    f.transport.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    let ended = false;
    let pending: Promise<unknown> | undefined;
    if (operation === 'prepare')
      pending = f.authority.prepare('none').catch(() => {
        ended = true;
      });
    if (operation === 'consume')
      pending = f.authority.verify(intent!).then((value) => {
        expect(value).toBe(false);
        ended = true;
      });
    if (operation === 'check') await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const calls = f.transport.mock.calls.length;
    try {
      if (interruption === 'timeout') await vi.advanceTimersByTimeAsync(5000);
      if (interruption === 'invalidate') f.authority.invalidate();
      if (interruption === 'dispose') await f.authority.dispose();
      await flush();
      expect(f.authority.inspect()).toBeNull();
      if (pending) expect(ended).toBe(true);
      expect(f.transport.mock.calls.at(-1)![2].aborted).toBe(true);
      await expect(f.authority.prepare('none')).rejects.toThrow(/busy/);
      expect(f.transport).toHaveBeenCalledTimes(calls);
    } finally {
      if (late === 'resolve') resolve({ id: f.id, remainingMs: 10000 });
      else reject(new Error('Synthetic late native failure'));
      await pending;
      await flush();
    }
    expect(f.authority.inspect()).toBeNull();
    expect(f.transport.mock.calls.filter((call) => call[0] === 'cancel')).toHaveLength(1);
    await flush();
    if (interruption !== 'dispose') {
      const replacement = await f.authority.prepare('none');
      expect(replacement).not.toBe(intent);
      expect(await f.authority.verify(replacement)).toBe(true);
    }
  },
);
it.each(['resolve', 'reject'] as const)(
  'bounds background cancellation and observes its late %s',
  async (late) => {
    const f = fixture();
    await f.authority.prepare('none');
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    f.transport.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    f.authority.invalidate();
    await flush();
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.onError).toHaveBeenCalledWith('cancel_unavailable');
      expect(f.transport.mock.calls.at(-1)![2].aborted).toBe(true);
      await expect(f.authority.prepare('none')).rejects.toThrow(/busy/);
      await f.authority.dispose();
      expect(f.transport).toHaveBeenCalledTimes(2);
    } finally {
      if (late === 'resolve') resolve({ cancelled: true });
      else reject(new Error('Synthetic late cancel failure'));
      await flush();
    }
    expect(f.onError).toHaveBeenCalledExactlyOnceWith('cancel_unavailable');
  },
);
it('does not dispatch obsolete prepare work after same-stack disposal', async () => {
  const f = fixture();
  const pending = f.authority.prepare('none');
  const rejected = expect(pending).rejects.toThrow(/ended/);
  await f.authority.dispose();
  await rejected;
  await flush();
  expect(f.transport.mock.calls.every((call) => call[0] === 'cancel')).toBe(true);
});
it.each(['reject', 'hang'] as const)(
  'keeps %s body cancellation bounded logically and owns native cleanup',
  async (outcome) => {
    const f = fixture();
    let release!: () => void;
    const cancel = vi.fn(() =>
      outcome === 'reject'
        ? Promise.reject(new Error('Synthetic body cancellation failure'))
        : new Promise<void>((yes) => {
            release = yes;
          }),
    );
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    const fetch = vi.fn(async () => response);
    const transport = sessionCaptureTransport({ fetch } as never, 'https://fixture.example');
    f.transport.mockImplementationOnce((op, body, signal) => transport(op, body, signal));
    let ended = false;
    const pending = f.authority.prepare('none').catch(() => {
      ended = true;
    });
    await flush();
    try {
      expect(cancel).toHaveBeenCalledOnce();
      if (outcome === 'hang') {
        await vi.advanceTimersByTimeAsync(5000);
        expect(ended).toBe(true);
        await expect(f.authority.prepare('none')).rejects.toThrow(/busy/);
        expect(f.transport).toHaveBeenCalledTimes(1);
      } else {
        await pending;
        expect(ended).toBe(true);
      }
      await f.authority.dispose();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      await pending;
      await flush();
    }
    expect(response.body!.locked).toBe(false);
  },
);
it('cancels a stalled JSON reader on abort and makes no later POST', async () => {
  const f = fixture(),
    cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
    headers: { 'content-type': 'application/json' },
  });
  const fetch = vi.fn(async () => response);
  const transport = sessionCaptureTransport({ fetch } as never, 'https://fixture.example');
  f.transport.mockImplementationOnce((op, body, signal) => transport(op, body, signal));
  const pending = f.authority.prepare('none');
  const rejected = expect(pending).rejects.toThrow(/ended/);
  await flush();
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  await flush();
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('disposes late headers after abort without parsing authority or making another request', async () => {
  const f = fixture(),
    cancel = vi.fn();
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((yes) => {
        resolve = yes;
      }),
  );
  const transport = sessionCaptureTransport({ fetch } as never, 'https://fixture.example');
  f.transport.mockImplementationOnce((op, body, signal) => transport(op, body, signal));
  const pending = f.authority.prepare('none');
  const rejected = expect(pending).rejects.toThrow(/ended/);
  await flush();
  try {
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await expect(f.authority.prepare('none')).rejects.toThrow(/busy/);
  } finally {
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-type': 'application/json' },
    });
    resolve(response);
    await flush();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(f.authority.inspect()).toBeNull();
});
it('cancels oversized live JSON and releases malformed JSON readers', async () => {
  const cancel = vi.fn();
  const oversized = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8193));
      },
      cancel,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  const malformed = new Response('{', { headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn().mockResolvedValueOnce(oversized).mockResolvedValueOnce(malformed);
  const transport = sessionCaptureTransport({ fetch } as never, 'https://fixture.example');
  const args = [
    'prepare',
    { requestId: randomUUID(), sound: 'none' },
    new AbortController().signal,
  ] as const;
  await expect(transport(...args)).rejects.toThrow(/limit/);
  expect(cancel).toHaveBeenCalledOnce();
  expect(oversized.body!.locked).toBe(false);
  await expect(transport(...args)).rejects.toThrow(SyntaxError);
  expect(malformed.bodyUsed).toBe(true);
  expect(malformed.body!.locked).toBe(false);
});
it('retains both the rejected-response error and a failed cancellation cause', async () => {
  const cleanupError = new Error('Synthetic cancellation failure');
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(cleanupError),
    }),
    { status: 503 },
  );
  const transport = sessionCaptureTransport(
    { fetch: async () => response } as never,
    'https://fixture.example',
  );
  const error = await transport(
    'prepare',
    { requestId: randomUUID(), sound: 'none' },
    new AbortController().signal,
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  const failure = error as AggregateError;
  expect(failure.errors).toEqual([
    expect.objectContaining({ message: 'Capture authority request failed.' }),
    cleanupError,
  ]);
  expect(failure.cause).toBe(failure.errors[0]);
  expect(response.body!.locked).toBe(false);
});
it.each([
  { remainingMs: 0 },
  { remainingMs: 45001 },
  { remainingMs: 1.5 },
  { id: 'invalid' },
  { sessionId: 'injected' },
])('rejects malformed authority response %#', async (mutation) => {
  const f = fixture();
  f.transport.mockResolvedValueOnce({ id: f.id, remainingMs: 10000, ...mutation });
  await expect(f.authority.prepare('none')).rejects.toThrow();
  expect(f.authority.inspect()).toBeNull();
});
it('uses only fixed session fetch routes, keeps CSRF in main and rejects redirects/oversized responses', async () => {
  const csrf = 'a'.repeat(64),
    id = randomUUID();
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith('/me')
            ? { user: { status: 'approved' }, csrfToken: csrf }
            : { id, remainingMs: 10000 },
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const transport = sessionCaptureTransport({ fetch } as never, 'https://fixture.example');
  const signal = new AbortController().signal;
  await transport('prepare', { requestId: randomUUID(), sound: 'none' }, signal);
  await transport('check', { id }, signal);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    'https://fixture.example/api/auth/me',
    'https://fixture.example/api/screen/capture/prepare',
    'https://fixture.example/api/screen/capture/check',
  ]);
  expect(fetch).toHaveBeenLastCalledWith(
    'https://fixture.example/api/screen/capture/check',
    expect.objectContaining({
      credentials: 'include',
      redirect: 'error',
      headers: expect.objectContaining({ Origin: 'https://fixture.example', 'X-CSRF-Token': csrf }),
    }),
  );
  fetch.mockResolvedValueOnce(
    new Response('x'.repeat(8193), { headers: { 'content-type': 'application/json' } }),
  );
  await expect(transport('check', { id }, signal)).rejects.toThrow(/limit/);
  expect(() => sessionCaptureTransport({ fetch } as never, 'http://remote.example')).toThrow();
});
it.each(['navigation', 'renderer-loss', 'closed', 'cookie', 'before-quit', 'will-quit'])(
  'invalidates native session authority on %s and removes lifecycle listeners on disposal',
  async (change) => {
    const cookies = new EventEmitter(),
      shutdown = new EventEmitter();
    const session = {
      cookies,
      fetch: vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith('/me')
                ? { user: { status: 'approved' }, csrfToken: 'a'.repeat(64) }
                : url.endsWith('/cancel')
                  ? { cancelled: true }
                  : { id: randomUUID(), remainingMs: 10000 },
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    };
    const contents = Object.assign(new EventEmitter(), { session });
    const owner = Object.assign(new EventEmitter(), { webContents: contents });
    const frame = {} as WebFrameMain;
    const authority = createSessionCaptureAuthority({
      owner: owner as never,
      session: session as never,
      shutdown,
      origin: 'https://fixture.example',
      onError: vi.fn(),
      context: () => ({
        mainFrame: frame,
        url: 'https://fixture.example/app',
        navigation: 1,
        alive: true,
      }),
    });
    sources.push(authority);
    expect(session.fetch).not.toHaveBeenCalled();
    const intent = await authority.prepare('none');
    expect(authority.inspect()).toBe(intent);
    const invalidated = vi.fn();
    authority.onInvalidated(invalidated);
    cookies.emit('changed', {}, { name: 'unrelated' });
    expect(invalidated).not.toHaveBeenCalled();
    expect(authority.inspect()).toBe(intent);
    if (change === 'navigation') contents.emit('did-start-navigation');
    if (change === 'renderer-loss') contents.emit('render-process-gone');
    if (change === 'closed') owner.emit('closed');
    if (change === 'cookie') cookies.emit('changed', {}, { name: 'tricord_session' });
    if (change.endsWith('quit')) shutdown.emit(change);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(authority.inspect()).toBeNull();
    await authority.dispose();
    for (const emitter of [contents, owner, cookies, shutdown])
      expect(emitter.eventNames()).toEqual([]);
    expect(session.fetch.mock.calls.map((call) => new URL(call[0]).pathname)).toEqual([
      '/api/auth/me',
      '/api/screen/capture/prepare',
      '/api/screen/capture/cancel',
    ]);
    expect(() =>
      createSessionCaptureAuthority({
        owner: owner as never,
        session: {} as never,
        origin: 'https://fixture.example',
        context: () => null,
        onError: vi.fn(),
      }),
    ).toThrow(/session/);
  },
);
