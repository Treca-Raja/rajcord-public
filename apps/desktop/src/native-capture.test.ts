import { EventEmitter } from 'node:events';
import type { BrowserWindow, Session, WebContents, WebFrameMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  installNativeCapture,
  type NativeCapturePermissions,
  type TrustedCaptureIntent,
  type NativeCaptureSource,
} from './native-capture.js';
import { screenPickerUrl } from './screen-picker.js';
import { ServerCaptureAuthority } from './capture-authority.js';
import type { DesktopCapturePolicy } from './screen-capture-policy.js';
import type { DesktopPickerSnapshot } from '@tricord/shared' with { 'resolution-mode': 'import' };

type Boundary = ReturnType<typeof installNativeCapture>;
const boundaries: Boundary[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(overrides: Partial<Parameters<typeof installNativeCapture>[0]> = {}) {
  let request!: NativeCapturePermissions['request'], check!: NativeCapturePermissions['check'];
  let display!: NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>;
  const session = {
    setPermissionRequestHandler: vi.fn((handler: typeof request) => {
      request = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler: typeof check) => {
      check = handler;
    }),
    setDisplayMediaRequestHandler: vi.fn((handler: typeof display) => {
      display = handler;
    }),
  } as unknown as Session;
  const frame = { url: 'http://127.0.0.1:3001/app', detached: false } as WebFrameMain;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    session,
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const owner = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  }) as unknown as BrowserWindow;
  const shutdown = new EventEmitter(),
    listeners = new Set<() => void>();
  let intent: TrustedCaptureIntent | null = null;
  const authority = {
    inspect: vi.fn(() => intent),
    verify: vi.fn(
      async (value: TrustedCaptureIntent) =>
        intent?.intent === value.intent &&
        intent.authorization === value.authorization &&
        intent.generation === value.generation,
    ),
    onInvalidated: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const source: NativeCaptureSource = {
    id: 'screen:1:0',
    name: 'Synthetic',
    video: { id: 'screen:1:0', name: 'Synthetic' },
  };
  const enumerate = vi.fn(async (_signal: AbortSignal): Promise<readonly NativeCaptureSource[]> => [
    source,
  ]);
  const pickerDocument = {
    webContents: {},
    mainFrame: {},
    url: screenPickerUrl,
    navigation: 1,
    alive: true,
  };
  const picker = { inspect: () => pickerDocument, close: vi.fn() };
  let pickerPolicy!: DesktopCapturePolicy<NativeCaptureSource>, snapshot!: DesktopPickerSnapshot;
  const openPicker = vi.fn(
    async (value: DesktopPickerSnapshot, _signal: AbortSignal, policy: typeof pickerPolicy) => {
      snapshot = value;
      pickerPolicy = policy;
      return picker;
    },
  );
  const permissions: NativeCapturePermissions = {
    request: vi.fn((_wc, _permission, cb) => cb(true)),
    check: vi.fn(() => true),
  };
  const errors = vi.fn();
  const boundary = installNativeCapture({
    owner,
    session,
    targetOrigin: 'http://127.0.0.1:3001',
    permissions,
    enabled: true,
    authority,
    qualification: 'synthetic-webcontents',
    enumerate,
    openPicker,
    onError: errors,
    shutdown,
    ...overrides,
  });
  boundaries.push(boundary);
  const issue = (change: Partial<TrustedCaptureIntent> = {}) => {
    intent = {
      intent: {},
      authorization: {},
      generation: 1,
      expires: Date.now() + 5000,
      frame,
      url: frame.url,
      navigation: boundary.context()!.navigation,
      sound: 'none',
      ...change,
    };
    return intent;
  };
  const invalidate = () => {
    for (const listener of listeners) listener();
  };
  const details = () =>
    ({ isMainFrame: true, requestingUrl: frame.url }) as Parameters<typeof check>[3];
  const allowed = (
    change: Partial<Parameters<typeof check>[3]> = {},
    wc = contents,
    origin = 'http://127.0.0.1:3001',
  ) => check(wc, 'display-capture', origin, { ...details(), ...change });
  const native = (change: Partial<Parameters<typeof display>[0]> = {}) => {
    const callback = vi.fn();
    display(
      {
        frame,
        securityOrigin: 'http://127.0.0.1:3001/',
        userGesture: true,
        videoRequested: true,
        audioRequested: false,
        ...change,
      },
      callback,
    );
    return callback;
  };
  const select = () =>
    pickerPolicy.select(
      { webContents: pickerDocument.webContents, frame: pickerDocument.mainFrame },
      { requestId: snapshot.requestId, handle: snapshot.sources[0]!.handle, sound: 'none' },
    );
  return {
    boundary,
    owner,
    contents,
    frame,
    session,
    authority,
    permissions,
    errors,
    shutdown,
    picker,
    enumerate,
    openPicker,
    issue,
    invalidate,
    allowed,
    native,
    select,
    source,
    setIntent: (value: TrustedCaptureIntent | null) => {
      intent = value;
    },
    permissionRequest: (name: Parameters<typeof request>[1], extra = {}) => {
      const cb = vi.fn();
      request(contents, name, cb, {
        requestingUrl: frame.url,
        isMainFrame: true,
        ...extra,
      } as Parameters<typeof request>[3]);
      return cb;
    },
    permissionCheck: (name: Parameters<typeof check>[1], extra = {}) =>
      check(contents, name, 'http://127.0.0.1:3001', { ...details(), ...extra }),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(() => {
  for (const boundary of boundaries.splice(0)) boundary.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it.each([
  { enabled: undefined },
  { enabled: false },
  { authority: undefined },
  { qualification: undefined },
  { qualification: 'unqualified' as const },
  { enumerate: undefined },
])('denies unavailable enable/authority/source gates %# before enumeration', (options) => {
  const f = fixture(options);
  f.issue();
  expect(f.allowed()).toBe(false);
  expect(f.native()).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.enumerate).not.toHaveBeenCalled();
});
it('permits only the exact main-frame armed intent and consumes it once', async () => {
  const f = fixture();
  f.issue();
  expect(f.allowed()).toBe(true);
  expect(f.allowed({ isMainFrame: false })).toBe(false);
  expect(f.allowed({}, {} as WebContents)).toBe(false);
  expect(f.allowed({}, f.contents, 'https://evil.example')).toBe(false);
  expect(f.allowed({ requestingUrl: f.frame.url + '?stale' })).toBe(false);
  const callback = f.native();
  await flush();
  expect(callback).not.toHaveBeenCalled();
  expect((await f.select()).ok).toBe(true);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ video: f.source.video });
  expect(f.allowed()).toBe(false);
  expect(f.native()).toHaveBeenCalledExactlyOnceWith(null);
});
it.each([
  { frame: null },
  { frame: {} as WebFrameMain },
  { securityOrigin: 'https://evil.example' },
  { userGesture: false },
  { videoRequested: false },
  { audioRequested: true },
])('rejects malformed/mismatched native request %#', (request) => {
  const f = fixture();
  f.issue();
  expect(f.native(request)).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.openPicker).not.toHaveBeenCalled();
});
it('rejects a second native request without evicting the pending owner', async () => {
  const f = fixture();
  f.issue();
  const first = f.native();
  await flush();
  expect(f.native()).toHaveBeenCalledExactlyOnceWith(null);
  expect(first).not.toHaveBeenCalled();
  await f.select();
  expect(first).toHaveBeenCalledOnce();
});
it.each([
  'logout',
  'authorization',
  'generation',
  'intent',
  'expiry',
  'navigation',
  'renderer',
  'window',
  'shutdown',
] as const)('invalidates pending native selection on %s', async (reason) => {
  const f = fixture(),
    intent = f.issue();
  const callback = f.native();
  await flush();
  const gate = deferred<readonly NativeCaptureSource[]>();
  f.enumerate.mockReturnValueOnce(gate.promise);
  const selection = f.select();
  if (reason === 'logout') {
    f.setIntent(null);
    f.invalidate();
  }
  if (reason === 'authorization') {
    f.setIntent({ ...intent, authorization: {} });
    f.invalidate();
  }
  if (reason === 'generation') {
    f.setIntent({ ...intent, generation: 2 });
    f.invalidate();
  }
  if (reason === 'intent') {
    f.setIntent({ ...intent, intent: {} });
    f.invalidate();
  }
  if (reason === 'expiry') await vi.advanceTimersByTimeAsync(5000);
  if (reason === 'navigation') f.contents.emit('did-start-navigation', {});
  if (reason === 'renderer') f.contents.emit('render-process-gone', {});
  if (reason === 'window') f.owner.emit('closed');
  if (reason === 'shutdown') f.shutdown.emit('before-quit');
  expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  gate.resolve([f.source]);
  expect((await selection).ok).toBe(false);
  expect(callback).toHaveBeenCalledOnce();
});
it('requires new intent identity after cancellation and old completion cannot affect a replacement', async () => {
  const f = fixture();
  f.issue();
  const first = f.native();
  await flush();
  f.boundary.invalidate();
  expect(first).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.allowed()).toBe(false);
  f.issue({ generation: 2 });
  const second = f.native();
  await flush();
  await f.select();
  expect(second).toHaveBeenCalledExactlyOnceWith({ video: f.source.video });
  expect(first).toHaveBeenCalledOnce();
});
it('does not extend the captured authorization deadline when the authority later renews', async () => {
  const f = fixture(),
    intent = f.issue();
  const callback = f.native();
  await flush();
  f.setIntent({ ...intent, expires: intent.expires + 10000 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.allowed()).toBe(false);
});
it('fails closed on an authority outage, without forwarding display permission to microphone handlers', async () => {
  const f = fixture();
  f.issue();
  const callback = f.native();
  await flush();
  f.authority.inspect.mockImplementationOnce(() => {
    throw new Error('Fixture authority outage');
  });
  expect(f.allowed()).toBe(false);
  expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.errors).toHaveBeenCalledWith('authority_unavailable');
  expect(f.permissions.check).not.toHaveBeenCalled();
});
it('rejects detached or unreadable native sources once final verification settles', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.issue();
    const callback = f.native();
    await flush();
    const fresh = { ...f.source };
    Object.defineProperty(fresh, 'video', {
      get: () => {
        if (throws) throw new Error('Synthetic disposed source getter');
        return { detached: true };
      },
    });
    f.enumerate.mockResolvedValueOnce([fresh]);
    await f.select();
    await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  }
});
it('withholds native completion until server consume verifies, and ignores late authorization after logout', async () => {
  const f = fixture();
  f.issue();
  const callback = f.native();
  await flush();
  let release!: (value: boolean) => void;
  f.authority.verify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await f.select();
  expect(callback).not.toHaveBeenCalled();
  f.setIntent(null);
  f.invalidate();
  expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  release(true);
  await flush();
  expect(callback).toHaveBeenCalledOnce();
});
it.each(['resolve', 'reject'] as const)(
  'denies native completion at consume timeout before late %s',
  async (late) => {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const id = 'd567e019-10fc-471a-b37d-c1807d6092d0';
    const transport = vi.fn(async (operation: string) => {
      if (operation === 'consume')
        return new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
      return operation === 'cancel' ? { cancelled: true } : { id, remainingMs: 10000 };
    });
    const authority = new ServerCaptureAuthority({
      context: () => f.boundary.context(),
      transport,
      onError: vi.fn(),
    });
    const f: ReturnType<typeof fixture> = fixture({ authority });
    await authority.prepare('none');
    const callback = f.native();
    await flush();
    try {
      await f.select();
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledExactlyOnceWith(null);
      expect(authority.inspect()).toBeNull();
      await expect(authority.prepare('none')).rejects.toThrow(/busy/);
    } finally {
      if (late === 'resolve') resolve({ id, remainingMs: 10000 });
      else reject(new Error('Synthetic late consume failure'));
      await flush();
      await authority.dispose();
      await flush();
    }
    expect(callback).toHaveBeenCalledOnce();
  },
);
it('checks authority replacement again on permission delivery even without an invalidation notification', async () => {
  const f = fixture(),
    intent = f.issue();
  const callback = f.native();
  await flush();
  f.setIntent({ ...intent, authorization: {} });
  expect(f.allowed()).toBe(false);
  expect(callback).toHaveBeenCalledExactlyOnceWith(null);
});
it('invalidates an unused armed intent on document navigation', () => {
  const f = fixture();
  f.issue();
  f.contents.emit('did-start-navigation', {});
  expect(f.allowed()).toBe(false);
  expect(f.native()).toHaveBeenCalledExactlyOnceWith(null);
});
it('preserves microphone/speaker handlers while denying camera and display after disposal', () => {
  const f = fixture();
  expect(f.permissionRequest('media', { mediaTypes: ['audio'] })).toHaveBeenCalledExactlyOnceWith(
    true,
  );
  expect(f.permissionCheck('media', { mediaType: 'audio' })).toBe(true);
  expect(f.permissionCheck('speaker-selection')).toBe(true);
  expect(f.permissionRequest('media', { mediaTypes: ['video'] })).toHaveBeenCalledExactlyOnceWith(
    false,
  );
  expect(f.permissionCheck('media', { mediaType: 'video' })).toBe(false);
  f.issue();
  f.boundary.dispose();
  expect(f.permissionCheck('display-capture')).toBe(false);
  expect(f.native()).toHaveBeenCalledExactlyOnceWith(null);
  expect(f.permissionCheck('media', { mediaType: 'audio' })).toBe(true);
});
it('requires the exact intent document generation and leaves system audio unqualified', () => {
  const f = fixture();
  f.issue({ navigation: 10 });
  expect(f.allowed()).toBe(false);
  f.issue({ sound: 'system' });
  expect(f.allowed()).toBe(false);
  expect(f.native({ audioRequested: true })).toHaveBeenCalledExactlyOnceWith(null);
});
it('rejects session takeover and removes all authority/lifecycle subscriptions on dispose', () => {
  const f = fixture();
  expect(() =>
    installNativeCapture({
      owner: f.owner,
      session: f.session,
      targetOrigin: 'http://127.0.0.1:3001',
      permissions: f.permissions,
      onError: f.errors,
    }),
  ).toThrow(/already/);
  f.boundary.dispose();
  expect(f.shutdown.listenerCount('will-quit')).toBe(0);
  expect(f.contents.listenerCount('did-start-navigation')).toBe(0);
});
