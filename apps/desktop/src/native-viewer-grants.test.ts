import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeViewerGrants } from './native-viewer-grants';

afterEach(() => vi.useRealTimers());

it('waits for the exact delivered answer on the selected viewer and applies the server deadline', async () => {
  const { NATIVE_VIEWER_GRANT_BATCH_SIZE } = await import('@tricord/shared');
  vi.useFakeTimers();
  const grants = new NativeViewerGrants(NATIVE_VIEWER_GRANT_BATCH_SIZE),
    id = randomUUID(),
    other = randomUUID();
  const started = Date.now(),
    hash = 'a'.repeat(64);
  const pending = grants.deadline(id, hash);
  grants.observe(
    {
      iceServers: [],
      viewers: [
        { id: other, remainingMs: 15000, answerHash: hash },
        { id, remainingMs: 14000, answerHash: null },
      ],
    },
    started,
  );
  grants.observe(
    { iceServers: [], viewers: [{ id, remainingMs: 12000, answerHash: hash }] },
    started,
  );
  expect(await pending).toBe(started + 12000);
  const forged = expect(grants.deadline(id, 'b'.repeat(64))).rejects.toThrow('did not authorize');
  await vi.advanceTimersByTimeAsync(3501);
  await forged;
  grants.observe({ iceServers: [], viewers: [] }, Date.now());
  const revoked = expect(grants.deadline(id)).rejects.toThrow('did not authorize');
  grants.stop();
  await revoked;
});

it('rejects unbounded and duplicate server grants', async () => {
  const { NATIVE_VIEWER_GRANT_BATCH_SIZE } = await import('@tricord/shared');
  const grants = new NativeViewerGrants(NATIVE_VIEWER_GRANT_BATCH_SIZE);
  const viewer = { id: randomUUID(), remainingMs: 45000, answerHash: null };
  expect(() => grants.observe({ iceServers: [], viewers: [viewer, viewer] }, Date.now())).toThrow();
  expect(() =>
    grants.observe({ iceServers: [], viewers: [{ ...viewer, remainingMs: 45001 }] }, Date.now()),
  ).toThrow();
  expect(() =>
    grants.observe(
      {
        iceServers: [],
        viewers: Array.from({ length: NATIVE_VIEWER_GRANT_BATCH_SIZE + 1 }, () => ({
          ...viewer,
          id: randomUUID(),
        })),
      },
      Date.now(),
    ),
  ).toThrow('Invalid authorized native viewers');
});

it('releases simultaneous waiters and refreshes each live grant independently', async () => {
  const { NATIVE_VIEWER_GRANT_BATCH_SIZE } = await import('@tricord/shared');
  vi.useFakeTimers();
  const grants = new NativeViewerGrants(NATIVE_VIEWER_GRANT_BATCH_SIZE);
  const viewers = Array.from({ length: 10 }, () => ({
    id: randomUUID(),
    remainingMs: 5000,
    answerHash: 'a'.repeat(64),
  }));
  const started = Date.now();
  const waits = viewers.map(({ id, answerHash }) => grants.deadline(id, answerHash));
  grants.observe({ viewers, iceServers: [] }, started);
  expect(await Promise.all(waits)).toEqual(viewers.map(() => started + 5000));
  await vi.advanceTimersByTimeAsync(4500);
  grants.observe({ viewers: viewers.slice(1), iceServers: [] }, Date.now());
  expect(grants.currentDeadline(viewers[0]!.id)).toBe(0);
  await vi.advanceTimersByTimeAsync(501);
  expect(grants.currentDeadline(viewers[1]!.id)).toBe(started + 9500);
  await vi.advanceTimersByTimeAsync(4500);
  expect(grants.currentDeadline(viewers[1]!.id)).toBe(0);
  const expired = expect(grants.deadline(viewers[1]!.id)).rejects.toThrow('did not authorize');
  await vi.advanceTimersByTimeAsync(3500);
  await expired;
  grants.stop();
  expect(vi.getTimerCount()).toBe(0);
});
