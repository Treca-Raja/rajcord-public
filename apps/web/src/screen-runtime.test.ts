import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScreenRuntime, type ScreenRuntimeAttachment } from './screen-runtime';
import { ScreenBindingOwner, type ScreenBindingDependency } from './screen-binding';
import { ApprovedVoiceSession } from './voice-session';
import { WebScreenCapture } from './screen-capture';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const channel = 'd263d939-d638-4bf0-8f60-9ca08763a372';
const lease = { id: '0a16e0e1-27ee-4603-b0d7-a631636e29cc', channelId: channel };
const reply = () => ({
  epoch: '69229444-94d6-4127-9cce-c2ef505f7521',
  channelId: channel,
  remainingMs: 45000,
});
const flush = async () => {
  for (let i = 0; i < 32; i++) await Promise.resolve();
};
const sessions: ApprovedVoiceSession[] = [],
  runtimes: ScreenRuntime[] = [],
  owners: ScreenBindingOwner[] = [];
const drain: (() => void)[] = [],
  pending: Promise<unknown>[] = [];
function session() {
  const value = new ApprovedVoiceSession(async <T>() => ({ ok: true }) as T);
  sessions.push(value);
  return value;
}
function fixture() {
  const created: {
    raw: ReturnType<typeof deferred<unknown>>;
    retired: ReturnType<typeof deferred<void>>;
    retire: ReturnType<typeof vi.fn>;
  }[] = [];
  const errors = vi.fn(),
    capture = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
  const create = vi.fn<ScreenBindingDependency['create']>((own) => {
    const raw = deferred<unknown>(),
      retired = deferred<void>(),
      retire = vi.fn(() => retired.promise);
    created.push({ raw, retired, retire });
    own(retire);
    drain.push(() => {
      raw.resolve(reply());
      retired.resolve();
    });
    return { bind: () => raw.promise, retire };
  });
  const runtime = new ScreenRuntime({
    binding: { create, onError: errors },
    capture,
    onError: errors,
  });
  runtimes.push(runtime);
  function attach(s = session()) {
    const attachment = runtime.attach(s);
    const owner = new ScreenBindingOwner(attachment.bindingDependency);
    owners.push(owner);
    const listeners = new Set<() => void>();
    const delegate = {
      bindScreens: ({ signal }: { signal?: AbortSignal } = {}) =>
        owner.bind(lease, () => s.current, signal),
      onLeaseInvalidated: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    attachment.connectVoice(delegate);
    return { attachment, owner, listeners, session: s, delegate };
  }
  return { runtime, create, created, errors, capture, attach };
}
function observe<T>(work: Promise<T>) {
  const result = work.then(
    (value) => ({ value }),
    (cause) => ({ cause: cause as Error }),
  );
  pending.push(result);
  return result;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  sessions.splice(0).forEach((s) => s.invalidate());
  owners.splice(0).forEach((owner) => owner.dispose());
  drain.splice(0).forEach((work) => work());
  await flush();
  await Promise.all(pending.splice(0));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it.each(['release', 'logout', 'replacement', 'stop'] as const)(
  '%s cancels logically while replacement controllers cannot bypass raw bind admission',
  async (reason) => {
    const f = fixture(),
      a = f.attach();
    const old = observe(a.attachment.bind());
    if (reason === 'release') a.attachment.release();
    if (reason === 'logout') a.session.invalidate();
    if (reason === 'stop') a.attachment.stop();
    const b = f.attach();
    expect(await old).toHaveProperty('cause');
    await expect(b.attachment.bind()).rejects.toThrow('unresolved');
    expect(f.create).toHaveBeenCalledTimes(1);
    f.created[0]!.retired.resolve();
    await flush();
    await expect(b.attachment.bind()).rejects.toThrow('unresolved');
    f.created[0]!.raw.resolve(reply());
    await flush();
    const next = b.attachment.bind();
    f.created[1]!.raw.resolve(reply());
    const handle = await next;
    expect(handle.inspect()).not.toBeNull();
    a.attachment.release();
    a.attachment.stop();
    expect(handle.inspect()).not.toBeNull();
  },
);
it('retains retirement after raw bind settlement and observes late cleanup rejection', async () => {
  const f = fixture(),
    a = f.attach();
  const old = observe(a.attachment.bind());
  a.session.invalidate();
  expect(await old).toHaveProperty('cause');
  f.created[0]!.raw.reject(new Error('late bind failure'));
  await flush();
  const b = f.attach();
  await expect(b.attachment.bind()).rejects.toThrow('unresolved');
  f.created[0]!.retired.reject(new Error('late cleanup failure'));
  await flush();
  expect(f.errors).toHaveBeenCalledTimes(1);
  expect(f.runtime.inspect().bindingBusy).toBe(false);
  const work = b.attachment.bind();
  f.created[1]!.raw.resolve(reply());
  expect((await work).inspect()).not.toBeNull();
});
it('does not free the document ledger on controller disposal or logical timeout', async () => {
  const f = fixture(),
    a = f.attach();
  const old = observe(a.attachment.bind());
  await vi.advanceTimersByTimeAsync(5000);
  expect(await old).toHaveProperty('cause');
  a.owner.dispose();
  const b = f.attach();
  await expect(b.attachment.bind()).rejects.toThrow('unresolved');
  f.created[0]!.raw.resolve(reply());
  await flush();
  await expect(b.attachment.bind()).rejects.toThrow('unresolved');
  f.created[0]!.retired.resolve();
  await flush();
  expect(f.runtime.inspect().bindingBusy).toBe(false);
});
it('retired voice callbacks and stale commands cannot stop replacement capture/bindings', async () => {
  const f = fixture(),
    a = f.attach(),
    stale = [...a.listeners][0]!;
  const b = f.attach(),
    work = b.attachment.bind();
  f.created[0]!.raw.resolve(reply());
  const handle = await work,
    stopped = f.capture.stop.mock.calls.length;
  stale();
  a.attachment.stop();
  a.attachment.release();
  expect(f.capture.stop).toHaveBeenCalledTimes(stopped);
  expect(handle.inspect()).not.toBeNull();
  b.listeners.forEach((listener) => listener());
  expect(handle.inspect()).toBeNull();
  expect(f.capture.stop).toHaveBeenCalledTimes(stopped + 1);
});
it('permanent shutdown stops injected roots once and prevents new attachments', () => {
  const f = fixture(),
    a = f.attach();
  f.runtime.dispose();
  f.runtime.dispose();
  expect(f.capture.dispose).toHaveBeenCalledTimes(1);
  expect(f.runtime.inspect()).toMatchObject({ disposed: true, attached: false });
  expect(() => f.runtime.attach(session())).toThrow('ended');
  expect(() => a.attachment.connectVoice(a.delegate)).toThrow('unavailable');
});
it('reports optional screen attachment failure without manufacturing an owner', () => {
  const f = fixture();
  f.runtime.dispose();
  expect(f.runtime.attachCall(session())).toBeUndefined();
  expect(f.errors).toHaveBeenCalledTimes(1);
  expect(f.create).not.toHaveBeenCalled();
});
it('keeps the same capture adapter through attachment replacement and late native chooser settlement', async () => {
  const native = deferred<MediaStream>(),
    getDisplayMedia = vi.fn(() => native.promise);
  const capture = new WebScreenCapture({ getDisplayMedia });
  const runtime = new ScreenRuntime({ capture, onError: vi.fn() });
  runtimes.push(runtime);
  const a = runtime.attach(session()),
    old = observe(capture.start({ sound: 'none' }));
  runtime.attach(session());
  expect(await old).toHaveProperty('cause');
  await expect(capture.start({ sound: 'none' })).rejects.toMatchObject({ code: 'busy' });
  const track = { stop: vi.fn() };
  native.resolve({ getTracks: () => [track] } as unknown as MediaStream);
  await flush();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  a.release();
});
it('fences reentrant attachment creation during retirement without disrupting current voice', async () => {
  const f = fixture(),
    a = f.attach();
  const work = a.attachment.bind();
  f.created[0]!.raw.resolve(reply());
  const handle = await work;
  let attempted = false;
  handle.onInvalidated(() => {
    attempted = true;
    expect(() => f.runtime.attach(session())).toThrow('in progress');
  });
  a.attachment.stop();
  expect(attempted).toBe(true);
  expect(f.errors).not.toHaveBeenCalled();
});
it('keeps incoming allocation unavailable without an exact current binding', () => {
  const f = fixture(),
    a = f.attach();
  expect(() =>
    a.attachment.openIncoming({} as Parameters<ScreenRuntimeAttachment['openIncoming']>[0]),
  ).toThrow('unavailable');
});
