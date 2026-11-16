import { beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { waitForDebuggingPort } from './browser-harness';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

beforeEach(() => vi.mocked(readFile).mockReset());

it('waits through missing and partially written port files without accepting empty readiness', async () => {
  vi.mocked(readFile)
    .mockRejectedValueOnce(Object.assign(new Error('not created'), { code: 'ENOENT' }))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce('\n')
    .mockResolvedValueOnce('0\n')
    .mockResolvedValueOnce('65536\n')
    .mockResolvedValueOnce('43123\n/devtools/browser/fixture');
  await expect(waitForDebuggingPort('fixture-profile', () => {})).resolves.toBe('43123');
  expect(readFile).toHaveBeenCalledTimes(6);
});

it('bounds incomplete readiness and reports file access errors', async () => {
  vi.mocked(readFile).mockResolvedValue('');
  await expect(waitForDebuggingPort('fixture-profile', () => {})).rejects.toThrow(
    'valid debugging port',
  );
  expect(readFile).toHaveBeenCalledTimes(100);
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  vi.mocked(readFile).mockRejectedValueOnce(denied);
  await expect(waitForDebuggingPort('fixture-profile', () => {})).rejects.toBe(denied);
});

it('stops waiting when the browser launch has failed', async () => {
  const failed = new Error('browser exited');
  await expect(
    waitForDebuggingPort('fixture-profile', () => {
      throw failed;
    }),
  ).rejects.toBe(failed);
  expect(readFile).not.toHaveBeenCalled();
});
