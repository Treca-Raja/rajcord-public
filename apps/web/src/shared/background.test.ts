import { afterEach, expect, it, vi } from 'vitest';
import { runInBackground } from './background';

afterEach(() => vi.unstubAllGlobals());
it('reports a detached rejection without replacing the error', async () => {
  const report = vi.fn();
  vi.stubGlobal('reportError', report);
  const cause = new Error('Synthetic failure');
  runInBackground(Promise.reject(cause));
  await Promise.resolve();
  expect(report).toHaveBeenCalledExactlyOnceWith(cause);
});
it('accepts absent work and completed operations without reporting a failure', async () => {
  const report = vi.fn();
  vi.stubGlobal('reportError', report);
  expect(runInBackground(undefined)).toBeUndefined();
  expect(runInBackground(Promise.resolve('done'))).toBeUndefined();
  await Promise.resolve();
  expect(report).not.toHaveBeenCalled();
});
