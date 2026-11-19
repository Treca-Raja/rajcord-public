import { beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { launch, waitForDebuggingPage, waitForDebuggingPort } from './browser-harness';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

beforeEach(() => vi.mocked(readFile).mockReset());

it('waits for the debugging page when the port is ready earlier', async () => {
  const url = 'ws://127.0.0.1:43123/devtools/page/test';
  const fetchPages = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json([{ type: 'page', webSocketDebuggerUrl: url }]));
  try {
    await expect(waitForDebuggingPage('43123')).resolves.toBe(url);
    expect(fetchPages).toHaveBeenCalledTimes(2);
  } finally {
    fetchPages.mockRestore();
  }
});

it('requires fake devices for a file-backed gameplay capture', async () => {
  await expect(launch({ fakeMicrophone: false, fakeVideoFile: 'fixture.y4m' })).rejects.toThrow(
    'requires fake media devices',
  );
});

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
  expect(readFile).toHaveBeenCalledTimes(300);
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  vi.mocked(readFile).mockRejectedValueOnce(denied);
  await expect(waitForDebuggingPort('fixture-profile', () => {})).rejects.toBe(denied);
});

it('allows a cold start beyond ten seconds within the bounded thirty-second readiness window', async () => {
  let reads = 0;
  vi.mocked(readFile).mockImplementation(async () => (++reads > 150 ? '43123\n' : ''));
  await expect(waitForDebuggingPort('fixture-profile', () => {})).resolves.toBe('43123');
  expect(readFile).toHaveBeenCalledTimes(151);
});

it('waits through a transient browser writer lock before reading the published port', async () => {
  vi.mocked(readFile)
    .mockRejectedValueOnce(Object.assign(new Error('writer holds file'), { code: 'EBUSY' }))
    .mockResolvedValueOnce('43123\n');
  const check = vi.fn();
  await expect(waitForDebuggingPort('fixture-profile', check)).resolves.toBe('43123');
  expect(check).toHaveBeenCalledTimes(2);
});

it('bounds a persistently locked port file without declaring the browser ready', async () => {
  vi.mocked(readFile).mockImplementation(async () => {
    throw Object.assign(new Error('writer holds file'), { code: 'EBUSY' });
  });
  const result = await waitForDebuggingPort('fixture-profile', () => {}).catch(
    (error: unknown) => error,
  );
  const reads = vi.mocked(readFile).mock.calls.length;
  // Assertion diagnostics may read source files through the same filesystem mock.
  vi.mocked(readFile).mockReset();
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain('valid debugging port');
  expect(reads).toBe(300);
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
