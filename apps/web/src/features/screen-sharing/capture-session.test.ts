import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptureSession, ScreenLifetime } from './capture-session';
import { WebScreenCapture } from './screen-capture';
import { screenRenewalPermit } from './screen-renewal';
import type { ScreenPublishGrant } from '@tricord/shared';

const sessions: CaptureSession[] = [],
  adapters: WebScreenCapture[] = [],
  lives: ScreenLifetime[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
});
afterEach(async () => {
  sessions.splice(0).forEach((session) => session.stop());
  adapters.splice(0).forEach((adapter) => adapter.dispose());
  lives.splice(0).forEach((life) => life.stop());
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
async function fixture(failDisposal = false) {
  const video = Object.assign(new EventTarget(), {
    kind: 'video',
    enabled: true,
    readyState: 'live',
    label: 'Owned synthetic source',
    getSettings: () => ({ displaySurface: 'browser', width: 1280, height: 720, frameRate: 60 }),
    stop: vi.fn(() => {
      video.readyState = 'ended';
    }),
  });
  const stream = Object.assign(new EventTarget(), { getTracks: () => [video] });
  const adapter = new WebScreenCapture({
    getDisplayMedia: vi.fn(async () => stream as unknown as MediaStream),
  });
  adapters.push(adapter);
  if (failDisposal) {
    const start = adapter.start.bind(adapter);
    vi.spyOn(adapter, 'start').mockImplementation(async (options) => {
      const capture = await start(options);
      return {
        ...capture,
        dispose: () => {
          capture.dispose();
          throw new Error('native stop failed');
        },
      };
    });
  }
  const ended = vi.fn();
  const session = new CaptureSession({
    adapter,
    deadline: Date.now() + 1000,
    sound: 'none',
    quality: { profile: 'smooth', resolution: 720, frameRate: 60, videoBitrate: 4000000 },
    onEnded: ended,
  });
  sessions.push(session);
  await session.choose();
  const grant: ScreenPublishGrant = {
    share: {
      id: crypto.randomUUID(),
      publisherId: crypto.randomUUID(),
      sourceGeneration: 1,
      profile: 'smooth',
      resolution: 720,
      frameRate: 60,
      videoBitrate: 4000000,
      sound: 'none',
    },
    remainingMs: 10000,
  };
  return { session, adapter, video, ended, grant };
}
it('atomically replaces preview supervision while retaining the same capture and adapter ownership', async () => {
  const f = await fixture(),
    capture = f.session.borrow(),
    previous = f.session.lifecycle();
  f.session.commitPublication(f.session.previewKey, f.grant, Date.now() + 10000, 1);
  f.session.stopPreview(f.session.previewKey);
  previous.stop();
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.session.borrow()).toBe(capture);
  expect(f.video.stop).not.toHaveBeenCalled();
  f.session.stop();
  expect(f.video.stop).toHaveBeenCalledTimes(1);
  expect(f.ended).toHaveBeenCalledTimes(1);
});
it('cannot promote expired preview, another source generation or different source-sound consent', async () => {
  const f = await fixture();
  expect(() => f.session.commitPublication({}, f.grant, Date.now() + 10000, 1)).toThrow();
  expect(() =>
    f.session.commitPublication(f.session.previewKey, f.grant, Date.now() + 10000, 2),
  ).toThrow();
  expect(() =>
    f.session.commitPublication(
      f.session.previewKey,
      { ...f.grant, share: { ...f.grant.share, sound: 'system' } },
      Date.now() + 10000,
      1,
    ),
  ).toThrow();
  expect(() =>
    f.session.commitPublication(
      f.session.previewKey,
      { ...f.grant, share: { ...f.grant.share, frameRate: 30 } },
      Date.now() + 10000,
      1,
    ),
  ).toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  expect(() =>
    f.session.commitPublication(f.session.previewKey, f.grant, Date.now() + 10000, 1),
  ).toThrow();
  expect(f.video.readyState).toBe('ended');
});
it('source end remains a root stop after publication promotion', async () => {
  const f = await fixture();
  f.session.commitPublication(f.session.previewKey, f.grant, Date.now() + 10000, 1);
  f.video.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  expect(f.video.readyState).toBe('ended');
  expect(f.ended).toHaveBeenCalledTimes(1);
});
it('adopts only newly minted exact-generation renewal before the previous deadline', async () => {
  const life = new ScreenLifetime(Date.now() + 1000);
  lives.push(life);
  expect(() =>
    life.renew({ generation: life.generation, deadline: Date.now() + 10000, revision: 1 }),
  ).toThrow();
  expect(() => life.renew(screenRenewalPermit({}, Date.now() + 10000, 1))).toThrow();
  const permit = screenRenewalPermit(life.generation, Date.now() + 10000, 1);
  life.renew(permit);
  expect(() => life.renew(permit)).toThrow();
  await vi.advanceTimersByTimeAsync(1500);
  expect(life.inspect()).not.toBeNull();
  await vi.advanceTimersByTimeAsync(8500);
  expect(life.inspect()).toBeNull();
  expect(() => life.renew(screenRenewalPermit(life.generation, Date.now() + 10000, 2))).toThrow();
});

it('still invalidates publication lifetime and notifies its owner if native capture disposal throws', async () => {
  const f = await fixture(true);
  const life = f.session.lifecycle();
  expect(() => f.session.stop()).toThrow('native stop failed');
  expect(life.inspect()).toBeNull();
  expect(f.ended).toHaveBeenCalledTimes(1);
});
