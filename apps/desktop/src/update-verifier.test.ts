import { expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: run }));
import { verifyUpdateSignature } from './update-signature';
it('fails closed when PowerShell cannot start or its output is ambiguous', async () => {
  run.mockImplementation((_exe, _args, _options, callback) => callback(new Error('blocked')));
  expect(await verifyUpdateSignature(['CN=Trusted'], 'C:/update.exe')).not.toBeNull();
  run.mockImplementation((_exe, _args, _options, callback) => callback(null, 'invalid', ''));
  expect(await verifyUpdateSignature(['CN=Trusted'], 'C:/update.exe')).not.toBeNull();
  const options = run.mock.calls[0]![2];
  expect(options.shell).not.toBe(true);
  expect(options.windowsHide).toBe(true);
  expect(options.timeout).toBe(20000);
});
