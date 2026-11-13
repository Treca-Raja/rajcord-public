import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { waitForBrowserPort } from './browser-startup.js';

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));

function browser() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr: new PassThrough(),
  }) as unknown as ChildProcess;
}

beforeEach(() => {
  mocks.readFile.mockReset();
  mocks.readFile.mockRejectedValue(Object.assign(new Error('not ready'), { code: 'ENOENT' }));
});

it('reads a valid debugging port and detaches startup listeners', async () => {
  const child = browser();
  mocks.readFile.mockResolvedValue('43123\n/devtools/browser/fixture\n');
  await expect(waitForBrowserPort(child, 'private-test-profile')).resolves.toBe('43123');
  expect(child.listenerCount('error')).toBe(0);
  expect(child.stderr!.listenerCount('data')).toBe(0);
});

it('waits for the readiness file instead of failing on the first missing read', async () => {
  mocks.readFile
    .mockRejectedValueOnce(Object.assign(new Error('not ready'), { code: 'ENOENT' }))
    .mockResolvedValueOnce('43123\n');
  await expect(waitForBrowserPort(browser(), 'private-test-profile')).resolves.toBe('43123');
});

it('reports a missing executable without leaking its path', async () => {
  const child = browser();
  const startup = waitForBrowserPort(child, 'private-test-profile');
  child.emit('error', Object.assign(new Error('private executable path'), { code: 'ENOENT' }));
  await expect(startup).rejects.toThrow('Cannot launch the configured test browser (ENOENT)');
});

it('reports an early exit and only a safe category from browser stderr', async () => {
  const child = browser();
  const startup = waitForBrowserPort(child, 'private-test-profile');
  child.stderr!.emit('data', Buffer.from('No usable sandbox! private-test-profile secret-cookie'));
  child.exitCode = 1;
  const error = await startup.catch((reason: Error) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('exit code 1');
  expect((error as Error).message).toContain("Chromium's Linux sandbox");
  expect((error as Error).message).not.toMatch(/private-test-profile|secret-cookie/);
});

it('reports termination by signal before readiness', async () => {
  const child = browser();
  child.signalCode = 'SIGTERM';
  await expect(waitForBrowserPort(child, 'private-test-profile')).rejects.toThrow('signal SIGTERM');
});

it.each(['', 'not-a-port', '0', '65536'])(
  'times out with an actionable error for port %j',
  async (port) => {
    const child = browser();
    mocks.readFile.mockResolvedValue(port + '\n');
    await expect(waitForBrowserPort(child, 'private-test-profile', 100)).rejects.toThrow(
      'Headless browser did not publish a valid debugging port within 100 ms',
    );
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stderr!.listenerCount('data')).toBe(0);
  },
);
