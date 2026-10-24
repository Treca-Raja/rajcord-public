import { it, expect } from 'vitest';
import { singleFlight } from './single-flight';
it('coalesces concurrent account refreshes and rechecks after completion', async () => {
  let count = 0,
    release!: (value: number) => void;
  const run = singleFlight(() => {
    count++;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  });
  const first = run(),
    second = run();
  expect(first).toBe(second);
  expect(count).toBe(1);
  release(1);
  expect(await first).toBe(1);
  const third = run();
  expect(count).toBe(2);
  release(2);
  expect(await third).toBe(2);
});
it('permits recovery after a failed account refresh', async () => {
  let count = 0;
  const run = singleFlight(async () => {
    if (++count === 1) throw new Error('offline');
    return 'recovered';
  });
  await expect(run()).rejects.toThrow('offline');
  expect(await run()).toBe('recovered');
});
