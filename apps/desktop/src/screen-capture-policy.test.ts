import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopPickerSnapshot } from '@tricord/shared' with { 'resolution-mode': 'import' };
import {
  DesktopCapturePolicy,
  type CaptureDocument,
  type NativeCaptureRequest,
} from './screen-capture-policy.js';

type Source = { id: string; name: string; thumbnail: object };
const policies: DesktopCapturePolicy<Source>[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(systemAudio: 'unqualified' | 'qualified-windows-loopback' = 'unqualified') {
  const owner = {},
    frame = {},
    pickerContents = {},
    pickerFrame = {};
  const document = {
    webContents: owner,
    mainFrame: frame,
    url: 'http://127.0.0.1:3001/app',
    navigation: 1,
    alive: true,
    authorized: true,
    authorizationGeneration: 1,
  };
  const pickerDocument: CaptureDocument = {
    webContents: pickerContents,
    mainFrame: pickerFrame,
    url: 'file:///synthetic/screen-picker.html',
    navigation: 1,
    alive: true,
  };
  const sources: Source[] = [
    { id: 'screen:1:0', name: 'Synthetic display', thumbnail: {} },
    { id: 'window:2:0', name: 'Synthetic window', thumbnail: {} },
  ];
  const enumerate = vi.fn(async (_signal: AbortSignal): Promise<readonly Source[]> => sources);
  const picker = { inspect: vi.fn(() => pickerDocument), close: vi.fn() };
  const openPicker = vi.fn(
    async (_snapshot: DesktopPickerSnapshot, _signal: AbortSignal) => picker,
  );
  const onError = vi.fn();
  const deps = {
    owner,
    targetOrigin: 'http://127.0.0.1:3001',
    pickerUrl: pickerDocument.url,
    inspectOwner: () => document,
    enumerate,
    openPicker,
    onError,
    systemAudio,
    timeoutMs: 1000,
  };
  const policy = new DesktopCapturePolicy(deps);
  policies.push(policy);
  const caller = { webContents: pickerContents, frame: pickerFrame };
  const request: NativeCaptureRequest = {
    frame,
    securityOrigin: deps.targetOrigin + '/',
    videoRequested: true,
    audioRequested: true,
    userGesture: true,
  };
  const respond = vi.fn();
  const begin = (override: Partial<NativeCaptureRequest> = {}) => {
    const ack = policy.begin({ ...request, ...override }, respond);
    if (!ack.ok) throw new Error('Fixture begin rejected: ' + ack.code);
    return ack.data.requestId;
  };
  const ready = async (override: Partial<NativeCaptureRequest> = {}) => {
    const requestId = begin(override);
    await flush();
    const snapshot = policy.getSources(caller);
    if (!snapshot.ok) throw new Error('Fixture picker not ready: ' + snapshot.code);
    return {
      requestId,
      snapshot: snapshot.data,
      choice: { requestId, handle: snapshot.data.sources[0]!.handle, sound: 'none' as const },
    };
  };
  return {
    policy,
    deps,
    document,
    pickerDocument,
    picker,
    enumerate,
    openPicker,
    onError,
    caller,
    request,
    sources,
    respond,
    begin,
    ready,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(() => {
  for (const policy of policies.splice(0)) policy.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('desktop capture consent boundary', () => {
  it.each([
    { frame: null },
    { frame: {} },
    { securityOrigin: 'https://evil.example' },
    { securityOrigin: 'http://127.0.0.1:3001/other' },
    { securityOrigin: 'http://user@127.0.0.1:3001' },
    { userGesture: false },
    { videoRequested: false },
  ])('denies untrusted native request %# before enumeration', (request) => {
    const f = fixture();
    expect(f.policy.begin({ ...f.request, ...request }, f.respond)).toEqual({
      ok: false,
      code: 'not_authorized',
    });
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.enumerate).not.toHaveBeenCalled();
    expect(f.openPicker).not.toHaveBeenCalled();
  });
  it.each(['foreign-owner', 'foreign-url', 'dead', 'unauthorized'] as const)(
    'denies %s owner context',
    (change) => {
      const f = fixture();
      if (change === 'foreign-owner') f.document.webContents = {};
      if (change === 'foreign-url') f.document.url = 'https://evil.example';
      if (change === 'dead') f.document.alive = false;
      if (change === 'unauthorized') f.document.authorized = false;
      expect(f.policy.begin(f.request, f.respond)).toMatchObject({ ok: false });
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
      expect(f.enumerate).not.toHaveBeenCalled();
    },
  );
  it('exposes bounded copied summaries only to the exact local picker frame; unauthorized queries cannot cancel the request', async () => {
    const f = fixture(),
      { snapshot, choice } = await f.ready();
    expect(Object.keys(snapshot.sources[0]!).sort()).toEqual(['handle', 'kind', 'label', 'sounds']);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /screen:1:0|window:2:0|thumbnail|webContents|mainFrame/,
    );
    expect(f.policy.getSources({ ...f.caller, frame: {} })).toMatchObject({ ok: false });
    expect(
      f.policy.getSources({ webContents: f.document.webContents, frame: f.document.mainFrame }),
    ).toMatchObject({ ok: false });
    expect(f.respond).not.toHaveBeenCalled();
    snapshot.sources[0]!.handle = 'modified';
    snapshot.sources[0]!.sounds.push('system');
    expect(await f.policy.select(f.caller, choice)).toEqual({ ok: true, data: { selected: true } });
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({ video: f.sources[0] });
    expect(f.picker.close).toHaveBeenCalledOnce();
    expect(await f.policy.select(f.caller, choice)).toMatchObject({ ok: false });
    expect(f.respond).toHaveBeenCalledOnce();
  });
  it('does not expose sources or cancel while initial enumeration is still unresolved', async () => {
    const f = fixture(),
      gate = deferred<readonly Source[]>();
    f.enumerate.mockReturnValueOnce(gate.promise);
    f.begin();
    expect(f.policy.getSources(f.caller)).toMatchObject({ ok: false });
    expect(f.respond).not.toHaveBeenCalled();
    gate.resolve(f.sources);
    await flush();
    expect(f.policy.getSources(f.caller).ok).toBe(true);
  });
  it('notifies picker readiness only after its live document is bound', async () => {
    const f = fixture();
    const ready = vi.fn(() => expect(f.policy.getSources(f.caller).ok).toBe(true));
    f.openPicker.mockResolvedValueOnce({ ...f.picker, ready } as typeof f.picker);
    await f.ready();
    expect(ready).toHaveBeenCalledOnce();
  });
  it('requires explicit sound consent plus native audio request and qualified screen-loopback policy', async () => {
    for (const qualified of [false, true]) {
      const f = fixture(qualified ? 'qualified-windows-loopback' : 'unqualified'),
        { choice, snapshot } = await f.ready();
      expect(snapshot.sources[0]!.sounds).toEqual(qualified ? ['none', 'system'] : ['none']);
      expect(snapshot.sources[1]!.sounds).toEqual(['none']);
      const result = await f.policy.select(f.caller, { ...choice, sound: 'system' });
      expect(result.ok).toBe(qualified);
      if (qualified)
        expect(f.respond).toHaveBeenCalledExactlyOnceWith({
          video: f.sources[0],
          audio: 'loopback',
        });
      else expect(f.respond).not.toHaveBeenCalled();
      f.policy.dispose();
    }
    const f = fixture('qualified-windows-loopback'),
      { choice } = await f.ready({ audioRequested: false });
    expect(await f.policy.select(f.caller, { ...choice, sound: 'system' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(f.respond).not.toHaveBeenCalled();
  });
  it('rejects injected raw source IDs, caller identities, missing consent, guessed and foreign handles without consuming a valid choice', async () => {
    const f = fixture(),
      { choice } = await f.ready();
    for (const mutation of [
      { sourceId: 'screen:1:0' },
      { frame: {} },
      { sound: undefined },
      { sound: 'microphone' },
      { handle: randomUUID() },
      { requestId: randomUUID() },
    ])
      expect((await f.policy.select(f.caller, { ...choice, ...mutation })).ok).toBe(false);
    expect(f.respond).not.toHaveBeenCalled();
    expect((await f.policy.select(f.caller, choice)).ok).toBe(true);
  });
  it('bounds source count and labels; rejects duplicate, empty and unsupported source lists', async () => {
    const f = fixture();
    f.sources[0]!.name = '\u0000' + 'x'.repeat(200);
    const { snapshot } = await f.ready();
    expect(snapshot.sources[0]!.label).toBe('x'.repeat(120));
    f.policy.dispose();
    for (const sources of [
      [],
      Array.from({ length: 33 }, (_, i) => ({
        id: `window:${i}:0`,
        name: 'Synthetic',
        thumbnail: {},
      })),
      [
        { id: 'screen:1:0', name: 'a', thumbnail: {} },
        { id: 'screen:1:0', name: 'b', thumbnail: {} },
      ],
      [{ id: 'tab:1:0', name: 'Synthetic', thumbnail: {} }],
    ]) {
      const f = fixture();
      f.enumerate.mockResolvedValueOnce(sources);
      f.begin();
      await flush();
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
      expect(f.openPicker).not.toHaveBeenCalled();
      expect(f.onError).toHaveBeenCalledWith('sources_failed');
    }
  });
});

describe('desktop capture request lifetime', () => {
  it('keeps one unresolved source operation reserved across timeout and consumes late completion', async () => {
    const f = fixture(),
      gate = deferred<readonly Source[]>();
    f.enumerate.mockReturnValueOnce(gate.promise);
    f.begin();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    const other = vi.fn();
    expect(f.policy.begin(f.request, other)).toMatchObject({ ok: false, code: 'busy' });
    expect(other).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.enumerate.mock.calls[0]![0].aborted).toBe(true);
    gate.resolve(f.sources);
    await flush();
    expect(f.openPicker).not.toHaveBeenCalled();
    f.begin();
    await flush();
    expect(f.openPicker).toHaveBeenCalledOnce();
  });
  it('closes a picker returned after timeout exactly once', async () => {
    const f = fixture(),
      gate = deferred<typeof f.picker>();
    f.openPicker.mockReturnValueOnce(gate.promise);
    f.begin();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    gate.resolve(f.picker);
    await flush();
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.picker.close).toHaveBeenCalledOnce();
  });
  it.each([
    'navigate',
    'same-url-navigation',
    'frame-replaced',
    'owner-destroyed',
    'logout',
    'authorization-replaced',
    'picker-navigated',
    'picker-destroyed',
  ] as const)(
    'denies and resolves once after %s during selection authorization',
    async (change) => {
      const f = fixture(),
        { choice } = await f.ready(),
        gate = deferred<readonly Source[]>();
      f.enumerate.mockReturnValueOnce(gate.promise);
      const pending = f.policy.select(f.caller, choice);
      if (change === 'navigate') f.document.url += '?changed';
      if (change === 'same-url-navigation') f.document.navigation++;
      if (change === 'frame-replaced') f.document.mainFrame = {};
      if (change === 'owner-destroyed') f.document.alive = false;
      if (change === 'logout') f.document.authorized = false;
      if (change === 'authorization-replaced') f.document.authorizationGeneration++;
      if (change === 'picker-navigated') f.pickerDocument.navigation++;
      if (change === 'picker-destroyed') f.pickerDocument.alive = false;
      f.policy.sweep();
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
      gate.resolve(f.sources);
      expect((await pending).ok).toBe(false);
      expect(f.respond).toHaveBeenCalledOnce();
      expect(f.picker.close).toHaveBeenCalledOnce();
    },
  );
  it('consumes selection handles before asynchronous re-enumeration and never substitutes a vanished or renamed source', async () => {
    for (const renamed of [false, true]) {
      const f = fixture(),
        { choice } = await f.ready(),
        gate = deferred<readonly Source[]>();
      f.enumerate.mockReturnValueOnce(gate.promise);
      const pending = f.policy.select(f.caller, choice);
      expect(await f.policy.select(f.caller, choice)).toMatchObject({ ok: false, code: 'busy' });
      gate.resolve(renamed ? [{ ...f.sources[0]!, name: 'Replacement' }] : [f.sources[1]!]);
      expect(await pending).toMatchObject({ ok: false, code: 'stale' });
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    }
  });
  it('returns only a fresh re-enumerated main-side source object', async () => {
    const f = fixture(),
      { choice } = await f.ready(),
      fresh = { ...f.sources[0]!, thumbnail: {} };
    f.enumerate.mockResolvedValueOnce([fresh]);
    expect((await f.policy.select(f.caller, choice)).ok).toBe(true);
    expect(f.respond.mock.calls[0]![0].video).toBe(fresh);
  });
  it('freezes offered source identity even if the enumerator mutates its original objects', async () => {
    const f = fixture(),
      { choice } = await f.ready();
    f.sources[0]!.name = 'Changed after consent';
    expect(await f.policy.select(f.caller, choice)).toMatchObject({ ok: false, code: 'stale' });
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
  });
  it('snapshots explicit sound consent before awaiting source revalidation', async () => {
    const f = fixture(),
      { choice } = await f.ready(),
      gate = deferred<readonly Source[]>();
    const mutable = { ...choice, sound: 'none' as 'none' | 'system' };
    f.enumerate.mockReturnValueOnce(gate.promise);
    const pending = f.policy.select(f.caller, mutable);
    mutable.sound = 'system';
    gate.resolve(f.sources);
    expect((await pending).ok).toBe(true);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith({ video: f.sources[0] });
  });
  it('checks expiry synchronously even if the timeout callback has not run', async () => {
    const f = fixture(),
      { choice } = await f.ready();
    vi.setSystemTime(101001);
    expect((await f.policy.select(f.caller, choice)).ok).toBe(false);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.enumerate).toHaveBeenCalledOnce();
  });
  it('closes an old picker whose owner navigates while it is opening', async () => {
    const f = fixture(),
      gate = deferred<typeof f.picker>();
    f.openPicker.mockReturnValueOnce(gate.promise);
    f.begin();
    await flush();
    f.document.navigation++;
    f.policy.sweep();
    gate.resolve(f.picker);
    await flush();
    expect(f.picker.close).toHaveBeenCalledOnce();
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
  });
  it('surfaces inspection failures as denial and never leaves a pending callback', async () => {
    const f = fixture(),
      { choice } = await f.ready();
    f.picker.inspect.mockImplementationOnce(() => {
      throw new Error('Synthetic destroyed-frame getter');
    });
    expect((await f.policy.select(f.caller, choice)).ok).toBe(false);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.onError).toHaveBeenCalledWith('context_failed');
  });
  it('denies callback failures and re-enumeration outages without retrying or substituting a source', async () => {
    for (const callbackFails of [false, true]) {
      const f = fixture(),
        { choice } = await f.ready();
      if (callbackFails)
        f.respond.mockImplementationOnce(() => {
          throw new Error('Synthetic callback failure');
        });
      else f.enumerate.mockRejectedValueOnce(new Error('Synthetic re-enumeration outage'));
      expect(await f.policy.select(f.caller, choice)).toMatchObject({
        ok: false,
        code: 'unavailable',
      });
      expect(f.respond).toHaveBeenCalledOnce();
      expect(f.onError).toHaveBeenCalledWith(callbackFails ? 'callback_failed' : 'sources_failed');
    }
  });
  it('consumes late enumeration failure after main invalidation and recovers admission', async () => {
    const f = fixture(),
      gate = deferred<readonly Source[]>();
    f.enumerate.mockReturnValueOnce(gate.promise);
    f.begin();
    f.policy.invalidate();
    gate.reject(new Error('Synthetic late failure'));
    await flush();
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    await f.ready();
    expect(f.openPicker).toHaveBeenCalledOnce();
  });
  it('cancels during selection without waiting and cannot revive from late enumeration', async () => {
    const f = fixture(),
      { choice } = await f.ready(),
      gate = deferred<readonly Source[]>();
    f.enumerate.mockReturnValueOnce(gate.promise);
    const selecting = f.policy.select(f.caller, choice);
    expect(f.policy.cancel(f.caller, { requestId: choice.requestId })).toEqual({
      ok: true,
      data: { cancelled: true },
    });
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    gate.resolve(f.sources);
    expect((await selecting).ok).toBe(false);
    expect(f.respond).toHaveBeenCalledOnce();
  });
  it('old cancel/handles cannot remove a replacement request', async () => {
    const f = fixture(),
      first = await f.ready();
    f.policy.cancel(f.caller, { requestId: first.requestId });
    const second = await f.ready();
    expect(f.policy.cancel(f.caller, { requestId: first.requestId })).toMatchObject({
      ok: false,
      code: 'stale',
    });
    expect((await f.policy.select(f.caller, first.choice)).ok).toBe(false);
    expect((await f.policy.select(f.caller, second.choice)).ok).toBe(true);
    expect(f.respond).toHaveBeenCalledTimes(2);
  });
  it('fences owner changes during initial enumeration before opening a picker', async () => {
    const f = fixture(),
      gate = deferred<readonly Source[]>();
    f.enumerate.mockReturnValueOnce(gate.promise);
    f.begin();
    f.document.navigation++;
    gate.resolve(f.sources);
    await flush();
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.openPicker).not.toHaveBeenCalled();
  });
  it('invalid picker URL, renderer reuse and picker-close failures never grant capture', async () => {
    for (const change of ['url', 'reuse', 'close'] as const) {
      const f = fixture();
      if (change === 'url') f.pickerDocument.url = 'https://evil.example';
      if (change === 'reuse') f.pickerDocument.webContents = f.document.webContents;
      if (change === 'close') {
        const { choice } = await f.ready();
        f.picker.close.mockImplementationOnce(() => {
          throw new Error('Fixture close failure');
        });
        expect(await f.policy.select(f.caller, choice)).toMatchObject({
          ok: false,
          code: 'unavailable',
        });
      } else {
        f.begin();
        await flush();
      }
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    }
  });
  it('rechecks the owner after picker close before invoking the native grant callback', async () => {
    const f = fixture(),
      { choice } = await f.ready();
    f.picker.close.mockImplementationOnce(() => {
      f.document.navigation++;
    });
    expect((await f.policy.select(f.caller, choice)).ok).toBe(false);
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
  });
  it('surfaces source/picker failures with safe codes and invokes the callback once', async () => {
    for (const phase of ['sources', 'picker'] as const) {
      const f = fixture();
      if (phase === 'sources')
        f.enumerate.mockRejectedValueOnce(new Error('Synthetic enumeration failure'));
      else f.openPicker.mockRejectedValueOnce(new Error('Synthetic picker failure'));
      f.begin();
      await flush();
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
      expect(f.onError).toHaveBeenCalledWith(
        phase === 'sources' ? 'sources_failed' : 'picker_failed',
      );
    }
  });
  it('disposal and main invalidation are synchronous and permanent disposal denies further requests', async () => {
    const f = fixture();
    await f.ready();
    f.policy.invalidate();
    f.policy.invalidate();
    expect(f.respond).toHaveBeenCalledExactlyOnceWith(null);
    await f.ready();
    f.policy.dispose();
    const other = vi.fn();
    expect(f.policy.begin(f.request, other).ok).toBe(false);
    expect(other).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.respond).toHaveBeenCalledTimes(2);
  });
});
