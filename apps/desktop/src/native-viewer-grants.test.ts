import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeViewerGrants } from './native-viewer-grants';

afterEach(() => vi.useRealTimers());

it('waits for the exact delivered answer on the selected viewer and applies the server deadline', async () => {
  vi.useFakeTimers();
  const grants = new NativeViewerGrants(),
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

it('rejects unbounded and duplicate server grants', () => {
  const grants = new NativeViewerGrants();
  const viewer = { id: randomUUID(), remainingMs: 45000, answerHash: null };
  expect(() => grants.observe({ iceServers: [], viewers: [viewer, viewer] }, Date.now())).toThrow();
  expect(() =>
    grants.observe({ iceServers: [], viewers: [{ ...viewer, remainingMs: 45001 }] }, Date.now()),
  ).toThrow();
});
